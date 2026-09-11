/**
 * AccountManager — port of Modules/Account/Sources/Account/AccountManager.swift
 *
 * Owns every account: reads them off disk, creates and deletes them, drives refreshAll /
 * sendArticleStatusAll, aggregates the unread count and the combined refresh progress, and
 * runs the hourly status repair.
 *
 * It is also the resolver the model layer needs: Feed and Folder carry only an accountID
 * (models hold no back-references), so `accountForFeed` / `accountForArticle` live here.
 *
 * NSUbiquitousKeyValueStore has no HarmonyOS counterpart, so the
 * syncArticleContentForUnreadArticles setting is a local preference only.
 */

import fs from '@ohos.file.fs';
import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountType } from '../../model/AccountType';
import { Article } from '../../model/Article';
import { ContainerIdentifier, ContainerIdentifierType } from '../../model/ContainerIdentifier';
import { Feed } from '../../model/Feed';
import { FetchType } from '../../model/FetchType';
import { Folder } from '../../model/Folder';
import { ProgressInfo } from '../../model/ProgressInfo';
import { SidebarItemIdentifier, SidebarItemIdentifierType } from '../../model/SidebarItemIdentifier';
import { ErrorLogDatabase } from '../db/ErrorLogDatabase';
import { AppDefaults } from '../prefs/AppDefaults';
import { AppContext } from '../util/AppContext';
import { AccountChange, AccountChangeListener, AccountService, ContainerRef } from './Account';
import { CombinedRefreshProgress } from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'AccountManager';

export const netNewsWireNewsURL: string = 'https://netnewswire.blog/feed.xml';
const jsonNetNewsWireNewsURL: string = 'https://netnewswire.blog/feed.json';

const defaultAccountFolderName: string = 'OnMyMac';
const defaultAccountIdentifier: string = 'OnMyMac';
const statusRepairIntervalMillis: number = 60 * 60 * 1000;

export const syncArticleContentForUnreadArticlesKey: string =
  'iCloudSyncArticleContentForUnreadArticles';

export type AccountManagerChangeListener = (change: AccountChange,
  account?: AccountService) => void;

/** One account folder on disk: `<rawType>_<accountID>`. */
class AccountSpecifier {
  readonly type: AccountType;
  readonly identifier: string;
  readonly folderPath: string;

  private constructor(type: AccountType, identifier: string, folderPath: string) {
    this.type = type;
    this.identifier = identifier;
    this.folderPath = folderPath;
  }

  static fromFolder(folderPath: string, folderName: string): AccountSpecifier | undefined {
    if (folderName.startsWith('.')) {
      return undefined;
    }
    const components: string[] = folderName.split('_');
    if (components.length !== 2) {
      return undefined;
    }
    const rawType: number = Number.parseInt(components[0], 10);
    if (Number.isNaN(rawType) || !isKnownAccountTypeRawValue(rawType)) {
      return undefined;
    }
    return new AccountSpecifier(rawType as AccountType, components[1], folderPath);
  }
}

function isKnownAccountTypeRawValue(rawValue: number): boolean {
  return rawValue === AccountType.onMyMac || rawValue === AccountType.cloudKit
    || rawValue === AccountType.feedly || rawValue === AccountType.feedbin
    || rawValue === AccountType.newsBlur || rawValue === AccountType.freshRSS
    || rawValue === AccountType.inoreader || rawValue === AccountType.bazQux
    || rawValue === AccountType.theOldReader;
}

export class AccountManager {
  static readonly shared: AccountManager = new AccountManager();

  readonly errorLogDatabase: ErrorLogDatabase = ErrorLogDatabase.shared;

  private accountsFolder: string = '';
  private accountsDictionary: Map<string, AccountService> = new Map<string, AccountService>();
  private defaultAccountValue?: AccountService;
  private listeners: AccountManagerChangeListener[] = [];
  private lastStatusRepairDate?: Date;
  /** The in-flight (or finished) start(); doubles as the run-once flag. */
  private startPromise?: Promise<void>;

  unreadCount: number = 0;
  isSuspended: boolean = false;

  /**
   * Account.init is async here (databases, OPML), so the manager has an explicit start()
   * instead of Swift's init. The local "On My iPhone" account must always exist.
   *
   * Returns the IN-FLIGHT start when one is already running, so a caller that arrives
   * mid-bootstrap waits for the accounts instead of reading an empty dictionary. A screen
   * opened by deep link runs its aboutToAppear long before EntryAbility.onCreate's
   * bootstrap has finished; with a plain boolean guard those screens saw zero accounts and
   * never refreshed again (Account Stats rendered no rows at all).
   */
  start(): Promise<void> {
    let pending: Promise<void> | undefined = this.startPromise;
    if (pending === undefined) {
      pending = this.runStart();
      this.startPromise = pending;
    }
    return pending;
  }

  private async runStart(): Promise<void> {
    this.accountsFolder = AppContext.dataSubfolder('Accounts');
    const localAccountFolder: string = this.accountsFolder + '/' + defaultAccountFolderName;
    AppContext.ensureFolder(localAccountFolder);

    await ErrorLogDatabase.shared.open();

    const defaultAccount: AccountService = new AccountService(defaultAccountIdentifier,
      AccountType.onMyMac, localAccountFolder);
    this.defaultAccountValue = defaultAccount;
    this.attach(defaultAccount);
    await defaultAccount.open();

    await this.readAccountsFromDisk();
    this.updateUnreadCount();
  }

  get defaultAccount(): AccountService {
    return this.defaultAccountValue as AccountService;
  }

  get accounts(): AccountService[] {
    const out: AccountService[] = [];
    this.accountsDictionary.forEach((account: AccountService) => out.push(account));
    return out;
  }

  get sortedAccounts(): AccountService[] {
    return this.sortByName(this.accounts);
  }

  get activeAccounts(): AccountService[] {
    return this.accounts.filter((account: AccountService) => account.isActive);
  }

  get sortedActiveAccounts(): AccountService[] {
    return this.sortByName(this.activeAccounts);
  }

  get iCloudAccount(): AccountService | undefined {
    for (const account of this.accounts) {
      if (account.type === AccountType.cloudKit) {
        return account;
      }
    }
    return undefined;
  }

  get hasiCloudAccount(): boolean {
    return this.iCloudAccount !== undefined;
  }

  get areUnreadCountsInitialized(): boolean {
    for (const account of this.activeAccounts) {
      if (!account.areUnreadCountsInitialized) {
        return false;
      }
    }
    return true;
  }

  get refreshInProgress(): boolean {
    for (const account of this.activeAccounts) {
      if (account.refreshInProgress) {
        return true;
      }
    }
    return false;
  }

  get lastRefreshCompletedDate(): Date | undefined {
    let latest: Date | undefined = undefined;
    for (const account of this.activeAccounts) {
      const date: Date | undefined = account.lastRefreshCompletedDate;
      if (date !== undefined && (latest === undefined || latest.getTime() < date.getTime())) {
        latest = date;
      }
    }
    return latest;
  }

  get syncArticleContentForUnreadArticles(): boolean {
    return AppDefaults.boolValue(syncArticleContentForUnreadArticlesKey);
  }

  set syncArticleContentForUnreadArticles(value: boolean) {
    AppDefaults.setBool(syncArticleContentForUnreadArticlesKey, value);
  }

  // MARK: - Listeners

  addListener(listener: AccountManagerChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: AccountManagerChangeListener): void {
    this.listeners = this.listeners.filter((l: AccountManagerChangeListener) => l !== listener);
  }

  private post(change: AccountChange, account?: AccountService): void {
    for (const listener of this.listeners) {
      listener(change, account);
    }
  }

  private attach(account: AccountService): void {
    this.accountsDictionary.set(account.accountID, account);
    const listener: AccountChangeListener = (change: AccountChange,
      changed: AccountService): void => {
      if (change === AccountChange.unreadCount || change === AccountChange.state
        || change === AccountChange.unreadCountDidInitialize) {
        this.updateUnreadCount();
      }
      if (change === AccountChange.progress) {
        this.updateCombinedProgress();
      }
      this.post(change, changed);
    };
    account.addListener(listener);
  }

  // MARK: - API

  /** Creates and opens an account. iCloud is single-instance, as in the source. */
  async createAccount(type: AccountType): Promise<AccountService> {
    if (type === AccountType.cloudKit) {
      const existing: AccountService | undefined = this.iCloudAccount;
      if (existing !== undefined) {
        return existing;
      }
    }

    const accountID: string = type === AccountType.cloudKit ? 'iCloud'
      : util.generateRandomUUID(true);
    const accountFolder: string = this.accountsFolder + '/' + (type as number) + '_' + accountID;
    AppContext.ensureFolder(accountFolder);

    const account: AccountService = new AccountService(accountID, type, accountFolder);
    this.attach(account);
    await account.open();

    this.post(AccountChange.state, account);
    return account;
  }

  async deleteAccount(account: AccountService): Promise<void> {
    if (account.refreshInProgress) {
      return;
    }

    account.prepareForDeletion();
    account.deleteSettings();
    await account.close();

    this.accountsDictionary.delete(account.accountID);
    account.isDeleted = true;

    try {
      fs.rmdirSync(account.dataFolder);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'deleteAccount: %{public}s', String(e));
    }

    this.updateUnreadCount();
    this.post(AccountChange.state, account);
  }

  /** Self-hosted services can have the same username on different servers. */
  duplicateServiceAccount(type: AccountType, username?: string, endpoint?: string): boolean {
    if (type === AccountType.onMyMac) {
      return false;
    }
    for (const account of this.accounts) {
      if (account.type === type && username === account.username) {
        const existingEndpoint: string | undefined = account.endpointURL;
        if (endpoint !== undefined && existingEndpoint !== undefined
          && endpoint !== existingEndpoint) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  existingAccount(accountID: string): AccountService | undefined {
    return this.accountsDictionary.get(accountID);
  }

  existingActiveAccountForDisplayName(displayName: string): AccountService | undefined {
    for (const account of this.activeAccounts) {
      if (account.nameForDisplay === displayName) {
        return account;
      }
    }
    return undefined;
  }

  existingContainer(containerID: ContainerIdentifier): ContainerRef | undefined {
    const accountID: string | undefined = containerID.accountID;
    if (accountID === undefined) {
      return undefined;
    }
    const account: AccountService | undefined = this.existingAccount(accountID);
    if (account === undefined) {
      return undefined;
    }
    if (containerID.type === ContainerIdentifierType.account) {
      return ContainerRef.forAccount(account);
    }
    if (containerID.type === ContainerIdentifierType.folder) {
      const folderName: string | undefined = containerID.folderName;
      if (folderName === undefined) {
        return undefined;
      }
      const folder: Folder | undefined = account.existingFolderWithName(folderName);
      return folder === undefined ? undefined : ContainerRef.forFolder(account, folder);
    }
    return undefined;
  }

  existingFeedWithSidebarItemID(sidebarItemID: SidebarItemIdentifier): Feed | undefined {
    if (sidebarItemID.type !== SidebarItemIdentifierType.feed) {
      return undefined;
    }
    const accountID: string | undefined = sidebarItemID.accountID;
    const feedID: string | undefined = sidebarItemID.feedID;
    if (accountID === undefined || feedID === undefined) {
      return undefined;
    }
    const account: AccountService | undefined = this.existingAccount(accountID);
    return account === undefined ? undefined : account.existingFeedWithFeedID(feedID);
  }

  existingFolderWithSidebarItemID(sidebarItemID: SidebarItemIdentifier): Folder | undefined {
    if (sidebarItemID.type !== SidebarItemIdentifierType.folder) {
      return undefined;
    }
    const accountID: string | undefined = sidebarItemID.accountID;
    const folderName: string | undefined = sidebarItemID.folderName;
    if (accountID === undefined || folderName === undefined) {
      return undefined;
    }
    const account: AccountService | undefined = this.existingAccount(accountID);
    return account === undefined ? undefined : account.existingFolderWithName(folderName);
  }

  // MARK: - Model back-reference resolution

  /** Feed holds only accountID — this is Swift's `feed.account`. */
  accountForFeed(feed: Feed): AccountService | undefined {
    return this.existingAccount(feed.accountID);
  }

  /** Folder holds only accountID — this is Swift's `folder.account`. */
  accountForFolder(folder: Folder): AccountService | undefined {
    return this.existingAccount(folder.accountID);
  }

  /** Article.account (DataExtensions.swift). */
  accountForArticle(article: Article): AccountService | undefined {
    return this.existingAccount(article.accountID);
  }

  /** Article.feed (DataExtensions.swift). */
  feedForArticle(article: Article): Feed | undefined {
    const account: AccountService | undefined = this.accountForArticle(article);
    return account === undefined ? undefined : account.existingFeedWithFeedID(article.feedID);
  }

  containersForFeed(feed: Feed): ContainerRef[] {
    const account: AccountService | undefined = this.accountForFeed(feed);
    return account === undefined ? [] : account.existingContainersWithFeed(feed);
  }

  // MARK: - Lifecycle

  suspendNetworkAll(): void {
    this.isSuspended = true;
    for (const account of this.accounts) {
      account.suspendNetwork();
    }
  }

  async resumeAll(): Promise<void> {
    this.isSuspended = false;
    for (const account of this.accounts) {
      account.resumeDelegate();
    }
    for (const account of this.accounts) {
      await account.resume();
    }
  }

  async receiveRemoteNotification(userInfo: Map<string, string>): Promise<void> {
    for (const account of this.activeAccounts) {
      await account.receiveRemoteNotification(userInfo);
    }
  }

  /** Refreshes every active account, reporting combined progress. */
  async refreshAll(errorHandler?: (error: Error) => void): Promise<void> {
    CombinedRefreshProgress.shared.start();
    try {
      const refreshes: Promise<void>[] = [];
      for (const account of this.activeAccounts) {
        refreshes.push(this.refreshOne(account, errorHandler));
      }
      await Promise.all(refreshes);
    } finally {
      CombinedRefreshProgress.shared.stop();
    }
  }

  private async refreshOne(account: AccountService,
    errorHandler?: (error: Error) => void): Promise<void> {
    try {
      await account.refreshAll();
    } catch (e) {
      if (errorHandler !== undefined) {
        errorHandler(e as Error);
      } else {
        hilog.error(DOMAIN, TAG, 'refreshAll: %{public}s', String(e));
      }
    }
  }

  async sendArticleStatusAll(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const account of this.activeAccounts) {
      sends.push(this.sendOne(account));
    }
    await Promise.all(sends);
  }

  private async sendOne(account: AccountService): Promise<void> {
    try {
      await account.sendArticleStatus();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'sendArticleStatus: %{public}s', String(e));
    }
  }

  /** True when any account reported meaningful work this round. */
  async syncArticleStatusAll(): Promise<boolean> {
    const syncs: Promise<boolean>[] = [];
    for (const account of this.activeAccounts) {
      syncs.push(this.syncOne(account));
    }
    const results: boolean[] = await Promise.all(syncs);
    for (const didWork of results) {
      if (didWork) {
        return true;
      }
    }
    return false;
  }

  private async syncOne(account: AccountService): Promise<boolean> {
    try {
      return await account.syncArticleStatus();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'syncArticleStatus: %{public}s', String(e));
      return false;
    }
  }

  saveAll(): void {
    for (const account of this.accounts) {
      account.save();
    }
  }

  /** Repairs article statuses in every active account, at most once an hour. */
  async repairStatusesIfNeeded(): Promise<void> {
    const last: Date | undefined = this.lastStatusRepairDate;
    if (last !== undefined && Date.now() - last.getTime() < statusRepairIntervalMillis) {
      return;
    }
    this.lastStatusRepairDate = new Date();
    for (const account of this.activeAccounts) {
      await account.repairStatuses();
    }
  }

  anyAccountHasAtLeastOneFeed(): boolean {
    for (const account of this.activeAccounts) {
      if (account.hasAtLeastOneFeed()) {
        return true;
      }
    }
    return false;
  }

  anyAccountHasFeedWithURL(urlString: string): boolean {
    for (const account of this.activeAccounts) {
      if (account.existingFeedWithURL(urlString) !== undefined) {
        return true;
      }
    }
    return false;
  }

  anyAccountHasNetNewsWireNewsSubscription(): boolean {
    return this.anyAccountHasFeedWithURL(netNewsWireNewsURL)
      || this.anyAccountHasFeedWithURL(jsonNetNewsWireNewsURL);
  }

  // MARK: - Fetching articles across accounts

  async fetchArticles(fetchType: FetchType): Promise<Article[]> {
    const all: Article[] = [];
    for (const account of this.activeAccounts) {
      const articles: Article[] = await account.fetchArticles(fetchType);
      for (const article of articles) {
        all.push(article);
      }
    }
    return all;
  }

  async fetchArticle(accountID: string, articleID: string): Promise<Article | undefined> {
    const account: AccountService | undefined = this.existingAccount(accountID);
    if (account === undefined) {
      return undefined;
    }
    const articles: Article[] = await account.fetchArticles(FetchType.forArticleIDs([articleID]));
    return articles.length === 0 ? undefined : articles[0];
  }

  async fetchCountForStarredArticles(): Promise<number> {
    let count: number = 0;
    for (const account of this.activeAccounts) {
      count += await account.fetchCountForStarredArticles();
    }
    return count;
  }

  async fetchCountForTodayArticles(): Promise<number> {
    let count: number = 0;
    for (const account of this.activeAccounts) {
      count += await account.fetchCountForTodayArticles();
    }
    return count;
  }

  async fetchUnreadCountForToday(): Promise<number> {
    let count: number = 0;
    for (const account of this.activeAccounts) {
      count += await account.fetchUnreadCountForToday();
    }
    return count;
  }

  async fetchUnreadCountForStarredArticles(): Promise<number> {
    let count: number = 0;
    for (const account of this.activeAccounts) {
      count += await account.fetchUnreadCountForStarredArticles();
    }
    return count;
  }

  // MARK: - Maintenance

  async vacuumAccountDatabases(): Promise<void> {
    for (const account of this.accounts) {
      await account.vacuumDatabases();
    }
    await ErrorLogDatabase.shared.vacuum();
  }

  emptyCaches(): void {
    for (const account of this.accounts) {
      account.emptyCaches();
    }
  }

  // MARK: - Private

  private updateUnreadCount(): void {
    let updated: number = 0;
    for (const account of this.activeAccounts) {
      updated += account.unreadCount;
    }
    if (updated !== this.unreadCount) {
      this.unreadCount = updated;
      this.post(AccountChange.unreadCount);
    }
  }

  private updateCombinedProgress(): void {
    const progressInfos: ProgressInfo[] = [];
    for (const account of this.activeAccounts) {
      progressInfos.push(account.progressInfo);
    }
    CombinedRefreshProgress.shared.update(progressInfos);
  }

  private async readAccountsFromDisk(): Promise<void> {
    let fileNames: string[] = [];
    try {
      fileNames = fs.listFileSync(this.accountsFolder);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'Error reading Accounts folder: %{public}s', String(e));
      return;
    }
    fileNames.sort();

    for (const fileName of fileNames) {
      if (fileName === defaultAccountFolderName) {
        continue;
      }
      const folderPath: string = this.accountsFolder + '/' + fileName;
      const specifier: AccountSpecifier | undefined =
        AccountSpecifier.fromFolder(folderPath, fileName);
      if (specifier === undefined) {
        continue;
      }
      const account: AccountService = new AccountService(specifier.identifier, specifier.type,
        specifier.folderPath);
      if (this.duplicateServiceAccount(account.type, account.username, account.endpointURL)) {
        continue;
      }
      this.attach(account);
      try {
        await account.open();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'Failed to open account %{public}s: %{public}s',
          specifier.identifier, String(e));
      }
    }
  }

  /** The local account sorts first; the rest by display name. */
  private sortByName(accounts: AccountService[]): AccountService[] {
    const sorted: AccountService[] = accounts.slice();
    const defaultAccount: AccountService | undefined = this.defaultAccountValue;
    sorted.sort((a: AccountService, b: AccountService): number => {
      if (defaultAccount !== undefined) {
        if (a === defaultAccount) {
          return -1;
        }
        if (b === defaultAccount) {
          return 1;
        }
      }
      return a.nameForDisplay.localeCompare(b.nameForDisplay);
    });
    return sorted;
  }
}
