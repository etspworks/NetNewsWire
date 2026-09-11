/**
 * NewsBlurAccountDelegate — port of
 * Modules/Account/Sources/Account/NewsBlur/{NewsBlurAccountDelegate,
 * Internals/NewsBlurAccountDelegate+Internal}.swift plus the whole Modules/NewsBlur
 * package (NewsBlurAPICaller and its request bodies).
 *
 * AccountType.newsBlur, session-cookie auth against https://www.newsblur.com/.
 *
 * The quirk travels with it: NewsBlurAccountDelegate.swift:52 points its SyncDatabase at
 * "DB.sqlite3", the SAME file ArticlesDatabase uses — every other delegate uses its own
 * Sync.sqlite3. Reproduced verbatim; the syncStatus table just lives in the articles store.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { ActivityKindType } from '../../model/Activity';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Credentials, CredentialsType } from '../../model/Credentials';
import { DownloadResponse } from '../../model/DownloadResponse';
import { Feed } from '../../model/Feed';
import { Folder } from '../../model/Folder';
import {
  NewsBlurFeed, NewsBlurFeedWire, NewsBlurFeedsResponse, NewsBlurFolder,
  NewsBlurFolderRelationship, newsBlurFeedFromJSON, newsBlurFolderRelationships,
  visibleNewsBlurFeeds
} from '../../model/NewsBlurFeed';
import { NewsBlurStory, NewsBlurStoryWire, newsBlurStoryFromJSON } from '../../model/NewsBlurStory';
import { ParsedAuthor } from '../../model/ParsedAuthor';
import { ParsedItem } from '../../model/ParsedItem';
import { ProgressInfo } from '../../model/ProgressInfo';
import { SyncStatus, SyncStatusKey, makeSyncStatus, syncStatusKeyFromArticleStatusKey }
  from '../../model/SyncStatus';
import { SyncDatabase } from '../db/SyncDatabase';
import { Downloader, HTTPMethod, HTTPRequestHeader } from '../net/DownloadSession';
import {
  JsonObject, getNumber, getObject, getString, getStringArray, getStringOrNumberAsString, keysOf
} from '../util/Json';
import { RSProgress } from '../util/Progress';
import { AccountService, ContainerRef } from './Account';
import {
  AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener, WebserviceError,
  WebserviceErrorKind, appendQueryItems, arrayOf, chunked, formEncode, formEncodeRepeated,
  jsonObjectOf, requireOK, setOf, subtractingIDs
} from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'NewsBlur';

const newsBlurBaseURL: string = 'https://www.newsblur.com/';
export const newsBlurSessionIDCookieKey: string = 'newsblur_sessionid';

/** NewsBlurStoryHash — a story hash with the timestamp NewsBlur reports beside it. */
export class NewsBlurStoryHash {
  readonly hash: string;
  readonly timestamp: Date;

  constructor(hash: string, timestamp: Date) {
    this.hash = hash;
    this.timestamp = timestamp;
  }
}

export class NewsBlurStoriesPage {
  readonly stories?: NewsBlurStory[];
  readonly date?: Date;

  constructor(stories?: NewsBlurStory[], date?: Date) {
    this.stories = stories;
    this.date = date;
  }
}

// MARK: - JSON -> wire mapping

function feedWireFrom(json: JsonObject): NewsBlurFeedWire | undefined {
  const id: number | undefined = getNumber(json, 'id');
  const title: string | undefined = getString(json, 'feed_title');
  const address: string | undefined = getString(json, 'feed_address');
  if (id === undefined || title === undefined || address === undefined) {
    return undefined;
  }
  const wire: NewsBlurFeedWire = {
    id: id,
    feed_title: title,
    feed_address: address,
    feed_link: getString(json, 'feed_link'),
    favicon_url: getString(json, 'favicon_url')
  };
  return wire;
}

function storyWireFrom(json: JsonObject): NewsBlurStoryWire | undefined {
  const hash: string | undefined = getString(json, 'story_hash');
  const feedID: number | undefined = getNumber(json, 'story_feed_id');
  if (hash === undefined || feedID === undefined) {
    return undefined;
  }
  const timestamp: string | undefined = getStringOrNumberAsString(json, 'story_timestamp');
  let imageURLs: Map<string, string> | undefined = undefined;
  const imageObject: JsonObject | undefined = getObject(json, 'secure_image_urls');
  if (imageObject !== undefined) {
    imageURLs = new Map<string, string>();
    for (const key of keysOf(imageObject)) {
      const value: string | undefined = getString(imageObject, key);
      if (value !== undefined) {
        imageURLs.set(key, value);
      }
    }
  }
  const wire: NewsBlurStoryWire = {
    story_hash: hash,
    story_feed_id: feedID,
    story_title: getString(json, 'story_title'),
    story_permalink: getString(json, 'story_permalink'),
    story_authors: getString(json, 'story_authors'),
    story_content: getString(json, 'story_content'),
    secure_image_urls: imageURLs,
    story_tags: getStringArray(json, 'story_tags'),
    story_timestamp: timestamp === undefined ? '0' : timestamp
  };
  return wire;
}

// MARK: - The API caller

export class NewsBlurAPICaller {
  credentials?: Credentials;
  private suspended: boolean = false;

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  private requireNotSuspended(): void {
    if (this.suspended) {
      throw WebserviceError.suspended();
    }
  }

  /** Session-cookie auth once logged in; a login POSTs username/password instead. */
  private sessionHeaders(contentType?: string): Map<string, string> {
    const headers: Map<string, string> = new Map<string, string>();
    const credentials: Credentials | undefined = this.credentials;
    if (credentials !== undefined && credentials.type === CredentialsType.newsBlurSessionID) {
      headers.set('Cookie', newsBlurSessionIDCookieKey + '=' + credentials.secret);
    }
    if (contentType !== undefined) {
      headers.set(HTTPRequestHeader.contentType, contentType);
    }
    return headers;
  }

  /** POST api/login with the basic credentials; the session ID comes back in Set-Cookie. */
  async validateCredentials(): Promise<Credentials | undefined> {
    this.requireNotSuspended();
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    const form: Map<string, string> = new Map<string, string>();
    form.set('username', credentials.username);
    form.set('password', credentials.secret);

    const headers: Map<string, string> = new Map<string, string>();
    headers.set(HTTPRequestHeader.contentType, 'application/x-www-form-urlencoded');
    const response: DownloadResponse = await Downloader.shared.send(newsBlurBaseURL + 'api/login',
      HTTPMethod.post, headers, formEncode(form));
    requireOK(response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    const code: number | undefined = json === undefined ? undefined : getNumber(json, 'code');
    if (code === -1) {
      throw new Error(NewsBlurAPICaller.loginErrorMessage(json));
    }

    const sessionID: string | undefined = NewsBlurAPICaller.sessionIDFrom(response);
    if (sessionID === undefined) {
      throw new Error('Failed to retrieve session');
    }
    const sessionCredentials: Credentials = {
      type: CredentialsType.newsBlurSessionID,
      username: credentials.username,
      secret: sessionID
    };
    return sessionCredentials;
  }

  private static loginErrorMessage(json?: JsonObject): string {
    if (json === undefined) {
      return 'An unknown error occurred';
    }
    const errors: JsonObject | undefined = getObject(json, 'errors');
    if (errors === undefined) {
      return 'An unknown error occurred';
    }
    const username: string[] | undefined = getStringArray(errors, 'username');
    if (username !== undefined && username.length > 0) {
      return username[0];
    }
    const others: string[] | undefined = getStringArray(errors, '__all__');
    if (others !== undefined && others.length > 0) {
      return others[0];
    }
    return 'An unknown error occurred';
  }

  private static sessionIDFrom(response: DownloadResponse): string | undefined {
    const headers: Map<string, string> | undefined = response.headers;
    if (headers === undefined) {
      return undefined;
    }
    let setCookie: string | undefined = undefined;
    headers.forEach((value: string, key: string) => {
      if (key.toLowerCase() === 'set-cookie') {
        setCookie = value;
      }
    });
    if (setCookie === undefined) {
      return undefined;
    }
    const cookies: string = setCookie as string;
    for (const part of cookies.split(';')) {
      const trimmed: string = part.trim();
      const prefix: string = newsBlurSessionIDCookieKey + '=';
      if (trimmed.startsWith(prefix)) {
        const value: string = trimmed.substring(prefix.length);
        // A cleared cookie carries an empty or deleted value.
        if (value.length > 0 && value !== 'deleted') {
          return value;
        }
      }
    }
    return undefined;
  }

  async logout(): Promise<void> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(newsBlurBaseURL + 'api/logout',
      HTTPMethod.get, this.sessionHeaders());
    requireOK(response);
  }

  /**
   * GET reader/feeds?flat=true — `feeds` and `flat_folders` are objects keyed by feed ID /
   * folder name, so the key walk is done here; the per-object decode and NewsBlur's own
   * visibility filter live in the model.
   */
  async retrieveFeeds(): Promise<NewsBlurFeedsResponse> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('flat', 'true');
    query.set('update_counts', 'true');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(newsBlurBaseURL + 'reader/feeds', query), HTTPMethod.get,
      this.sessionHeaders());
    requireOK(response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    const emptyResponse: NewsBlurFeedsResponse = { feeds: [], folders: [] };
    if (json === undefined) {
      return emptyResponse;
    }

    const feeds: NewsBlurFeed[] = [];
    const feedsObject: JsonObject | undefined = getObject(json, 'feeds');
    if (feedsObject !== undefined) {
      for (const key of keysOf(feedsObject)) {
        const feedObject: JsonObject | undefined = getObject(feedsObject, key);
        if (feedObject === undefined) {
          continue;
        }
        const wire: NewsBlurFeedWire | undefined = feedWireFrom(feedObject);
        if (wire !== undefined) {
          feeds.push(newsBlurFeedFromJSON(wire));
        }
      }
    }

    const folders: NewsBlurFolder[] = [];
    const foldersObject: JsonObject | undefined = getObject(json, 'flat_folders');
    if (foldersObject !== undefined) {
      for (const key of keysOf(foldersObject)) {
        const feedIDs: number[] = [];
        const value: Object | undefined = foldersObject[key];
        if (Array.isArray(value)) {
          for (const item of value as Object[]) {
            if (typeof item === 'number') {
              feedIDs.push(item as number);
            }
          }
        }
        const folder: NewsBlurFolder = { name: key, feedIDs: feedIDs };
        folders.push(folder);
      }
    }

    const result: NewsBlurFeedsResponse = {
      feeds: visibleNewsBlurFeeds(feeds, folders),
      folders: folders
    };
    return result;
  }

  async retrieveUnreadStoryHashes(): Promise<NewsBlurStoryHash[]> {
    return await this.retrieveStoryHashes('reader/unread_story_hashes',
      'unread_feed_story_hashes');
  }

  async retrieveStarredStoryHashes(): Promise<NewsBlurStoryHash[]> {
    return await this.retrieveStoryHashes('reader/starred_story_hashes',
      'starred_story_hashes');
  }

  /**
   * Both hash endpoints answer with [hash, timestamp] pairs — unread keyed by feed ID,
   * starred as a flat array.
   */
  private async retrieveStoryHashes(endpoint: string,
    key: string): Promise<NewsBlurStoryHash[]> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('include_timestamps', 'true');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(newsBlurBaseURL + endpoint, query), HTTPMethod.get,
      this.sessionHeaders());
    requireOK(response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return [];
    }
    const hashes: NewsBlurStoryHash[] = [];
    const value: Object | undefined = json[key];
    if (value === undefined) {
      return hashes;
    }
    if (Array.isArray(value)) {
      NewsBlurAPICaller.appendHashPairs(value as Object[], hashes);
      return hashes;
    }
    const keyed: JsonObject | undefined = getObject(json, key);
    if (keyed !== undefined) {
      for (const feedKey of keysOf(keyed)) {
        const pairs: Object | undefined = keyed[feedKey];
        if (Array.isArray(pairs)) {
          NewsBlurAPICaller.appendHashPairs(pairs as Object[], hashes);
        }
      }
    }
    return hashes;
  }

  private static appendHashPairs(pairs: Object[], out: NewsBlurStoryHash[]): void {
    for (const pair of pairs) {
      if (!Array.isArray(pair)) {
        continue;
      }
      const values: Object[] = pair as Object[];
      if (values.length < 1 || typeof values[0] !== 'string') {
        continue;
      }
      const hash: string = values[0] as string;
      let seconds: number = 0;
      if (values.length > 1) {
        const raw: Object = values[1];
        if (typeof raw === 'number') {
          seconds = raw as number;
        } else if (typeof raw === 'string') {
          const parsed: number = Number.parseFloat(raw as string);
          seconds = Number.isNaN(parsed) ? 0 : parsed;
        }
      }
      out.push(new NewsBlurStoryHash(hash, new Date(seconds * 1000)));
    }
  }

  async retrieveStoriesForFeedID(feedID: string, page: number): Promise<NewsBlurStoriesPage> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('page', String(page));
    query.set('order', 'newest');
    query.set('read_filter', 'all');
    query.set('include_hidden', 'false');
    query.set('include_story_content', 'true');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(newsBlurBaseURL + 'reader/feed/' + feedID, query), HTTPMethod.get,
      this.sessionHeaders());
    requireOK(response);
    return new NewsBlurStoriesPage(NewsBlurAPICaller.storiesOf(response));
  }

  async retrieveStoriesForHashes(hashes: NewsBlurStoryHash[]): Promise<NewsBlurStoriesPage> {
    this.requireNotSuspended();
    const hashValues: string[] = hashes.map((hash: NewsBlurStoryHash) => hash.hash);
    const urlString: string = newsBlurBaseURL + 'reader/river_stories?include_hidden=false&'
      + formEncodeRepeated('h', hashValues);
    const response: DownloadResponse =
      await Downloader.shared.send(urlString, HTTPMethod.get, this.sessionHeaders());
    requireOK(response);
    return new NewsBlurStoriesPage(NewsBlurAPICaller.storiesOf(response));
  }

  private static storiesOf(response: DownloadResponse): NewsBlurStory[] {
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return [];
    }
    const stories: NewsBlurStory[] = [];
    const value: Object | undefined = json['stories'];
    if (!Array.isArray(value)) {
      return stories;
    }
    for (const item of value as Object[]) {
      const storyObject: JsonObject = item as JsonObject;
      const wire: NewsBlurStoryWire | undefined = storyWireFrom(storyObject);
      if (wire !== undefined) {
        stories.push(newsBlurStoryFromJSON(wire));
      }
    }
    return stories;
  }

  async markAsUnread(hashes: string[]): Promise<void> {
    await this.sendStoryHashes('reader/mark_story_hash_as_unread', hashes);
  }

  async markAsRead(hashes: string[]): Promise<void> {
    await this.sendStoryHashes('reader/mark_story_hashes_as_read', hashes);
  }

  async star(hashes: string[]): Promise<void> {
    await this.sendStoryHashes('reader/mark_story_hash_as_starred', hashes);
  }

  async unstar(hashes: string[]): Promise<void> {
    await this.sendStoryHashes('reader/mark_story_hash_as_unstarred', hashes);
  }

  private async sendStoryHashes(endpoint: string, hashes: string[]): Promise<void> {
    this.requireNotSuspended();
    const body: string = formEncodeRepeated('story_hash', hashes);
    const response: DownloadResponse = await Downloader.shared.send(newsBlurBaseURL + endpoint,
      HTTPMethod.post, this.sessionHeaders('application/x-www-form-urlencoded'), body);
    requireOK(response);
  }

  async addFolder(name: string): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('folder', name);
    form.set('parent_folder', '');
    await this.post('reader/add_folder', formEncode(form));
  }

  async renameFolder(folder: string, name: string): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('folder_to_rename', folder);
    form.set('new_folder_name', name);
    form.set('in_folder', '');
    await this.post('reader/rename_folder', formEncode(form));
  }

  async removeFolder(name: string, feedIDs: string[]): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('folder_to_delete', name);
    form.set('in_folder', '');
    let body: string = formEncode(form);
    if (feedIDs.length > 0) {
      body += '&' + formEncodeRepeated('feed_id', feedIDs);
    }
    await this.post('reader/delete_folder', body);
  }

  async addURL(url: string, folder?: string): Promise<NewsBlurFeed | undefined> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('url', url);
    if (folder !== undefined) {
      form.set('folder', folder);
    }
    const response: DownloadResponse = await this.post('reader/add_url', formEncode(form));
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return undefined;
    }
    const feedObject: JsonObject | undefined = getObject(json, 'feed');
    if (feedObject === undefined) {
      return undefined;
    }
    const wire: NewsBlurFeedWire | undefined = feedWireFrom(feedObject);
    return wire === undefined ? undefined : newsBlurFeedFromJSON(wire);
  }

  async renameFeed(feedID: string, newName: string): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('feed_id', feedID);
    form.set('feed_title', newName);
    await this.post('reader/rename_feed', formEncode(form));
  }

  async deleteFeed(feedID: string, folder?: string): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('feed_id', feedID);
    if (folder !== undefined) {
      form.set('in_folder', folder);
    }
    await this.post('reader/delete_feed', formEncode(form));
  }

  async moveFeed(feedID: string, from?: string, to?: string): Promise<void> {
    const form: Map<string, string> = new Map<string, string>();
    form.set('feed_id', feedID);
    form.set('in_folder', from === undefined ? '' : from);
    form.set('to_folder', to === undefined ? '' : to);
    await this.post('reader/move_feed_to_folder', formEncode(form));
  }

  private async post(endpoint: string, body: string): Promise<DownloadResponse> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(newsBlurBaseURL + endpoint,
      HTTPMethod.post, this.sessionHeaders('application/x-www-form-urlencoded'), body);
    requireOK(response);
    return response;
  }
}

// MARK: - The delegate

export class NewsBlurAccountDelegate implements AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[] = [];
  isOPMLImportInProgress: boolean = false;
  readonly server?: string = 'newsblur.com';
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  private credentialsValue?: Credentials;
  private readonly caller: NewsBlurAPICaller = new NewsBlurAPICaller();
  private readonly syncDatabase: SyncDatabase;
  private readonly refreshProgress: RSProgress = new RSProgress();

  constructor(dataFolder: string) {
    // Verbatim from the source: NewsBlur shares DB.sqlite3 with ArticlesDatabase.
    this.syncDatabase = new SyncDatabase(dataFolder + '/DB.sqlite3');
    this.refreshProgress.addListener((progressInfo: ProgressInfo): void => {
      this.progressInfo = progressInfo;
      if (this.onProgressChange !== undefined) {
        this.onProgressChange();
      }
    });
  }

  get credentials(): Credentials | undefined {
    return this.credentialsValue;
  }

  set credentials(value: Credentials | undefined) {
    this.credentialsValue = value;
    this.caller.credentials = value;
  }

  async receiveRemoteNotification(userInfo: Map<string, string>): Promise<void> {
    hilog.debug(DOMAIN, TAG, 'ignoring remote notification (%{public}d keys)', userInfo.size);
  }

  accountDidInitialize(): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    account.retrieveCredentials(CredentialsType.newsBlurSessionID)
      .then((credentials: Credentials | undefined): void => {
        this.credentials = credentials;
      })
      .catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'retrieveCredentials: %{public}s', String(e));
      });
    this.syncDatabase.open().then((): Promise<void> => {
      return this.syncDatabase.resetAllSelectedForProcessing();
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sync database open failed: %{public}s', String(e));
    });
  }

  accountWillBeDeleted(): void {
    this.caller.logout().catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'logout failed: %{public}s', String(e));
    });
  }

  async refreshAll(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    if (this.credentials === undefined) {
      this.credentials = await account.retrieveCredentials(CredentialsType.newsBlurSessionID);
    }

    this.refreshProgress.reset();
    this.refreshProgress.addTasks(4);
    const activityID: number = account.logActivityStart(ActivityKindType.refreshAll);
    try {
      await this.refreshFeeds(account);
      this.refreshProgress.completeTask();

      await this.sendArticleStatus();
      this.refreshProgress.completeTask();

      await this.refreshArticleStatus();
      this.refreshProgress.completeTask();

      await this.refreshMissingStories(account);
      this.refreshProgress.completeTask();

      account.lastRefreshCompletedDate = new Date();
      account.logActivityComplete(activityID);
    } catch (e) {
      this.refreshProgress.reset();
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    }
  }

  async syncArticleStatus(): Promise<boolean> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return false;
    }
    const sentCount: number = await this.sendArticleStatusReturningCount(account);
    const changedCount: number = await this.refreshArticleStatusReturningCount(account);
    return sentCount > 0 || changedCount > 0;
  }

  async sendArticleStatus(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    await this.sendArticleStatusReturningCount(account);
  }

  async refreshArticleStatus(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    await this.refreshArticleStatusReturningCount(account);
  }

  private async sendArticleStatusReturningCount(account: AccountService): Promise<number> {
    const activityID: number = account.logActivityStart(ActivityKindType.sendArticleStatuses);
    const statuses: SyncStatus[] = await this.syncDatabase.selectForProcessing();
    let sentCount: number = 0;
    let savedError: Error | undefined = undefined;

    // NewsBlur throttles: unread/star/unstar go one hash at a time, mark-read in 100s.
    const groups: SyncStatus[][] = [
      statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.read && !s.flag),
      statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.read && s.flag),
      statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.starred && s.flag),
      statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.starred && !s.flag)
    ];
    const throttles: boolean[] = [true, false, true, true];

    for (let i: number = 0; i < groups.length; i++) {
      try {
        sentCount += await this.sendStoryStatuses(groups[i], throttles[i], i);
      } catch (e) {
        savedError = e as Error;
      }
    }

    if (savedError !== undefined) {
      account.postSyncError(savedError, 'Sending article status');
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, sentCount + ' statuses sent', sentCount > 0);
    return sentCount;
  }

  private async sendStoryStatuses(statuses: SyncStatus[], throttle: boolean,
    groupIndex: number): Promise<number> {
    if (statuses.length === 0) {
      return 0;
    }
    const key: SyncStatusKey = statuses[0].key;
    const storyHashes: string[] = statuses.map((status: SyncStatus) => status.articleID);

    let savedError: Error | undefined = undefined;
    let sentCount: number = 0;
    for (const group of chunked(storyHashes, throttle ? 1 : 100)) {
      try {
        await this.callStatusAPI(groupIndex, group);
        await this.syncDatabase.deleteSelectedForProcessing(group, key);
        sentCount += group.length;
      } catch (e) {
        savedError = e as Error;
        hilog.error(DOMAIN, TAG, 'Story status sync call failed: %{public}s', String(e));
        await this.syncDatabase.resetSelectedForProcessing(group, key);
      }
    }
    if (savedError !== undefined) {
      throw savedError;
    }
    return sentCount;
  }

  private async callStatusAPI(groupIndex: number, hashes: string[]): Promise<void> {
    if (groupIndex === 0) {
      await this.caller.markAsUnread(hashes);
      return;
    }
    if (groupIndex === 1) {
      await this.caller.markAsRead(hashes);
      return;
    }
    if (groupIndex === 2) {
      await this.caller.star(hashes);
      return;
    }
    await this.caller.unstar(hashes);
  }

  private async refreshArticleStatusReturningCount(account: AccountService): Promise<number> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshArticleStatuses);
    let changedCount: number = 0;
    let savedError: Error | undefined = undefined;

    try {
      const hashes: NewsBlurStoryHash[] = await this.caller.retrieveUnreadStoryHashes();
      changedCount += await this.syncStoryReadState(account, hashes);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'error retrieving unread stories: %{public}s', String(e));
      savedError = e as Error;
    }

    try {
      const hashes: NewsBlurStoryHash[] = await this.caller.retrieveStarredStoryHashes();
      changedCount += await this.syncStoryStarredState(account, hashes);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'error retrieving starred stories: %{public}s', String(e));
      savedError = e as Error;
    }

    if (savedError !== undefined) {
      account.postSyncError(savedError, 'Refreshing article status');
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, changedCount + ' changed', changedCount > 0);
    return changedCount;
  }

  /** NewsBlur has no OPML import endpoint — the source leaves this empty too. */
  async importOPML(opmlFilePath: string): Promise<void> {
    hilog.info(DOMAIN, TAG, 'NewsBlur has no OPML import endpoint: %{public}s', opmlFilePath);
  }

  async createFolder(name: string): Promise<Folder> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.createFolder, name);
    try {
      await this.caller.addFolder(name);
      const folder: Folder | undefined = account.ensureFolder(name);
      if (folder === undefined) {
        throw AccountError.of(AccountErrorKind.invalidParameter);
      }
      account.logActivityComplete(activityID, name);
      return folder;
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async renameFolder(folder: Folder, name: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folderToRename: string | undefined = folder.name;
    if (folderToRename === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.renameFolder,
      folderToRename + ' → ' + name);
    try {
      await this.caller.renameFolder(folderToRename, name);
      folder.name = name;
      account.structureDidChange();
      account.logActivityComplete(activityID, name);
    } catch (e) {
      // Revert the optimistic rename.
      folder.name = folderToRename;
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async removeFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folderToRemove: string | undefined = folder.name;
    if (folderToRemove === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const activityID: number = account.logActivityStart(ActivityKindType.removeFolder,
      folderToRemove);
    const feedIDs: string[] = [];
    for (const feed of folder.topLevelFeeds) {
      const relationship: Map<string, string> | undefined = feed.folderRelationship;
      if (relationship !== undefined && relationship.size > 1) {
        await this.clearFolderRelationship(account, feed, folderToRemove);
      } else {
        const feedID: string | undefined = feed.externalID;
        if (feedID !== undefined) {
          feedIDs.push(feedID);
        }
      }
    }

    this.refreshProgress.addTask();
    try {
      await this.caller.removeFolder(folderToRemove, feedIDs);
      account.removeFolderFromTree(folder);
      account.logActivityComplete(activityID, folderToRemove);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const folder: Folder | undefined = container.folder;
    const folderName: string | undefined = folder === undefined ? undefined : folder.name;

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.subscribeFeed, url);
    try {
      const newsBlurFeed: NewsBlurFeed | undefined = await this.caller.addURL(url, folderName);
      if (newsBlurFeed === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }
      const feed: Feed = await this.createFeedFromNewsBlurFeed(account, newsBlurFeed, name,
        container);
      account.logActivityComplete(activityID, feed.nameForDisplay);
      return feed;
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  private async createFeedFromNewsBlurFeed(account: AccountService, newsBlurFeed: NewsBlurFeed,
    name: string | undefined, container: ContainerRef): Promise<Feed> {
    const feed: Feed = account.createFeedWith(newsBlurFeed.name, newsBlurFeed.feedURL,
      String(newsBlurFeed.feedID), newsBlurFeed.homePageURL);
    feed.externalID = String(newsBlurFeed.feedID);
    feed.faviconURL = newsBlurFeed.faviconURL;
    await account.persistFeedSettings(feed);

    await this.addFeed(feed, container);
    if (name !== undefined) {
      await this.renameFeed(feed, name);
    }
    this.initialFeedDownload(account, feed).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'initial feed download failed: %{public}s', String(e));
    });
    return feed;
  }

  private async initialFeedDownload(account: AccountService, feed: Feed): Promise<void> {
    this.refreshProgress.addTask();
    try {
      await this.downloadFeed(account, feed, 1);
      await this.refreshArticleStatus();
      await this.refreshMissingStories(account);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  private async downloadFeed(account: AccountService, feed: Feed, page: number): Promise<void> {
    this.refreshProgress.addTask();
    try {
      const result: NewsBlurStoriesPage =
        await this.caller.retrieveStoriesForFeedID(feed.feedID, page);
      const stories: NewsBlurStory[] | undefined = result.stories;
      if (stories === undefined || stories.length === 0) {
        return;
      }
      const since: Date = new Date();
      since.setMonth(since.getMonth() - 3);
      const hasStories: boolean = await this.processStories(account, stories, since);
      if (hasStories) {
        await this.downloadFeed(account, feed, page + 1);
      }
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const feedID: string | undefined = feed.externalID;
    if (feedID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.renameFeed, feed.url);
    try {
      await this.caller.renameFeed(feedID, name);
      feed.editedName = name;
      await account.persistFeedSettings(feed);
      account.logActivityComplete(activityID, name);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folder: Folder | undefined = container.folder;
    if (folder === undefined) {
      account.addFeedToTreeAtTopLevel(feed);
      return;
    }
    const folderName: string = folder.name === undefined ? '' : folder.name;
    await this.saveFolderRelationship(account, feed, folderName, folderName);
    folder.addFeedToTreeAtTopLevel(feed);
    account.structureDidChange();
  }

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const feedID: string | undefined = feed.externalID;
    if (feedID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const folder: Folder | undefined = container.folder;
    const folderName: string | undefined = folder === undefined ? undefined : folder.name;

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.removeFeed, feed.url);
    try {
      await this.caller.deleteFeed(feedID, folderName);
      account.clearFeedSettings(feed);
      account.removeAllInstancesOfFeedFromTreeAtAllLevels(feed);
      account.logActivityComplete(activityID, feed.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const feedID: string | undefined = feed.externalID;
    if (feedID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const sourceFolder: Folder | undefined = sourceContainer.folder;
    const destinationFolder: Folder | undefined = destinationContainer.folder;

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.moveFeed, feed.url);
    try {
      await this.caller.moveFeed(feedID,
        sourceFolder === undefined ? undefined : sourceFolder.name,
        destinationFolder === undefined ? undefined : destinationFolder.name);
      sourceContainer.removeFeedFromTreeAtTopLevel(feed);
      destinationContainer.addFeedToTreeAtTopLevel(feed);
      account.logActivityComplete(activityID, destinationContainer.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async restoreFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const existing: Feed | undefined = account.existingFeedWithURL(feed.url);
    if (existing !== undefined) {
      await this.addFeed(existing, container);
    } else {
      await this.createFeed(feed.url, feed.editedName, container, true);
    }
  }

  async restoreFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folderName: string | undefined = folder.name;
    if (folderName === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const feedsToRestore: Feed[] = folder.topLevelFeeds.slice();
    for (const feed of feedsToRestore) {
      folder.removeFeedFromTreeAtTopLevel(feed);
    }

    const activityID: number = account.logActivityStart(ActivityKindType.restoreFolder,
      folderName);
    try {
      const restored: Folder = await this.createFolder(folderName);
      const container: ContainerRef = ContainerRef.forFolder(account, restored);
      for (const feed of feedsToRestore) {
        await this.restoreFeed(feed, container);
      }
      account.logActivityComplete(activityID, folderName);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'Restore folder error: %{public}s', String(e));
      account.postSyncError(e as Error, 'Restoring folder');
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async markArticles(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    await account.updateStatuses(articleIDs, statusKey, flag);
    // NewsBlur queues every requested articleID, not just the changed ones.
    const syncStatuses: SyncStatus[] = [];
    for (const articleID of articleIDs) {
      syncStatuses.push(makeSyncStatus(articleID, syncStatusKeyFromArticleStatusKey(statusKey),
        flag));
    }
    await this.syncDatabase.insertStatuses(syncStatuses);

    const pendingCount: number = await this.syncDatabase.selectPendingCount();
    if (pendingCount > 100) {
      this.sendArticleStatus().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'background status flush failed: %{public}s', String(e));
      });
    }
  }

  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    const caller: NewsBlurAPICaller = new NewsBlurAPICaller();
    caller.credentials = credentials;
    return await caller.validateCredentials();
  }

  async vacuumDatabases(): Promise<void> {
    await this.syncDatabase.vacuum();
  }

  suspendNetwork(): void {
    this.caller.suspend();
  }

  resume(): void {
    const account: AccountService | undefined = this.account;
    if (account !== undefined && this.credentials === undefined) {
      account.retrieveCredentials(CredentialsType.newsBlurSessionID)
        .then((credentials: Credentials | undefined): void => {
          this.credentials = credentials;
        })
        .catch((e: Object): void => {
          hilog.error(DOMAIN, TAG, 'retrieveCredentials: %{public}s', String(e));
        });
    }
    this.caller.resume();
  }

  // MARK: - Sync phases

  private async refreshFeeds(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshFeedList);
    try {
      const response: NewsBlurFeedsResponse = await this.caller.retrieveFeeds();
      this.syncFolders(account, response.folders);
      await this.syncFeeds(account, response.feeds);
      await this.syncFeedFolderRelationship(account, response.folders);
      account.logActivityComplete(activityID,
        response.feeds.length + ' feeds, ' + response.folders.length + ' folders');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Refreshing feeds');
      throw e as Error;
    }
  }

  private syncFolders(account: AccountService, folders: NewsBlurFolder[]): void {
    const folderNames: string[] = folders.map((folder: NewsBlurFolder) => folder.name);

    for (const folder of account.folders().slice()) {
      const name: string = folder.name === undefined ? '' : folder.name;
      if (!folderNames.includes(name)) {
        for (const feed of folder.topLevelFeeds.slice()) {
          account.addFeedToTreeAtTopLevel(feed);
          this.clearFolderRelationship(account, feed, name).catch((e: Object): void => {
            hilog.error(DOMAIN, TAG, 'clearFolderRelationship: %{public}s', String(e));
          });
        }
        account.removeFolderFromTree(folder);
      }
    }

    const accountFolderNames: string[] = account.folders().map((folder: Folder) =>
      folder.name === undefined ? '' : folder.name);
    for (const folderName of folderNames) {
      // " " is NewsBlur's account-level pseudo-folder, not a real folder.
      if (!accountFolderNames.includes(folderName) && folderName !== ' ') {
        account.ensureFolder(folderName);
      }
    }
  }

  private async syncFeeds(account: AccountService, feeds: NewsBlurFeed[]): Promise<void> {
    const newsBlurFeedIDs: string[] =
      feeds.map((feed: NewsBlurFeed) => String(feed.feedID));

    for (const folder of account.folders()) {
      for (const feed of folder.topLevelFeeds.slice()) {
        if (!newsBlurFeedIDs.includes(feed.feedID)) {
          folder.removeFeedFromTreeAtTopLevel(feed);
        }
      }
    }
    for (const feed of account.model.topLevelFeeds.slice()) {
      if (!newsBlurFeedIDs.includes(feed.feedID)) {
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }

    const feedsToAdd: NewsBlurFeed[] = [];
    for (const newsBlurFeed of feeds) {
      const feedID: string = String(newsBlurFeed.feedID);
      const feed: Feed | undefined = account.existingFeedWithFeedID(feedID);
      if (feed === undefined) {
        feedsToAdd.push(newsBlurFeed);
        continue;
      }
      // A server-side rename drops the locally edited name.
      if (feed.name !== newsBlurFeed.name) {
        feed.editedName = undefined;
      }
      feed.name = newsBlurFeed.name;
      feed.homePageURL = newsBlurFeed.homePageURL;
      feed.externalID = feedID;
      feed.faviconURL = newsBlurFeed.faviconURL;
      await account.persistFeedSettings(feed);
    }

    for (const newsBlurFeed of feedsToAdd) {
      const feed: Feed = account.createFeedWith(newsBlurFeed.name, newsBlurFeed.feedURL,
        String(newsBlurFeed.feedID), newsBlurFeed.homePageURL);
      feed.externalID = String(newsBlurFeed.feedID);
      feed.faviconURL = newsBlurFeed.faviconURL;
      await account.persistFeedSettings(feed);
      account.addFeedToTreeAtTopLevel(feed);
    }
  }

  private async syncFeedFolderRelationship(account: AccountService,
    folders: NewsBlurFolder[]): Promise<void> {
    const relationships: NewsBlurFolderRelationship[] = [];
    for (const folder of folders) {
      for (const relationship of newsBlurFolderRelationships(folder)) {
        relationships.push(relationship);
      }
    }

    const folderDict: Map<string, Folder> = new Map<string, Folder>();
    for (const folder of account.folders()) {
      const name: string = folder.name === undefined ? '' : folder.name;
      if (!folderDict.has(name)) {
        folderDict.set(name, folder);
      }
    }

    const grouped: Map<string, NewsBlurFolderRelationship[]> =
      new Map<string, NewsBlurFolderRelationship[]>();
    for (const relationship of relationships) {
      const existing: NewsBlurFolderRelationship[] | undefined =
        grouped.get(relationship.folderName);
      if (existing === undefined) {
        grouped.set(relationship.folderName, [relationship]);
      } else {
        existing.push(relationship);
      }
    }

    const folderNames: string[] = [];
    grouped.forEach((value: NewsBlurFolderRelationship[], folderName: string) => {
      folderNames.push(folderName);
    });

    for (const folderName of folderNames) {
      if (folderName === ' ') {
        continue;
      }
      const folderRelationships: NewsBlurFolderRelationship[] | undefined =
        grouped.get(folderName);
      const folder: Folder | undefined = folderDict.get(folderName);
      // A missing folder must not abort the rest of the relationship sync.
      if (folder === undefined || folderRelationships === undefined) {
        continue;
      }
      const folderFeedIDs: string[] =
        folderRelationships.map((r: NewsBlurFolderRelationship) => String(r.feedID));

      for (const feed of folder.topLevelFeeds.slice()) {
        if (!folderFeedIDs.includes(feed.feedID)) {
          folder.removeFeedFromTreeAtTopLevel(feed);
          await this.clearFolderRelationship(account, feed, folderName);
          account.addFeedToTreeAtTopLevel(feed);
        }
      }

      const currentFeedIDs: string[] = folder.topLevelFeeds.map((feed: Feed) => feed.feedID);
      for (const relationship of folderRelationships) {
        const relationshipFeedID: string = String(relationship.feedID);
        if (currentFeedIDs.includes(relationshipFeedID)) {
          continue;
        }
        const feed: Feed | undefined = account.existingFeedWithFeedID(relationshipFeedID);
        if (feed === undefined) {
          continue;
        }
        await this.saveFolderRelationship(account, feed, folderName, relationship.folderName);
        folder.addFeedToTreeAtTopLevel(feed);
      }
    }

    // " " holds the account-level feeds. Without it, every feed is inside a folder.
    const accountLevel: NewsBlurFolderRelationship[] | undefined = grouped.get(' ');
    if (accountLevel !== undefined) {
      const accountFeedIDs: string[] =
        accountLevel.map((r: NewsBlurFolderRelationship) => String(r.feedID));
      for (const feed of account.model.topLevelFeeds.slice()) {
        if (!accountFeedIDs.includes(feed.feedID)) {
          account.removeFeedFromTreeAtTopLevel(feed);
        }
      }
    } else {
      for (const feed of account.model.topLevelFeeds.slice()) {
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }
    account.structureDidChange();
  }

  private async refreshMissingStories(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshMissingArticles);
    let savedError: Error | undefined = undefined;

    const fetched: Set<string> =
      await account.fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate();
    const hashes: NewsBlurStoryHash[] = [];
    for (const articleID of arrayOf(fetched)) {
      hashes.push(new NewsBlurStoryHash(articleID, new Date()));
    }

    for (const chunk of chunked(hashes, 100)) {
      try {
        const page: NewsBlurStoriesPage = await this.caller.retrieveStoriesForHashes(chunk);
        await this.processStories(account, page.stories);
      } catch (e) {
        savedError = e as Error;
        hilog.error(DOMAIN, TAG, 'Refresh missing stories error: %{public}s', String(e));
        account.postSyncError(e as Error, 'Refreshing stories');
      }
    }

    if (savedError !== undefined) {
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, hashes.length + ' articles');
  }

  private async processStories(account: AccountService, stories?: NewsBlurStory[],
    since?: Date): Promise<boolean> {
    const parsedItems: ParsedItem[] =
      NewsBlurAccountDelegate.mapStoriesToParsedItems(stories, since);
    const feedIDsAndItems: Map<string, ParsedItem[]> = new Map<string, ParsedItem[]>();
    for (const item of parsedItems) {
      const existing: ParsedItem[] | undefined = feedIDsAndItems.get(item.feedURL);
      if (existing === undefined) {
        feedIDsAndItems.set(item.feedURL, [item]);
      } else {
        existing.push(item);
      }
    }
    await account.updateFeedIDsAndItems(feedIDsAndItems, true);
    return feedIDsAndItems.size > 0;
  }

  private static mapStoriesToParsedItems(stories?: NewsBlurStory[],
    since?: Date): ParsedItem[] {
    if (stories === undefined) {
      return [];
    }
    const parsedItems: ParsedItem[] = [];
    for (const story of stories) {
      const datePublished: Date | undefined = story.datePublished;
      if (since !== undefined && datePublished !== undefined
        && datePublished.getTime() < since.getTime()) {
        continue;
      }
      const author: ParsedAuthor = {
        name: story.authorName,
        url: undefined,
        avatarURL: undefined,
        emailAddress: undefined
      };
      const item: ParsedItem = {
        syncServiceID: story.storyID,
        uniqueID: story.storyID,
        feedURL: String(story.feedID),
        url: story.url,
        title: story.title,
        contentHTML: story.contentHTML,
        imageURL: story.imageURL,
        datePublished: datePublished,
        authors: [author],
        tags: story.tags
      };
      parsedItems.push(item);
    }
    return parsedItems;
  }

  private async clearFolderRelationship(account: AccountService, feed: Feed,
    folderName: string): Promise<void> {
    const relationship: Map<string, string> | undefined = feed.folderRelationship;
    if (relationship === undefined) {
      return;
    }
    relationship.delete(folderName);
    feed.folderRelationship = relationship;
    await account.persistFeedSettings(feed);
  }

  private async saveFolderRelationship(account: AccountService, feed: Feed, folderName: string,
    id: string): Promise<void> {
    let relationship: Map<string, string> | undefined = feed.folderRelationship;
    if (relationship === undefined) {
      relationship = new Map<string, string>();
    }
    relationship.set(folderName, id);
    feed.folderRelationship = relationship;
    await account.persistFeedSettings(feed);
  }

  private async syncStoryReadState(account: AccountService,
    hashes: NewsBlurStoryHash[]): Promise<number> {
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingReadStatusArticleIDs());
    const remoteUnread: Set<string> =
      setOf(hashes.map((hash: NewsBlurStoryHash) => hash.hash));
    const localUnread: Set<string> = await account.fetchUnreadArticleIDs();

    const toMarkUnread: Set<string> =
      subtractingIDs(subtractingIDs(remoteUnread, localUnread), pending);
    const markedUnread: string[] = await account.markAsUnread(toMarkUnread);

    const toMarkRead: Set<string> =
      subtractingIDs(subtractingIDs(localUnread, remoteUnread), pending);
    const markedRead: string[] = await account.markAsRead(toMarkRead);

    return markedUnread.length + markedRead.length;
  }

  private async syncStoryStarredState(account: AccountService,
    hashes: NewsBlurStoryHash[]): Promise<number> {
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingStarredStatusArticleIDs());
    const remoteStarred: Set<string> =
      setOf(hashes.map((hash: NewsBlurStoryHash) => hash.hash));
    const localStarred: Set<string> = await account.fetchStarredArticleIDs();

    const toStar: Set<string> =
      subtractingIDs(subtractingIDs(remoteStarred, localStarred), pending);
    const markedStarred: string[] = await account.markAsStarred(toStar);

    const toUnstar: Set<string> =
      subtractingIDs(subtractingIDs(localStarred, remoteStarred), pending);
    const markedUnstarred: string[] = await account.markAsUnstarred(toUnstar);

    return markedStarred.length + markedUnstarred.length;
  }
}
