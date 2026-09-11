/**
 * ReaderAPIAccountDelegate — port of
 * Modules/Account/Sources/Account/ReaderAPI/{ReaderAPIAccountDelegate,ReaderAPICaller,
 * ReaderAPIVariant}.swift
 *
 * ONE delegate serving FOUR AccountTypes — freshRSS, inoreader, bazQux, theOldReader.
 * The provider-conditional parts are all here:
 *   • the endpoint host: a fixed host for inoreader / bazQux / theOldReader, and the
 *     user-supplied endpointURL for the self-hosted freshRSS,
 *   • behaviors: disallowFeedInMultipleFolders everywhere, plus disallowFeedInRootFolder
 *     for freshRSS,
 *   • folder tags: Inoreader filters by type == "folder", the others by "/label/",
 *   • article IDs: The Old Reader sends them verbatim, the rest as zero-padded 16-digit hex,
 *   • Inoreader reports a per-zone API quota and skips status DOWNLOADS near the limit
 *     (sends still go out — skipping those loses stars).
 *
 * Auth is Google ClientLogin: an Email/Passwd POST yields an Auth token used as
 * "GoogleLogin auth=…", and every write additionally carries a short-lived T= token.
 */

import fs from '@ohos.file.fs';
import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior, AccountBehaviorKind } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { ActivityKindType } from '../../model/Activity';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Credentials, CredentialsType } from '../../model/Credentials';
import { DownloadResponse } from '../../model/DownloadResponse';
import { Feed } from '../../model/Feed';
import { FeedSpecifier, bestFeed } from '../../model/FeedSpecifier';
import { Folder } from '../../model/Folder';
import { HTTPConditionalGetInfo, conditionalGetInfoFromHeaders, conditionalGetRequestHeaders }
  from '../../model/HTTPConditionalGetInfo';
import { ParsedAuthor } from '../../model/ParsedAuthor';
import { ParsedItem } from '../../model/ParsedItem';
import { ProgressInfo } from '../../model/ProgressInfo';
import {
  ReaderAPIAlternateLocation, ReaderAPIAlternateLocationWire, ReaderAPIArticleSummary,
  ReaderAPIEntry, ReaderAPIEntryOrigin, ReaderAPIEntryWire, readerAPIEntryDatePublished,
  readerAPIEntryFromJSON, uniqueIDForEntry
} from '../../model/ReaderAPIEntry';
import {
  ReaderAPICategoryWire, ReaderAPISubscription, ReaderAPISubscriptionWire, ReaderAPITag,
  ReaderAPITagWire, readerAPISubscriptionFromJSON, readerAPISubscriptionURL,
  readerAPITagFolderName, readerAPITagFromJSON
} from '../../model/ReaderAPISubscription';
import { SyncStatus, SyncStatusKey, makeSyncStatus, syncStatusKeyFromArticleStatusKey }
  from '../../model/SyncStatus';
import { SyncDatabase } from '../db/SyncDatabase';
import { FeedFinder } from '../net/FeedFinder';
import { Downloader, HTTPMethod, HTTPRequestHeader, HTTPResponseCode } from '../net/DownloadSession';
import {
  JsonObject, getNumber, getObject, getObjectArray, getString, getStringArray
} from '../util/Json';
import { RSProgress } from '../util/Progress';
import { AccountService, ContainerRef } from './Account';
import {
  AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener, SyncRateLimiter,
  WebserviceError, WebserviceErrorKind, appendQueryItems, arrayOf, chunked,
  decodingFullwidthEscapedCharacters, isCredentialsErrorStatus, jsonObjectOf, requireOK,
  responseDate, responseHeader, setOf, statusCodeOf, subtractingIDs, textOf
} from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'ReaderAPI';

export enum ReaderAPIVariant {
  generic = 'generic',
  freshRSS = 'freshRSS',
  inoreader = 'inoreader',
  bazQux = 'bazQux',
  theOldReader = 'theOldReader'
}

/** ReaderAPIVariant.host — empty for the self-hosted variants, which supply their own. */
export function readerAPIVariantHost(variant: ReaderAPIVariant): string {
  if (variant === ReaderAPIVariant.inoreader) {
    return 'https://www.inoreader.com';
  }
  if (variant === ReaderAPIVariant.bazQux) {
    return 'https://bazqux.com';
  }
  if (variant === ReaderAPIVariant.theOldReader) {
    return 'https://theoldreader.com';
  }
  return '';
}

export class ReaderAPIEndpoints {
  static readonly login: string = '/accounts/ClientLogin';
  static readonly token: string = '/reader/api/0/token';
  static readonly disableTag: string = '/reader/api/0/disable-tag';
  static readonly renameTag: string = '/reader/api/0/rename-tag';
  static readonly tagList: string = '/reader/api/0/tag/list';
  static readonly subscriptionList: string = '/reader/api/0/subscription/list';
  static readonly subscriptionEdit: string = '/reader/api/0/subscription/edit';
  static readonly subscriptionAdd: string = '/reader/api/0/subscription/quickadd';
  static readonly subscriptionImport: string = '/reader/api/0/subscription/import';
  static readonly contents: string = '/reader/api/0/stream/items/contents';
  static readonly itemIds: string = '/reader/api/0/stream/items/ids';
  static readonly editTag: string = '/reader/api/0/edit-tag';
}

class ReaderState {
  static readonly read: string = 'user/-/state/com.google/read';
  static readonly starred: string = 'user/-/state/com.google/starred';
}

class ReaderStreams {
  static readonly readingList: string = 'user/-/state/com.google/reading-list';
}

class ReaderAPIConditionalGetKeys {
  static readonly subscriptions: string = 'subscriptions';
  static readonly tags: string = 'tags';
}

export enum ItemIDType {
  unread = 'unread',
  starred = 'starred',
  allForAccount = 'allForAccount',
  allForFeed = 'allForFeed'
}

/** Inoreader's per-zone API usage, reported on every response. Zone 1 is reads. */
export class ReaderAPIUsageLimits {
  readonly zone1Usage: number;
  readonly zone1Limit: number;
  readonly resetDate: Date;

  constructor(zone1Usage: number, zone1Limit: number, resetDate: Date) {
    this.zone1Usage = zone1Usage;
    this.zone1Limit = zone1Limit;
    this.resetDate = resetDate;
  }
}

class UsageLimitHeader {
  static readonly zone1Usage: string = 'X-Reader-Zone1-Usage';
  static readonly zone1Limit: string = 'X-Reader-Zone1-Limit';
  static readonly resetAfter: string = 'X-Reader-Limits-Reset-After';
}

const defaultUsageLimitsResetAfterSeconds: number = 60 * 60 * 24;

export enum CreateReaderAPISubscriptionResultKind {
  created = 'created',
  notFound = 'notFound'
}

export class CreateReaderAPISubscriptionResult {
  readonly kind: CreateReaderAPISubscriptionResultKind;
  readonly subscription?: ReaderAPISubscription;

  constructor(kind: CreateReaderAPISubscriptionResultKind,
    subscription?: ReaderAPISubscription) {
    this.kind = kind;
    this.subscription = subscription;
  }
}

function monthsAgo(months: number): Date {
  const date: Date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

// MARK: - JSON -> wire mapping

function subscriptionWireFrom(json: JsonObject): ReaderAPISubscriptionWire | undefined {
  const id: string | undefined = getString(json, 'id');
  if (id === undefined) {
    return undefined;
  }
  const categories: ReaderAPICategoryWire[] = [];
  const categoryObjects: JsonObject[] | undefined = getObjectArray(json, 'categories');
  if (categoryObjects !== undefined) {
    for (const categoryObject of categoryObjects) {
      const categoryID: string | undefined = getString(categoryObject, 'id');
      if (categoryID === undefined) {
        continue;
      }
      const label: string | undefined = getString(categoryObject, 'label');
      const category: ReaderAPICategoryWire = { id: categoryID, label: label === undefined ? '' : label };
      categories.push(category);
    }
  }
  const wire: ReaderAPISubscriptionWire = {
    id: id,
    title: getString(json, 'title'),
    categories: categories,
    url: getString(json, 'url'),
    htmlUrl: getString(json, 'htmlUrl'),
    iconUrl: getString(json, 'iconUrl')
  };
  return wire;
}

function entryWireFrom(json: JsonObject): ReaderAPIEntryWire | undefined {
  const id: string | undefined = getString(json, 'id');
  if (id === undefined) {
    return undefined;
  }
  const summary: ReaderAPIArticleSummary = { content: undefined };
  const summaryObject: JsonObject | undefined = getObject(json, 'summary');
  if (summaryObject !== undefined) {
    summary.content = getString(summaryObject, 'content');
  }
  let alternates: ReaderAPIAlternateLocationWire[] | undefined = undefined;
  const alternateObjects: JsonObject[] | undefined = getObjectArray(json, 'alternate');
  if (alternateObjects !== undefined) {
    alternates = [];
    for (const alternateObject of alternateObjects) {
      const alternate: ReaderAPIAlternateLocationWire = {
        href: getString(alternateObject, 'href')
      };
      alternates.push(alternate);
    }
  }
  const origin: ReaderAPIEntryOrigin = { streamId: undefined, title: undefined };
  const originObject: JsonObject | undefined = getObject(json, 'origin');
  if (originObject !== undefined) {
    origin.streamId = getString(originObject, 'streamId');
    origin.title = getString(originObject, 'title');
  }
  const categories: string[] | undefined = getStringArray(json, 'categories');
  const wire: ReaderAPIEntryWire = {
    id: id,
    title: getString(json, 'title'),
    author: getString(json, 'author'),
    summary: summary,
    alternate: alternates,
    categories: categories === undefined ? [] : categories,
    published: getNumber(json, 'published'),
    crawlTimeMsec: getString(json, 'crawlTimeMsec'),
    timestampUsec: getString(json, 'timestampUsec'),
    origin: origin
  };
  return wire;
}

/** One page of GET /stream/items/ids. */
class ItemIDPage {
  readonly itemIDs: string[];
  readonly continuation?: string;

  constructor(itemIDs: string[], continuation?: string) {
    this.itemIDs = itemIDs;
    this.continuation = continuation;
  }
}

// MARK: - The API caller

export class ReaderAPICaller {
  variant: ReaderAPIVariant = ReaderAPIVariant.generic;
  credentials?: Credentials;
  account?: AccountService;
  /** Set for validateCredentials, where there is no account yet. */
  endpointOverride?: string;
  usageLimits?: ReaderAPIUsageLimits;

  private accessToken?: string;
  private suspended: boolean = false;

  get server(): string | undefined {
    const baseURL: string | undefined = this.apiBaseURL;
    if (baseURL === undefined) {
      return undefined;
    }
    const withoutScheme: string = baseURL.replace(/^https?:\/\//, '');
    const slash: number = withoutScheme.indexOf('/');
    return slash < 0 ? withoutScheme : withoutScheme.substring(0, slash);
  }

  /** The fixed variant host, or the user-supplied endpoint for generic / freshRSS. */
  get apiBaseURL(): string | undefined {
    const override: string | undefined = this.endpointOverride;
    if (override !== undefined) {
      return ReaderAPICaller.trimTrailingSlash(override);
    }
    if (this.variant === ReaderAPIVariant.generic || this.variant === ReaderAPIVariant.freshRSS) {
      const account: AccountService | undefined = this.account;
      const endpointURL: string | undefined = account === undefined
        ? undefined : account.endpointURL;
      return endpointURL === undefined ? undefined
        : ReaderAPICaller.trimTrailingSlash(endpointURL);
    }
    return readerAPIVariantHost(this.variant);
  }

  private static trimTrailingSlash(urlString: string): string {
    return urlString.endsWith('/') ? urlString.substring(0, urlString.length - 1) : urlString;
  }

  cancelAll(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  private requireBaseURL(): string {
    if (this.suspended) {
      throw WebserviceError.suspended();
    }
    const baseURL: string | undefined = this.apiBaseURL;
    if (baseURL === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    return baseURL;
  }

  /** Inoreader requires its app credentials on every request. */
  private variantHeaders(): Map<string, string> {
    const headers: Map<string, string> = new Map<string, string>();
    if (this.variant === ReaderAPIVariant.inoreader) {
      // The source substitutes SecretKey.inoreaderAppID/AppKey at build time. A
      // self-signed build has no such secrets store, so the headers are only sent when
      // the operator supplies them through the account settings.
      const account: AccountService | undefined = this.account;
      if (account !== undefined) {
        const externalID: string | undefined = account.externalID;
        if (externalID !== undefined && externalID.includes(':')) {
          const parts: string[] = externalID.split(':');
          headers.set('AppId', parts[0]);
          headers.set('AppKey', parts[1]);
        }
      }
    }
    return headers;
  }

  private apiKeyHeaders(contentType?: string): Map<string, string> {
    const headers: Map<string, string> = this.variantHeaders();
    const credentials: Credentials | undefined = this.credentials;
    if (credentials !== undefined && credentials.type === CredentialsType.readerAPIKey) {
      headers.set(HTTPRequestHeader.authorization, 'GoogleLogin auth=' + credentials.secret);
    }
    if (contentType !== undefined) {
      headers.set(HTTPRequestHeader.contentType, contentType);
    }
    return headers;
  }

  private noteUsageLimits(response: DownloadResponse): void {
    const usageValue: string | undefined = responseHeader(response, UsageLimitHeader.zone1Usage);
    const limitValue: string | undefined = responseHeader(response, UsageLimitHeader.zone1Limit);
    if (usageValue === undefined || limitValue === undefined) {
      return;
    }
    const usage: number = Number.parseInt(usageValue, 10);
    const limit: number = Number.parseInt(limitValue, 10);
    if (Number.isNaN(usage) || Number.isNaN(limit) || limit <= 0) {
      return;
    }
    const resetValue: string | undefined = responseHeader(response, UsageLimitHeader.resetAfter);
    let resetAfter: number = defaultUsageLimitsResetAfterSeconds;
    if (resetValue !== undefined) {
      const parsed: number = Number.parseFloat(resetValue);
      if (!Number.isNaN(parsed)) {
        resetAfter = parsed;
      }
    }
    this.usageLimits =
      new ReaderAPIUsageLimits(usage, limit, new Date(Date.now() + resetAfter * 1000));
  }

  /** Google ClientLogin: Email/Passwd form POST, "Auth=<token>" in the body. */
  async validateCredentials(endpoint: string): Promise<Credentials | undefined> {
    const credentials: Credentials | undefined = this.credentials;
    if (credentials === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    if (this.suspended) {
      throw WebserviceError.suspended();
    }
    const headers: Map<string, string> = this.variantHeaders();
    headers.set(HTTPRequestHeader.contentType, 'application/x-www-form-urlencoded');
    const body: string = 'Email=' + encodeURIComponent(credentials.username)
      + '&Passwd=' + encodeURIComponent(credentials.secret);

    const response: DownloadResponse = await Downloader.shared.send(
      ReaderAPICaller.trimTrailingSlash(endpoint) + ReaderAPIEndpoints.login,
      HTTPMethod.post, headers, body);
    const statusCode: number = statusCodeOf(response);
    if (statusCode === 404) {
      throw AccountError.of(AccountErrorKind.urlNotFound);
    }
    if (isCredentialsErrorStatus(statusCode)) {
      return undefined;
    }
    requireOK(response);

    const rawData: string = textOf(response);
    let authString: string | undefined = undefined;
    for (const line of rawData.split('\n')) {
      const items: string[] = line.split('=');
      if (items.length === 2 && items[0] === 'Auth') {
        authString = items[1];
      }
    }
    if (authString === undefined) {
      return undefined;
    }
    const apiCredentials: Credentials = {
      type: CredentialsType.readerAPIKey,
      username: credentials.username,
      secret: authString
    };
    this.credentials = apiCredentials;
    return apiCredentials;
  }

  /** The short-lived write token every mutating call carries as T=. */
  async requestAuthorizationToken(baseURL: string): Promise<string> {
    const cached: string | undefined = this.accessToken;
    if (cached !== undefined) {
      return cached;
    }
    const response: DownloadResponse = await Downloader.shared.send(
      baseURL + ReaderAPIEndpoints.token, HTTPMethod.get, this.apiKeyHeaders());
    requireOK(response);
    let token: string = textOf(response);
    if (token.endsWith('\n')) {
      token = token.substring(0, token.length - 1);
    }
    if (token.length === 0) {
      throw new WebserviceError(WebserviceErrorKind.noData);
    }
    this.accessToken = token;
    return token;
  }

  /**
   * Runs a token-authenticated request, refetching the token and retrying once on 401/403 —
   * write tokens are short-lived, and a stale one would otherwise fail every sync.
   */
  async withWriteToken<T>(baseURL: string,
    operation: (token: string) => Promise<T>): Promise<T> {
    const token: string = await this.requestAuthorizationToken(baseURL);
    try {
      return await operation(token);
    } catch (e) {
      if (e instanceof WebserviceError) {
        const webserviceError: WebserviceError = e as WebserviceError;
        if (webserviceError.kind === WebserviceErrorKind.httpError
          && isCredentialsErrorStatus(webserviceError.status)) {
          this.accessToken = undefined;
          const freshToken: string = await this.requestAuthorizationToken(baseURL);
          return await operation(freshToken);
        }
      }
      throw e as Error;
    }
  }

  private conditionalHeaders(key: string): Map<string, string> {
    const headers: Map<string, string> = this.apiKeyHeaders();
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return headers;
    }
    const info: HTTPConditionalGetInfo | undefined = account.conditionalGetInfoFor(key);
    if (info === undefined) {
      return headers;
    }
    conditionalGetRequestHeaders(info).forEach((value: string, name: string) => {
      headers.set(name, value);
    });
    return headers;
  }

  private storeConditionalGet(key: string, response: DownloadResponse): void {
    const account: AccountService | undefined = this.account;
    const headers: Map<string, string> | undefined = response.headers;
    if (account === undefined || headers === undefined) {
      return;
    }
    account.setConditionalGetInfo(conditionalGetInfoFromHeaders(headers), key);
  }

  /** Undefined on a 304 — the caller then skips syncing. */
  async retrieveTags(): Promise<ReaderAPITag[] | undefined> {
    const baseURL: string = this.requireBaseURL();
    const query: Map<string, string> = new Map<string, string>();
    query.set('output', 'json');
    if (this.variant === ReaderAPIVariant.inoreader) {
      query.set('types', '1');
    }
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(baseURL + ReaderAPIEndpoints.tagList, query), HTTPMethod.get,
      this.conditionalHeaders(ReaderAPIConditionalGetKeys.tags));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(ReaderAPIConditionalGetKeys.tags, response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return undefined;
    }
    const tagObjects: JsonObject[] | undefined = getObjectArray(json, 'tags');
    if (tagObjects === undefined) {
      return undefined;
    }
    const tags: ReaderAPITag[] = [];
    for (const tagObject of tagObjects) {
      const id: string | undefined = getString(tagObject, 'id');
      if (id === undefined) {
        continue;
      }
      const wire: ReaderAPITagWire = { id: id, type: getString(tagObject, 'type') };
      tags.push(readerAPITagFromJSON(wire));
    }
    return tags;
  }

  async renameTag(oldName: string, newName: string): Promise<void> {
    const baseURL: string = this.requireBaseURL();
    const oldTagName: string = 'user/-/label/' + encodeURIComponent(oldName);
    const newTagName: string = 'user/-/label/' + encodeURIComponent(newName);
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      const body: string = 'T=' + token + '&s=' + oldTagName + '&dest=' + newTagName;
      const response: DownloadResponse = await Downloader.shared.send(
        baseURL + ReaderAPIEndpoints.renameTag, HTTPMethod.post,
        this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
      requireOK(response);
    });
  }

  async deleteTag(folderExternalID: string): Promise<void> {
    const baseURL: string = this.requireBaseURL();
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      const body: string = 'T=' + token + '&s=' + folderExternalID;
      const response: DownloadResponse = await Downloader.shared.send(
        baseURL + ReaderAPIEndpoints.disableTag, HTTPMethod.post,
        this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
      requireOK(response);
    });
  }

  async retrieveSubscriptions(): Promise<ReaderAPISubscription[] | undefined> {
    const baseURL: string = this.requireBaseURL();
    const query: Map<string, string> = new Map<string, string>();
    query.set('output', 'json');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(baseURL + ReaderAPIEndpoints.subscriptionList, query), HTTPMethod.get,
      this.conditionalHeaders(ReaderAPIConditionalGetKeys.subscriptions));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(ReaderAPIConditionalGetKeys.subscriptions, response);

    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return undefined;
    }
    const subscriptionObjects: JsonObject[] | undefined = getObjectArray(json, 'subscriptions');
    if (subscriptionObjects === undefined) {
      return undefined;
    }
    const subscriptions: ReaderAPISubscription[] = [];
    for (const subscriptionObject of subscriptionObjects) {
      const wire: ReaderAPISubscriptionWire | undefined = subscriptionWireFrom(subscriptionObject);
      if (wire !== undefined) {
        subscriptions.push(readerAPISubscriptionFromJSON(wire));
      }
    }
    return subscriptions;
  }

  async createSubscription(url: string,
    name?: string): Promise<CreateReaderAPISubscriptionResult> {
    const baseURL: string = this.requireBaseURL();
    const streamID: string | undefined =
      await this.withWriteToken(baseURL, async (token: string): Promise<string | undefined> => {
        const body: string = 'T=' + token + '&quickadd=' + encodeURIComponent(url);
        const response: DownloadResponse = await Downloader.shared.send(
          baseURL + ReaderAPIEndpoints.subscriptionAdd, HTTPMethod.post,
          this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
        requireOK(response);
        const json: JsonObject | undefined = jsonObjectOf(response);
        if (json === undefined) {
          return undefined;
        }
        const numResults: number | undefined = getNumber(json, 'numResults');
        if (numResults === undefined || numResults === 0) {
          return undefined;
        }
        return getString(json, 'streamId');
      });

    if (streamID === undefined) {
      return new CreateReaderAPISubscriptionResult(CreateReaderAPISubscriptionResultKind.notFound);
    }

    // There is no call for a single subscription, so fetch them all and pick this one out.
    const subscriptions: ReaderAPISubscription[] | undefined = await this.retrieveSubscriptions();
    if (subscriptions === undefined) {
      throw AccountError.of(AccountErrorKind.createErrorNotFound);
    }
    for (const subscription of subscriptions) {
      if (subscription.feedID === streamID) {
        return new CreateReaderAPISubscriptionResult(
          CreateReaderAPISubscriptionResultKind.created, subscription);
      }
    }
    throw AccountError.of(AccountErrorKind.createErrorNotFound);
  }

  async renameSubscription(subscriptionID: string, newName: string): Promise<void> {
    await this.changeSubscription(subscriptionID, undefined, undefined, newName);
  }

  async deleteSubscription(subscriptionID: string): Promise<void> {
    const baseURL: string = this.requireBaseURL();
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      const body: string = 'T=' + token + '&s=' + subscriptionID + '&ac=unsubscribe';
      const response: DownloadResponse = await Downloader.shared.send(
        baseURL + ReaderAPIEndpoints.subscriptionEdit, HTTPMethod.post,
        this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
      requireOK(response);
    });
  }

  async createTagging(subscriptionID: string, tagName: string): Promise<void> {
    await this.changeSubscription(subscriptionID, undefined, tagName, undefined);
  }

  async deleteTagging(subscriptionID: string, tagName: string): Promise<void> {
    await this.changeSubscription(subscriptionID, tagName, undefined, undefined);
  }

  async moveSubscription(subscriptionID: string, sourceTag: string,
    destinationTag: string): Promise<void> {
    await this.changeSubscription(subscriptionID, sourceTag, destinationTag, undefined);
  }

  private async changeSubscription(subscriptionID: string, removeTagName?: string,
    addTagName?: string, title?: string): Promise<void> {
    if (removeTagName === undefined && addTagName === undefined && title === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const baseURL: string = this.requireBaseURL();
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      let postString: string = 'T=' + token + '&s=' + subscriptionID + '&ac=edit';
      if (removeTagName !== undefined) {
        postString += '&r=user/-/label/' + encodeURIComponent(removeTagName);
      }
      if (addTagName !== undefined) {
        postString += '&a=user/-/label/' + encodeURIComponent(addTagName);
      }
      if (title !== undefined) {
        postString += '&t=' + encodeURIComponent(title);
      }
      const response: DownloadResponse = await Downloader.shared.send(
        baseURL + ReaderAPIEndpoints.subscriptionEdit, HTTPMethod.post,
        this.apiKeyHeaders('application/x-www-form-urlencoded'), postString);
      requireOK(response);
    });
  }

  /**
   * The Reader API rejects every unauthenticated write, so each one carries the short-lived
   * write token — see changeSubscription/renameTag/deleteTag/quickAdd, all of which run
   * through withWriteToken. The source's importOPML is the one write that omits it
   * (ReaderAPICaller.swift:558-576), which is why BazQux, Inoreader and The Old Reader answer
   * the import POST with a 4xx and the import surfaces as "Import Failed".
   * The body has to be the OPML itself, so the token goes in the query string.
   */
  async importOPML(opmlText: string): Promise<void> {
    const baseURL: string = this.requireBaseURL();
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      const query: Map<string, string> = new Map<string, string>();
      query.set('T', token);
      const response: DownloadResponse = await Downloader.shared.send(
        appendQueryItems(baseURL + ReaderAPIEndpoints.subscriptionImport, query),
        HTTPMethod.post, this.apiKeyHeaders('text/xml'), opmlText);
      // requireOK, not a bare status check: withWriteToken only retries with a fresh token
      // when the failure arrives as a WebserviceError httpError.
      requireOK(response);
      if (statusCodeOf(response) !== HTTPResponseCode.OK) {
        throw AccountError.of(AccountErrorKind.invalidResponse);
      }
    });
  }

  async retrieveEntries(articleIDs: string[]): Promise<ReaderAPIEntry[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    const baseURL: string = this.requireBaseURL();
    const idParameters: string[] = [];
    for (const articleID of articleIDs) {
      const parameter: string | undefined = this.itemIDParameter(articleID);
      if (parameter !== undefined) {
        idParameters.push(parameter);
      }
    }
    if (idParameters.length === 0) {
      return [];
    }

    const entries: ReaderAPIEntry[] | undefined = await this.withWriteToken(baseURL,
      async (token: string): Promise<ReaderAPIEntry[] | undefined> => {
        const body: string = 'T=' + token + '&output=json&' + idParameters.join('&');
        const response: DownloadResponse = await Downloader.shared.send(
          baseURL + ReaderAPIEndpoints.contents, HTTPMethod.post,
          this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
        requireOK(response);
        this.noteUsageLimits(response);

        const json: JsonObject | undefined = jsonObjectOf(response);
        if (json === undefined) {
          return undefined;
        }
        const itemObjects: JsonObject[] | undefined = getObjectArray(json, 'items');
        if (itemObjects === undefined) {
          return undefined;
        }
        const parsed: ReaderAPIEntry[] = [];
        for (const itemObject of itemObjects) {
          const wire: ReaderAPIEntryWire | undefined = entryWireFrom(itemObject);
          if (wire !== undefined) {
            parsed.push(readerAPIEntryFromJSON(wire));
          }
        }
        return parsed;
      });

    if (entries === undefined) {
      throw AccountError.of(AccountErrorKind.invalidResponse);
    }
    return entries;
  }

  /** Walks every continuation page of /stream/items/ids for the requested stream. */
  async retrieveItemIDs(type: ItemIDType, feedID?: string,
    pageHandler?: (count: number) => void): Promise<string[]> {
    const baseURL: string = this.requireBaseURL();
    const query: Map<string, string> = new Map<string, string>();
    query.set('n', '1000');
    query.set('output', 'json');

    if (type === ItemIDType.allForAccount) {
      const account: AccountService | undefined = this.account;
      const lastArticleFetch: Date | undefined =
        account === undefined ? undefined : account.lastArticleFetchStartTime;
      const since: Date = lastArticleFetch === undefined ? monthsAgo(3) : lastArticleFetch;
      query.set('ot', String(Math.floor(since.getTime() / 1000)));
      query.set('s', ReaderStreams.readingList);
    } else if (type === ItemIDType.allForFeed) {
      if (feedID === undefined) {
        throw AccountError.of(AccountErrorKind.invalidParameter);
      }
      query.set('ot', String(Math.floor(monthsAgo(3).getTime() / 1000)));
      query.set('s', feedID);
    } else if (type === ItemIDType.unread) {
      query.set('s', ReaderStreams.readingList);
      query.set('xt', ReaderState.read);
    } else {
      query.set('s', ReaderState.starred);
    }

    const callURL: string = appendQueryItems(baseURL + ReaderAPIEndpoints.itemIds, query);
    const itemIDs: string[] = [];
    let continuation: string | undefined = undefined;
    let fetchDate: Date | undefined = undefined;
    let isFirstPage: boolean = true;

    while (true) {
      const pageURL: string = continuation === undefined ? callURL
        : callURL + '&c=' + encodeURIComponent(continuation);
      const response: DownloadResponse =
        await Downloader.shared.send(pageURL, HTTPMethod.get, this.apiKeyHeaders());
      requireOK(response);
      this.noteUsageLimits(response);
      if (isFirstPage) {
        fetchDate = responseDate(response);
        isFirstPage = false;
      }

      const page: ItemIDPage = ReaderAPICaller.itemIDPageOf(response);
      if (page.itemIDs.length > 0 && pageHandler !== undefined) {
        pageHandler(page.itemIDs.length);
      }
      for (const itemID of page.itemIDs) {
        itemIDs.push(itemID);
      }
      continuation = page.continuation;
      if (continuation === undefined) {
        break;
      }
    }

    if (type === ItemIDType.allForAccount) {
      const account: AccountService | undefined = this.account;
      if (account !== undefined && fetchDate !== undefined) {
        account.lastArticleFetchStartTime = fetchDate;
        account.lastRefreshCompletedDate = new Date();
      }
    }
    return itemIDs;
  }

  private static itemIDPageOf(response: DownloadResponse): ItemIDPage {
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return new ItemIDPage([]);
    }
    const itemIDs: string[] = [];
    const refObjects: JsonObject[] | undefined = getObjectArray(json, 'itemRefs');
    if (refObjects !== undefined) {
      for (const refObject of refObjects) {
        const id: string | undefined = getString(refObject, 'id');
        if (id !== undefined) {
          itemIDs.push(id);
        }
      }
    }
    return new ItemIDPage(itemIDs, getString(json, 'continuation'));
  }

  async createUnreadEntries(entries: string[]): Promise<void> {
    await this.updateStateToEntries(entries, ReaderState.read, false);
  }

  async deleteUnreadEntries(entries: string[]): Promise<void> {
    await this.updateStateToEntries(entries, ReaderState.read, true);
  }

  async createStarredEntries(entries: string[]): Promise<void> {
    await this.updateStateToEntries(entries, ReaderState.starred, true);
  }

  async deleteStarredEntries(entries: string[]): Promise<void> {
    await this.updateStateToEntries(entries, ReaderState.starred, false);
  }

  private async updateStateToEntries(entries: string[], state: string,
    add: boolean): Promise<void> {
    const baseURL: string = this.requireBaseURL();
    const idParameters: string[] = [];
    for (const articleID of entries) {
      const parameter: string | undefined = this.itemIDParameter(articleID);
      if (parameter !== undefined) {
        idParameters.push(parameter);
      }
    }
    if (idParameters.length === 0) {
      return;
    }
    const actionIndicator: string = add ? 'a' : 'r';
    await this.withWriteToken(baseURL, async (token: string): Promise<void> => {
      const body: string = 'T=' + token + '&' + idParameters.join('&') + '&'
        + actionIndicator + '=' + state;
      const response: DownloadResponse = await Downloader.shared.send(
        baseURL + ReaderAPIEndpoints.editTag, HTTPMethod.post,
        this.apiKeyHeaders('application/x-www-form-urlencoded'), body);
      requireOK(response);
      this.noteUsageLimits(response);
    });
  }

  /**
   * The long-form item parameter — i=tag:google.com,2005:reader/item/000000000004c608.
   * The Old Reader takes the ID verbatim; every other variant wants zero-padded 16-digit hex.
   */
  itemIDParameter(articleID: string): string | undefined {
    if (this.variant === ReaderAPIVariant.theOldReader) {
      return 'i=tag:google.com,2005:reader/item/' + articleID;
    }
    const idValue: number = Number.parseInt(articleID, 10);
    if (Number.isNaN(idValue)) {
      return undefined;
    }
    // ponytail: positive IDs only, zero-padded to 16 hex digits as "%.16llx" produces.
    // A negative ID would need 64-bit two's complement; the services do not emit them.
    if (idValue < 0) {
      return undefined;
    }
    let hex: string = idValue.toString(16);
    while (hex.length < 16) {
      hex = '0' + hex;
    }
    return 'i=tag:google.com,2005:reader/item/' + hex;
  }

  /** Whether an articleID can be encoded for this server's edit-tag API. */
  articleIDIsSendable(articleID: string): boolean {
    if (this.variant === ReaderAPIVariant.theOldReader) {
      return true;
    }
    return !Number.isNaN(Number.parseInt(articleID, 10));
  }
}

// MARK: - The delegate

export class ReaderAPIAccountDelegate implements AccountDelegate {
  account?: AccountService;
  isOPMLImportInProgress: boolean = false;
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  private static readonly zone1UsageThreshold: number = 0.9;

  private readonly variant: ReaderAPIVariant;
  private readonly caller: ReaderAPICaller = new ReaderAPICaller();
  private readonly syncDatabase: SyncDatabase;
  private readonly refreshProgress: RSProgress = new RSProgress();
  // Skipping while rate limited protects the shared per-application API quota.
  private readonly rateLimiter: SyncRateLimiter = new SyncRateLimiter('ReaderAPI', false);
  private credentialsValue?: Credentials;

  constructor(dataFolder: string, variant: ReaderAPIVariant) {
    this.variant = variant;
    this.caller.variant = variant;
    this.syncDatabase = new SyncDatabase(dataFolder + '/Sync.sqlite3');
    this.refreshProgress.addListener((progressInfo: ProgressInfo): void => {
      this.progressInfo = progressInfo;
      if (this.onProgressChange !== undefined) {
        this.onProgressChange();
      }
    });
  }

  /** disallowFeedInMultipleFolders always; FreshRSS also disallows feeds in the root. */
  get behaviors(): AccountBehavior[] {
    const behaviors: AccountBehavior[] =
      [new AccountBehavior(AccountBehaviorKind.disallowFeedInMultipleFolders)];
    if (this.variant === ReaderAPIVariant.freshRSS) {
      behaviors.push(new AccountBehavior(AccountBehaviorKind.disallowFeedInRootFolder));
    }
    return behaviors;
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
    this.caller.account = account;
    this.retrieveCredentialsIfNeeded(account);
    this.syncDatabase.open().then((): Promise<void> => {
      return this.syncDatabase.resetAllSelectedForProcessing();
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sync database open failed: %{public}s', String(e));
    });
  }

  accountWillBeDeleted(): void {
    // Reader API has no logout call.
  }

  private retrieveCredentialsIfNeeded(account: AccountService): void {
    if (this.credentials !== undefined) {
      return;
    }
    account.retrieveCredentials(CredentialsType.readerAPIKey)
      .then((credentials: Credentials | undefined): void => {
        this.credentials = credentials;
      })
      .catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'retrieveCredentials: %{public}s', String(e));
      });
  }

  async refreshAll(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    if (this.rateLimiter.shouldSkip()) {
      return;
    }
    if (this.credentials === undefined) {
      this.credentials = await account.retrieveCredentials(CredentialsType.readerAPIKey);
    }

    this.refreshProgress.addTasks(6);
    const activityID: number = account.logActivityStart(ActivityKindType.refreshAll);
    try {
      await this.refreshAccount(account);

      // A failed status send must not block fetching new articles.
      try {
        await this.sendArticleStatus();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'status send failed, continuing: %{public}s', String(e));
      }
      this.refreshProgress.completeTask();

      // The mark-as-read of every fetched ID and the unread download that corrects it are
      // a pair: skipping only the second half would leave new articles wrongly read.
      if (this.shouldSkipStatusDownloadsToConserveQuota()) {
        this.refreshProgress.completeTask();
        this.refreshProgress.completeTask();
      } else {
        const articleIDs: string[] = await this.caller.retrieveItemIDs(ItemIDType.allForAccount,
          undefined, this.articleIDPageHandler(account, ActivityKindType.fetchArticleIDs));
        this.refreshProgress.completeTask();

        await account.markAsRead(setOf(articleIDs));
        try {
          await this.refreshArticleStatus();
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'refreshArticleStatus failed: %{public}s', String(e));
        }
        this.refreshProgress.completeTask();
      }

      await this.refreshMissingArticles(account);
      this.refreshProgress.reset();
      account.logActivityComplete(activityID);
    } catch (e) {
      this.refreshProgress.reset();
      const error: Error = e as Error;
      if (this.rateLimiter.isRateLimitError(error)) {
        this.rateLimiter.noteRateLimited(error, account, 'Refreshing account');
        account.logActivityComplete(activityID, 'Skipped — rate limited');
        return;
      }
      account.logActivityFail(activityID, error);

      // A credentials error is worth one ClientLogin retry: the API key expired.
      const wrapped: AccountError = account.wrapError(error);
      if (wrapped.isCredentialsError) {
        const basicCredentials: Credentials | undefined =
          await account.retrieveCredentials(CredentialsType.readerBasic);
        const endpoint: string | undefined = this.caller.apiBaseURL;
        if (basicCredentials !== undefined && endpoint !== undefined) {
          this.caller.credentials = basicCredentials;
          const apiCredentials: Credentials | undefined =
            await this.caller.validateCredentials(endpoint);
          if (apiCredentials !== undefined) {
            await account.storeCredentials(apiCredentials);
            this.credentials = apiCredentials;
            await this.refreshAll();
            return;
          }
        }
      }
      throw wrapped;
    }
  }

  async syncArticleStatus(): Promise<boolean> {
    const account: AccountService | undefined = this.account;
    if (account === undefined || this.rateLimiter.shouldSkip()) {
      return false;
    }
    try {
      const sentCount: number = await this.sendArticleStatusReturningCount(account);
      // Inoreader: skip DOWNLOADING statuses to conserve its rate limit, but still send —
      // a send is one cheap request and skipping it loses stars.
      if (this.variant === ReaderAPIVariant.inoreader) {
        return sentCount > 0;
      }
      const changedCount: number = await this.refreshArticleStatusReturningCount(account);
      return sentCount > 0 || changedCount > 0;
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
      await this.refreshArticleStatusReturningCount(account);
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
    const activityID: number = account.logActivityStart(ActivityKindType.sendArticleStatuses);
    const statuses: SyncStatus[] = await this.syncDatabase.selectForProcessing();
    let sentCount: number = 0;
    let savedError: Error | undefined = undefined;

    const pairs: SyncStatusKey[] = [SyncStatusKey.read, SyncStatusKey.read,
      SyncStatusKey.starred, SyncStatusKey.starred];
    const flags: boolean[] = [false, true, true, false];
    const labels: string[] = ['unread', 'read', 'starred', 'unstarred'];

    for (let i: number = 0; i < pairs.length; i++) {
      const key: SyncStatusKey = pairs[i];
      const flag: boolean = flags[i];
      const pending: SyncStatus[] =
        statuses.filter((s: SyncStatus) => s.key === key && s.flag === flag);
      try {
        sentCount += await this.sendStatuses(account, pending, labels[i], flag);
      } catch (e) {
        savedError = e as Error;
      }
    }

    if (savedError !== undefined) {
      // A 429 gets one Error Log entry from noteRateLimited, not one per send.
      if (!this.rateLimiter.isRateLimitError(savedError)) {
        account.postSyncError(savedError, 'Sending article status');
      }
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, sentCount + ' statuses sent', sentCount > 0);
    return sentCount;
  }

  private async sendStatuses(account: AccountService, statuses: SyncStatus[], label: string,
    flag: boolean): Promise<number> {
    if (statuses.length === 0) {
      return 0;
    }
    const key: SyncStatusKey = statuses[0].key;
    const articleIDs: string[] = statuses.map((status: SyncStatus) => status.articleID);

    // IDs that can't be encoded for this server would fail forever and churn the database.
    const unsendable: string[] =
      articleIDs.filter((id: string) => !this.caller.articleIDIsSendable(id));
    if (unsendable.length > 0) {
      hilog.error(DOMAIN, TAG, 'dropping %{public}d unsendable article IDs', unsendable.length);
      account.postSyncError(
        new Error('Dropped ' + unsendable.length
          + ' article status changes that can’t be encoded for this service.'),
        'Sending article status');
      await this.syncDatabase.deleteSelectedForProcessing(unsendable, key);
    }
    const sendable: string[] =
      articleIDs.filter((id: string) => this.caller.articleIDIsSendable(id));

    let sentCount: number = 0;
    let savedError: Error | undefined = undefined;
    for (const group of chunked(sendable, 1000)) {
      try {
        await this.callStatusAPI(key, flag, group);
        await this.syncDatabase.deleteSelectedForProcessing(group, key);
        sentCount += group.length;
      } catch (e) {
        savedError = e as Error;
        hilog.error(DOMAIN, TAG, 'sendArticleStatuses (%{public}s) failed: %{public}s', label,
          String(e));
        await this.syncDatabase.resetSelectedForProcessing(group, key);
      }
    }
    if (savedError !== undefined) {
      throw savedError;
    }
    return sentCount;
  }

  private async callStatusAPI(key: SyncStatusKey, flag: boolean,
    articleIDs: string[]): Promise<void> {
    if (key === SyncStatusKey.read) {
      if (flag) {
        await this.caller.deleteUnreadEntries(articleIDs);
      } else {
        await this.caller.createUnreadEntries(articleIDs);
      }
      return;
    }
    if (flag) {
      await this.caller.createStarredEntries(articleIDs);
    } else {
      await this.caller.deleteStarredEntries(articleIDs);
    }
  }

  private async refreshArticleStatusReturningCount(account: AccountService): Promise<number> {
    if (this.shouldSkipStatusDownloadsToConserveQuota()) {
      return 0;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.refreshArticleStatuses);
    let changedCount: number = 0;
    let savedError: Error | undefined = undefined;

    try {
      const articleIDs: string[] = await this.caller.retrieveItemIDs(ItemIDType.unread, undefined,
        this.articleIDPageHandler(account, ActivityKindType.refreshArticleStatuses));
      changedCount += await this.syncArticleReadState(account, articleIDs);
    } catch (e) {
      savedError = e as Error;
      hilog.error(DOMAIN, TAG, 'retrieving unread entries failed: %{public}s', String(e));
    }

    try {
      const articleIDs: string[] = await this.caller.retrieveItemIDs(ItemIDType.starred, undefined,
        this.articleIDPageHandler(account, ActivityKindType.refreshArticleStatuses));
      changedCount += await this.syncArticleStarredState(account, articleIDs);
    } catch (e) {
      if (savedError === undefined) {
        savedError = e as Error;
      }
      hilog.error(DOMAIN, TAG, 'retrieving starred entries failed: %{public}s', String(e));
    }

    if (savedError !== undefined) {
      if (!this.rateLimiter.isRateLimitError(savedError)) {
        account.postSyncError(savedError, 'Refreshing article status');
      }
      account.logActivityFail(activityID, savedError);
      throw savedError;
    }
    account.logActivityComplete(activityID, changedCount + ' changed', changedCount > 0);
    return changedCount;
  }

  private articleIDPageHandler(account: AccountService,
    kind: ActivityKindType): (count: number) => void {
    return (count: number): void => {
      const id: number = account.logActivityStart(kind, account.nextTaskNumberString());
      account.logActivityComplete(id, count + ' article IDs', false);
    };
  }

  async importOPML(opmlFilePath: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.importOPML, opmlFilePath);
    let file: fs.File | undefined = undefined;
    try {
      const size: number = fs.statSync(opmlFilePath).size;
      file = fs.openSync(opmlFilePath, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      fs.readSync(file.fd, buffer);
      const opmlText: string = new util.TextDecoder().decodeToString(new Uint8Array(buffer));
      await this.caller.importOPML(opmlText);
      account.logActivityComplete(activityID);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  /**
   * Reader API has no create-tag endpoint — the server creates a tag when a feed is tagged
   * with it, so a new folder stays local (no externalID) until it gets its first feed.
   */
  async createFolder(name: string): Promise<Folder> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const folder: Folder | undefined = account.ensureFolder(name);
    if (folder === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    return folder;
  }

  async renameFolder(folder: Folder, name: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    // A folder with no externalID has no tag on the server yet.
    if (folder.externalID === undefined) {
      folder.name = name;
      account.structureDidChange();
      return;
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.renameFolder,
      (folder.name === undefined ? '' : folder.name) + ' → ' + name);
    try {
      await this.caller.renameTag(folder.name === undefined ? '' : folder.name, name);
      folder.externalID = ReaderAPIAccountDelegate.folderExternalID(name);
      folder.name = name;
      account.structureDidChange();
      account.logActivityComplete(activityID, name);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  async removeFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.removeFolder,
      folder.name);
    try {
      for (const feed of folder.topLevelFeeds.slice()) {
        const subscriptionID: string | undefined = feed.externalID;
        if (subscriptionID === undefined) {
          continue;
        }
        const relationship: Map<string, string> | undefined = feed.folderRelationship;
        this.refreshProgress.addTask();
        try {
          if (relationship !== undefined && relationship.size > 1) {
            await this.caller.deleteTagging(subscriptionID, folder.nameForDisplay);
            await this.clearFolderRelationship(account, feed, folder.externalID);
          } else {
            await this.caller.deleteSubscription(subscriptionID);
            account.clearFeedSettings(feed);
          }
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'removeFolder — remove feed error: %{public}s', String(e));
          account.postSyncError(e as Error, 'Removing feed from folder');
        } finally {
          this.refreshProgress.completeTask();
        }
      }

      // The Old Reader has no disable-tag call; the tag disappears with its last feed.
      if (this.variant !== ReaderAPIVariant.theOldReader) {
        const folderExternalID: string | undefined = folder.externalID;
        if (folderExternalID !== undefined) {
          await this.caller.deleteTag(folderExternalID);
        }
      }
      account.removeFolderFromTree(folder);
      account.logActivityComplete(activityID, folder.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.retrieveCredentialsIfNeeded(account);
    this.refreshProgress.addTasks(2);
    const activityID: number = account.logActivityStart(ActivityKindType.subscribeFeed, url);
    try {
      const specifiers: FeedSpecifier[] = await FeedFinder.find(url);
      this.refreshProgress.completeTask();
      const filtered: FeedSpecifier[] =
        specifiers.filter((s: FeedSpecifier) => !s.urlString.includes('json'));
      const best: FeedSpecifier | undefined = bestFeed(filtered);
      if (best === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }

      const result: CreateReaderAPISubscriptionResult =
        await this.caller.createSubscription(best.urlString, name);
      this.refreshProgress.completeTask();
      if (result.kind !== CreateReaderAPISubscriptionResultKind.created
        || result.subscription === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }

      const feed: Feed = await this.createFeedFromSubscription(account,
        result.subscription as ReaderAPISubscription, name, container);
      account.logActivityComplete(activityID, feed.nameForDisplay);
      return feed;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'createFeed error: %{public}s', String(e));
      this.refreshProgress.reset();
      account.logActivityFail(activityID, e as Error);
      throw AccountError.of(AccountErrorKind.createErrorNotFound);
    }
  }

  private async createFeedFromSubscription(account: AccountService,
    subscription: ReaderAPISubscription, name: string | undefined,
    container: ContainerRef): Promise<Feed> {
    const feed: Feed = account.createFeedWith(subscription.name,
      readerAPISubscriptionURL(subscription), subscription.feedID, subscription.homePageURL);
    feed.externalID = subscription.feedID;
    await account.persistFeedSettings(feed);

    await this.addFeed(feed, container);
    if (name !== undefined) {
      await this.renameFeed(feed, name);
    }
    await this.initialFeedDownload(account, feed);
    return feed;
  }

  private async initialFeedDownload(account: AccountService, feed: Feed): Promise<void> {
    this.refreshProgress.addTasks(5);
    const articleIDs: string[] = await this.caller.retrieveItemIDs(ItemIDType.allForFeed,
      feed.feedID, this.articleIDPageHandler(account, ActivityKindType.fetchArticleIDs));
    this.refreshProgress.completeTask();

    await account.markAsRead(setOf(articleIDs));
    this.refreshProgress.completeTask();

    try {
      await this.refreshArticleStatus();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'initial refreshArticleStatus failed: %{public}s', String(e));
    }
    this.refreshProgress.completeTask();

    await this.refreshMissingArticles(account);
    this.refreshProgress.reset();
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const subscriptionID: string | undefined = feed.externalID;
    if (subscriptionID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.renameFeed, feed.url);
    try {
      await this.caller.renameSubscription(subscriptionID, name);
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

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const subscriptionID: string | undefined = feed.externalID;
    if (subscriptionID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.removeFeed, feed.url);
    try {
      await this.caller.deleteSubscription(subscriptionID);
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
    if (sourceContainer.isAccount) {
      await this.addFeed(feed, destinationContainer);
      return;
    }
    const subscriptionID: string | undefined = feed.externalID;
    const sourceFolder: Folder | undefined = sourceContainer.folder;
    const destinationFolder: Folder | undefined = destinationContainer.folder;
    if (subscriptionID === undefined || sourceFolder === undefined
      || destinationFolder === undefined || sourceFolder.name === undefined
      || destinationFolder.name === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.moveFeed, feed.url);
    try {
      await this.caller.moveSubscription(subscriptionID, sourceFolder.name,
        destinationFolder.name);
      ReaderAPIAccountDelegate.ensureFolderExternalID(destinationFolder);
      sourceContainer.removeFeedFromTreeAtTopLevel(feed);
      destinationContainer.addFeedToTreeAtTopLevel(feed);
      account.logActivityComplete(activityID, destinationFolder.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
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
    const feedExternalID: string | undefined = feed.externalID;
    if (folder === undefined || feedExternalID === undefined) {
      account.addFeedIfNotInAnyFolder(feed);
      return;
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.addFeed, feed.url);
    try {
      await this.caller.createTagging(feedExternalID,
        folder.name === undefined ? '' : folder.name);
      ReaderAPIAccountDelegate.ensureFolderExternalID(folder);
      await this.saveFolderRelationship(account, feed, folder.externalID, feedExternalID);
      account.removeFeedFromTreeAtTopLevel(feed);
      folder.addFeedToTreeAtTopLevel(feed);
      account.structureDidChange();
      account.logActivityComplete(activityID, folder.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
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
    const activityID: number = account.logActivityStart(ActivityKindType.restoreFolder,
      folder.name);
    const container: ContainerRef = ContainerRef.forFolder(account, folder);
    for (const feed of folder.topLevelFeeds.slice()) {
      folder.removeFeedFromTreeAtTopLevel(feed);
      try {
        await this.restoreFeed(feed, container);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'restoreFolder error: %{public}s', String(e));
        account.postSyncError(e as Error, 'Restoring feed to folder');
      }
    }
    account.addFolderToTree(folder);
    account.logActivityComplete(activityID, folder.nameForDisplay);
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

    const pendingCount: number = await this.syncDatabase.selectPendingCount();
    if (pendingCount > 100) {
      this.sendArticleStatus().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'background status flush failed: %{public}s', String(e));
      });
    }
  }

  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    if (endpointURL === undefined) {
      throw new WebserviceError(WebserviceErrorKind.noURL);
    }
    const caller: ReaderAPICaller = new ReaderAPICaller();
    caller.credentials = credentials;
    caller.endpointOverride = endpointURL;
    return await caller.validateCredentials(endpointURL);
  }

  async vacuumDatabases(): Promise<void> {
    await this.syncDatabase.vacuum();
  }

  suspendNetwork(): void {
    this.caller.cancelAll();
  }

  resume(): void {
    this.caller.resume();
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      this.retrieveCredentialsIfNeeded(account);
    }
  }

  // MARK: - Sync phases

  private async refreshAccount(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshFeedList);
    try {
      const tags: ReaderAPITag[] | undefined = await this.caller.retrieveTags();
      this.refreshProgress.completeTask();

      const subscriptions: ReaderAPISubscription[] | undefined =
        await this.caller.retrieveSubscriptions();
      this.refreshProgress.completeTask();

      this.syncFolders(account, tags);
      await this.syncFeeds(account, subscriptions);
      await this.syncFeedFolderRelationship(account, subscriptions);

      account.logActivityComplete(activityID,
        (subscriptions === undefined ? 0 : subscriptions.length) + ' feeds, '
        + (tags === undefined ? 0 : tags.length) + ' folders');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Refreshing account');
      throw e as Error;
    }
  }

  /** Inoreader marks folder tags with type "folder"; the others use a "/label/" tag ID. */
  private syncFolders(account: AccountService, tags?: ReaderAPITag[]): void {
    if (tags === undefined) {
      return;
    }
    const folderTags: ReaderAPITag[] = this.variant === ReaderAPIVariant.inoreader
      ? tags.filter((tag: ReaderAPITag) => tag.type === 'folder')
      : tags.filter((tag: ReaderAPITag) => tag.tagID.includes('/label/'));
    if (folderTags.length === 0) {
      return;
    }
    const readerFolderExternalIDs: string[] = folderTags.map((tag: ReaderAPITag) => tag.tagID);

    // Delete folders that are no longer at the server. A folder with no externalID has
    // never been sent — it is waiting for its first feed — so leave it alone.
    for (const folder of account.folders().slice()) {
      const folderExternalID: string | undefined = folder.externalID;
      if (folderExternalID === undefined) {
        continue;
      }
      if (!readerFolderExternalIDs.includes(folderExternalID)) {
        for (const feed of folder.topLevelFeeds.slice()) {
          account.addFeedToTreeAtTopLevel(feed);
          this.clearFolderRelationship(account, feed, folderExternalID)
            .catch((e: Object): void => {
              hilog.error(DOMAIN, TAG, 'clearFolderRelationship: %{public}s', String(e));
            });
        }
        account.removeFolderFromTree(folder);
      }
    }

    const folderExternalIDs: string[] = [];
    for (const folder of account.folders()) {
      const externalID: string | undefined = folder.externalID;
      if (externalID !== undefined) {
        folderExternalIDs.push(externalID);
      }
    }

    for (const tag of folderTags) {
      if (folderExternalIDs.includes(tag.tagID)) {
        continue;
      }
      const folderName: string | undefined = readerAPITagFolderName(tag);
      const folder: Folder | undefined =
        account.ensureFolder(folderName === undefined ? 'None' : folderName);
      if (folder !== undefined) {
        folder.externalID = tag.tagID;
      }
    }
  }

  private async syncFeeds(account: AccountService,
    subscriptions?: ReaderAPISubscription[]): Promise<void> {
    if (subscriptions === undefined) {
      return;
    }
    const subFeedIDs: string[] =
      subscriptions.map((subscription: ReaderAPISubscription) => subscription.feedID);

    for (const folder of account.folders()) {
      for (const feed of folder.topLevelFeeds.slice()) {
        if (!subFeedIDs.includes(feed.feedID)) {
          account.clearFeedSettings(feed);
          folder.removeFeedFromTreeAtTopLevel(feed);
        }
      }
    }
    for (const feed of account.model.topLevelFeeds.slice()) {
      if (!subFeedIDs.includes(feed.feedID)) {
        account.clearFeedSettings(feed);
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }

    for (const subscription of subscriptions) {
      const feed: Feed | undefined = account.existingFeedWithFeedID(subscription.feedID);
      if (feed !== undefined) {
        feed.name = decodingFullwidthEscapedCharacters(subscription.name);
        feed.editedName = undefined;
        feed.homePageURL = subscription.homePageURL;
        await account.persistFeedSettings(feed);
        continue;
      }
      const created: Feed = account.createFeedWith(
        decodingFullwidthEscapedCharacters(subscription.name),
        readerAPISubscriptionURL(subscription), subscription.feedID, subscription.homePageURL);
      created.externalID = subscription.feedID;
      await account.persistFeedSettings(created);
      account.addFeedToTreeAtTopLevel(created);
    }
  }

  private async syncFeedFolderRelationship(account: AccountService,
    subscriptions?: ReaderAPISubscription[]): Promise<void> {
    if (subscriptions === undefined) {
      return;
    }
    const folderDict: Map<string, Folder> = new Map<string, Folder>();
    for (const folder of account.folders()) {
      const externalID: string | undefined = folder.externalID;
      if (externalID !== undefined && !folderDict.has(externalID)) {
        folderDict.set(externalID, folder);
      }
    }

    const taggingsDict: Map<string, ReaderAPISubscription[]> =
      new Map<string, ReaderAPISubscription[]>();
    for (const subscription of subscriptions) {
      for (const category of subscription.categories) {
        const existing: ReaderAPISubscription[] | undefined =
          taggingsDict.get(category.categoryId);
        if (existing === undefined) {
          taggingsDict.set(category.categoryId, [subscription]);
        } else {
          existing.push(subscription);
        }
      }
    }

    const folderExternalIDs: string[] = [];
    taggingsDict.forEach((grouped: ReaderAPISubscription[], folderExternalID: string) => {
      folderExternalIDs.push(folderExternalID);
    });

    for (const folderExternalID of folderExternalIDs) {
      const folder: Folder | undefined = folderDict.get(folderExternalID);
      const grouped: ReaderAPISubscription[] | undefined = taggingsDict.get(folderExternalID);
      if (folder === undefined || grouped === undefined) {
        continue;
      }
      const taggingFeedIDs: string[] =
        grouped.map((subscription: ReaderAPISubscription) => subscription.feedID);

      for (const feed of folder.topLevelFeeds.slice()) {
        if (!taggingFeedIDs.includes(feed.feedID)) {
          folder.removeFeedFromTreeAtTopLevel(feed);
          await this.clearFolderRelationship(account, feed, folder.externalID);
          account.addFeedToTreeAtTopLevel(feed);
        }
      }

      const folderFeedIDs: string[] = folder.topLevelFeeds.map((feed: Feed) => feed.feedID);
      for (const subscription of grouped) {
        if (folderFeedIDs.includes(subscription.feedID)) {
          continue;
        }
        const feed: Feed | undefined = account.existingFeedWithFeedID(subscription.feedID);
        if (feed === undefined) {
          continue;
        }
        await this.saveFolderRelationship(account, feed, folderExternalID, subscription.feedID);
        folder.addFeedToTreeAtTopLevel(feed);
      }
    }

    const taggedFeedIDs: Set<string> = new Set<string>();
    for (const subscription of subscriptions) {
      if (subscription.categories.length > 0) {
        taggedFeedIDs.add(subscription.feedID);
      }
    }
    for (const feed of account.model.topLevelFeeds.slice()) {
      if (taggedFeedIDs.has(feed.feedID)) {
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }
    account.structureDidChange();
  }

  static folderExternalID(folderName: string): string {
    return 'user/-/label/' + folderName;
  }

  /** Give a folder an externalID now that tagging a feed has created its tag server-side. */
  static ensureFolderExternalID(folder: Folder): void {
    if (folder.externalID !== undefined || folder.name === undefined) {
      return;
    }
    folder.externalID = ReaderAPIAccountDelegate.folderExternalID(folder.name);
  }

  private async clearFolderRelationship(account: AccountService, feed: Feed,
    folderExternalID?: string): Promise<void> {
    const relationship: Map<string, string> | undefined = feed.folderRelationship;
    if (relationship === undefined || folderExternalID === undefined) {
      return;
    }
    relationship.delete(folderExternalID);
    feed.folderRelationship = relationship;
    await account.persistFeedSettings(feed);
  }

  private async saveFolderRelationship(account: AccountService, feed: Feed,
    folderExternalID: string | undefined, feedExternalID: string): Promise<void> {
    if (folderExternalID === undefined) {
      return;
    }
    let relationship: Map<string, string> | undefined = feed.folderRelationship;
    if (relationship === undefined) {
      relationship = new Map<string, string>();
    }
    relationship.set(folderExternalID, feedExternalID);
    feed.folderRelationship = relationship;
    await account.persistFeedSettings(feed);
  }

  private async refreshMissingArticles(account: AccountService): Promise<void> {
    const fetched: Set<string> =
      await account.fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate();
    if (fetched.size === 0) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.refreshMissingArticles);
    const chunks: string[][] = chunked(arrayOf(fetched), 150);
    this.refreshProgress.addTasks(chunks.length + 1);

    for (const chunk of chunks) {
      try {
        const entries: ReaderAPIEntry[] = await this.caller.retrieveEntries(chunk);
        this.refreshProgress.completeTask();
        await this.processEntries(account, entries);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'Refresh missing articles error: %{public}s', String(e));
        account.postSyncError(e as Error, 'Refreshing missing articles');
        this.refreshProgress.completeTask();
      }
    }
    this.refreshProgress.completeTask();
    account.logActivityComplete(activityID, fetched.size + ' articles');
  }

  private async processEntries(account: AccountService,
    entries: ReaderAPIEntry[]): Promise<void> {
    const parsedItems: ParsedItem[] = this.mapEntriesToParsedItems(entries);
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
  }

  private mapEntriesToParsedItems(entries: ReaderAPIEntry[]): ParsedItem[] {
    const isTheOldReader: boolean = this.variant === ReaderAPIVariant.theOldReader;
    const parsedItems: ParsedItem[] = [];
    for (const entry of entries) {
      const streamID: string | undefined = entry.origin.streamId;
      if (streamID === undefined) {
        continue;
      }
      let authors: ParsedAuthor[] | undefined = undefined;
      const authorName: string | undefined = decodingFullwidthEscapedCharacters(entry.author);
      if (authorName !== undefined) {
        const author: ParsedAuthor = {
          name: authorName,
          url: undefined,
          avatarURL: undefined,
          emailAddress: undefined
        };
        authors = [author];
      }
      const alternates: ReaderAPIAlternateLocation[] | undefined = entry.alternates;
      const uniqueID: string = uniqueIDForEntry(entry.articleID, isTheOldReader);
      const item: ParsedItem = {
        syncServiceID: uniqueID,
        uniqueID: uniqueID,
        feedURL: streamID,
        externalURL: (alternates === undefined || alternates.length === 0)
          ? undefined : alternates[0].url,
        title: decodingFullwidthEscapedCharacters(entry.title),
        contentHTML: entry.summary.content,
        summary: entry.summary.content,
        datePublished: readerAPIEntryDatePublished(entry),
        authors: authors
      };
      parsedItems.push(item);
    }
    return parsedItems;
  }

  private async syncArticleReadState(account: AccountService,
    articleIDs: string[]): Promise<number> {
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingReadStatusArticleIDs());
    const serverUnread: Set<string> = setOf(articleIDs);
    const localUnread: Set<string> = await account.fetchUnreadArticleIDs();

    const toMarkUnread: Set<string> =
      subtractingIDs(subtractingIDs(serverUnread, localUnread), pending);
    const markedUnread: string[] = await account.markAsUnread(toMarkUnread);

    const toMarkRead: Set<string> =
      subtractingIDs(subtractingIDs(localUnread, serverUnread), pending);
    const markedRead: string[] = await account.markAsRead(toMarkRead);

    return markedUnread.length + markedRead.length;
  }

  private async syncArticleStarredState(account: AccountService,
    articleIDs: string[]): Promise<number> {
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingStarredStatusArticleIDs());
    const serverStarred: Set<string> = setOf(articleIDs);
    const localStarred: Set<string> = await account.fetchStarredArticleIDs();

    const toStar: Set<string> =
      subtractingIDs(subtractingIDs(serverStarred, localStarred), pending);
    const markedStarred: string[] = await account.markAsStarred(toStar);

    const toUnstar: Set<string> =
      subtractingIDs(subtractingIDs(localStarred, serverStarred), pending);
    const markedUnstarred: string[] = await account.markAsUnstarred(toUnstar);

    return markedStarred.length + markedUnstarred.length;
  }

  /**
   * True when Inoreader's reported Zone 1 (read) usage is close enough to the daily limit
   * that full status downloads should be skipped until the limits reset.
   */
  private shouldSkipStatusDownloadsToConserveQuota(): boolean {
    const usageLimits: ReaderAPIUsageLimits | undefined = this.caller.usageLimits;
    if (usageLimits === undefined) {
      return false;
    }
    if (usageLimits.resetDate.getTime() <= Date.now()) {
      return false;
    }
    if (usageLimits.zone1Usage
      < usageLimits.zone1Limit * ReaderAPIAccountDelegate.zone1UsageThreshold) {
      return false;
    }
    hilog.info(DOMAIN, TAG, 'skipping status downloads — Zone 1 usage %{public}d of %{public}d',
      usageLimits.zone1Usage, usageLimits.zone1Limit);
    return true;
  }
}
