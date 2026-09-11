/**
 * FeedlyAccountDelegate — port of
 * Modules/Account/Sources/Account/Feedly/{FeedlyAccountDelegate,FeedlyAPICaller,
 * FeedlyAccountDelegate+OAuth,OAuthAuthorizationCodeGranting,FeedlyFolderReconciliation}.swift
 *
 * AccountType.feedly. OAuth2 against https://cloud.feedly.com — the Add Account row starts
 * the authorization page rather than opening a credential screen, and the account has no
 * validateCredentials entry point: it refreshes its access token instead.
 *
 * Behaviors: disallowFeedInRootFolder (Feedly requires feeds to live in a collection) and
 * disallowMarkAsUnreadAfterPeriod(31) (its markers API refuses older articles).
 *
 * The bounds that keep Feedly from rate-limiting the app travel with it: a 90-day stream
 * ingest window, a 40-page cap per walk, 20 article-download chunks per sync, 300-ID marker
 * chunks, a 30-minute no-change backoff, and one shared token refresh for concurrent 401s.
 */

import fs from '@ohos.file.fs';
import i18n from '@ohos.i18n';
import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior, AccountBehaviorKind } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { ActivityKindType } from '../../model/Activity';
import { Article } from '../../model/Article';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Credentials, CredentialsType } from '../../model/Credentials';
import { DownloadResponse } from '../../model/DownloadResponse';
import { Feed } from '../../model/Feed';
import { FeedSpecifier, bestFeed } from '../../model/FeedSpecifier';
import {
  FeedlyCategory, FeedlyCollection, FeedlyContent, FeedlyEntry, FeedlyFeed, FeedlyLink,
  FeedlyOrigin, FeedlyOriginWire, FeedlyStream, FeedlyStreamIDs, FeedlyTag,
  feedlyAllResourceID, feedlyEntryContentHTML, feedlyEntryDatePublished, feedlyEntryExternalURL,
  feedlyEntryFeedURL, feedlyEntrySummary, feedlyFeedResourceURL, feedlyOriginFromJSON,
  feedlySavedResourceID, sanitizeFeedlyText
} from '../../model/FeedlyCollection';
import { FetchType } from '../../model/FetchType';
import { Folder } from '../../model/Folder';
import { ParsedAuthor } from '../../model/ParsedAuthor';
import { ParsedItem } from '../../model/ParsedItem';
import { ProgressInfo } from '../../model/ProgressInfo';
import { SyncStatus, SyncStatusKey, makeSyncStatus, syncStatusKeyFromArticleStatusKey }
  from '../../model/SyncStatus';
import { ArticleChanges } from '../db/ArticlesDatabase';
import { SyncDatabase } from '../db/SyncDatabase';
import { FeedFinder } from '../net/FeedFinder';
import { Downloader, HTTPMethod, HTTPRequestHeader } from '../net/DownloadSession';
import { AppDefaults } from '../prefs/AppDefaults';
import {
  JsonObject, getBoolean, getNumber, getObject, getObjectArray, getString, getStringArray
} from '../util/Json';
import { RSProgress } from '../util/Progress';
import { AccountService, ContainerRef } from './Account';
import {
  AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener, SyncRateLimiter,
  WebserviceError, WebserviceErrorKind, appendQueryItems, arrayOf, chunked, jsonObjectArrayOf,
  jsonObjectOf, requireOK, setOf, statusCodeOf, subtractingIDs
} from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'Feedly';

const feedlyBaseURL: string = 'https://cloud.feedly.com';
const feedlyRedirectURI: string = 'netnewswire://auth/feedly';
const feedlyOAuthScope: string = 'https://cloud.feedly.com/subscriptions';
/**
 * The `state` of the authorization request still waiting for its redirect.
 *
 * The source keeps it in OAuthAccountAuthorizationOperation's memory, because
 * ASWebAuthenticationSession hands the callback straight back to that live operation. Here
 * the consent page runs in the SYSTEM browser and the redirect returns as a Want that can
 * cold-start this app — the system is free to kill it while the browser is open — so the
 * value has to outlive the process, and preferences is the only store this layer has.
 */
const feedlyPendingOAuthStateKey: string = 'feedlyPendingOAuthState';

/** Feedly can't mark entries crawled more than ~31 days ago. */
const markAsReadDaysLimit: number = 31;
/** The stream-ID walk bound: NNW's own 90-day article retention. */
const streamIngestDaysLimit: number = 90;
/** Safety net so no continuation loop can run away. */
const maxStreamPageCount: number = 40;
/** At most this many article-download chunks per sync; the rest follow on later syncs. */
const maxArticleDownloadChunksPerSync: number = 20;
const articleDownloadChunkSize: number = 1000;
/** Feedly's /v3/markers limit. */
const markChunkSize: number = 300;
const pendingStatusSendThreshold: number = 100;
const feedsToRefreshPerSync: number = 5;
const individualFeedRefreshCount: number = 100;
/** Slightly over a day, so each feed's schedule drifts instead of stacking up daily. */
const minimumFeedRefreshIntervalMillis: number = 24.5 * 60 * 60 * 1000;
const noChangeBackoffMillis: number = 30 * 60 * 1000;
/** Back-dating the watermark covers clock skew; re-fetching the overlap is idempotent. */
const articleFetchOverlapMillis: number = 5 * 60 * 1000;
const streamContentsCount: number = 1000;
const streamIDsCount: number = 10000;

/**
 * The client credentials the source substitutes at build time from its private secrets
 * (OAuthAuthorizationClient+Feedly.swift reads SecretKey.feedlyClientID/Secret). A
 * self-signed build has no secrets store, so they are read from preferences instead —
 * but nothing in the app writes those preferences, exactly as nothing in the source's
 * UI edits its secrets: without them Feedly sign-in is simply unavailable.
 */
const feedlyNotConfiguredMessage: string =
  'Feedly sign-in isn’t available in this build. The Feedly client ID and secret are'
  + ' build-time secrets, and this build was made without them.';

export class FeedlyOAuthClient {
  static readonly clientIDKey: string = 'feedlyClientID';
  static readonly clientSecretKey: string = 'feedlyClientSecret';

  readonly id: string;
  readonly secret: string;
  readonly redirectURI: string = feedlyRedirectURI;

  constructor(id: string, secret: string) {
    this.id = id;
    this.secret = secret;
  }

  static current(): FeedlyOAuthClient | undefined {
    const id: string | undefined = AppDefaults.stringValue(FeedlyOAuthClient.clientIDKey);
    const secret: string | undefined = AppDefaults.stringValue(FeedlyOAuthClient.clientSecretKey);
    if (id === undefined || id.length === 0 || secret === undefined || secret.length === 0) {
      return undefined;
    }
    return new FeedlyOAuthClient(id, secret);
  }
}

/**
 * Is this the redirect this app registered? `netnewswire://auth/feedly`, compared without
 * its query or fragment and case-insensitively, as OAuthAuthorizationResponse.init(url:client:)
 * compares the scheme. `feed://`, `feeds://` and any other `netnewswire://` path are not ours.
 */
export function isFeedlyRedirectURI(urlString: string): boolean {
  let end: number = urlString.length;
  const questionMark: number = urlString.indexOf('?');
  const hash: number = urlString.indexOf('#');
  if (questionMark >= 0) {
    end = questionMark;
  }
  if (hash >= 0 && hash < end) {
    end = hash;
  }
  let base: string = urlString.substring(0, end).toLowerCase();
  if (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  return base === feedlyRedirectURI;
}

/** OAuthAuthorizationResponse (RFC 6749 §4.1.2) — what the redirect carried back. */
export class FeedlyAuthorizationResponse {
  readonly code: string;
  readonly state?: string;

  constructor(code: string, state?: string) {
    this.code = code;
    this.state = state;
  }
}

/**
 * OAuthAuthorizationErrorResponse.isAccessDenied — the user tapped Deny on the consent page.
 * The source calls that a cancellation and shows NOTHING, so it is a type of its own rather
 * than an error message the caller would put in front of the user.
 */
export class FeedlyAuthorizationCancelledError extends Error {
  constructor() {
    super('The Feedly authorization was cancelled.');
  }
}

/** The token pair a completed authorization grant produces. */
export class OAuthAuthorizationGrant {
  readonly accessToken: Credentials;
  readonly refreshToken?: Credentials;

  constructor(accessToken: Credentials, refreshToken?: Credentials) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }
}

export class FeedlyOAuthAccessTokenResponse {
  readonly id: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;

  constructor(id: string, accessToken: string, expiresIn: number, refreshToken?: string) {
    this.id = id;
    this.accessToken = accessToken;
    this.expiresIn = expiresIn;
    this.refreshToken = refreshToken;
  }
}

export enum FeedlyMarkAction {
  read = 'markAsRead',
  unread = 'keepUnread',
  saved = 'markAsSaved',
  unsaved = 'markAsUnsaved'
}

/** The outcome of ingesting a batch of Feedly entries. */
class IngestResult {
  newArticleCount: number = 0;
  /** New (not previously in the database) article IDs that are unread on the server. */
  newUnreadArticleIDs: Set<string> = new Set<string>();
}

class StreamIDCollection {
  readonly ids: Set<string>;
  readonly truncated: boolean;

  constructor(ids: Set<string>, truncated: boolean) {
    this.ids = ids;
    this.truncated = truncated;
  }
}

class StatusChangeCounts {
  added: number = 0;
  removed: number = 0;
}

/** One Feedly collection paired with the folder that mirrors it. */
class CollectionFolderPair {
  readonly feeds: FeedlyFeed[];
  readonly folder: Folder;

  constructor(feeds: FeedlyFeed[], folder: Folder) {
    this.feeds = feeds;
    this.folder = folder;
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// MARK: - JSON -> model mapping

function feedFrom(json: JsonObject): FeedlyFeed | undefined {
  const id: string | undefined = getString(json, 'id');
  if (id === undefined) {
    return undefined;
  }
  const updated: number | undefined = getNumber(json, 'updated');
  const feed: FeedlyFeed = {
    id: id,
    title: getString(json, 'title'),
    updated: updated === undefined ? undefined : new Date(updated),
    website: getString(json, 'website')
  };
  return feed;
}

function collectionFrom(json: JsonObject): FeedlyCollection | undefined {
  const id: string | undefined = getString(json, 'id');
  if (id === undefined) {
    return undefined;
  }
  const feeds: FeedlyFeed[] = [];
  const feedObjects: JsonObject[] | undefined = getObjectArray(json, 'feeds');
  if (feedObjects !== undefined) {
    for (const feedObject of feedObjects) {
      const feed: FeedlyFeed | undefined = feedFrom(feedObject);
      if (feed !== undefined) {
        feeds.push(feed);
      }
    }
  }
  const label: string | undefined = getString(json, 'label');
  const collection: FeedlyCollection = {
    feeds: feeds,
    label: label === undefined ? '' : label,
    id: id
  };
  return collection;
}

function contentFrom(json?: JsonObject): FeedlyContent | undefined {
  if (json === undefined) {
    return undefined;
  }
  const content: FeedlyContent = {
    content: getString(json, 'content'),
    direction: undefined
  };
  return content;
}

function linksFrom(json: JsonObject, key: string): FeedlyLink[] | undefined {
  const objects: JsonObject[] | undefined = getObjectArray(json, key);
  if (objects === undefined) {
    return undefined;
  }
  const links: FeedlyLink[] = [];
  for (const object of objects) {
    const href: string | undefined = getString(object, 'href');
    if (href === undefined) {
      continue;
    }
    const link: FeedlyLink = { href: href, type: getString(object, 'type') };
    links.push(link);
  }
  return links;
}

function entryFrom(json: JsonObject): FeedlyEntry | undefined {
  const id: string | undefined = getString(json, 'id');
  if (id === undefined) {
    return undefined;
  }
  let origin: FeedlyOrigin | undefined = undefined;
  const originObject: JsonObject | undefined = getObject(json, 'origin');
  if (originObject !== undefined) {
    const wire: FeedlyOriginWire = {
      title: getString(originObject, 'title'),
      streamId: getString(originObject, 'streamId'),
      htmlUrl: getString(originObject, 'htmlUrl')
    };
    origin = feedlyOriginFromJSON(wire);
  }
  let tags: FeedlyTag[] | undefined = undefined;
  const tagObjects: JsonObject[] | undefined = getObjectArray(json, 'tags');
  if (tagObjects !== undefined) {
    tags = [];
    for (const tagObject of tagObjects) {
      const tagID: string | undefined = getString(tagObject, 'id');
      if (tagID !== undefined) {
        const tag: FeedlyTag = { id: tagID, label: getString(tagObject, 'label') };
        tags.push(tag);
      }
    }
  }
  let categories: FeedlyCategory[] | undefined = undefined;
  const categoryObjects: JsonObject[] | undefined = getObjectArray(json, 'categories');
  if (categoryObjects !== undefined) {
    categories = [];
    for (const categoryObject of categoryObjects) {
      const categoryID: string | undefined = getString(categoryObject, 'id');
      const label: string | undefined = getString(categoryObject, 'label');
      if (categoryID !== undefined) {
        const category: FeedlyCategory = { id: categoryID, label: label === undefined ? '' : label };
        categories.push(category);
      }
    }
  }

  const crawled: number | undefined = getNumber(json, 'crawled');
  const recrawled: number | undefined = getNumber(json, 'recrawled');
  const published: number | undefined = getNumber(json, 'published');
  const unread: boolean | undefined = getBoolean(json, 'unread');

  const entry: FeedlyEntry = {
    id: id,
    title: sanitizeFeedlyText(getString(json, 'title')),
    content: contentFrom(getObject(json, 'content')),
    summary: contentFrom(getObject(json, 'summary')),
    author: getString(json, 'author'),
    crawled: new Date(crawled === undefined ? Date.now() : crawled),
    recrawled: recrawled === undefined ? undefined : new Date(recrawled),
    published: published === undefined ? undefined : new Date(published),
    origin: origin,
    canonical: linksFrom(json, 'canonical'),
    alternate: linksFrom(json, 'alternate'),
    unread: unread === true,
    tags: tags,
    categories: categories,
    enclosure: linksFrom(json, 'enclosure')
  };
  return entry;
}

// MARK: - The API caller

export class FeedlyAPICaller {
  credentials?: Credentials;
  /** Set by the delegate: refreshes the OAuth credentials so a 401 can be retried once. */
  reauthorize?: () => Promise<boolean>;

  private isSuspended: boolean = false;

  get server(): string {
    return 'cloud.feedly.com';
  }

  cancelAll(): void {
    this.isSuspended = true;
  }

  suspend(): void {
    this.isSuspended = true;
  }

  resume(): void {
    this.isSuspended = false;
  }

  private requireNotSuspended(): void {
    if (this.isSuspended) {
      throw WebserviceError.suspended();
    }
  }

  private requireAccessToken(): string {
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    return credentials.secret;
  }

  private jsonHeaders(accessToken: string): Map<string, string> {
    const headers: Map<string, string> = new Map<string, string>();
    headers.set(HTTPRequestHeader.contentType, 'application/json');
    headers.set('Accept-Type', 'application/json');
    headers.set(HTTPRequestHeader.authorization, 'OAuth ' + accessToken);
    return headers;
  }

  /** Performs the request, reauthorizing and retrying exactly once on a 401. */
  private async send(urlString: string, method: string, body?: string,
    contentType?: string): Promise<DownloadResponse> {
    this.requireNotSuspended();
    let accessToken: string = this.requireAccessToken();
    let headers: Map<string, string> = this.jsonHeaders(accessToken);
    if (contentType !== undefined) {
      headers.set(HTTPRequestHeader.contentType, contentType);
    }

    let response: DownloadResponse =
      await Downloader.shared.send(urlString, method, headers, body);
    if (statusCodeOf(response) !== 401) {
      requireOK(response);
      return response;
    }

    const reauthorize: (() => Promise<boolean>) | undefined = this.reauthorize;
    if (reauthorize === undefined) {
      throw WebserviceError.httpError(401);
    }
    const didReauthorize: boolean = await reauthorize();
    if (!didReauthorize) {
      throw WebserviceError.httpError(401);
    }
    accessToken = this.requireAccessToken();
    headers = this.jsonHeaders(accessToken);
    if (contentType !== undefined) {
      headers.set(HTTPRequestHeader.contentType, contentType);
    }
    response = await Downloader.shared.send(urlString, method, headers, body);
    requireOK(response);
    return response;
  }

  // MARK: Collections

  async getCollections(): Promise<FeedlyCollection[]> {
    const response: DownloadResponse =
      await this.send(feedlyBaseURL + '/v3/collections', HTTPMethod.get);
    return FeedlyAPICaller.collectionsOf(response);
  }

  async createCollection(label: string): Promise<FeedlyCollection> {
    const body: string = '{"label":' + JSON.stringify(label) + '}';
    const response: DownloadResponse =
      await this.send(feedlyBaseURL + '/v3/collections', HTTPMethod.post, body);
    const collections: FeedlyCollection[] = FeedlyAPICaller.collectionsOf(response);
    if (collections.length === 0) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    return collections[0];
  }

  async renameCollection(id: string, name: string): Promise<FeedlyCollection> {
    const body: string = '{"id":' + JSON.stringify(id) + ',"label":'
      + JSON.stringify(name) + '}';
    const response: DownloadResponse =
      await this.send(feedlyBaseURL + '/v3/collections', HTTPMethod.post, body);
    const collections: FeedlyCollection[] = FeedlyAPICaller.collectionsOf(response);
    if (collections.length === 0) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    return collections[0];
  }

  async deleteCollection(id: string): Promise<void> {
    await this.send(feedlyBaseURL + '/v3/collections/' + encodeURIComponent(id),
      HTTPMethod.delete);
  }

  async addFeedToCollection(feedResourceID: string, title: string | undefined,
    collectionID: string): Promise<FeedlyFeed[]> {
    let body: string = '{"id":' + JSON.stringify(feedResourceID);
    if (title !== undefined) {
      body += ',"title":' + JSON.stringify(title);
    }
    body += '}';
    const response: DownloadResponse = await this.send(
      feedlyBaseURL + '/v3/collections/' + encodeURIComponent(collectionID) + '/feeds',
      HTTPMethod.put, body);
    const feeds: FeedlyFeed[] = [];
    const objects: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (objects !== undefined) {
      for (const object of objects) {
        const feed: FeedlyFeed | undefined = feedFrom(object);
        if (feed !== undefined) {
          feeds.push(feed);
        }
      }
    }
    return feeds;
  }

  async removeFeedFromCollection(feedID: string, collectionID: string): Promise<void> {
    const body: string = '[{"id":' + JSON.stringify(feedID) + '}]';
    await this.send(
      feedlyBaseURL + '/v3/collections/' + encodeURIComponent(collectionID) + '/feeds/.mdelete',
      HTTPMethod.delete, body);
  }

  private static collectionsOf(response: DownloadResponse): FeedlyCollection[] {
    const collections: FeedlyCollection[] = [];
    const objects: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (objects === undefined) {
      return collections;
    }
    for (const object of objects) {
      const collection: FeedlyCollection | undefined = collectionFrom(object);
      if (collection !== undefined) {
        collections.push(collection);
      }
    }
    return collections;
  }

  // MARK: Streams

  async getStreamContents(resourceID: string, continuation: string | undefined,
    newerThan: Date | undefined, unreadOnly: boolean | undefined,
    count?: number): Promise<FeedlyStream> {
    const query: Map<string, string> = new Map<string, string>();
    if (newerThan !== undefined) {
      query.set('newerThan', String(newerThan.getTime()));
    }
    if (unreadOnly !== undefined) {
      query.set('unreadOnly', unreadOnly ? 'true' : 'false');
    }
    if (continuation !== undefined && continuation.length > 0) {
      query.set('continuation', continuation);
    }
    query.set('count', String(count === undefined ? streamContentsCount : count));
    query.set('streamId', resourceID);

    const response: DownloadResponse = await this.send(
      appendQueryItems(feedlyBaseURL + '/v3/streams/contents', query), HTTPMethod.get);
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    const items: FeedlyEntry[] = [];
    const itemObjects: JsonObject[] | undefined = getObjectArray(json, 'items');
    if (itemObjects !== undefined) {
      for (const itemObject of itemObjects) {
        const entry: FeedlyEntry | undefined = entryFrom(itemObject);
        if (entry !== undefined) {
          items.push(entry);
        }
      }
    }
    const id: string | undefined = getString(json, 'id');
    const stream: FeedlyStream = {
      id: id === undefined ? resourceID : id,
      continuation: getString(json, 'continuation'),
      items: items
    };
    return stream;
  }

  async getStreamIDs(resourceID: string, continuation: string | undefined,
    newerThan: Date | undefined, unreadOnly: boolean | undefined): Promise<FeedlyStreamIDs> {
    const query: Map<string, string> = new Map<string, string>();
    if (newerThan !== undefined) {
      query.set('newerThan', String(newerThan.getTime()));
    }
    if (unreadOnly !== undefined) {
      query.set('unreadOnly', unreadOnly ? 'true' : 'false');
    }
    if (continuation !== undefined && continuation.length > 0) {
      query.set('continuation', continuation);
    }
    query.set('count', String(streamIDsCount));
    query.set('streamId', resourceID);

    const response: DownloadResponse = await this.send(
      appendQueryItems(feedlyBaseURL + '/v3/streams/ids', query), HTTPMethod.get);
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    const ids: string[] | undefined = getStringArray(json, 'ids');
    const streamIDs: FeedlyStreamIDs = {
      continuation: getString(json, 'continuation'),
      ids: ids === undefined ? [] : ids
    };
    return streamIDs;
  }

  // MARK: Entries and markers

  async getEntries(ids: string[]): Promise<FeedlyEntry[]> {
    const body: string = JSON.stringify(ids);
    const response: DownloadResponse =
      await this.send(feedlyBaseURL + '/v3/entries/.mget', HTTPMethod.post, body);
    const entries: FeedlyEntry[] = [];
    const objects: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (objects === undefined) {
      return entries;
    }
    for (const object of objects) {
      const entry: FeedlyEntry | undefined = entryFrom(object);
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
    return entries;
  }

  /** One batch; the caller chunks to stay under Feedly's markers limit. */
  async mark(articleIDs: string[], action: FeedlyMarkAction): Promise<void> {
    const body: string = '{"type":"entries","action":' + JSON.stringify(action as string)
      + ',"entryIds":' + JSON.stringify(articleIDs) + '}';
    // The markers response body is irrelevant to success — decoding it could turn a
    // successful mark into a spurious failure that requeues forever.
    await this.send(feedlyBaseURL + '/v3/markers', HTTPMethod.post, body);
  }

  // MARK: OPML, search and logout

  async importOPML(opmlText: string): Promise<void> {
    await this.send(feedlyBaseURL + '/v3/opml', HTTPMethod.post, opmlText, 'text/xml');
  }

  async searchFeeds(query: string, count: number, locale: string): Promise<string[]> {
    this.requireNotSuspended();
    const items: Map<string, string> = new Map<string, string>();
    items.set('query', query);
    items.set('count', String(count));
    items.set('locale', locale);
    const headers: Map<string, string> = new Map<string, string>();
    headers.set(HTTPRequestHeader.contentType, 'application/json');
    headers.set('Accept-Type', 'application/json');

    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedlyBaseURL + '/v3/search/feeds', items), HTTPMethod.get, headers);
    requireOK(response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    const feedIDs: string[] = [];
    if (json === undefined) {
      return feedIDs;
    }
    const results: JsonObject[] | undefined = getObjectArray(json, 'results');
    if (results === undefined) {
      return feedIDs;
    }
    for (const result of results) {
      const feedID: string | undefined = getString(result, 'feedId');
      if (feedID !== undefined) {
        feedIDs.push(feedID);
      }
    }
    return feedIDs;
  }

  async logout(): Promise<void> {
    await this.send(feedlyBaseURL + '/v3/auth/logout', HTTPMethod.post);
  }

  // MARK: OAuth

  /** The page the Web component loads to ask the user to consent. */
  static authorizationCodeURL(client: FeedlyOAuthClient, state: string): string {
    const query: Map<string, string> = new Map<string, string>();
    query.set('response_type', 'code');
    query.set('client_id', client.id);
    query.set('scope', feedlyOAuthScope);
    query.set('redirect_uri', client.redirectURI);
    query.set('state', state);
    return appendQueryItems(feedlyBaseURL + '/v3/auth/auth', query);
  }

  /**
   * OAuthAuthorizationResponse.init(url:client:): pulls ?code= and ?state= out of the
   * redirect, and throws instead on ?error= — access_denied as the cancellation the source
   * treats it as, anything else carrying `error_description ?? error`.
   *
   * `state` comes back too because the caller has to compare it with the request's; dropping
   * it (as this did) turns the CSRF defence the authorization URL already asks for into
   * decoration. The scheme/path check is the source's guard that a URL which is not OUR
   * redirect never reaches the token endpoint.
   */
  static authorizationResponseFromRedirect(urlString: string): FeedlyAuthorizationResponse {
    if (!isFeedlyRedirectURI(urlString)) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const questionMark: number = urlString.indexOf('?');
    if (questionMark < 0) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    let query: string = urlString.substring(questionMark + 1);
    const hash: number = query.indexOf('#');
    if (hash >= 0) {
      query = query.substring(0, hash);
    }
    let code: string | undefined = undefined;
    let state: string | undefined = undefined;
    let error: string | undefined = undefined;
    let errorDescription: string | undefined = undefined;
    for (const pair of query.split('&')) {
      const separator: number = pair.indexOf('=');
      if (separator < 0) {
        continue;
      }
      const name: string = decodeURIComponent(pair.substring(0, separator)).toLowerCase();
      const value: string = decodeURIComponent(pair.substring(separator + 1));
      if (name === 'code') {
        code = value;
      } else if (name === 'state') {
        state = value;
      } else if (name === 'error') {
        error = value;
      } else if (name === 'error_description') {
        errorDescription = value;
      }
    }
    if (error === 'access_denied') {
      throw new FeedlyAuthorizationCancelledError();
    }
    if (error !== undefined && error.length > 0) {
      throw new Error(errorDescription !== undefined && errorDescription.length > 0
        ? errorDescription : error);
    }
    if (code === undefined || code.length === 0) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    return new FeedlyAuthorizationResponse(code, state);
  }

  async requestAccessToken(client: FeedlyOAuthClient,
    code: string): Promise<FeedlyOAuthAccessTokenResponse> {
    const body: string = '{"grant_type":"authorization_code","code":' + JSON.stringify(code)
      + ',"redirect_uri":' + JSON.stringify(client.redirectURI)
      + ',"client_id":' + JSON.stringify(client.id)
      + ',"client_secret":' + JSON.stringify(client.secret)
      + ',"scope":' + JSON.stringify(feedlyOAuthScope) + '}';
    return await this.postOAuthTokenRequest(body);
  }

  async refreshAccessToken(client: FeedlyOAuthClient,
    refreshToken: string): Promise<FeedlyOAuthAccessTokenResponse> {
    const body: string = '{"grant_type":"refresh_token","refresh_token":'
      + JSON.stringify(refreshToken)
      + ',"client_id":' + JSON.stringify(client.id)
      + ',"client_secret":' + JSON.stringify(client.secret) + '}';
    return await this.postOAuthTokenRequest(body);
  }

  /**
   * The raw request deliberately: a 401 here means the refresh token itself is bad, and
   * going through send() would reauthorize, which calls back here and recurses forever.
   */
  private async postOAuthTokenRequest(body: string): Promise<FeedlyOAuthAccessTokenResponse> {
    this.requireNotSuspended();
    const headers: Map<string, string> = new Map<string, string>();
    headers.set(HTTPRequestHeader.contentType, 'application/json');
    headers.set('Accept-Type', 'application/json');
    const response: DownloadResponse = await Downloader.shared.send(
      feedlyBaseURL + '/v3/auth/token', HTTPMethod.post, headers, body);
    requireOK(response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    const id: string | undefined = getString(json, 'id');
    const accessToken: string | undefined = getString(json, 'access_token');
    if (id === undefined || accessToken === undefined) {
      throw new WebserviceError(WebserviceErrorKind.invalidResponse);
    }
    const expiresIn: number | undefined = getNumber(json, 'expires_in');
    return new FeedlyOAuthAccessTokenResponse(id, accessToken,
      expiresIn === undefined ? 0 : expiresIn, getString(json, 'refresh_token'));
  }
}

// MARK: - The delegate

export class FeedlyAccountDelegate implements AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[] = [
    new AccountBehavior(AccountBehaviorKind.disallowFeedInRootFolder),
    new AccountBehavior(AccountBehaviorKind.disallowMarkAsUnreadAfterPeriod, markAsReadDaysLimit)
  ];
  isOPMLImportInProgress: boolean = false;
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  readonly caller: FeedlyAPICaller = new FeedlyAPICaller();

  private credentialsValue?: Credentials;
  private readonly syncDatabase: SyncDatabase;
  private readonly refreshProgress: RSProgress = new RSProgress();
  // Feedly reports its rate-limit ban as a 403, so that counts as rate limited too.
  private readonly rateLimiter: SyncRateLimiter = new SyncRateLimiter('Feedly', true);

  private lastNoChangeSyncDate?: Date;
  /** Overlapping sends would select and post the same queued rows. */
  private statusSendTask?: Promise<number>;
  /** Concurrent 401s must share one token refresh, or Feedly reads it as abuse. */
  private reauthorizeTask?: Promise<boolean>;
  private refreshAllIsRunning: boolean = false;

  constructor(dataFolder: string) {
    this.syncDatabase = new SyncDatabase(dataFolder + '/Sync.sqlite3');
    this.refreshProgress.addListener((progressInfo: ProgressInfo): void => {
      this.progressInfo = progressInfo;
      if (this.onProgressChange !== undefined) {
        this.onProgressChange();
      }
    });
    this.caller.reauthorize = (): Promise<boolean> => {
      return this.reauthorizeFeedlyAPICaller();
    };
  }

  get server(): string | undefined {
    return this.caller.server;
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
    account.retrieveCredentials(CredentialsType.oauthAccessToken)
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
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    this.caller.logout().catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'Logout failed: %{public}s', String(e));
    }).then((): void => {
      // Remove the tokens even when the logout request failed — the account is gone anyway.
      account.removeCredentials(CredentialsType.oauthAccessToken).catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'removeCredentials: %{public}s', String(e));
      });
      account.removeCredentials(CredentialsType.oauthRefreshToken).catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'removeCredentials: %{public}s', String(e));
      });
    });
  }

  // MARK: - OAuth entry points (the Add Account row starts these)

  /** The authorization page URL the Add Account row opens in a Web component. */
  static oauthAuthorizationURL(state: string): string {
    const client: FeedlyOAuthClient | undefined = FeedlyOAuthClient.current();
    if (client === undefined) {
      throw new Error(feedlyNotConfiguredMessage);
    }
    return FeedlyAPICaller.authorizationCodeURL(client, state);
  }

  /**
   * OAuthAccountAuthorizationOperation.run(): the consent page to open, with a fresh `state`
   * remembered for the redirect to be matched against.
   *
   * Throws (and remembers nothing) when the client credentials are absent, so a fresh
   * install shows the "not available in this build" message and leaves no half-started
   * request.
   */
  static beginOAuthAuthorization(): string {
    const state: string = util.generateRandomUUID(true);
    const url: string = FeedlyAccountDelegate.oauthAuthorizationURL(state);
    AppDefaults.setString(feedlyPendingOAuthStateKey, state);
    return url;
  }

  /** Is this Want's URI the Feedly redirect? EntryAbility asks before doing anything. */
  static isOAuthRedirect(urlString: string): boolean {
    return isFeedlyRedirectURI(urlString);
  }

  /**
   * OAuthAccountAuthorizationOperation.didEndAuthentication: validates the callback against
   * the request that started it, then exchanges its code.
   *
   * Saving the account (duplicateServiceAccount / createAccount / storeCredentials) is the
   * CALLER's half, as it is the operation's in the source — importing AccountManager here
   * would close an import cycle, since it reaches this file back through AccountDelegate.
   */
  static async completeOAuthAuthorization(redirectURL: string): Promise<OAuthAuthorizationGrant> {
    const expected: string | undefined = AppDefaults.stringValue(feedlyPendingOAuthStateKey);
    if (expected !== undefined) {
      // One redirect per request: a replayed callback must not open a second exchange.
      AppDefaults.setString(feedlyPendingOAuthStateKey, undefined);
    }
    const response: FeedlyAuthorizationResponse =
      FeedlyAPICaller.authorizationResponseFromRedirect(redirectURL);
    if (expected === undefined || expected.length === 0 || response.state !== expected) {
      throw new Error('The authorization response didn’t match the authorization request.');
    }
    return await FeedlyAccountDelegate.requestOAuthAccessToken(response);
  }

  /** Exchanges the redirect's ?code= for the access/refresh token pair. */
  static async requestOAuthAccessToken(
    response: FeedlyAuthorizationResponse): Promise<OAuthAuthorizationGrant> {
    const client: FeedlyOAuthClient | undefined = FeedlyOAuthClient.current();
    if (client === undefined) {
      throw new Error(feedlyNotConfiguredMessage);
    }
    const caller: FeedlyAPICaller = new FeedlyAPICaller();
    const tokenResponse: FeedlyOAuthAccessTokenResponse =
      await caller.requestAccessToken(client, response.code);

    const accessToken: Credentials = {
      type: CredentialsType.oauthAccessToken,
      username: tokenResponse.id,
      secret: tokenResponse.accessToken
    };
    let refreshToken: Credentials | undefined = undefined;
    if (tokenResponse.refreshToken !== undefined) {
      refreshToken = {
        type: CredentialsType.oauthRefreshToken,
        username: tokenResponse.id,
        secret: tokenResponse.refreshToken
      };
    }
    return new OAuthAuthorizationGrant(accessToken, refreshToken);
  }

  /** The caller invokes this on a 401 to refresh the OAuth credentials before retrying. */
  private async reauthorizeFeedlyAPICaller(): Promise<boolean> {
    const inFlight: Promise<boolean> | undefined = this.reauthorizeTask;
    if (inFlight !== undefined) {
      return await inFlight;
    }
    const task: Promise<boolean> = this.performReauthorization();
    this.reauthorizeTask = task;
    try {
      return await task;
    } finally {
      this.reauthorizeTask = undefined;
    }
  }

  private async performReauthorization(): Promise<boolean> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return false;
    }
    const client: FeedlyOAuthClient | undefined = FeedlyOAuthClient.current();
    if (client === undefined) {
      return false;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.validateCredentials,
      'Refreshing access token');
    try {
      const refreshCredentials: Credentials | undefined =
        await account.retrieveCredentials(CredentialsType.oauthRefreshToken);
      if (refreshCredentials === undefined) {
        throw new Error('Please add the Feedly account again.');
      }
      const response: FeedlyOAuthAccessTokenResponse =
        await this.caller.refreshAccessToken(client, refreshCredentials.secret);

      // Store the refresh token first: storeCredentials propagates the new value to this
      // delegate, and the access token has to win that race.
      if (response.refreshToken !== undefined) {
        const newRefresh: Credentials = {
          type: CredentialsType.oauthRefreshToken,
          username: response.id,
          secret: response.refreshToken
        };
        await account.storeCredentials(newRefresh);
      }
      const newAccess: Credentials = {
        type: CredentialsType.oauthAccessToken,
        username: response.id,
        secret: response.accessToken
      };
      await account.storeCredentials(newAccess);
      this.credentials = newAccess;
      account.logActivityComplete(activityID);
      return true;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'Refresh access token failed: %{public}s', String(e));
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Refreshing access token');
      return false;
    }
  }

  // MARK: - Refresh

  async refreshAll(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    if (this.credentials === undefined) {
      this.credentials = await account.retrieveCredentials(CredentialsType.oauthAccessToken);
    }
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      throw new Error('Please add the Feedly account again.');
    }
    if (this.rateLimiter.shouldSkip()) {
      return;
    }
    if (this.refreshAllIsRunning) {
      hilog.info(DOMAIN, TAG, 'Ignoring refreshAll — a refresh is already running');
      return;
    }
    this.refreshAllIsRunning = true;

    // Clear progress BEFORE addTasks: the other order wipes the counts just published.
    this.refreshProgress.reset();
    this.refreshProgress.addTasks(7);
    const startDate: Date = new Date();
    const activityID: number = account.logActivityStart(ActivityKindType.refreshAll);
    let ingestTruncated: boolean = false;

    try {
      try {
        await this.sendArticleStatusReturningCount(account);
      } catch (e) {
        // A failed status send must not block fetching new articles — unless it is a rate
        // limit, where continuing would just extend the ban.
        if (this.rateLimiter.isRateLimitError(e as Error)) {
          throw e as Error;
        }
        hilog.error(DOMAIN, TAG, 'continuing refresh despite send failure: %{public}s', String(e));
      }
      this.refreshProgress.completeTask();

      await this.refreshFeedList(account);
      this.refreshProgress.completeTask();

      const ingested: StreamIDCollection =
        await this.ingestStreamArticleIDs(account, credentials.username);
      ingestTruncated = ingested.truncated;
      this.refreshProgress.completeTask();

      await this.refreshArticleStatusReturningCounts(account, true);
      this.refreshProgress.completeTask();

      // Reuse the IDs the ingest walk just fetched instead of walking global.all twice.
      const updatedIDs: Set<string> = account.lastArticleFetchStartTime === undefined
        ? new Set<string>() : ingested.ids;
      const missingIDs: Set<string> =
        await account.fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate();
      this.refreshProgress.completeTask();

      // Updated articles first: missing ones are recomputed every sync, so they survive
      // the per-sync download cap, while a truncated update would be lost.
      const downloadIDs: string[] = arrayOf(updatedIDs);
      for (const id of arrayOf(subtractingIDs(missingIDs, updatedIDs))) {
        downloadIDs.push(id);
      }
      await this.downloadEntries(account, downloadIDs);
      this.refreshProgress.completeTask();

      await this.refreshIndividualFeeds(account);
      this.refreshProgress.completeTask();

      // Don't advance the watermark when the ID walk stopped at the page cap — the
      // unwalked window would fall outside every future fetch and be lost.
      if (!ingestTruncated) {
        account.lastArticleFetchStartTime =
          new Date(startDate.getTime() - articleFetchOverlapMillis);
      }
      account.lastRefreshCompletedDate = new Date();
      account.logActivityComplete(activityID);
    } catch (e) {
      this.refreshProgress.reset();
      const error: Error = e as Error;
      account.logActivityFail(activityID, error);
      if (this.rateLimiter.isRateLimitError(error)) {
        this.rateLimiter.noteRateLimited(error, account, 'Refreshing account');
        return;
      }
      throw account.wrapError(error);
    } finally {
      this.refreshAllIsRunning = false;
      this.refreshProgress.reset();
    }
  }

  async syncArticleStatus(): Promise<boolean> {
    const account: AccountService | undefined = this.account;
    if (account === undefined || this.rateLimiter.shouldSkip()) {
      return false;
    }
    const lastNoChange: Date | undefined = this.lastNoChangeSyncDate;
    if (lastNoChange !== undefined
      && Date.now() - lastNoChange.getTime() < noChangeBackoffMillis) {
      return false;
    }
    // refreshAll sends and refreshes statuses itself, and resetting the shared progress
    // here would wipe an in-flight refresh's task counts.
    if (this.refreshAllIsRunning) {
      return false;
    }

    try {
      const sentCount: number = await this.sendArticleStatusReturningCount(account);
      // The starred stream has no date bound, so a full starred walk every two minutes is
      // expensive; remote star changes arrive with each refreshAll instead.
      const counts: StatusChangeCounts =
        await this.refreshArticleStatusReturningCounts(account, false);
      const totalChanged: number = counts.added + counts.removed;

      this.lastNoChangeSyncDate =
        (sentCount === 0 && totalChanged === 0) ? new Date() : undefined;
      return sentCount > 0 || totalChanged > 0;
    } catch (e) {
      const error: Error = e as Error;
      if (this.rateLimiter.isRateLimitError(error)) {
        this.rateLimiter.noteRateLimited(error, account, 'Syncing article status');
        return false;
      }
      throw error;
    }
  }

  async sendArticleStatus(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined || this.rateLimiter.shouldSkip()) {
      return;
    }
    try {
      await this.sendArticleStatusReturningCount(account);
    } catch (e) {
      const error: Error = e as Error;
      if (this.rateLimiter.isRateLimitError(error)) {
        this.rateLimiter.noteRateLimited(error, account, 'Sending article status');
        return;
      }
      throw error;
    }
  }

  async refreshArticleStatus(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined || this.rateLimiter.shouldSkip()) {
      return;
    }
    try {
      await this.refreshArticleStatusReturningCounts(account, true);
    } catch (e) {
      const error: Error = e as Error;
      if (this.rateLimiter.isRateLimitError(error)) {
        this.rateLimiter.noteRateLimited(error, account, 'Refreshing article status');
        return;
      }
      throw error;
    }
  }

  private async sendArticleStatusReturningCount(account: AccountService): Promise<number> {
    const inFlight: Promise<number> | undefined = this.statusSendTask;
    if (inFlight !== undefined) {
      return await inFlight;
    }
    const task: Promise<number> = this.performStatusSend(account);
    this.statusSendTask = task;
    try {
      return await task;
    } finally {
      this.statusSendTask = undefined;
    }
  }

  private async performStatusSend(account: AccountService): Promise<number> {
    const activityID: number = account.logActivityStart(ActivityKindType.sendArticleStatuses);
    const syncStatuses: SyncStatus[] = await this.syncDatabase.selectForProcessing();

    const keys: SyncStatusKey[] = [SyncStatusKey.read, SyncStatusKey.read,
      SyncStatusKey.starred, SyncStatusKey.starred];
    const flags: boolean[] = [false, true, true, false];
    const actions: FeedlyMarkAction[] = [FeedlyMarkAction.unread, FeedlyMarkAction.read,
      FeedlyMarkAction.saved, FeedlyMarkAction.unsaved];

    let sentCount: number = 0;
    let savedError: Error | undefined = undefined;

    for (let i: number = 0; i < keys.length; i++) {
      const key: SyncStatusKey = keys[i];
      const flag: boolean = flags[i];
      const pending: SyncStatus[] =
        syncStatuses.filter((s: SyncStatus) => s.key === key && s.flag === flag);
      if (pending.length === 0) {
        continue;
      }
      let articleIDs: Set<string> =
        setOf(pending.map((status: SyncStatus) => status.articleID));

      // A mark-as-read past Feedly's marker limit can never succeed — it would requeue
      // forever and grow the backlog without bound.
      if (key === SyncStatusKey.read && flag) {
        const unmarkable: Set<string> =
          await this.unmarkableAsReadArticleIDs(account, articleIDs);
        if (unmarkable.size > 0) {
          hilog.info(DOMAIN, TAG, 'dropping %{public}d mark-as-read statuses past the limit',
            unmarkable.size);
          await this.syncDatabase.deleteSelectedForProcessing(arrayOf(unmarkable),
            SyncStatusKey.read);
          articleIDs = subtractingIDs(articleIDs, unmarkable);
        }
        if (articleIDs.size === 0) {
          continue;
        }
      }

      const chunks: string[][] = chunked(arrayOf(articleIDs), markChunkSize);
      let chunkIndex: number = 0;
      let failed: boolean = false;
      for (const chunk of chunks) {
        try {
          await this.caller.mark(chunk, actions[i]);
          await this.syncDatabase.deleteSelectedForProcessing(chunk, key);
          sentCount += chunk.length;
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'Article status sync call failed: %{public}s', String(e));
          // Reset every chunk from this one on, so a later failure can't resurrect
          // statuses the server already accepted.
          const unsent: string[] = [];
          for (let j: number = chunkIndex; j < chunks.length; j++) {
            for (const id of chunks[j]) {
              unsent.push(id);
            }
          }
          await this.syncDatabase.resetSelectedForProcessing(unsent, key);
          savedError = e as Error;
          failed = true;
          break;
        }
        chunkIndex += 1;
      }
      if (failed && savedError !== undefined
        && this.rateLimiter.isRateLimitError(savedError)) {
        break;
      }
    }

    if (savedError !== undefined) {
      if (!this.rateLimiter.isRateLimitError(savedError)) {
        account.postSyncError(savedError, 'Sending article status');
      }
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, sentCount + ' statuses sent', sentCount > 0);
    return sentCount;
  }

  /**
   * ArticleIDs whose mark-as-read can never succeed: older than the marker limit, or gone
   * from the database entirely (older still). Feedly's limit is on the crawl date, which
   * is not stored — dateArrived can't precede the crawl, so the newer of the two dates
   * being past the cutoff means the crawl certainly is.
   */
  private async unmarkableAsReadArticleIDs(account: AccountService,
    articleIDs: Set<string>): Promise<Set<string>> {
    const articles: Article[] =
      await account.fetchArticles(FetchType.forArticleIDs(arrayOf(articleIDs)));
    const datesByArticleID: Map<string, number> = new Map<string, number>();
    for (const article of articles) {
      const published: number =
        article.datePublished === undefined ? 0 : article.datePublished.getTime();
      const arrived: number = article.status.dateArrived.getTime();
      datesByArticleID.set(article.articleID, Math.max(published, arrived));
    }
    const cutoff: number = daysAgo(markAsReadDaysLimit).getTime();
    const unmarkable: Set<string> = new Set<string>();
    articleIDs.forEach((articleID: string) => {
      const date: number | undefined = datesByArticleID.get(articleID);
      if (date === undefined || date < cutoff) {
        unmarkable.add(articleID);
      }
    });
    return unmarkable;
  }

  private async refreshArticleStatusReturningCounts(account: AccountService,
    includeStarred: boolean): Promise<StatusChangeCounts> {
    const counts: StatusChangeCounts = new StatusChangeCounts();
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      return counts;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.refreshArticleStatuses);
    let refreshError: Error | undefined = undefined;

    try {
      const unread: StatusChangeCounts =
        await this.ingestUnreadArticleIDs(account, credentials.username);
      counts.added += unread.added;
      counts.removed += unread.removed;
    } catch (e) {
      // Don't start the starred walk into an active rate limit — up to 40 more requests.
      if (this.rateLimiter.isRateLimitError(e as Error)) {
        account.logActivityFail(activityID, e as Error);
        throw e as Error;
      }
      refreshError = e as Error;
      hilog.error(DOMAIN, TAG, 'Ingesting unread article IDs failed: %{public}s', String(e));
    }

    if (includeStarred) {
      try {
        const starred: StatusChangeCounts =
          await this.ingestStarredArticleIDs(account, credentials.username);
        counts.added += starred.added;
        counts.removed += starred.removed;
      } catch (e) {
        refreshError = e as Error;
        hilog.error(DOMAIN, TAG, 'Ingesting starred article IDs failed: %{public}s', String(e));
      }
    }

    if (refreshError !== undefined) {
      if (!this.rateLimiter.isRateLimitError(refreshError)) {
        account.postSyncError(refreshError, 'Refreshing article status');
      }
      account.logActivityFail(activityID, refreshError);
      throw refreshError;
    }
    account.logActivityComplete(activityID, (counts.added + counts.removed) + ' changed',
      counts.added + counts.removed > 0);
    return counts;
  }

  async importOPML(opmlFilePath: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    let file: fs.File | undefined = undefined;
    let opmlText: string = '';
    try {
      const size: number = fs.statSync(opmlFilePath).size;
      file = fs.openSync(opmlFilePath, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      fs.readSync(file.fd, buffer);
      opmlText = new util.TextDecoder().decodeToString(new Uint8Array(buffer));
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
    if (opmlText.length === 0) {
      return;
    }

    this.isOPMLImportInProgress = true;
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.importOPML, opmlFilePath);
    try {
      await this.caller.importOPML(opmlText);
      account.logActivityComplete(activityID);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.isOPMLImportInProgress = false;
      this.refreshProgress.completeTask();
    }
  }

  async createFolder(name: string): Promise<Folder> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.createFolder, name);
    try {
      const collection: FeedlyCollection = await this.caller.createCollection(name);
      const folder: Folder | undefined = account.ensureFolder(collection.label);
      if (folder === undefined) {
        throw new Error('Could not create a folder named “' + name + '”.');
      }
      folder.externalID = collection.id;
      account.structureDidChange();
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
    const id: string | undefined = folder.externalID;
    if (id === undefined) {
      throw new Error('Could not rename “' + folder.nameForDisplay + '” to “' + name + '”.');
    }
    const nameBefore: string | undefined = folder.name;
    // Optimistically apply the new name; revert on failure.
    folder.name = name;
    const activityID: number = account.logActivityStart(ActivityKindType.renameFolder,
      (nameBefore === undefined ? '' : nameBefore) + ' → ' + name);
    try {
      const collection: FeedlyCollection = await this.caller.renameCollection(id, name);
      folder.name = collection.label;
      account.structureDidChange();
      account.logActivityComplete(activityID, name);
    } catch (e) {
      folder.name = nameBefore;
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async removeFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const id: string | undefined = folder.externalID;
    if (id === undefined) {
      throw new Error('Could not remove the folder named “' + folder.nameForDisplay + '”.');
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.removeFolder,
      folder.name);
    try {
      await this.caller.deleteCollection(id);
      account.removeFolderFromTree(folder);
      account.logActivityComplete(activityID, folder.nameForDisplay);
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
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      throw new Error('Please add the Feedly account again.');
    }
    const folder: Folder | undefined = container.folder;
    if (folder === undefined) {
      throw new Error('Please choose a folder to contain the feed.');
    }
    const collectionID: string | undefined = folder.externalID;
    if (collectionID === undefined) {
      throw new Error('Feeds cannot be added to the “' + folder.nameForDisplay + '” folder.');
    }

    this.refreshProgress.addTasks(5);
    const activityID: number = account.logActivityStart(ActivityKindType.subscribeFeed, url);
    try {
      const feedID: string = await this.searchForFeed(url);
      const collectionFeeds: FeedlyFeed[] =
        await this.caller.addFeedToCollection(feedID, name, collectionID);
      let found: boolean = false;
      for (const collectionFeed of collectionFeeds) {
        if (collectionFeed.id === feedID) {
          found = true;
        }
      }
      if (!found) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }

      await this.syncFeedsForCollectionFolder(account, collectionFeeds, folder);
      await this.ingestUnreadArticleIDs(account, credentials.username);
      await this.syncStreamContents(account, feedID, false, undefined, undefined);

      const feed: Feed | undefined = account.existingFeedWithFeedID(feedID);
      if (feed === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }
      account.logActivityComplete(activityID, feed.nameForDisplay);
      return feed;
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTasks(5);
    }
  }

  /**
   * Feedly search sometimes fails to resolve a home page URL to its feed; discover the feed
   * URL locally and search again with that.
   */
  private async searchForFeed(urlString: string): Promise<string> {
    const results: string[] =
      await this.caller.searchFeeds(urlString, 1, FeedlyAccountDelegate.currentLocale());
    if (results.length > 0) {
      return results[0];
    }
    const specifiers: FeedSpecifier[] = await FeedFinder.find(urlString);
    const filtered: FeedSpecifier[] =
      specifiers.filter((s: FeedSpecifier) => !s.urlString.includes('json'));
    const best: FeedSpecifier | undefined = bestFeed(filtered);
    if (best === undefined || best.urlString === urlString) {
      throw AccountError.of(AccountErrorKind.createErrorNotFound);
    }
    const retry: string[] =
      await this.caller.searchFeeds(best.urlString, 1, FeedlyAccountDelegate.currentLocale());
    if (retry.length === 0) {
      throw AccountError.of(AccountErrorKind.createErrorNotFound);
    }
    return retry[0];
  }

  /** Locale.current.identifier — the locale Feedly's feed search is scoped to. */
  private static currentLocale(): string {
    try {
      const locale: string = i18n.System.getSystemLocale();
      return locale.length === 0 ? 'en_US' : locale;
    } catch (e) {
      return 'en_US';
    }
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    let collectionID: string | undefined = undefined;
    for (const folder of account.folders()) {
      if (folder.containsFeed(feed) && folder.externalID !== undefined) {
        collectionID = folder.externalID;
        break;
      }
    }
    if (collectionID === undefined) {
      throw new Error('Could not rename “' + feed.nameForDisplay + '” to “' + name + '”.');
    }

    const editedNameBefore: string | undefined = feed.editedName;
    // Optimistically set the name; revert on failure.
    feed.editedName = name;
    const activityID: number = account.logActivityStart(ActivityKindType.renameFeed, feed.url);
    try {
      // Adding an existing feed updates it — in every collection that holds it.
      await this.caller.addFeedToCollection(feed.feedID, name, collectionID);
      await account.persistFeedSettings(feed);
      account.logActivityComplete(activityID, name);
    } catch (e) {
      feed.editedName = editedNameBefore;
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    if (this.credentials === undefined) {
      throw new Error('Please add the Feedly account again.');
    }
    const folder: Folder | undefined = container.folder;
    if (folder === undefined) {
      throw new Error('Please choose a folder to contain the feed.');
    }
    const collectionID: string | undefined = folder.externalID;
    if (collectionID === undefined) {
      throw new Error('Feeds cannot be added to the “' + folder.nameForDisplay + '” folder.');
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.addFeed, feed.url);
    try {
      const collectionFeeds: FeedlyFeed[] =
        await this.caller.addFeedToCollection(feed.feedID, feed.editedName, collectionID);
      let found: boolean = false;
      for (const collectionFeed of collectionFeeds) {
        if (collectionFeed.id === feed.feedID) {
          found = true;
        }
      }
      if (!found) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }
      await this.syncFeedsForCollectionFolder(account, collectionFeeds, folder);
      account.logActivityComplete(activityID, folder.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folder: Folder | undefined = container.folder;
    const collectionID: string | undefined =
      folder === undefined ? undefined : folder.externalID;
    if (folder === undefined || collectionID === undefined) {
      throw new Error('Could not remove “' + feed.nameForDisplay + '”.');
    }

    // Optimistically remove the feed; restore on failure.
    folder.removeFeedFromTreeAtTopLevel(feed);
    account.structureDidChange();
    const activityID: number = account.logActivityStart(ActivityKindType.removeFeed, feed.url);
    try {
      await this.caller.removeFeedFromCollection(feed.feedID, collectionID);
      account.logActivityComplete(activityID, feed.nameForDisplay);
    } catch (e) {
      const error: Error = e as Error;
      if (error instanceof WebserviceError) {
        const webserviceError: WebserviceError = error as WebserviceError;
        if (webserviceError.status === 400 || webserviceError.status === 404) {
          // Feedly doesn't recognize this subscription — most likely a stale feedID. Let
          // the local removal stand, or the feed could never be deleted.
          hilog.info(DOMAIN, TAG, 'Feedly returned %{public}d removing %{public}s — removing'
            + ' locally anyway', webserviceError.status, feed.url);
          account.logActivityComplete(activityID, feed.nameForDisplay);
          return;
        }
      }
      folder.addFeedToTreeAtTopLevel(feed);
      account.structureDidChange();
      account.logActivityFail(activityID, error);
      throw error;
    }
  }

  async moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const from: Folder | undefined = sourceContainer.folder;
    const to: Folder | undefined = destinationContainer.folder;
    const fromCollectionID: string | undefined = from === undefined ? undefined : from.externalID;
    const toCollectionID: string | undefined = to === undefined ? undefined : to.externalID;
    if (from === undefined || to === undefined || fromCollectionID === undefined
      || toCollectionID === undefined) {
      throw new Error('Please choose a folder to contain the feed.');
    }

    const activityID: number = account.logActivityStart(ActivityKindType.moveFeed, feed.url);
    // Optimistically move the feed.
    from.removeFeedFromTreeAtTopLevel(feed);
    to.addFeedToTreeAtTopLevel(feed);
    account.structureDidChange();

    try {
      await this.caller.addFeedToCollection(feed.feedID, feed.editedName, toCollectionID);
    } catch (e) {
      from.addFeedToTreeAtTopLevel(feed);
      to.removeFeedFromTreeAtTopLevel(feed);
      account.structureDidChange();
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }

    try {
      await this.caller.removeFeedFromCollection(feed.feedID, fromCollectionID);
      account.logActivityComplete(activityID, to.nameForDisplay);
    } catch (e) {
      // Undo the whole move: without removing the remote add and the local destination
      // copy, the feed ends up in both folders permanently.
      try {
        await this.caller.removeFeedFromCollection(feed.feedID, toCollectionID);
      } catch (removeError) {
        hilog.error(DOMAIN, TAG, 'undo move failed: %{public}s', String(removeError));
      }
      to.removeFeedFromTreeAtTopLevel(feed);
      from.addFeedToTreeAtTopLevel(feed);
      account.structureDidChange();
      account.logActivityFail(activityID, e as Error);
      throw new Error('Could not move “' + feed.nameForDisplay + '” to “'
        + to.nameForDisplay + '”.');
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
    const activityID: number = account.logActivityStart(ActivityKindType.restoreFolder,
      folder.name);
    try {
      // removeFolder deleted the collection: recreate it first, or restoring the feeds
      // would target a dead collection ID.
      const collection: FeedlyCollection =
        await this.caller.createCollection(folder.name === undefined ? '' : folder.name);
      folder.externalID = collection.id;

      const container: ContainerRef = ContainerRef.forFolder(account, folder);
      for (const feed of folder.topLevelFeeds.slice()) {
        folder.removeFeedFromTreeAtTopLevel(feed);
        try {
          await this.restoreFeed(feed, container);
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'Restore folder feed error: %{public}s', String(e));
          account.postSyncError(e as Error, 'Restoring feed');
        }
      }
      account.addFolderToTree(folder);
      account.logActivityComplete(activityID, folder.nameForDisplay);
    } catch (e) {
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
    const changedArticleIDs: string[] = await account.updateStatuses(articleIDs, statusKey, flag);
    const syncStatuses: SyncStatus[] = [];
    for (const articleID of changedArticleIDs) {
      syncStatuses.push(makeSyncStatus(articleID, syncStatusKeyFromArticleStatusKey(statusKey),
        flag));
    }
    await this.syncDatabase.insertStatuses(syncStatuses);
    if (syncStatuses.length > 0) {
      this.lastNoChangeSyncDate = undefined;
    }

    if (!this.rateLimiter.shouldSkip()) {
      const pendingCount: number = await this.syncDatabase.selectPendingCount();
      if (pendingCount > pendingStatusSendThreshold) {
        this.sendArticleStatus().catch((e: Object): void => {
          hilog.error(DOMAIN, TAG, 'background status flush failed: %{public}s', String(e));
        });
      }
    }
  }

  /** Feedly validates through the OAuth refresh flow, not through this entry point. */
  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    return credentials;
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
      account.retrieveCredentials(CredentialsType.oauthAccessToken)
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

  private async refreshFeedList(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshFeedList);
    try {
      const collections: FeedlyCollection[] = await this.caller.getCollections();
      const pairs: CollectionFolderPair[] = this.mirrorCollectionsAsFolders(account, collections);
      for (const pair of pairs) {
        await this.syncFeedsForCollectionFolder(account, pair.feeds, pair.folder);
      }
      account.logActivityComplete(activityID, collections.length + ' collections');
    } catch (e) {
      if (!this.rateLimiter.isRateLimitError(e as Error)) {
        account.postSyncError(e as Error, 'Refreshing feed list');
      }
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  /**
   * One folder per collection, matched by external ID first — matching by name races a
   * local rename and could steal a folder belonging to a later collection.
   */
  private mirrorCollectionsAsFolders(account: AccountService,
    collections: FeedlyCollection[]): CollectionFolderPair[] {
    const claimed: Folder[] = [];
    const folderForCollectionID: Map<string, Folder> = new Map<string, Folder>();

    for (const collection of collections) {
      const folder: Folder | undefined = account.existingFolderWithExternalID(collection.id);
      if (folder === undefined || claimed.includes(folder)) {
        continue;
      }
      claimed.push(folder);
      folderForCollectionID.set(collection.id, folder);
      if (folder.name !== collection.label) {
        folder.name = collection.label;
      }
    }

    const pairs: CollectionFolderPair[] = [];
    for (const collection of collections) {
      const matched: Folder | undefined = folderForCollectionID.get(collection.id);
      if (matched !== undefined) {
        pairs.push(new CollectionFolderPair(collection.feeds, matched));
        continue;
      }
      // No ID match: find or create by name, disambiguating a label another collection
      // already claimed.
      let name: string = collection.label;
      let suffix: number = 2;
      while (true) {
        const folder: Folder | undefined = account.ensureFolder(name);
        if (folder === undefined) {
          break;
        }
        if (claimed.includes(folder)) {
          name = collection.label + ' (' + suffix + ')';
          suffix += 1;
          continue;
        }
        claimed.push(folder);
        folder.externalID = collection.id;
        pairs.push(new CollectionFolderPair(collection.feeds, folder));
        break;
      }
    }

    // Remove folders without a corresponding collection.
    for (const folder of account.folders().slice()) {
      if (!claimed.includes(folder)) {
        account.removeFolderFromTree(folder);
      }
    }
    return pairs;
  }

  /** Reconciles one folder's feed membership against the collection that produced it. */
  private async syncFeedsForCollectionFolder(account: AccountService,
    collectionFeeds: FeedlyFeed[], folder: Folder): Promise<void> {
    const collectionFeedIDs: string[] = collectionFeeds.map((feed: FeedlyFeed) => feed.id);

    const feedsToRemove: Feed[] =
      folder.topLevelFeeds.filter((feed: Feed) => !collectionFeedIDs.includes(feed.feedID));
    if (feedsToRemove.length > 0) {
      folder.removeFeedsFromTreeAtTopLevel(feedsToRemove);
    }

    for (const collectionFeed of collectionFeeds) {
      const title: string | undefined = sanitizeFeedlyText(collectionFeed.title);
      const existing: Feed | undefined = account.existingFeedWithFeedID(collectionFeed.id);
      if (existing !== undefined) {
        // Compare against the PARSED title: the raw title differs for RTL and untitled
        // feeds, so comparing it rewrote their names every sync.
        if (existing.name !== title) {
          existing.name = title;
          if (existing.editedName !== undefined) {
            existing.editedName = undefined;
          }
          await account.persistFeedSettings(existing);
        }
        if (!folder.containsFeed(existing)) {
          folder.addFeedToTreeAtTopLevel(existing);
        }
        continue;
      }
      const feed: Feed = account.createFeedWith(title,
        feedlyFeedResourceURL(collectionFeed.id), collectionFeed.id, collectionFeed.website);
      feed.externalID = collectionFeed.id;
      await account.persistFeedSettings(feed);
      folder.addFeedToTreeAtTopLevel(feed);
    }
    account.structureDidChange();
  }

  /**
   * Pages global.all's stream IDs, creating a status for each so downstream status sync has
   * something to attach to. Bounded — walking the whole history every sync was most of the
   * request volume that got users rate limited.
   */
  private async ingestStreamArticleIDs(account: AccountService,
    userID: string): Promise<StreamIDCollection> {
    const resourceID: string = feedlyAllResourceID(userID);
    const lastFetch: Date | undefined = account.lastArticleFetchStartTime;
    const floor: Date = daysAgo(streamIngestDaysLimit);
    const newerThan: Date = (lastFetch !== undefined && lastFetch.getTime() > floor.getTime())
      ? lastFetch : floor;

    const activityID: number = account.logActivityStart(ActivityKindType.fetchArticleIDs,
      'All articles');
    const collected: Set<string> = new Set<string>();
    let continuation: string | undefined = undefined;
    let pageCount: number = 0;
    try {
      while (true) {
        const page: FeedlyStreamIDs =
          await this.caller.getStreamIDs(resourceID, continuation, newerThan, undefined);
        await account.createStatusesIfNeeded(page.ids);
        for (const id of page.ids) {
          collected.add(id);
        }
        continuation = page.continuation;
        pageCount += 1;
        if (continuation === undefined || pageCount >= maxStreamPageCount) {
          break;
        }
      }
      account.logActivityComplete(activityID, collected.size + ' article IDs');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
    if (continuation !== undefined) {
      hilog.info(DOMAIN, TAG, 'stopped the article ID walk at the page cap');
    }
    return new StreamIDCollection(collected, continuation !== undefined);
  }

  /** Mirrors the remote unread set onto local statuses, skipping pending local edits. */
  private async ingestUnreadArticleIDs(account: AccountService,
    userID: string): Promise<StatusChangeCounts> {
    const resourceID: string = feedlyAllResourceID(userID);
    const collection: StreamIDCollection = await this.collectStreamIDs(resourceID,
      daysAgo(streamIngestDaysLimit), true);
    const localUnread: Set<string> = await account.fetchUnreadArticleIDs();

    // Read the pending set LAST, right before the diffs: an edit made during the fetches
    // above must be in it, or the marks below would briefly revert it.
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingReadStatusArticleIDs());
    const adjustedRemote: Set<string> = subtractingIDs(collection.ids, pending);

    const newlyUnread: Set<string> = subtractingIDs(adjustedRemote, localUnread);
    await account.markAsUnread(adjustedRemote);

    const counts: StatusChangeCounts = new StatusChangeCounts();
    counts.added = newlyUnread.size;
    // A truncated walk is not authoritative about absence: marking read from it would
    // flip everything past the page cap.
    if (!collection.truncated) {
      const toMarkRead: Set<string> =
        subtractingIDs(subtractingIDs(localUnread, adjustedRemote), pending);
      await account.markAsRead(toMarkRead);
      counts.removed = toMarkRead.size;
    }
    return counts;
  }

  private async ingestStarredArticleIDs(account: AccountService,
    userID: string): Promise<StatusChangeCounts> {
    const resourceID: string = feedlySavedResourceID(userID);
    const collection: StreamIDCollection =
      await this.collectStreamIDs(resourceID, undefined, undefined);
    const localStarred: Set<string> = await account.fetchStarredArticleIDs();

    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingStarredStatusArticleIDs());
    const adjustedRemote: Set<string> = subtractingIDs(collection.ids, pending);

    const newlyStarred: Set<string> = subtractingIDs(adjustedRemote, localStarred);
    await account.markAsStarred(adjustedRemote);

    const counts: StatusChangeCounts = new StatusChangeCounts();
    counts.added = newlyStarred.size;
    if (!collection.truncated) {
      const toUnstar: Set<string> =
        subtractingIDs(subtractingIDs(localStarred, adjustedRemote), pending);
      await account.markAsUnstarred(toUnstar);
      counts.removed = toUnstar.size;
    }
    return counts;
  }

  private async collectStreamIDs(resourceID: string, newerThan: Date | undefined,
    unreadOnly: boolean | undefined): Promise<StreamIDCollection> {
    const collected: Set<string> = new Set<string>();
    let continuation: string | undefined = undefined;
    let pageCount: number = 0;
    while (true) {
      const page: FeedlyStreamIDs =
        await this.caller.getStreamIDs(resourceID, continuation, newerThan, unreadOnly);
      for (const id of page.ids) {
        collected.add(id);
      }
      continuation = page.continuation;
      pageCount += 1;
      if (continuation === undefined || pageCount >= maxStreamPageCount) {
        break;
      }
    }
    if (continuation !== undefined) {
      hilog.info(DOMAIN, TAG, 'stopped a stream ID walk at the page cap');
    }
    return new StreamIDCollection(collected, continuation !== undefined);
  }

  /** Fetches full entries in 1000-ID chunks, in order — the front survives the cap. */
  private async downloadEntries(account: AccountService, articleIDs: string[]): Promise<number> {
    if (articleIDs.length === 0) {
      return 0;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.refreshMissingArticles);
    try {
      let ingested: number = 0;
      const chunks: string[][] = chunked(articleIDs, articleDownloadChunkSize);
      const limit: number = Math.min(chunks.length, maxArticleDownloadChunksPerSync);
      if (chunks.length > maxArticleDownloadChunksPerSync) {
        hilog.info(DOMAIN, TAG, 'downloading %{public}d of %{public}d articles this sync',
          maxArticleDownloadChunksPerSync * articleDownloadChunkSize, articleIDs.length);
      }
      for (let i: number = 0; i < limit; i++) {
        const entries: FeedlyEntry[] = await this.caller.getEntries(chunks[i]);
        const result: IngestResult = await this.ingest(account, entries);
        ingested += result.newArticleCount;
      }
      account.logActivityComplete(activityID, ingested + ' articles');
      return ingested;
    } catch (e) {
      if (!this.rateLimiter.isRateLimitError(e as Error)) {
        account.postSyncError(e as Error, 'Downloading articles');
      }
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  /**
   * Directly refreshes a few of the least-recently-checked feeds each sync, backfilling
   * articles the aggregate global.all stream doesn't return.
   */
  private async refreshIndividualFeeds(account: AccountService): Promise<number> {
    const now: Date = new Date();
    const due: Feed[] = account.flattenedFeeds().filter((feed: Feed): boolean => {
      const lastCheckDate: Date | undefined = feed.lastCheckDate;
      return lastCheckDate === undefined
        || now.getTime() - lastCheckDate.getTime() >= minimumFeedRefreshIntervalMillis;
    });
    due.sort((a: Feed, b: Feed): number => {
      const aDate: number = a.lastCheckDate === undefined ? 0 : a.lastCheckDate.getTime();
      const bDate: number = b.lastCheckDate === undefined ? 0 : b.lastCheckDate.getTime();
      return aDate - bDate;
    });

    let newArticleCount: number = 0;
    const selected: Feed[] = due.slice(0, Math.min(due.length, feedsToRefreshPerSync));
    for (const feed of selected) {
      const lastCheckDate: Date | undefined = feed.lastCheckDate;
      // Mark the attempt: a failed feed retries next rotation, not immediately.
      feed.lastCheckDate = now;
      await account.persistFeedSettings(feed);
      const activityID: number = account.logActivityStart(ActivityKindType.refreshFeedContent,
        feed.nameForDisplay, feed.url);
      try {
        const newerThan: Date = lastCheckDate === undefined
          ? daysAgo(streamIngestDaysLimit) : lastCheckDate;
        const result: IngestResult = await this.syncStreamContents(account, feed.feedID, true,
          newerThan, individualFeedRefreshCount);
        newArticleCount += result.newArticleCount;
        // ingest marks new articles read by default; restore the server's unread state.
        if (result.newUnreadArticleIDs.size > 0) {
          await account.markAsUnread(result.newUnreadArticleIDs);
        }
        account.logActivityComplete(activityID, result.newArticleCount + ' new articles');
      } catch (e) {
        account.logActivityFail(activityID, e as Error);
        // Arm the limiter and stop the rotation — more feeds would extend the ban.
        if (this.rateLimiter.isRateLimitError(e as Error)) {
          this.rateLimiter.noteRateLimited(e as Error, account,
            'Refreshing feed ' + feed.nameForDisplay);
          break;
        }
        account.postSyncError(e as Error, 'Refreshing feed ' + feed.nameForDisplay);
      }
    }
    return newArticleCount;
  }

  private async syncStreamContents(account: AccountService, resourceID: string,
    paginated: boolean, newerThan: Date | undefined, count?: number): Promise<IngestResult> {
    const result: IngestResult = new IngestResult();
    let continuation: string | undefined = undefined;
    let pageCount: number = 0;
    while (true) {
      const stream: FeedlyStream = await this.caller.getStreamContents(resourceID, continuation,
        newerThan, undefined, count);
      const pageResult: IngestResult = await this.ingest(account, stream.items);
      result.newArticleCount += pageResult.newArticleCount;
      pageResult.newUnreadArticleIDs.forEach((id: string) => {
        result.newUnreadArticleIDs.add(id);
      });
      continuation = paginated ? stream.continuation : undefined;
      pageCount += 1;
      if (continuation === undefined || pageCount >= maxStreamPageCount) {
        break;
      }
    }
    if (continuation !== undefined) {
      hilog.info(DOMAIN, TAG, 'stopped a stream contents walk at the page cap');
    }
    return result;
  }

  private async ingest(account: AccountService, entries: FeedlyEntry[]): Promise<IngestResult> {
    const parsedItems: ParsedItem[] = [];
    for (const entry of entries) {
      const item: ParsedItem | undefined = FeedlyAccountDelegate.parsedItemFor(entry);
      if (item !== undefined) {
        parsedItems.push(item);
      }
    }
    const feedIDsAndItems: Map<string, ParsedItem[]> = new Map<string, ParsedItem[]>();
    for (const item of parsedItems) {
      const existing: ParsedItem[] | undefined = feedIDsAndItems.get(item.feedURL);
      if (existing === undefined) {
        feedIDsAndItems.set(item.feedURL, [item]);
      } else {
        existing.push(item);
      }
    }
    const changes: ArticleChanges = await account.updateFeedIDsAndItems(feedIDsAndItems, true);

    const newArticleIDs: Set<string> = new Set<string>();
    for (const article of changes.newArticles) {
      newArticleIDs.add(article.articleID);
    }
    const unreadEntryIDs: Set<string> = new Set<string>();
    for (const entry of entries) {
      if (entry.unread) {
        unreadEntryIDs.add(entry.id);
      }
    }

    const result: IngestResult = new IngestResult();
    result.newArticleCount = newArticleIDs.size;
    newArticleIDs.forEach((id: string) => {
      if (unreadEntryIDs.has(id)) {
        result.newUnreadArticleIDs.add(id);
      }
    });
    return result;
  }

  private static parsedItemFor(entry: FeedlyEntry): ParsedItem | undefined {
    const feedURL: string | undefined = feedlyEntryFeedURL(entry);
    if (feedURL === undefined) {
      return undefined;
    }
    let authors: ParsedAuthor[] | undefined = undefined;
    const authorName: string | undefined = entry.author;
    if (authorName !== undefined) {
      const author: ParsedAuthor = {
        name: authorName,
        url: undefined,
        avatarURL: undefined,
        emailAddress: undefined
      };
      authors = [author];
    }
    let tags: string[] | undefined = undefined;
    const entryTags: FeedlyTag[] | undefined = entry.tags;
    if (entryTags !== undefined && entryTags.length > 0) {
      tags = [];
      for (const tag of entryTags) {
        const label: string | undefined = tag.label;
        if (label !== undefined) {
          tags.push(label);
        }
      }
    }
    const item: ParsedItem = {
      syncServiceID: entry.id,
      uniqueID: entry.id,
      feedURL: feedURL,
      externalURL: feedlyEntryExternalURL(entry),
      title: entry.title,
      contentHTML: feedlyEntryContentHTML(entry),
      summary: feedlyEntrySummary(entry),
      datePublished: feedlyEntryDatePublished(entry),
      dateModified: entry.recrawled,
      authors: authors,
      tags: tags
    };
    return item;
  }
}
