/**
 * AccountService — port of Modules/Account/Sources/Account/Account.swift
 * (plus AccountSettings.swift's UserDefaults persistence, OPMLFile.swift's wiring and
 * Container.swift's container protocol).
 *
 * The model layer's `Account` holds the account's data; this service owns everything the
 * Swift class did beyond it: the delegate, the ArticlesDatabase, the FeedSettings cache and
 * database, the Subscriptions.opml file, every tree mutation, and fetchArticles(FetchType) —
 * the one read path behind every timeline and smart feed.
 *
 * Swift's `Container` protocol is a class-existential over Account and Folder. ArkTS has no
 * such thing, so ContainerRef carries (account, folder?) and exposes the same operations.
 */

import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Account } from '../../model/Account';
import { AccountBehavior } from '../../model/AccountBehavior';
import { AccountSettingKey, AccountSettings } from '../../model/AccountSettings';
import { AccountType, accountTypeDisplayName } from '../../model/AccountType';
import { ActivityKind, ActivityKindType, ActivityOwner } from '../../model/Activity';
import { Article } from '../../model/Article';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Author } from '../../model/Author';
import { ContainerIdentifier } from '../../model/ContainerIdentifier';
import { Credentials, CredentialsType } from '../../model/Credentials';
import { Feed, feedIDs } from '../../model/Feed';
import { FeedSettings } from '../../model/FeedSettings';
import { FetchType, FetchTypeKind } from '../../model/FetchType';
import { Folder } from '../../model/Folder';
import { HTTPConditionalGetInfo, makeConditionalGetInfo } from '../../model/HTTPConditionalGetInfo';
import { OPMLFeedSpecifier, OPMLItem } from '../../model/OPMLDocument';
import { ParsedFeed } from '../../model/ParsedFeed';
import { ParsedItem } from '../../model/ParsedItem';
import { ProgressInfo } from '../../model/ProgressInfo';
import { ArticleChanges, ArticleCounts, ArticlesDatabase, RetentionStyle, UnreadCountDictionary }
  from '../db/ArticlesDatabase';
import { Database } from '../db/Database';
import { FeedSettingsColumn, FeedSettingsDatabase, FeedSettingsRow } from '../db/FeedSettingsDatabase';
import { ActivityLog } from '../log/ActivityLog';
import { UserNotificationManager } from '../notify/UserNotificationManager';
import { OPMLFile, normalizeOPMLItems, opmlStringForFeed, opmlStringForFolder } from '../parser/OPML';
import { AppDefaults } from '../prefs/AppDefaults';
import { CredentialsManager } from '../security/CredentialsManager';
import { AppContext } from '../util/AppContext';
import { AccountDelegate, AccountError, AccountErrorKind, createAccountDelegate, postSyncError }
  from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'Account';

/** Every notification the Swift account posted, as one listener signal. */
export enum AccountChange {
  unreadCount = 'unreadCount',
  unreadCountDidInitialize = 'unreadCountDidInitialize',
  children = 'children',
  displayName = 'displayName',
  articlesDownloaded = 'articlesDownloaded',
  statuses = 'statuses',
  progress = 'progress',
  refreshDidBegin = 'refreshDidBegin',
  refreshDidFinish = 'refreshDidFinish',
  state = 'state',
  queuedArticleStatuses = 'queuedArticleStatuses'
}

export type AccountChangeListener = (change: AccountChange, account: AccountService) => void;

/**
 * Container.swift — the Account-or-Folder existential. `folder` undefined means the
 * container is the account itself (the root).
 */
export class ContainerRef {
  readonly account: AccountService;
  readonly folder?: Folder;

  constructor(account: AccountService, folder?: Folder) {
    this.account = account;
    this.folder = folder;
  }

  static forAccount(account: AccountService): ContainerRef {
    return new ContainerRef(account);
  }

  static forFolder(account: AccountService, folder: Folder): ContainerRef {
    return new ContainerRef(account, folder);
  }

  get isAccount(): boolean {
    return this.folder === undefined;
  }

  get nameForDisplay(): string {
    const folder: Folder | undefined = this.folder;
    return folder === undefined ? this.account.nameForDisplay : folder.nameForDisplay;
  }

  get externalID(): string | undefined {
    const folder: Folder | undefined = this.folder;
    return folder === undefined ? this.account.externalID : folder.externalID;
  }

  get containerID(): ContainerIdentifier {
    const folder: Folder | undefined = this.folder;
    return folder === undefined ? this.account.model.containerID : folder.containerID;
  }

  topLevelFeeds(): Feed[] {
    const folder: Folder | undefined = this.folder;
    return folder === undefined ? this.account.model.topLevelFeeds.slice()
      : folder.topLevelFeeds.slice();
  }

  flattenedFeeds(): Feed[] {
    const folder: Folder | undefined = this.folder;
    return folder === undefined ? this.account.flattenedFeeds() : folder.flattenedFeeds();
  }

  hasFeed(feed: Feed): boolean {
    for (const candidate of this.flattenedFeeds()) {
      if (candidate.equals(feed)) {
        return true;
      }
    }
    return false;
  }

  addFeedToTreeAtTopLevel(feed: Feed): void {
    const folder: Folder | undefined = this.folder;
    if (folder === undefined) {
      this.account.addFeedToTreeAtTopLevel(feed);
    } else {
      folder.addFeedToTreeAtTopLevel(feed);
      this.account.structureDidChange();
      this.account.postChange(AccountChange.children);
    }
  }

  removeFeedFromTreeAtTopLevel(feed: Feed): void {
    const folder: Folder | undefined = this.folder;
    if (folder === undefined) {
      this.account.removeFeedFromTreeAtTopLevel(feed);
    } else {
      folder.removeFeedFromTreeAtTopLevel(feed);
      this.account.structureDidChange();
      this.account.postChange(AccountChange.children);
    }
  }

  existingFeedWithURL(url: string): Feed | undefined {
    for (const feed of this.flattenedFeeds()) {
      if (feed.url === url) {
        return feed;
      }
    }
    return undefined;
  }
}

// MARK: - AccountSettings persistence (UserDefaults -> @ohos.data.preferences)

/** Loads the `<accountID>-<key>` defaults the source files each account's settings under. */
export function loadAccountSettings(accountID: string, dataFolder: string): AccountSettings {
  const settings: AccountSettings = new AccountSettings(accountID, dataFolder);
  settings.name = AppDefaults.stringValue(settings.defaultsKey(AccountSettingKey.name));
  const isActiveKey: string = settings.defaultsKey(AccountSettingKey.isActive);
  // The registered default is true, so an absent value means active.
  settings.isActive = AppDefaults.stringValue(isActiveKey) === undefined
    ? true : AppDefaults.boolValue(isActiveKey);
  settings.username = AppDefaults.stringValue(settings.defaultsKey(AccountSettingKey.username));
  settings.lastArticleFetchStartTime =
    AppDefaults.dateValue(settings.defaultsKey(AccountSettingKey.lastArticleFetchStartTime));
  settings.lastRefreshCompletedDate =
    AppDefaults.dateValue(settings.defaultsKey(AccountSettingKey.lastRefreshCompletedDate));
  settings.endpointURL = AppDefaults.stringValue(settings.defaultsKey(AccountSettingKey.endpointURL));
  settings.externalID = AppDefaults.stringValue(settings.defaultsKey(AccountSettingKey.externalID));
  settings.plistImported = AppDefaults.boolValue(settings.defaultsKey(AccountSettingKey.imported));
  return settings;
}

export function saveAccountSettings(settings: AccountSettings): void {
  AppDefaults.setString(settings.defaultsKey(AccountSettingKey.name), settings.name);
  AppDefaults.setBool(settings.defaultsKey(AccountSettingKey.isActive), settings.isActive);
  AppDefaults.setString(settings.defaultsKey(AccountSettingKey.username), settings.username);
  AppDefaults.setDate(settings.defaultsKey(AccountSettingKey.lastArticleFetchStartTime),
    settings.lastArticleFetchStartTime);
  AppDefaults.setDate(settings.defaultsKey(AccountSettingKey.lastRefreshCompletedDate),
    settings.lastRefreshCompletedDate);
  AppDefaults.setString(settings.defaultsKey(AccountSettingKey.endpointURL), settings.endpointURL);
  AppDefaults.setString(settings.defaultsKey(AccountSettingKey.externalID), settings.externalID);
  AppDefaults.setBool(settings.defaultsKey(AccountSettingKey.imported), settings.plistImported);
}

export function deleteAccountSettings(settings: AccountSettings): void {
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.name));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.isActive));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.username));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.lastArticleFetchStartTime));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.lastRefreshCompletedDate));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.endpointURL));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.externalID));
  AppDefaults.removeValue(settings.defaultsKey(AccountSettingKey.imported));
  settings.conditionalGetInfo.forEach((info: HTTPConditionalGetInfo, endpoint: string) => {
    AppDefaults.removeValue(settings.conditionalGetInfoDefaultsKey(endpoint));
  });
}

/** Feed.takeSettings(from: parsedFeed) — DataExtensions.swift. */
export function takeFeedSettingsFromParsedFeed(feed: Feed, parsedFeed: ParsedFeed): void {
  feed.iconURL = parsedFeed.iconURL;
  feed.faviconURL = parsedFeed.faviconURL;
  feed.homePageURL = parsedFeed.homePageURL;
  feed.name = parsedFeed.title;
  const parsedAuthors = parsedFeed.authors;
  if (parsedAuthors !== undefined) {
    const authors: Author[] = [];
    for (const parsedAuthor of parsedAuthors) {
      const author: Author = {
        authorID: '',
        name: parsedAuthor.name,
        url: parsedAuthor.url,
        avatarURL: parsedAuthor.avatarURL,
        emailAddress: parsedAuthor.emailAddress
      };
      authors.push(author);
    }
    feed.authors = authors;
  }
}

// MARK: - AccountService

export class AccountService {
  readonly model: Account;
  readonly delegate: AccountDelegate;
  readonly database: ArticlesDatabase;
  readonly feedSettingsDatabase: FeedSettingsDatabase;

  private readonly opmlFile: OPMLFile;
  private readonly feedSettingsCache: Map<string, FeedSettings> = new Map<string, FeedSettings>();
  private listeners: AccountChangeListener[] = [];
  private fetchingAllUnreadCounts: boolean = false;
  private flattenedFeedsCache?: Feed[];
  private idToFeedCache?: Map<string, Feed>;
  private externalIDToFeedCache?: Map<string, Feed>;

  constructor(accountID: string, type: AccountType, dataFolder: string) {
    const settings: AccountSettings = loadAccountSettings(accountID, dataFolder);
    this.model = new Account(accountID, type, dataFolder, settings);

    const retentionStyle: RetentionStyle =
      (type === AccountType.onMyMac || type === AccountType.cloudKit)
        ? RetentionStyle.feedBased : RetentionStyle.syncSystem;
    this.database = new ArticlesDatabase(dataFolder + '/DB.sqlite3', accountID, retentionStyle);
    this.feedSettingsDatabase = new FeedSettingsDatabase(dataFolder + '/FeedSettings.db');

    this.opmlFile = new OPMLFile(dataFolder + '/Subscriptions.opml', (): string => {
      return this.opmlString();
    });

    this.delegate = createAccountDelegate(type, dataFolder);
    this.delegate.account = this;
    this.delegate.accountSettings = settings;
    this.delegate.onProgressChange = (): void => {
      this.progressInfoDidChange();
    };
    this.model.behaviors = this.delegate.behaviors;
  }

  /** The async half of Account.init: databases, the feed-settings cache, and the OPML tree. */
  async open(): Promise<void> {
    await this.database.open();
    await this.feedSettingsDatabase.open();
    await this.populateFeedSettingsCache();

    const items: OPMLItem[] | undefined = this.opmlFile.load();
    if (items !== undefined) {
      this.loadOPMLItems(items);
    }
    await this.feedSettingsDatabase.deleteSettingsForFeedsNotIn(this.model.flattenedFeedURLs());
    await this.database.cleanupDatabaseAtStartup(feedIDs(this.flattenedFeeds()));
    await this.fetchAllUnreadCounts();

    this.delegate.accountDidInitialize();
  }

  // MARK: - Identity

  get accountID(): string {
    return this.model.accountID;
  }

  get type(): AccountType {
    return this.model.type;
  }

  get dataFolder(): string {
    return this.model.dataFolder;
  }

  get settings(): AccountSettings {
    return this.model.settings;
  }

  get nameForDisplay(): string {
    return this.model.nameForDisplay;
  }

  get name(): string | undefined {
    return this.model.name;
  }

  set name(value: string | undefined) {
    const before: string = this.model.nameForDisplay;
    if (value !== this.model.name) {
      this.model.name = value;
      this.saveSettings();
      if (before !== this.model.nameForDisplay) {
        this.postChange(AccountChange.displayName);
      }
    }
  }

  get isActive(): boolean {
    return this.model.isActive;
  }

  set isActive(value: boolean) {
    if (value !== this.model.isActive) {
      this.model.isActive = value;
      this.saveSettings();
      this.postChange(AccountChange.state);
    }
  }

  get username(): string | undefined {
    return this.model.username;
  }

  set username(value: string | undefined) {
    if (value !== this.model.username) {
      this.model.username = value;
      this.saveSettings();
    }
  }

  get externalID(): string | undefined {
    return this.model.externalID;
  }

  set externalID(value: string | undefined) {
    this.model.externalID = value;
    this.saveSettings();
  }

  get endpointURL(): string | undefined {
    return this.model.endpointURL;
  }

  set endpointURL(value: string | undefined) {
    this.model.endpointURL = value;
    this.saveSettings();
  }

  get lastArticleFetchStartTime(): Date | undefined {
    return this.model.lastArticleFetchStartTime;
  }

  set lastArticleFetchStartTime(value: Date | undefined) {
    this.model.lastArticleFetchStartTime = value;
    this.saveSettings();
  }

  get lastRefreshCompletedDate(): Date | undefined {
    return this.model.lastRefreshCompletedDate;
  }

  set lastRefreshCompletedDate(value: Date | undefined) {
    this.model.lastRefreshCompletedDate = value;
    this.saveSettings();
  }

  get behaviors(): AccountBehavior[] {
    return this.delegate.behaviors;
  }

  get unreadCount(): number {
    return this.model.unreadCount;
  }

  get refreshInProgress(): boolean {
    return this.model.refreshInProgress;
  }

  get progressInfo(): ProgressInfo {
    return this.model.progressInfo;
  }

  get isDeleted(): boolean {
    return this.model.isDeleted;
  }

  set isDeleted(value: boolean) {
    this.model.isDeleted = value;
  }

  get activityOwner(): ActivityOwner {
    return ActivityOwner.account(this.accountID, this.nameForDisplay);
  }

  get containerRef(): ContainerRef {
    return ContainerRef.forAccount(this);
  }

  saveSettings(): void {
    saveAccountSettings(this.model.settings);
  }

  deleteSettings(): void {
    deleteAccountSettings(this.model.settings);
  }

  // MARK: - Listeners

  addListener(listener: AccountChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: AccountChangeListener): void {
    this.listeners = this.listeners.filter((l: AccountChangeListener) => l !== listener);
  }

  postChange(change: AccountChange): void {
    // Account.childrenDidChange (Account.swift:1157) recomputes the account's unread count
    // whenever .ChildrenDidChange names this account, because the tree mutators
    // (removeFeedFromTreeAtTopLevel, removeFeedsFromTreeAtTopLevel, removeFolderFromTree, ...)
    // only change membership - no per-feed count changes, so no other path recomputes it.
    // Every one of those mutators routes through this signal here, so this is the port of
    // that one observer.
    // The folder half is Folder.childrenDidChange (Folder.swift:97), which the port collapsed
    // into this same signal: ContainerRef.removeFeedFromTreeAtTopLevel posts it for the folder
    // case too, and a folder row's count is just as stale after a feed leaves it.
    if (change === AccountChange.children) {
      for (const folder of this.folders()) {
        folder.updateUnreadCount();
      }
      this.updateUnreadCount();
    }
    for (const listener of this.listeners) {
      listener(change, this);
    }
  }

  private progressInfoDidChange(): void {
    const updated: ProgressInfo = this.delegate.progressInfo;
    if (updated.equals(this.model.progressInfo)) {
      return;
    }
    this.model.progressInfo = updated;
    this.postChange(AccountChange.progress);

    const refreshInProgress: boolean = !updated.isComplete;
    if (refreshInProgress !== this.model.refreshInProgress) {
      this.model.refreshInProgress = refreshInProgress;
      if (refreshInProgress) {
        this.postChange(AccountChange.refreshDidBegin);
      } else {
        this.postChange(AccountChange.refreshDidFinish);
        this.opmlFile.markAsDirty();
      }
    }
  }

  // MARK: - Credentials

  async storeCredentials(credentials: Credentials): Promise<void> {
    this.username = credentials.username;
    const server: string | undefined = this.delegate.server;
    if (server === undefined) {
      return;
    }
    try {
      await CredentialsManager.storeCredentials(credentials, server);
    } catch (e) {
      this.postSyncError(e as Error, 'Storing credentials');
      throw e as Error;
    }
    this.delegate.credentials = credentials;
  }

  async retrieveCredentials(type: CredentialsType): Promise<Credentials | undefined> {
    const username: string | undefined = this.username;
    const server: string | undefined = this.delegate.server;
    if (username === undefined || server === undefined) {
      return undefined;
    }
    try {
      return await CredentialsManager.retrieveCredentials(type, server, username);
    } catch (e) {
      this.postSyncError(e as Error, 'Retrieving credentials');
      return undefined;
    }
  }

  async removeCredentials(type: CredentialsType): Promise<void> {
    const username: string | undefined = this.username;
    const server: string | undefined = this.delegate.server;
    if (username === undefined || server === undefined) {
      return;
    }
    try {
      await CredentialsManager.removeCredentials(type, server, username);
    } catch (e) {
      this.postSyncError(e as Error, 'Removing credentials');
    }
  }

  // MARK: - Conditional GET info (per sync endpoint)

  conditionalGetInfoFor(endpoint: string): HTTPConditionalGetInfo | undefined {
    const cached: HTTPConditionalGetInfo | undefined =
      this.model.settings.conditionalGetInfoFor(endpoint);
    if (cached !== undefined) {
      return cached;
    }
    const stored: Map<string, string> | undefined =
      AppDefaults.stringMapValue(this.model.settings.conditionalGetInfoDefaultsKey(endpoint));
    if (stored === undefined) {
      return undefined;
    }
    const info: HTTPConditionalGetInfo | undefined =
      makeConditionalGetInfo(stored.get('lastModified'), stored.get('etag'));
    if (info !== undefined) {
      this.model.settings.setConditionalGetInfo(info, endpoint);
    }
    return info;
  }

  setConditionalGetInfo(info: HTTPConditionalGetInfo | undefined, endpoint: string): void {
    this.model.settings.setConditionalGetInfo(info, endpoint);
    const key: string = this.model.settings.conditionalGetInfoDefaultsKey(endpoint);
    if (info === undefined) {
      AppDefaults.removeValue(key);
      return;
    }
    const stored: Map<string, string> = new Map<string, string>();
    if (info.lastModified !== undefined) {
      stored.set('lastModified', info.lastModified);
    }
    if (info.etag !== undefined) {
      stored.set('etag', info.etag);
    }
    AppDefaults.setStringMap(key, stored);
  }

  // MARK: - Activity log

  logActivityStart(kind: ActivityKindType, detail?: string, urlString?: string): number {
    const id: number = ActivityLog.shared.createActivity(this.activityOwner,
      new ActivityKind(kind, urlString), detail);
    ActivityLog.shared.didStartWithID(id);
    return id;
  }

  logActivityComplete(id: number, message?: string, durationIsSignificant: boolean = true): void {
    ActivityLog.shared.didCompleteWithID(id, message, durationIsSignificant);
  }

  logActivityFail(id: number, error: Error): void {
    ActivityLog.shared.didFailWithID(id, error);
  }

  /** ActivityLog.shared.nextTaskNumberString() — the per-page detail string. */
  nextTaskNumberString(): string {
    return ActivityLog.shared.nextTaskNumberString();
  }

  postSyncError(error: Error, operation: string): void {
    postSyncError(this.nameForDisplay, this.type, error, operation);
  }

  wrapError(error: Error): AccountError {
    return AccountError.wrapped(error, this.accountID, this.nameForDisplay, this.type);
  }

  // MARK: - Refreshing (delegate passthrough)

  async refreshAll(): Promise<void> {
    await this.delegate.refreshAll();
  }

  async sendArticleStatus(): Promise<void> {
    await this.delegate.sendArticleStatus();
  }

  async syncArticleStatus(): Promise<boolean> {
    return await this.delegate.syncArticleStatus();
  }

  async receiveRemoteNotification(userInfo: Map<string, string>): Promise<void> {
    await this.delegate.receiveRemoteNotification(userInfo);
  }

  /**
   * `onFeedsLoaded` runs the moment the OPML is in the account tree, BEFORE the refresh.
   *
   * The source needs no such hook: its sidebar redraws off .AccountDidChange as soon as the
   * feeds land. Here nothing observes an account, so the only redraw hangs off this promise —
   * and this promise does not settle until refreshAll has downloaded EVERY feed of the
   * account. On a large OPML that is minutes of network, during which the Feeds screen shows
   * exactly what it showed before: nothing visibly changes after the import.
   */
  async importOPML(opmlFilePath: string, onFeedsLoaded?: () => void): Promise<void> {
    if (this.delegate.isOPMLImportInProgress) {
      throw AccountError.of(AccountErrorKind.opmlImportInProgress);
    }
    await this.delegate.importOPML(opmlFilePath);
    // Reset the last fetch date so the added feeds get their article history.
    this.lastArticleFetchStartTime = undefined;
    if (onFeedsLoaded !== undefined) {
      onFeedsLoaded();
    }
    try {
      await this.delegate.refreshAll();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'refresh after OPML import failed: %{public}s', String(e));
    }
  }

  suspendNetwork(): void {
    this.delegate.suspendNetwork();
  }

  resumeDelegate(): void {
    this.delegate.resume();
  }

  async resume(): Promise<void> {
    await this.fetchAllUnreadCounts();
  }

  prepareForDeletion(): void {
    this.delegate.accountWillBeDeleted();
  }

  save(): void {
    this.opmlFile.save();
  }

  // MARK: - Feed and folder mutations (delegate passthrough)

  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    return await this.delegate.createFeed(url, name, container, validateFeed);
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    await this.delegate.addFeed(feed, container);
  }

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    await this.delegate.removeFeed(feed, container);
  }

  async moveFeed(feed: Feed, source: ContainerRef, destination: ContainerRef): Promise<void> {
    await this.delegate.moveFeed(feed, source, destination);
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    await this.delegate.renameFeed(feed, name);
  }

  async restoreFeed(feed: Feed, container: ContainerRef): Promise<void> {
    await this.delegate.restoreFeed(feed, container);
  }

  async addFolder(name: string): Promise<Folder> {
    return await this.delegate.createFolder(name);
  }

  async renameFolder(folder: Folder, name: string): Promise<void> {
    await this.delegate.renameFolder(folder, name);
  }

  async removeFolder(folder: Folder): Promise<void> {
    await this.delegate.removeFolder(folder);
  }

  async restoreFolder(folder: Folder): Promise<void> {
    await this.delegate.restoreFolder(folder);
  }

  async markArticles(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    await this.delegate.markArticles(articleIDs, statusKey, flag);
  }

  // MARK: - Feed settings

  private async populateFeedSettingsCache(): Promise<void> {
    const rows: Map<string, FeedSettingsRow> = await this.feedSettingsDatabase.allRows();
    rows.forEach((row: FeedSettingsRow, feedURL: string) => {
      const settings: FeedSettings = new FeedSettings(feedURL, row.feedID);
      settings.homePageURL = row.homePageURL;
      settings.iconURL = row.iconURL;
      settings.faviconURL = row.faviconURL;
      settings.editedName = row.editedName;
      settings.contentHash = row.contentHash;
      settings.newArticleNotificationsEnabled = row.newArticleNotificationsEnabled;
      settings.readerViewAlwaysEnabled = row.readerViewAlwaysEnabled;
      settings.authors = row.authors;
      settings.conditionalGetInfo = row.conditionalGetInfo;
      settings.conditionalGetInfoDate = row.conditionalGetInfoDate;
      settings.cacheControlInfo = row.cacheControlInfo;
      settings.externalID = row.externalID;
      settings.folderRelationship = row.folderRelationship;
      settings.lastCheckDate = row.lastCheckDate;
      settings.lastResponseCode = row.lastResponseCode;
      this.feedSettingsCache.set(feedURL, settings);
    });
  }

  feedSettings(feedURL: string, feedID: string): FeedSettings {
    const cached: FeedSettings | undefined = this.feedSettingsCache.get(feedURL);
    if (cached !== undefined) {
      return cached;
    }
    const settings: FeedSettings = new FeedSettings(feedURL, feedID);
    this.feedSettingsCache.set(feedURL, settings);
    return settings;
  }

  /**
   * The Swift FeedSettings wrote through to the database from every didSet. ArkTS models
   * carry plain fields, so the write-through is one explicit call after a mutation.
   */
  async persistFeedSettings(feed: Feed): Promise<void> {
    const settings: FeedSettings = feed.settings;
    const db: FeedSettingsDatabase = this.feedSettingsDatabase;
    await db.ensureFeedExists(settings.feedURL, settings.feedID);
    await db.setString(settings.feedID, settings.feedURL, FeedSettingsColumn.feedID);
    await db.setString(settings.homePageURL, settings.feedURL, FeedSettingsColumn.homePageURL);
    await db.setString(settings.iconURL, settings.feedURL, FeedSettingsColumn.iconURL);
    await db.setString(settings.faviconURL, settings.feedURL, FeedSettingsColumn.faviconURL);
    await db.setString(settings.editedName, settings.feedURL, FeedSettingsColumn.editedName);
    await db.setString(settings.contentHash, settings.feedURL, FeedSettingsColumn.contentHash);
    await db.setBool(settings.newArticleNotificationsEnabled, settings.feedURL,
      FeedSettingsColumn.newArticleNotificationsEnabled);
    await db.setBool(settings.readerViewAlwaysEnabled, settings.feedURL,
      FeedSettingsColumn.readerViewAlwaysEnabled);
    await db.setAuthors(settings.authors, settings.feedURL);
    await db.setConditionalGetInfo(settings.conditionalGetInfo, settings.feedURL);
    await db.setDate(settings.conditionalGetInfoDate, settings.feedURL,
      FeedSettingsColumn.conditionalGetInfoDate);
    await db.setCacheControlInfo(settings.cacheControlInfo, settings.feedURL);
    await db.setString(settings.externalID, settings.feedURL, FeedSettingsColumn.externalID);
    await db.setFolderRelationship(settings.folderRelationship, settings.feedURL);
    await db.setDate(settings.lastCheckDate, settings.feedURL, FeedSettingsColumn.lastCheckDate);
    await db.setInt(settings.lastResponseCode, settings.feedURL,
      FeedSettingsColumn.lastResponseCode);
  }

  /**
   * Call before permanently removing a feed, so the next feed created at this URL doesn't
   * inherit a stale feedID/externalID from the cache or the database.
   */
  clearFeedSettings(feed: Feed): void {
    this.feedSettingsCache.delete(feed.url);
    this.feedSettingsDatabase.deleteSettings(feed.url).catch((e: Object) => {
      hilog.error(DOMAIN, TAG, 'clearFeedSettings failed: %{public}s', String(e));
    });
  }

  // MARK: - Building feeds and folders

  createFeedWith(name: string | undefined, url: string, feedID: string,
    homePageURL: string | undefined): Feed {
    const settings: FeedSettings = this.feedSettings(url, feedID);
    // The caller's feedID is authoritative — repair a stored feedID that disagrees.
    if (settings.feedID !== feedID) {
      hilog.info(DOMAIN, TAG, 'repairing feedID for %{public}s', url);
      settings.feedID = feedID;
    }
    const feed: Feed = new Feed(this.accountID, url, settings);
    feed.name = name;
    feed.homePageURL = homePageURL;
    return feed;
  }

  newFeedWithOPMLFeedSpecifier(specifier: OPMLFeedSpecifier): Feed {
    const feedURL: string = specifier.feedURL;
    const settings: FeedSettings = this.feedSettings(feedURL, feedURL);
    const feed: Feed = new Feed(this.accountID, feedURL, settings);
    // Store as editedName so an imported title survives the next refresh.
    if (specifier.title !== undefined && feed.editedName === undefined) {
      feed.editedName = specifier.title;
    }
    return feed;
  }

  ensureFolder(name: string): Folder | undefined {
    if (name.length === 0) {
      return undefined;
    }
    const existing: Folder | undefined = this.existingFolderWithName(name);
    if (existing !== undefined) {
      return existing;
    }
    const folder: Folder = new Folder(this.accountID, name);
    const folders: Folder[] | undefined = this.model.folders;
    if (folders === undefined) {
      this.model.folders = [folder];
    } else {
      folders.push(folder);
    }
    this.structureDidChange();
    this.postChange(AccountChange.children);
    return folder;
  }

  ensureFolderWithFolderNames(folderNames: string[]): Folder | undefined {
    if (folderNames.length === 0) {
      return undefined;
    }
    // Sub-folders are not supported: take the last name.
    return this.ensureFolder(folderNames[folderNames.length - 1]);
  }

  addFolderToTree(folder: Folder): void {
    const folders: Folder[] | undefined = this.model.folders;
    if (folders === undefined) {
      this.model.folders = [folder];
    } else {
      folders.push(folder);
    }
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  removeFolderFromTree(folder: Folder): void {
    const folders: Folder[] | undefined = this.model.folders;
    if (folders !== undefined) {
      this.model.folders = folders.filter((candidate: Folder) => candidate !== folder);
    }
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  // MARK: - OPML

  addOPMLItems(items: OPMLItem[]): void {
    for (const item of items) {
      const specifier: OPMLFeedSpecifier | undefined = item.feedSpecifier;
      if (specifier !== undefined) {
        this.addFeedToTreeAtTopLevel(this.newFeedWithOPMLFeedSpecifier(specifier));
        continue;
      }
      const title: string | undefined = item.titleFromAttributes;
      if (title === undefined) {
        continue;
      }
      const folder: Folder | undefined = this.ensureFolder(title);
      if (folder === undefined) {
        continue;
      }
      const attributes: Map<string, string> | undefined = item.attributes;
      if (attributes !== undefined) {
        folder.externalID = attributes.get('nnw_externalID');
      }
      const children: OPMLItem[] | undefined = item.children;
      if (children !== undefined) {
        for (const child of children) {
          const childSpecifier: OPMLFeedSpecifier | undefined = child.feedSpecifier;
          if (childSpecifier !== undefined) {
            folder.addFeedToTreeAtTopLevel(this.newFeedWithOPMLFeedSpecifier(childSpecifier));
          }
        }
      }
    }
  }

  loadOPMLItems(items: OPMLItem[]): void {
    this.addOPMLItems(normalizeOPMLItems(items));
  }

  /** The account's OPML body — the tree the OPMLFile writes on every structure change. */
  opmlString(): string {
    let s: string = '';
    for (const feed of this.sortedTopLevelFeeds()) {
      s += opmlStringForFeed(feed.nameForDisplay, feed.homePageURL, feed.url, 1);
    }
    const folders: Folder[] | undefined = this.model.sortedFolders;
    if (folders !== undefined) {
      for (const folder of folders) {
        const childStrings: string[] = [];
        for (const feed of folder.sortedTopLevelFeeds()) {
          childStrings.push(opmlStringForFeed(feed.nameForDisplay, feed.homePageURL, feed.url, 2));
        }
        s += opmlStringForFolder(folder.nameForDisplay, folder.externalID, childStrings, 1, true);
      }
    }
    return s;
  }

  private sortedTopLevelFeeds(): Feed[] {
    const feeds: Feed[] = this.model.topLevelFeeds.slice();
    feeds.sort((a: Feed, b: Feed): number => a.nameForDisplay.localeCompare(b.nameForDisplay));
    return feeds;
  }

  // MARK: - Container

  flattenedFeeds(): Feed[] {
    if (this.flattenedFeedsCache === undefined) {
      this.flattenedFeedsCache = this.model.flattenedFeeds();
    }
    return this.flattenedFeedsCache;
  }

  flattenedFeedIDs(): string[] {
    return feedIDs(this.flattenedFeeds());
  }

  hasAtLeastOneFeed(): boolean {
    return this.model.topLevelFeeds.length > 0;
  }

  existingFeedWithFeedID(feedID: string): Feed | undefined {
    return this.idToFeedDictionary().get(feedID);
  }

  existingFeedWithExternalID(externalID: string): Feed | undefined {
    return this.externalIDToFeedDictionary().get(externalID);
  }

  existingFeedWithURL(url: string): Feed | undefined {
    for (const feed of this.flattenedFeeds()) {
      if (feed.url === url) {
        return feed;
      }
    }
    return undefined;
  }

  hasFeedWithURL(url: string): boolean {
    return this.existingFeedWithURL(url) !== undefined;
  }

  existingFolderWithName(name: string): Folder | undefined {
    const folders: Folder[] | undefined = this.model.folders;
    if (folders === undefined) {
      return undefined;
    }
    for (const folder of folders) {
      if (folder.name === name) {
        return folder;
      }
    }
    return undefined;
  }

  existingFolderWithDisplayName(displayName: string): Folder | undefined {
    const folders: Folder[] | undefined = this.model.folders;
    if (folders === undefined) {
      return undefined;
    }
    for (const folder of folders) {
      if (folder.nameForDisplay === displayName) {
        return folder;
      }
    }
    return undefined;
  }

  existingFolderWithExternalID(externalID: string): Folder | undefined {
    const folders: Folder[] | undefined = this.model.folders;
    if (folders === undefined) {
      return undefined;
    }
    for (const folder of folders) {
      if (folder.externalID === externalID) {
        return folder;
      }
    }
    return undefined;
  }

  folders(): Folder[] {
    const folders: Folder[] | undefined = this.model.folders;
    return folders === undefined ? [] : folders;
  }

  existingContainerWithExternalID(externalID: string): ContainerRef | undefined {
    if (this.externalID === externalID) {
      return ContainerRef.forAccount(this);
    }
    const folder: Folder | undefined = this.existingFolderWithExternalID(externalID);
    return folder === undefined ? undefined : ContainerRef.forFolder(this, folder);
  }

  /** Every container that currently holds this feed — the Dinosaurs delete path. */
  existingContainersWithFeed(feed: Feed): ContainerRef[] {
    const containers: ContainerRef[] = [];
    for (const candidate of this.model.topLevelFeeds) {
      if (candidate.equals(feed)) {
        containers.push(ContainerRef.forAccount(this));
        break;
      }
    }
    for (const folder of this.folders()) {
      if (folder.containsFeed(feed)) {
        containers.push(ContainerRef.forFolder(this, folder));
      }
    }
    return containers;
  }

  addFeedToTreeAtTopLevel(feed: Feed): void {
    for (const candidate of this.model.topLevelFeeds) {
      if (candidate.equals(feed)) {
        return;
      }
    }
    this.model.topLevelFeeds.push(feed);
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  addFeedIfNotInAnyFolder(feed: Feed): void {
    for (const candidate of this.flattenedFeeds()) {
      if (candidate.equals(feed)) {
        return;
      }
    }
    this.addFeedToTreeAtTopLevel(feed);
  }

  removeFeedFromTreeAtTopLevel(feed: Feed): void {
    this.model.topLevelFeeds =
      this.model.topLevelFeeds.filter((candidate: Feed) => !candidate.equals(feed));
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  removeFeedsFromTreeAtTopLevel(feeds: Feed[]): void {
    if (feeds.length === 0) {
      return;
    }
    for (const feed of feeds) {
      this.model.topLevelFeeds =
        this.model.topLevelFeeds.filter((candidate: Feed) => !candidate.equals(feed));
    }
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  removeAllInstancesOfFeedFromTreeAtAllLevels(feed: Feed): void {
    this.model.topLevelFeeds =
      this.model.topLevelFeeds.filter((candidate: Feed) => !candidate.equals(feed));
    for (const folder of this.folders()) {
      folder.removeFeedFromTreeAtTopLevel(feed);
    }
    this.structureDidChange();
    this.postChange(AccountChange.children);
  }

  structureDidChange(): void {
    this.opmlFile.markAsDirty();
    this.flattenedFeedsCache = undefined;
    this.idToFeedCache = undefined;
    this.externalIDToFeedCache = undefined;
  }

  private idToFeedDictionary(): Map<string, Feed> {
    if (this.idToFeedCache === undefined) {
      this.rebuildFeedDictionaries();
    }
    return this.idToFeedCache as Map<string, Feed>;
  }

  private externalIDToFeedDictionary(): Map<string, Feed> {
    if (this.externalIDToFeedCache === undefined) {
      this.rebuildFeedDictionaries();
    }
    return this.externalIDToFeedCache as Map<string, Feed>;
  }

  private rebuildFeedDictionaries(): void {
    const byID: Map<string, Feed> = new Map<string, Feed>();
    const byExternalID: Map<string, Feed> = new Map<string, Feed>();
    for (const feed of this.flattenedFeeds()) {
      byID.set(feed.feedID, feed);
      const externalID: string | undefined = feed.externalID;
      if (externalID !== undefined) {
        byExternalID.set(externalID, feed);
      }
    }
    this.idToFeedCache = byID;
    this.externalIDToFeedCache = byExternalID;
  }

  // MARK: - Fetching articles

  /** The one read path behind every timeline and smart feed. */
  async fetchArticles(fetchType: FetchType): Promise<Article[]> {
    const kind: FetchTypeKind = fetchType.kind;
    if (kind === FetchTypeKind.starred) {
      return await this.database.fetchStarredArticles(this.flattenedFeedIDs(), fetchType.limit);
    }
    if (kind === FetchTypeKind.unread) {
      const articles: Article[] =
        await this.database.fetchUnreadArticles(this.flattenedFeedIDs(), fetchType.limit);
      if (fetchType.limit === undefined) {
        this.validateUnreadCounts(this.flattenedFeeds(), articles);
      }
      return articles;
    }
    if (kind === FetchTypeKind.today) {
      return await this.database.fetchTodayArticles(this.flattenedFeedIDs(), fetchType.limit);
    }
    if (kind === FetchTypeKind.folder) {
      const folder: Folder | undefined = fetchType.folder;
      if (folder === undefined) {
        return [];
      }
      const feeds: Feed[] = folder.flattenedFeeds();
      const readFilter: boolean = fetchType.folderFlag === true;
      const articles: Article[] = readFilter
        ? await this.database.fetchUnreadArticles(feedIDs(feeds))
        : await this.database.fetchArticles(feedIDs(feeds));
      this.validateUnreadCounts(feeds, articles);
      return articles;
    }
    if (kind === FetchTypeKind.feed) {
      const feed: Feed | undefined = fetchType.feed;
      if (feed === undefined) {
        return [];
      }
      const articles: Article[] = await this.database.fetchArticlesForFeedID(feed.feedID);
      await this.validateUnreadCountForFeed(feed, articles);
      return articles;
    }
    if (kind === FetchTypeKind.articleIDs) {
      const articleIDs: string[] | undefined = fetchType.articleIDs;
      return articleIDs === undefined
        ? [] : await this.database.fetchArticlesWithArticleIDs(articleIDs);
    }
    if (kind === FetchTypeKind.search) {
      const searchString: string | undefined = fetchType.searchString;
      return searchString === undefined
        ? [] : await this.database.fetchArticlesMatching(searchString, this.flattenedFeedIDs());
    }
    const searchString: string | undefined = fetchType.searchString;
    const articleIDs: string[] | undefined = fetchType.articleIDs;
    if (searchString === undefined || articleIDs === undefined) {
      return [];
    }
    return await this.database.fetchArticlesMatchingWithArticleIDs(searchString, articleIDs);
  }

  async fetchArticleCounts(): Promise<ArticleCounts> {
    return await this.database.fetchArticleCounts(this.flattenedFeedIDs());
  }

  async fetchLastUpdateDates(): Promise<Map<string, Date>> {
    return await this.database.fetchLastUpdateDates();
  }

  async fetchCountForStarredArticles(): Promise<number> {
    return await this.database.fetchStarredArticlesCount(this.flattenedFeedIDs());
  }

  async fetchCountForTodayArticles(): Promise<number> {
    return await this.database.fetchTodayArticlesCount(this.flattenedFeedIDs());
  }

  async fetchUnreadCountForToday(): Promise<number> {
    return await this.database.fetchUnreadCountForToday(this.flattenedFeedIDs());
  }

  async fetchUnreadCountForStarredArticles(): Promise<number> {
    return await this.database.fetchUnreadCountForStarredArticles(this.flattenedFeedIDs());
  }

  async fetchUnreadArticleIDs(): Promise<Set<string>> {
    return new Set<string>(await this.database.fetchUnreadArticleIDs());
  }

  async fetchStarredArticleIDs(): Promise<Set<string>> {
    return new Set<string>(await this.database.fetchStarredArticleIDs());
  }

  /** ArticleIDs we should have but don't: starred, or newer than the article cutoff. */
  async fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate(): Promise<Set<string>> {
    return new Set<string>(
      await this.database.fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate());
  }

  // MARK: - Updating articles

  /** Local / iCloud accounts only: one feed's parsed items. */
  async updateFeedWithParsedFeed(feed: Feed, parsedFeed: ParsedFeed): Promise<ArticleChanges> {
    takeFeedSettingsFromParsedFeed(feed, parsedFeed);
    await this.persistFeedSettings(feed);
    const items: ParsedItem[] = parsedFeed.items;
    if (items.length === 0) {
      return new ArticleChanges();
    }
    return await this.updateFeedIDWithParsedItems(feed.feedID, items, true);
  }

  async updateFeedIDWithParsedItems(feedID: string, parsedItems: ParsedItem[],
    deleteOlder: boolean = true): Promise<ArticleChanges> {
    const changes: ArticleChanges =
      await this.database.updateParsedItems(parsedItems, feedID, deleteOlder);
    await this.sendNotificationAbout(changes);
    return changes;
  }

  /** Syncing accounts only: many feeds at once. */
  async updateFeedIDsAndItems(feedIDsAndItems: Map<string, ParsedItem[]>,
    defaultRead: boolean): Promise<ArticleChanges> {
    if (feedIDsAndItems.size === 0) {
      return new ArticleChanges();
    }
    const changes: ArticleChanges =
      await this.database.updateFeedIDsAndItems(feedIDsAndItems, defaultRead);
    await this.sendNotificationAbout(changes);
    return changes;
  }

  /** Marks statuses; returns the articleIDs whose status actually changed. */
  async updateStatuses(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<string[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    const changed: string[] = await this.database.mark(articleIDs, statusKey, flag);
    if (changed.length === 0) {
      return [];
    }
    await this.noteStatusesDidChange(changed, statusKey, flag);
    return changed;
  }

  async createStatusesIfNeeded(articleIDs: string[]): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    await this.database.createStatusesIfNeeded(articleIDs);
    await this.noteStatusesDidChange();
  }

  async markAndFetchNew(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<string[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    const newStatusIDs: string[] =
      await this.database.markAndFetchNew(articleIDs, statusKey, flag);
    await this.noteStatusesDidChange(articleIDs, statusKey, flag);
    return newStatusIDs;
  }

  async markAsRead(articleIDs: Set<string>): Promise<string[]> {
    return await this.markAndFetchNew(this.idArray(articleIDs), ArticleStatusKey.read, true);
  }

  async markAsUnread(articleIDs: Set<string>): Promise<string[]> {
    return await this.markAndFetchNew(this.idArray(articleIDs), ArticleStatusKey.read, false);
  }

  async markAsStarred(articleIDs: Set<string>): Promise<string[]> {
    return await this.markAndFetchNew(this.idArray(articleIDs), ArticleStatusKey.starred, true);
  }

  async markAsUnstarred(articleIDs: Set<string>): Promise<string[]> {
    return await this.markAndFetchNew(this.idArray(articleIDs), ArticleStatusKey.starred, false);
  }

  async deleteArticles(articleIDs: string[]): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    await this.database.deleteArticles(articleIDs);
  }

  private idArray(ids: Set<string>): string[] {
    const out: string[] = [];
    ids.forEach((id: string) => out.push(id));
    return out;
  }

  /**
   * The source has two overloads (Account.swift:1485/1490): one posts .StatusesDidChange with
   * userInfo[articleIDs/statusKey/statusFlag], one posts articleIDs alone. AccountChange has no
   * payload, so — as with .AccountDidDownloadArticles below — the one listener that needs it is
   * called directly, and the payload-less callers simply pass nothing.
   */
  private async noteStatusesDidChange(articleIDs?: string[], statusKey?: ArticleStatusKey,
    flag?: boolean): Promise<void> {
    await this.fetchAllUnreadCounts();
    this.postChange(AccountChange.statuses);
    if (articleIDs !== undefined && statusKey !== undefined && flag !== undefined) {
      await UserNotificationManager.shared.statusesDidChange(articleIDs, statusKey, flag);
    }
  }

  private async sendNotificationAbout(changes: ArticleChanges): Promise<void> {
    const hasNew: boolean = changes.newArticles.length > 0;
    const hasUpdated: boolean = changes.updatedArticles.length > 0;
    const hasDeleted: boolean = changes.deletedArticles.length > 0;
    if (hasNew || hasDeleted) {
      await this.fetchAllUnreadCounts();
    }
    if (hasNew || hasUpdated) {
      this.postChange(AccountChange.articlesDownloaded);
    }
    if (hasNew) {
      // .AccountDidDownloadArticles carried userInfo[newArticles] to
      // UserNotificationManager's observer (UserNotificationManager.swift:33); AccountChange
      // has no payload, so the one listener that needs the articles is called directly.
      await UserNotificationManager.shared.accountDidDownloadArticles(changes.newArticles);
    }
  }

  // MARK: - Unread counts

  unreadCountForFeed(feed: Feed): number {
    return this.model.unreadCountFor(feed);
  }

  async updateUnreadCountsForFeeds(feeds: Feed[]): Promise<void> {
    if (feeds.length === 0) {
      return;
    }
    if (feeds.length >= 10) {
      await this.fetchAllUnreadCounts();
      return;
    }
    const counts: UnreadCountDictionary =
      await this.database.fetchUnreadCounts(feedIDs(feeds));
    this.processUnreadCounts(counts, feeds);
    this.updateUnreadCount();
  }

  async fetchAllUnreadCounts(): Promise<void> {
    this.fetchingAllUnreadCounts = true;
    try {
      const counts: UnreadCountDictionary = await this.database.fetchAllUnreadCounts();
      this.processUnreadCounts(counts, this.flattenedFeeds());
    } finally {
      this.fetchingAllUnreadCounts = false;
    }
    this.updateUnreadCount();
    if (!this.model.areUnreadCountsInitialized) {
      this.model.areUnreadCountsInitialized = true;
      this.postChange(AccountChange.unreadCountDidInitialize);
    }
  }

  get areUnreadCountsInitialized(): boolean {
    return this.model.areUnreadCountsInitialized;
  }

  private processUnreadCounts(counts: UnreadCountDictionary, feeds: Feed[]): void {
    for (const feed of feeds) {
      const count: number | undefined = counts.get(feed.feedID);
      this.model.setUnreadCountFor(count === undefined ? 0 : count, feed);
    }
    for (const folder of this.folders()) {
      folder.updateUnreadCount();
    }
  }

  private updateUnreadCount(): void {
    if (this.fetchingAllUnreadCounts) {
      return;
    }
    let updated: number = 0;
    for (const feed of this.flattenedFeeds()) {
      updated += feed.unreadCount;
    }
    if (updated !== this.model.unreadCount) {
      this.model.unreadCount = updated;
      this.postChange(AccountChange.unreadCount);
    }
  }

  /** One pass over the articles, as the source's optimized version does. */
  private validateUnreadCounts(feeds: Feed[], articles: Article[]): void {
    const storage: Map<string, number> = new Map<string, number>();
    for (const article of articles) {
      if (!article.status.read) {
        const current: number | undefined = storage.get(article.feedID);
        storage.set(article.feedID, current === undefined ? 1 : current + 1);
      }
    }
    for (const feed of feeds) {
      const count: number | undefined = storage.get(feed.feedID);
      feed.unreadCount = count === undefined ? 0 : count;
    }
  }

  private async validateUnreadCountForFeed(feed: Feed, articles: Article[]): Promise<void> {
    let unreadCount: number = 0;
    for (const article of articles) {
      if (article.feedID === feed.feedID && !article.status.read) {
        unreadCount += 1;
      }
    }
    // Disagreement means some status rows are stale (a lost write) — repair them.
    if (unreadCount !== feed.unreadCount) {
      await this.database.repairStatuses();
    }
    feed.unreadCount = unreadCount;
  }

  // MARK: - Maintenance

  async repairStatuses(): Promise<void> {
    await this.database.repairStatuses();
  }

  async vacuumDatabases(): Promise<void> {
    const dbActivity: number = this.logActivityStart(ActivityKindType.vacuumDatabase,
      'DB.sqlite3');
    await this.database.vacuum();
    this.logActivityComplete(dbActivity);

    const settingsActivity: number = this.logActivityStart(ActivityKindType.vacuumDatabase,
      'FeedSettings.db');
    await this.feedSettingsDatabase.vacuum();
    this.logActivityComplete(settingsActivity);

    await this.delegate.vacuumDatabases();
  }

  emptyCaches(): void {
    this.database.emptyCaches();
  }

  /** Total on-disk size of this account's databases — the Account Stats row. */
  databaseSizeBytes(): number {
    const names: string[] = ['DB.sqlite3', 'FeedSettings.db', 'Sync.sqlite3'];
    let total: number = 0;
    for (const name of names) {
      // relationalStore keeps the file under <databaseDir>/rdb/<accountFolder>, not at the
      // path the store was opened with — statting dataFolder always reported 0 bytes.
      const path: string = Database.storeFolder(this.dataFolder + '/' + name) + '/' + name;
      try {
        if (fs.accessSync(path)) {
          total += fs.statSync(path).size;
        }
      } catch (e) {
        hilog.debug(DOMAIN, TAG, 'databaseSizeBytes: %{public}s', String(e));
      }
    }
    return total;
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  get typeDisplayName(): string {
    return accountTypeDisplayName(this.type);
  }

  /** The Accounts folder this account's data folder lives in. */
  static accountsFolder(): string {
    return AppContext.dataSubfolder('Accounts');
  }
}
