/**
 * FeedbinAccountDelegate — port of
 * Modules/Account/Sources/Account/Feedbin/{FeedbinAccountDelegate,FeedbinAPICaller}.swift
 *
 * AccountType.feedbin. HTTP Basic auth against https://api.feedbin.com/v2/, behavior
 * disallowFeedCopyInRootFolder. Folders are Feedbin tags; a feed's membership in a folder
 * is a tagging, and the tagging ID is kept in feed.folderRelationship.
 *
 * Feedbin allows 250 requests per second; exceeding it answers 403 for five minutes.
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
import { FeedSpecifier, FeedSpecifierSource, bestFeed } from '../../model/FeedSpecifier';
import {
  FeedbinEntry, FeedbinEntryJSONFeed, FeedbinEntryJSONFeedAuthor,
  FeedbinEntryJSONFeedAuthorWire, FeedbinEntryJSONFeedWire, FeedbinEntryWire,
  feedbinEntryFromJSON
} from '../../model/FeedbinEntry';
import {
  FeedbinSubscription, FeedbinSubscriptionChoice, FeedbinSubscriptionChoiceWire,
  FeedbinSubscriptionJSONFeed, FeedbinSubscriptionJSONFeedWire, FeedbinSubscriptionWire,
  feedbinSubscriptionChoiceFromJSON, feedbinSubscriptionFromJSON
} from '../../model/FeedbinSubscription';
import {
  FeedbinTag, FeedbinTagWire, FeedbinTagging, FeedbinTaggingWire, feedbinTagFromJSON,
  feedbinTaggingFromJSON
} from '../../model/FeedbinTag';
import { FeedbinImportResult, FeedbinImportResultWire, feedbinImportResultFromJSON }
  from '../../model/FeedbinUnreadEntry';
import { Folder } from '../../model/Folder';
import { HTTPConditionalGetInfo, conditionalGetInfoFromHeaders, conditionalGetRequestHeaders }
  from '../../model/HTTPConditionalGetInfo';
import { ParsedAuthor } from '../../model/ParsedAuthor';
import { ParsedItem } from '../../model/ParsedItem';
import { ProgressInfo } from '../../model/ProgressInfo';
import { SyncStatus, SyncStatusKey, makeSyncStatus, syncStatusKeyFromArticleStatusKey }
  from '../../model/SyncStatus';
import { SyncDatabase } from '../db/SyncDatabase';
import { Downloader, HTTPMethod, HTTPRequestHeader, HTTPResponseCode, HTTPResponseHeader }
  from '../net/DownloadSession';
import { JsonObject, getBoolean, getNumber, getObject, getString } from '../util/Json';
import { RSProgress } from '../util/Progress';
import { parseDate } from '../util/DateParser';
import { AccountService, ContainerRef } from './Account';
import {
  AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener, WebserviceError,
  WebserviceErrorKind, appendQueryItems, arrayOf, basicAuthValue, chunked, jsonArrayOf, jsonObjectArrayOf,
  jsonObjectOf, requireOK, responseDate, responseHeader, setOf, statusCodeOf, subtractingIDs
} from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'Feedbin';

/** The one gated Feedbin endpoint: every call hangs off this base. */
const feedbinBaseURL: string = 'https://api.feedbin.com/v2/';

export class FeedbinConditionalGetKeys {
  static readonly subscriptions: string = 'subscriptions';
  static readonly tags: string = 'tags';
  static readonly taggings: string = 'taggings';
  static readonly unreadEntries: string = 'unreadEntries';
  static readonly starredEntries: string = 'starredEntries';
}

/** FeedbinDate.formatter — "yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'" in GMT. */
export function feedbinDateString(date: Date): string {
  const pad: (value: number, width: number) => string =
    (value: number, width: number): string => {
      let s: string = String(value);
      while (s.length < width) {
        s = '0' + s;
      }
      return s;
    };
  return pad(date.getUTCFullYear(), 4) + '-' + pad(date.getUTCMonth() + 1, 2) + '-'
    + pad(date.getUTCDate(), 2) + 'T' + pad(date.getUTCHours(), 2) + ':'
    + pad(date.getUTCMinutes(), 2) + ':' + pad(date.getUTCSeconds(), 2) + '.'
    + pad(date.getUTCMilliseconds(), 3) + '000Z';
}

function monthsAgo(months: number): Date {
  const date: Date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function daysAgo(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

/** HTTPLinkPagingInfo — the rel="next" / rel="last" URLs of a Link header. */
class LinkPagingInfo {
  nextPage?: string;
  lastPage?: string;

  static fromResponse(response: DownloadResponse): LinkPagingInfo {
    const info: LinkPagingInfo = new LinkPagingInfo();
    const header: string | undefined = responseHeader(response, HTTPResponseHeader.link);
    if (header === undefined) {
      return info;
    }
    for (const part of header.split(',')) {
      const segments: string[] = part.split(';');
      if (segments.length < 2) {
        continue;
      }
      const urlSegment: string = segments[0].trim();
      if (!urlSegment.startsWith('<') || !urlSegment.endsWith('>')) {
        continue;
      }
      const url: string = urlSegment.substring(1, urlSegment.length - 1);
      const relSegment: string = segments[1].trim();
      if (relSegment.includes('rel="next"')) {
        info.nextPage = url;
      } else if (relSegment.includes('rel="last"')) {
        info.lastPage = url;
      }
    }
    return info;
  }
}

function pageNumberOf(link?: string): number | undefined {
  if (link === undefined) {
    return undefined;
  }
  const index: number = link.indexOf('page=');
  if (index < 0) {
    return undefined;
  }
  const rest: string = link.substring(index + 'page='.length);
  let end: number = rest.length;
  for (let i: number = 0; i < rest.length; i++) {
    const c: string = rest.charAt(i);
    if (c < '0' || c > '9') {
      end = i;
      break;
    }
  }
  const value: number = Number.parseInt(rest.substring(0, end), 10);
  return Number.isNaN(value) ? undefined : value;
}

// MARK: - JSON -> wire mapping

function entryWireFrom(json: JsonObject): FeedbinEntryWire | undefined {
  const id: number | undefined = getNumber(json, 'id');
  const feedID: number | undefined = getNumber(json, 'feed_id');
  if (id === undefined || feedID === undefined) {
    return undefined;
  }
  let jsonFeed: FeedbinEntryJSONFeedWire | undefined = undefined;
  const jsonFeedObject: JsonObject | undefined = getObject(json, 'json_feed');
  if (jsonFeedObject !== undefined) {
    let author: FeedbinEntryJSONFeedAuthorWire | undefined = undefined;
    const authorObject: JsonObject | undefined = getObject(jsonFeedObject, 'author');
    if (authorObject !== undefined) {
      author = {
        url: getString(authorObject, 'url'),
        avatar: getString(authorObject, 'avatar')
      };
    }
    jsonFeed = {
      author: author,
      external_url: getString(jsonFeedObject, 'external_url')
    };
  }
  const wire: FeedbinEntryWire = {
    id: id,
    feed_id: feedID,
    title: getString(json, 'title'),
    url: getString(json, 'url'),
    author: getString(json, 'author'),
    content: getString(json, 'content'),
    summary: getString(json, 'summary'),
    published: getString(json, 'published'),
    created_at: getString(json, 'created_at'),
    json_feed: jsonFeed
  };
  return wire;
}

function subscriptionWireFrom(json: JsonObject): FeedbinSubscriptionWire | undefined {
  const id: number | undefined = getNumber(json, 'id');
  const feedID: number | undefined = getNumber(json, 'feed_id');
  const feedURL: string | undefined = getString(json, 'feed_url');
  if (id === undefined || feedID === undefined || feedURL === undefined) {
    return undefined;
  }
  let jsonFeed: FeedbinSubscriptionJSONFeedWire | undefined = undefined;
  const jsonFeedObject: JsonObject | undefined = getObject(json, 'json_feed');
  if (jsonFeedObject !== undefined) {
    jsonFeed = {
      favicon: getString(jsonFeedObject, 'favicon'),
      icon: getString(jsonFeedObject, 'icon')
    };
  }
  const wire: FeedbinSubscriptionWire = {
    id: id,
    feed_id: feedID,
    title: getString(json, 'title'),
    feed_url: feedURL,
    site_url: getString(json, 'site_url'),
    json_feed: jsonFeed
  };
  return wire;
}

function tagWireFrom(json: JsonObject): FeedbinTagWire | undefined {
  const id: number | undefined = getNumber(json, 'id');
  const name: string | undefined = getString(json, 'name');
  if (id === undefined || name === undefined) {
    return undefined;
  }
  const wire: FeedbinTagWire = { id: id, name: name };
  return wire;
}

function taggingWireFrom(json: JsonObject): FeedbinTaggingWire | undefined {
  const id: number | undefined = getNumber(json, 'id');
  const feedID: number | undefined = getNumber(json, 'feed_id');
  const name: string | undefined = getString(json, 'name');
  if (id === undefined || feedID === undefined || name === undefined) {
    return undefined;
  }
  const wire: FeedbinTaggingWire = { id: id, feed_id: feedID, name: name };
  return wire;
}

// MARK: - Result shapes

export enum CreateSubscriptionResultKind {
  created = 'created',
  multipleChoice = 'multipleChoice',
  alreadySubscribed = 'alreadySubscribed',
  notFound = 'notFound'
}

export class CreateSubscriptionResult {
  readonly kind: CreateSubscriptionResultKind;
  readonly subscription?: FeedbinSubscription;
  readonly choices?: FeedbinSubscriptionChoice[];

  constructor(kind: CreateSubscriptionResultKind, subscription?: FeedbinSubscription,
    choices?: FeedbinSubscriptionChoice[]) {
    this.kind = kind;
    this.subscription = subscription;
    this.choices = choices;
  }
}

export class EntriesPage {
  readonly entries?: FeedbinEntry[];
  readonly nextPage?: string;
  readonly fetchDate?: Date;
  readonly lastPageNumber?: number;

  constructor(entries?: FeedbinEntry[], nextPage?: string, fetchDate?: Date,
    lastPageNumber?: number) {
    this.entries = entries;
    this.nextPage = nextPage;
    this.fetchDate = fetchDate;
    this.lastPageNumber = lastPageNumber;
  }
}

// MARK: - The API caller

export class FeedbinAPICaller {
  credentials?: Credentials;
  account?: AccountService;

  private suspended: boolean = false;
  private lastBackdateStartTime?: Date;

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

  private authHeaders(contentType?: string): Map<string, string> {
    const headers: Map<string, string> = new Map<string, string>();
    const credentials: Credentials | undefined = this.credentials;
    if (credentials !== undefined && credentials.type === CredentialsType.basic) {
      headers.set(HTTPRequestHeader.authorization,
        basicAuthValue(credentials.username, credentials.secret));
    }
    if (contentType !== undefined) {
      headers.set(HTTPRequestHeader.contentType, contentType);
    }
    return headers;
  }

  private conditionalHeaders(key: string): Map<string, string> {
    const headers: Map<string, string> = this.authHeaders();
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return headers;
    }
    const info: HTTPConditionalGetInfo | undefined = account.conditionalGetInfoFor(key);
    if (info === undefined) {
      return headers;
    }
    conditionalGetRequestHeaders(info).forEach((value: string, name: string) => {
      // A last-modified with the 32-bit end-of-time date (2038) is a known bad value.
      if (name !== HTTPRequestHeader.ifModifiedSince || !value.includes('2038')) {
        headers.set(name, value);
      }
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

  async validateCredentials(): Promise<Credentials | undefined> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'authentication.json', HTTPMethod.get, this.authHeaders());
    const statusCode: number = statusCodeOf(response);
    if (statusCode === 401) {
      return undefined;
    }
    requireOK(response);
    return this.credentials;
  }

  async importOPML(opmlText: string): Promise<FeedbinImportResult> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(feedbinBaseURL + 'imports.json',
      HTTPMethod.post, this.authHeaders('text/xml; charset=utf-8'), opmlText);
    requireOK(response);
    const result: FeedbinImportResult | undefined = FeedbinAPICaller.importResultOf(response);
    if (result === undefined) {
      throw new WebserviceError(WebserviceErrorKind.noData);
    }
    return result;
  }

  async retrieveOPMLImportResult(importID: number): Promise<FeedbinImportResult | undefined> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'imports/' + importID + '.json', HTTPMethod.get, this.authHeaders());
    requireOK(response);
    return FeedbinAPICaller.importResultOf(response);
  }

  private static importResultOf(response: DownloadResponse): FeedbinImportResult | undefined {
    const json: JsonObject | undefined = jsonObjectOf(response);
    if (json === undefined) {
      return undefined;
    }
    const id: number | undefined = getNumber(json, 'id');
    const complete: boolean | undefined = getBoolean(json, 'complete');
    if (id === undefined) {
      return undefined;
    }
    const wire: FeedbinImportResultWire = { id: id, complete: complete === true };
    return feedbinImportResultFromJSON(wire);
  }

  /** Undefined on a 304 — the caller then skips syncing. */
  async retrieveTags(): Promise<FeedbinTag[] | undefined> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(feedbinBaseURL + 'tags.json',
      HTTPMethod.get, this.conditionalHeaders(FeedbinConditionalGetKeys.tags));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(FeedbinConditionalGetKeys.tags, response);

    const items: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (items === undefined) {
      return undefined;
    }
    const tags: FeedbinTag[] = [];
    for (const item of items) {
      const wire: FeedbinTagWire | undefined = tagWireFrom(item);
      if (wire !== undefined) {
        tags.push(feedbinTagFromJSON(wire));
      }
    }
    return tags;
  }

  async renameTag(oldName: string, newName: string): Promise<void> {
    this.requireNotSuspended();
    const body: string = '{"old_name":' + JSON.stringify(oldName) + ',"new_name":'
      + JSON.stringify(newName) + '}';
    const response: DownloadResponse = await Downloader.shared.send(feedbinBaseURL + 'tags.json',
      HTTPMethod.post, this.authHeaders('application/json; charset=utf-8'), body);
    requireOK(response);
  }

  async retrieveSubscriptions(): Promise<FeedbinSubscription[] | undefined> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('mode', 'extended');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedbinBaseURL + 'subscriptions.json', query), HTTPMethod.get,
      this.conditionalHeaders(FeedbinConditionalGetKeys.subscriptions));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(FeedbinConditionalGetKeys.subscriptions, response);
    return FeedbinAPICaller.subscriptionsOf(response);
  }

  private static subscriptionsOf(response: DownloadResponse): FeedbinSubscription[] | undefined {
    const items: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (items === undefined) {
      return undefined;
    }
    const subscriptions: FeedbinSubscription[] = [];
    for (const item of items) {
      const wire: FeedbinSubscriptionWire | undefined = subscriptionWireFrom(item);
      if (wire !== undefined) {
        subscriptions.push(feedbinSubscriptionFromJSON(wire));
      }
    }
    return subscriptions;
  }

  async createSubscription(url: string): Promise<CreateSubscriptionResult> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('mode', 'extended');
    const body: string = '{"feed_url":' + JSON.stringify(url) + '}';
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedbinBaseURL + 'subscriptions.json', query), HTTPMethod.post,
      this.authHeaders('application/json; charset=utf-8'), body);

    const statusCode: number = statusCodeOf(response);
    if (statusCode === 201) {
      const items: JsonObject | undefined = jsonObjectOf(response);
      if (items === undefined) {
        throw new WebserviceError(WebserviceErrorKind.noData);
      }
      const wire: FeedbinSubscriptionWire | undefined = subscriptionWireFrom(items);
      if (wire === undefined) {
        throw new WebserviceError(WebserviceErrorKind.invalidResponse);
      }
      return new CreateSubscriptionResult(CreateSubscriptionResultKind.created,
        feedbinSubscriptionFromJSON(wire));
    }
    if (statusCode === 300) {
      const items: JsonObject[] | undefined = jsonObjectArrayOf(response);
      const choices: FeedbinSubscriptionChoice[] = [];
      if (items !== undefined) {
        for (const item of items) {
          const feedURL: string | undefined = getString(item, 'feed_url');
          if (feedURL === undefined) {
            continue;
          }
          const wire: FeedbinSubscriptionChoiceWire = {
            title: getString(item, 'title'),
            feed_url: feedURL
          };
          choices.push(feedbinSubscriptionChoiceFromJSON(wire));
        }
      }
      return new CreateSubscriptionResult(CreateSubscriptionResultKind.multipleChoice, undefined,
        choices);
    }
    if (statusCode === HTTPResponseCode.redirectTemporary) {
      return new CreateSubscriptionResult(CreateSubscriptionResultKind.alreadySubscribed);
    }
    // Feedbin answers 401 here when you are already subscribed — a service-side quirk.
    if (statusCode === 401) {
      return new CreateSubscriptionResult(CreateSubscriptionResultKind.alreadySubscribed);
    }
    if (statusCode === 404) {
      return new CreateSubscriptionResult(CreateSubscriptionResultKind.notFound);
    }
    throw WebserviceError.httpError(statusCode);
  }

  async renameSubscription(subscriptionID: string, newName: string): Promise<void> {
    this.requireNotSuspended();
    const body: string = '{"title":' + JSON.stringify(newName) + '}';
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'subscriptions/' + subscriptionID + '/update.json', HTTPMethod.post,
      this.authHeaders('application/json; charset=utf-8'), body);
    requireOK(response);
  }

  async deleteSubscription(subscriptionID: string): Promise<void> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'subscriptions/' + subscriptionID + '.json', HTTPMethod.delete,
      this.authHeaders());
    requireOK(response);
  }

  async retrieveTaggings(): Promise<FeedbinTagging[] | undefined> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'taggings.json', HTTPMethod.get,
      this.conditionalHeaders(FeedbinConditionalGetKeys.taggings));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(FeedbinConditionalGetKeys.taggings, response);

    const items: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (items === undefined) {
      return undefined;
    }
    const taggings: FeedbinTagging[] = [];
    for (const item of items) {
      const wire: FeedbinTaggingWire | undefined = taggingWireFrom(item);
      if (wire !== undefined) {
        taggings.push(feedbinTaggingFromJSON(wire));
      }
    }
    return taggings;
  }

  /** Returns the new tagging's ID, taken from the Location header. */
  async createTagging(feedID: number, name: string): Promise<number> {
    this.requireNotSuspended();
    const body: string = '{"feed_id":' + feedID + ',"name":' + JSON.stringify(name) + '}';
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'taggings.json', HTTPMethod.post,
      this.authHeaders('application/json; charset=utf-8'), body);
    requireOK(response);

    const location: string | undefined = responseHeader(response, HTTPResponseHeader.location);
    if (location !== undefined) {
      const lower: number = location.indexOf('v2/taggings/');
      const upper: number = location.indexOf('.json');
      if (lower >= 0 && upper > lower) {
        const idText: string = location.substring(lower + 'v2/taggings/'.length, upper);
        const taggingID: number = Number.parseInt(idText, 10);
        if (!Number.isNaN(taggingID)) {
          return taggingID;
        }
      }
    }
    throw new WebserviceError(WebserviceErrorKind.noData);
  }

  async deleteTagging(taggingID: string): Promise<void> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(
      feedbinBaseURL + 'taggings/' + taggingID + '.json', HTTPMethod.delete,
      this.authHeaders('application/json; charset=utf-8'));
    requireOK(response);
  }

  async retrieveEntriesWithArticleIDs(articleIDs: string[]): Promise<FeedbinEntry[]> {
    this.requireNotSuspended();
    if (articleIDs.length === 0) {
      return [];
    }
    const query: Map<string, string> = new Map<string, string>();
    query.set('ids', articleIDs.join(','));
    query.set('mode', 'extended');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedbinBaseURL + 'entries.json', query), HTTPMethod.get,
      this.authHeaders());
    requireOK(response);
    return FeedbinAPICaller.entriesOf(response);
  }

  /** The initial download for one newly-subscribed feed: the last 3 months. */
  async retrieveEntriesForFeedID(feedID: string): Promise<EntriesPage> {
    this.requireNotSuspended();
    const query: Map<string, string> = new Map<string, string>();
    query.set('since', feedbinDateString(monthsAgo(3)));
    query.set('per_page', '100');
    query.set('mode', 'extended');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedbinBaseURL + 'feeds/' + feedID + '/entries.json', query),
      HTTPMethod.get, this.authHeaders());
    requireOK(response);
    const paging: LinkPagingInfo = LinkPagingInfo.fromResponse(response);
    return new EntriesPage(FeedbinAPICaller.entriesOf(response), paging.nextPage);
  }

  /**
   * The account-wide article fetch. On a first sync it takes the previous 3 months; after
   * that it uses the last fetch time, back-dated by a day once every 24 hours so that
   * *updated* articles are picked up too.
   */
  async retrieveEntries(): Promise<EntriesPage> {
    this.requireNotSuspended();

    const lastArticleFetch: Date | undefined =
      this.account === undefined ? undefined : this.account.lastArticleFetchStartTime;
    let since: Date;
    if (lastArticleFetch === undefined) {
      since = monthsAgo(3);
    } else if (this.lastBackdateStartTime === undefined) {
      this.lastBackdateStartTime = lastArticleFetch;
      since = daysAgo(lastArticleFetch, 1);
    } else if (this.lastBackdateStartTime.getTime() + 24 * 60 * 60 * 1000
      < lastArticleFetch.getTime()) {
      this.lastBackdateStartTime = lastArticleFetch;
      since = daysAgo(lastArticleFetch, 1);
    } else {
      since = lastArticleFetch;
    }

    const query: Map<string, string> = new Map<string, string>();
    query.set('since', feedbinDateString(since));
    query.set('per_page', '100');
    query.set('mode', 'extended');
    const response: DownloadResponse = await Downloader.shared.send(
      appendQueryItems(feedbinBaseURL + 'entries.json', query), HTTPMethod.get,
      this.authHeaders());
    requireOK(response);

    const paging: LinkPagingInfo = LinkPagingInfo.fromResponse(response);
    return new EntriesPage(FeedbinAPICaller.entriesOf(response), paging.nextPage,
      responseDate(response), pageNumberOf(paging.lastPage));
  }

  async retrieveEntriesForPage(page: string): Promise<EntriesPage> {
    this.requireNotSuspended();
    const response: DownloadResponse =
      await Downloader.shared.send(page, HTTPMethod.get, this.authHeaders());
    requireOK(response);
    const paging: LinkPagingInfo = LinkPagingInfo.fromResponse(response);
    return new EntriesPage(FeedbinAPICaller.entriesOf(response), paging.nextPage);
  }

  private static entriesOf(response: DownloadResponse): FeedbinEntry[] {
    const items: JsonObject[] | undefined = jsonObjectArrayOf(response);
    if (items === undefined) {
      return [];
    }
    const entries: FeedbinEntry[] = [];
    for (const item of items) {
      const wire: FeedbinEntryWire | undefined = entryWireFrom(item);
      if (wire !== undefined) {
        entries.push(feedbinEntryFromJSON(wire));
      }
    }
    return entries;
  }

  async retrieveUnreadEntries(): Promise<number[] | undefined> {
    return await this.retrieveEntryIDs(feedbinBaseURL + 'unread_entries.json',
      FeedbinConditionalGetKeys.unreadEntries);
  }

  async retrieveStarredEntries(): Promise<number[] | undefined> {
    return await this.retrieveEntryIDs(feedbinBaseURL + 'starred_entries.json',
      FeedbinConditionalGetKeys.starredEntries);
  }

  private async retrieveEntryIDs(urlString: string,
    conditionalGetKey: string): Promise<number[] | undefined> {
    this.requireNotSuspended();
    const response: DownloadResponse = await Downloader.shared.send(urlString, HTTPMethod.get,
      this.conditionalHeaders(conditionalGetKey));
    if (statusCodeOf(response) === HTTPResponseCode.notModified) {
      return undefined;
    }
    requireOK(response);
    this.storeConditionalGet(conditionalGetKey, response);

    const values: Object[] | undefined = jsonArrayOf(response);
    if (values === undefined) {
      return undefined;
    }
    const ids: number[] = [];
    for (const value of values) {
      if (typeof value === 'number') {
        ids.push(value as number);
      }
    }
    return ids;
  }

  async createUnreadEntries(entries: number[]): Promise<void> {
    await this.sendEntryIDs(feedbinBaseURL + 'unread_entries.json', HTTPMethod.post,
      'unread_entries', entries);
  }

  async deleteUnreadEntries(entries: number[]): Promise<void> {
    await this.sendEntryIDs(feedbinBaseURL + 'unread_entries.json', HTTPMethod.delete,
      'unread_entries', entries);
  }

  async createStarredEntries(entries: number[]): Promise<void> {
    await this.sendEntryIDs(feedbinBaseURL + 'starred_entries.json', HTTPMethod.post,
      'starred_entries', entries);
  }

  async deleteStarredEntries(entries: number[]): Promise<void> {
    await this.sendEntryIDs(feedbinBaseURL + 'starred_entries.json', HTTPMethod.delete,
      'starred_entries', entries);
  }

  private async sendEntryIDs(urlString: string, method: string, key: string,
    entries: number[]): Promise<void> {
    this.requireNotSuspended();
    const body: string = '{"' + key + '":[' + entries.join(',') + ']}';
    const response: DownloadResponse = await Downloader.shared.send(urlString, method,
      this.authHeaders('application/json; charset=utf-8'), body);
    requireOK(response);
  }
}

// MARK: - The delegate

export class FeedbinAccountDelegate implements AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[] =
    [new AccountBehavior(AccountBehaviorKind.disallowFeedCopyInRootFolder)];
  isOPMLImportInProgress: boolean = false;
  readonly server?: string = 'api.feedbin.com';
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  private credentialsValue?: Credentials;
  private readonly caller: FeedbinAPICaller = new FeedbinAPICaller();
  private readonly syncDatabase: SyncDatabase;
  private readonly refreshProgress: RSProgress = new RSProgress();
  private articlesRefreshedCount: number = 0;

  constructor(dataFolder: string) {
    this.syncDatabase = new SyncDatabase(dataFolder + '/Sync.sqlite3');
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
    this.caller.account = account;
    account.retrieveCredentials(CredentialsType.basic)
      .then((credentials: Credentials | undefined): void => {
        this.credentials = credentials;
      })
      .catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'retrieveCredentials: %{public}s', String(e));
      });

    // A send in progress when the app was killed left its statuses selected. Clear them so
    // they get sent instead of waiting for the next selectForProcessing.
    this.syncDatabase.open().then((): Promise<void> => {
      return this.syncDatabase.resetAllSelectedForProcessing();
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sync database open failed: %{public}s', String(e));
    });
  }

  accountWillBeDeleted(): void {
    // Feedbin has no logout call.
  }

  async refreshAll(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    if (this.credentials === undefined) {
      this.credentials = await account.retrieveCredentials(CredentialsType.basic);
    }

    this.refreshProgress.reset();
    this.refreshProgress.addTasks(5);

    const activityID: number = account.logActivityStart(ActivityKindType.refreshAll);
    try {
      await this.refreshAccount(account);
      await this.refreshArticlesAndStatuses(account);
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
    try {
      const statuses: SyncStatus[] = await this.syncDatabase.selectForProcessing();
      let sentCount: number = 0;

      sentCount += await this.sendStatuses(
        statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.read && !s.flag),
        (ids: number[]): Promise<void> => this.caller.createUnreadEntries(ids));
      sentCount += await this.sendStatuses(
        statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.read && s.flag),
        (ids: number[]): Promise<void> => this.caller.deleteUnreadEntries(ids));
      sentCount += await this.sendStatuses(
        statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.starred && s.flag),
        (ids: number[]): Promise<void> => this.caller.createStarredEntries(ids));
      sentCount += await this.sendStatuses(
        statuses.filter((s: SyncStatus) => s.key === SyncStatusKey.starred && !s.flag),
        (ids: number[]): Promise<void> => this.caller.deleteStarredEntries(ids));

      account.logActivityComplete(activityID, sentCount + ' statuses sent', sentCount > 0);
      return sentCount;
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Sending article status');
      throw e as Error;
    }
  }

  private async sendStatuses(statuses: SyncStatus[],
    apiCall: (ids: number[]) => Promise<void>): Promise<number> {
    if (statuses.length === 0) {
      return 0;
    }
    const key: SyncStatusKey = statuses[0].key;
    const articleIDs: number[] = [];
    for (const status of statuses) {
      const id: number = Number.parseInt(status.articleID, 10);
      if (!Number.isNaN(id)) {
        articleIDs.push(id);
      }
    }

    let savedError: Error | undefined = undefined;
    let sentCount: number = 0;
    for (const group of chunked(articleIDs, 1000)) {
      const groupIDs: string[] = group.map((id: number) => String(id));
      try {
        await apiCall(group);
        await this.syncDatabase.deleteSelectedForProcessing(groupIDs, key);
        sentCount += group.length;
      } catch (e) {
        savedError = e as Error;
        hilog.error(DOMAIN, TAG, 'status sync call failed: %{public}s', String(e));
        await this.syncDatabase.resetSelectedForProcessing(groupIDs, key);
      }
    }
    if (savedError !== undefined) {
      throw savedError;
    }
    return sentCount;
  }

  private async refreshArticleStatusReturningCount(account: AccountService): Promise<number> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshArticleStatuses);
    let changedCount: number = 0;
    let refreshError: Error | undefined = undefined;

    try {
      const unreadIDs: number[] | undefined = await this.caller.retrieveUnreadEntries();
      changedCount += await this.syncArticleReadState(account, unreadIDs);
    } catch (e) {
      refreshError = e as Error;
      hilog.error(DOMAIN, TAG, 'retrieving unread entries failed: %{public}s', String(e));
    }

    try {
      const starredIDs: number[] | undefined = await this.caller.retrieveStarredEntries();
      changedCount += await this.syncArticleStarredState(account, starredIDs);
    } catch (e) {
      refreshError = e as Error;
      hilog.error(DOMAIN, TAG, 'retrieving starred entries failed: %{public}s', String(e));
    }

    if (refreshError !== undefined) {
      account.logActivityFail(activityID, refreshError);
      account.postSyncError(refreshError, 'Refreshing article status');
      throw refreshError;
    }
    account.logActivityComplete(activityID, changedCount + ' changed', changedCount > 0);
    return changedCount;
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
      const result: FeedbinImportResult = await this.caller.importOPML(opmlText);
      if (!result.complete) {
        await this.checkImportResult(result.importResultID);
      }
      account.logActivityComplete(activityID, 'Import finished');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.isOPMLImportInProgress = false;
      this.refreshProgress.completeTask();
    }
  }

  /** Polls the import every 15 seconds until it completes or errors, as the source does. */
  private async checkImportResult(importResultID: number): Promise<void> {
    while (true) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 15000);
      });
      const result: FeedbinImportResult | undefined =
        await this.caller.retrieveOPMLImportResult(importResultID);
      if (result !== undefined && result.complete) {
        return;
      }
    }
  }

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
    // Feedbin models a folder as a tag on its feeds: an empty folder exists only locally.
    if (folder.topLevelFeeds.length === 0) {
      folder.name = name;
      account.structureDidChange();
      return;
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.renameFolder, folder.name);
    try {
      const oldName: string = folder.name === undefined ? '' : folder.name;
      await this.caller.renameTag(oldName, name);
      await this.renameFolderRelationship(account, oldName, name);
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
    const folderName: string = folder.name === undefined ? '' : folder.name;
    // If no feed is tagged, the folder doesn't exist on Feedbin at all.
    if (folder.topLevelFeeds.length === 0) {
      account.removeFolderFromTree(folder);
      return;
    }

    this.refreshProgress.addTasks(folder.topLevelFeeds.length);
    for (const feed of folder.topLevelFeeds.slice()) {
      try {
        const relationship: Map<string, string> | undefined = feed.folderRelationship;
        if (relationship !== undefined && relationship.size > 1) {
          const taggingID: string | undefined = relationship.get(folderName);
          if (taggingID !== undefined) {
            await this.caller.deleteTagging(taggingID);
            await this.clearFolderRelationship(account, feed, folderName);
          }
        } else {
          const subscriptionID: string | undefined = feed.externalID;
          if (subscriptionID !== undefined) {
            await this.caller.deleteSubscription(subscriptionID);
            account.clearFeedSettings(feed);
          }
        }
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'Remove feed error: %{public}s', String(e));
        account.postSyncError(e as Error, 'Removing feed');
      } finally {
        this.refreshProgress.completeTask();
      }
    }
    account.removeFolderFromTree(folder);
  }

  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.subscribeFeed, url);
    try {
      const result: CreateSubscriptionResult = await this.caller.createSubscription(url);
      if (result.kind === CreateSubscriptionResultKind.created) {
        const feed: Feed = await this.createFeedFromSubscription(account,
          result.subscription as FeedbinSubscription, name, container);
        account.logActivityComplete(activityID, feed.nameForDisplay);
        return feed;
      }
      if (result.kind === CreateSubscriptionResultKind.multipleChoice) {
        const feed: Feed = await this.decideBestFeedChoice(url, name, container,
          result.choices === undefined ? [] : result.choices);
        account.logActivityComplete(activityID, feed.nameForDisplay);
        return feed;
      }
      if (result.kind === CreateSubscriptionResultKind.alreadySubscribed) {
        throw AccountError.of(AccountErrorKind.createErrorAlreadySubscribed);
      }
      throw AccountError.of(AccountErrorKind.createErrorNotFound);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  private async decideBestFeedChoice(url: string, name: string | undefined,
    container: ContainerRef, choices: FeedbinSubscriptionChoice[]): Promise<Feed> {
    const specifiers: FeedSpecifier[] = [];
    let orderFound: number = 0;
    for (const choice of choices) {
      orderFound += 1;
      const specifier: FeedSpecifier = {
        title: choice.name,
        urlString: choice.url,
        source: url === choice.url ? FeedSpecifierSource.userEntered
          : FeedSpecifierSource.HTMLLink,
        orderFound: orderFound
      };
      specifiers.push(specifier);
    }
    const best: FeedSpecifier | undefined = bestFeed(specifiers);
    if (best === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    return await this.createFeed(best.urlString, name, container, true);
  }

  private async createFeedFromSubscription(account: AccountService,
    subscription: FeedbinSubscription, name: string | undefined,
    container: ContainerRef): Promise<Feed> {
    const feed: Feed = account.createFeedWith(subscription.name, subscription.url,
      String(subscription.feedID), subscription.homePageURL);
    feed.externalID = String(subscription.subscriptionID);
    const jsonFeed: FeedbinSubscriptionJSONFeed | undefined = subscription.jsonFeed;
    if (jsonFeed !== undefined) {
      feed.iconURL = jsonFeed.icon;
      feed.faviconURL = jsonFeed.favicon;
    }
    await account.persistFeedSettings(feed);

    await this.addFeed(feed, container);
    if (name !== undefined) {
      await this.renameFeed(feed, name);
    }
    // The initial article download runs in the background, as in the source.
    this.initialFeedDownload(account, feed).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'initial feed download failed: %{public}s', String(e));
    });
    return feed;
  }

  private async initialFeedDownload(account: AccountService, feed: Feed): Promise<void> {
    const page: EntriesPage = await this.caller.retrieveEntriesForFeedID(feed.feedID);
    await this.processEntries(account, page.entries);
    await this.refreshArticleStatus();
    await this.refreshArticlesPaged(account, page.nextPage, undefined);
    await this.refreshMissingArticles(account);
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
    const activityID: number = account.logActivityStart(ActivityKindType.removeFeed, feed.url);
    try {
      const relationship: Map<string, string> | undefined = feed.folderRelationship;
      if (relationship !== undefined && relationship.size > 1) {
        await this.deleteTagging(account, feed, container);
      } else {
        await this.deleteSubscription(account, feed);
      }
      account.logActivityComplete(activityID, feed.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.moveFeed, feed.url);
    try {
      if (!sourceContainer.isAccount) {
        await this.deleteTagging(account, feed, sourceContainer);
      }
      await this.addFeed(feed, destinationContainer);
      account.logActivityComplete(activityID, destinationContainer.nameForDisplay);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const folder: Folder | undefined = container.folder;
    if (folder === undefined) {
      account.addFeedIfNotInAnyFolder(feed);
      return;
    }
    const feedID: number = Number.parseInt(feed.feedID, 10);
    if (Number.isNaN(feedID)) {
      return;
    }

    this.refreshProgress.addTask();
    const activityID: number = account.logActivityStart(ActivityKindType.addFeed, feed.url);
    try {
      const folderName: string = folder.name === undefined ? '' : folder.name;
      const taggingID: number = await this.caller.createTagging(feedID, folderName);
      await this.saveFolderRelationship(account, feed, folderName, String(taggingID));
      account.removeFeedFromTreeAtTopLevel(feed);
      folder.addFeedToTreeAtTopLevel(feed);
      account.structureDidChange();
      account.logActivityComplete(activityID, folderName);
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
        hilog.error(DOMAIN, TAG, 'Restore folder feed error: %{public}s', String(e));
        account.postSyncError(e as Error, 'Restoring feed');
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
      // Flush in the background so marking doesn't block the caller.
      this.sendArticleStatus().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'background status flush failed: %{public}s', String(e));
      });
    }
  }

  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    const caller: FeedbinAPICaller = new FeedbinAPICaller();
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
      account.retrieveCredentials(CredentialsType.basic)
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

  private async refreshAccount(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshFeedList);
    try {
      const tags: FeedbinTag[] | undefined = await this.caller.retrieveTags();
      this.refreshProgress.completeTask();

      const subscriptions: FeedbinSubscription[] | undefined =
        await this.caller.retrieveSubscriptions();
      this.refreshProgress.completeTask();
      this.forceExpireFolderFeedRelationship(account, tags);

      const taggings: FeedbinTagging[] | undefined = await this.caller.retrieveTaggings();
      this.syncFolders(account, tags);
      await this.syncFeeds(account, subscriptions);
      await this.syncFeedFolderRelationship(account, taggings);
      this.refreshProgress.completeTask();

      account.logActivityComplete(activityID,
        (subscriptions === undefined ? 0 : subscriptions.length) + ' feeds, '
        + (tags === undefined ? 0 : tags.length) + ' folders');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Refreshing account');
      throw e as Error;
    }
  }

  private async refreshArticlesAndStatuses(account: AccountService): Promise<void> {
    await this.sendArticleStatus();
    await this.refreshArticleStatus();
    await this.refreshArticles(account);
    await this.refreshMissingArticles(account);
    this.refreshProgress.reset();
  }

  /**
   * Feedbin doesn't change taggings.json when a tag is renamed, so a tag we have no folder
   * for forces the taggings conditional GET to expire.
   */
  private forceExpireFolderFeedRelationship(account: AccountService,
    tags?: FeedbinTag[]): void {
    if (tags === undefined) {
      return;
    }
    const folderNames: string[] = account.folders().map((f: Folder) =>
      f.name === undefined ? '' : f.name);
    for (const tag of tags) {
      if (!folderNames.includes(tag.name)) {
        account.setConditionalGetInfo(undefined, FeedbinConditionalGetKeys.taggings);
      }
    }
  }

  private syncFolders(account: AccountService, tags?: FeedbinTag[]): void {
    if (tags === undefined) {
      return;
    }
    const tagNames: string[] = tags.map((tag: FeedbinTag) => tag.name);

    // Delete any folders not at Feedbin.
    for (const folder of account.folders().slice()) {
      const folderName: string = folder.name === undefined ? '' : folder.name;
      if (!tagNames.includes(folderName)) {
        for (const feed of folder.topLevelFeeds.slice()) {
          account.addFeedToTreeAtTopLevel(feed);
          this.clearFolderRelationship(account, feed, folderName).catch((e: Object): void => {
            hilog.error(DOMAIN, TAG, 'clearFolderRelationship: %{public}s', String(e));
          });
        }
        account.removeFolderFromTree(folder);
      }
    }

    // Make any folders Feedbin has but we don't.
    const folderNames: string[] = account.folders().map((f: Folder) =>
      f.name === undefined ? '' : f.name);
    for (const tagName of tagNames) {
      if (!folderNames.includes(tagName)) {
        account.ensureFolder(tagName);
      }
    }
  }

  private async syncFeeds(account: AccountService,
    subscriptions?: FeedbinSubscription[]): Promise<void> {
    if (subscriptions === undefined) {
      return;
    }
    const subFeedIDs: string[] = subscriptions.map((s: FeedbinSubscription) => String(s.feedID));

    // Remove any feeds that are no longer in the subscriptions.
    for (const folder of account.folders()) {
      for (const feed of folder.topLevelFeeds.slice()) {
        if (!subFeedIDs.includes(feed.feedID)) {
          folder.removeFeedFromTreeAtTopLevel(feed);
        }
      }
    }
    for (const feed of account.model.topLevelFeeds.slice()) {
      if (!subFeedIDs.includes(feed.feedID)) {
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }

    const subscriptionsToAdd: FeedbinSubscription[] = [];
    for (const subscription of subscriptions) {
      const feedID: string = String(subscription.feedID);
      const feed: Feed | undefined = account.existingFeedWithFeedID(feedID);
      if (feed === undefined) {
        subscriptionsToAdd.push(subscription);
        continue;
      }
      feed.name = subscription.name;
      // The name changed on the server, so drop the locally edited name.
      feed.editedName = undefined;
      feed.homePageURL = subscription.homePageURL;
      feed.externalID = String(subscription.subscriptionID);
      const jsonFeed: FeedbinSubscriptionJSONFeed | undefined = subscription.jsonFeed;
      if (jsonFeed !== undefined) {
        feed.faviconURL = jsonFeed.favicon;
        feed.iconURL = jsonFeed.icon;
      }
      await account.persistFeedSettings(feed);
    }

    for (const subscription of subscriptionsToAdd) {
      const feed: Feed = account.createFeedWith(subscription.name, subscription.url,
        String(subscription.feedID), subscription.homePageURL);
      feed.externalID = String(subscription.subscriptionID);
      await account.persistFeedSettings(feed);
      account.addFeedToTreeAtTopLevel(feed);
    }
  }

  private async syncFeedFolderRelationship(account: AccountService,
    taggings?: FeedbinTagging[]): Promise<void> {
    if (taggings === undefined) {
      return;
    }
    const folderDict: Map<string, Folder> = new Map<string, Folder>();
    for (const folder of account.folders()) {
      const name: string = folder.name === undefined ? '' : folder.name;
      if (!folderDict.has(name)) {
        folderDict.set(name, folder);
      }
    }

    const taggingsDict: Map<string, FeedbinTagging[]> = new Map<string, FeedbinTagging[]>();
    for (const tagging of taggings) {
      const existing: FeedbinTagging[] | undefined = taggingsDict.get(tagging.name);
      if (existing === undefined) {
        taggingsDict.set(tagging.name, [tagging]);
      } else {
        existing.push(tagging);
      }
    }

    const folderNames: string[] = [];
    taggingsDict.forEach((groupedTaggings: FeedbinTagging[], folderName: string) => {
      folderNames.push(folderName);
    });

    for (const folderName of folderNames) {
      const folder: Folder | undefined = folderDict.get(folderName);
      const groupedTaggings: FeedbinTagging[] | undefined = taggingsDict.get(folderName);
      if (folder === undefined || groupedTaggings === undefined) {
        continue;
      }
      const taggingFeedIDs: string[] =
        groupedTaggings.map((t: FeedbinTagging) => String(t.feedID));

      // Move any feeds not in the folder back to the account.
      for (const feed of folder.topLevelFeeds.slice()) {
        if (!taggingFeedIDs.includes(feed.feedID)) {
          folder.removeFeedFromTreeAtTopLevel(feed);
          await this.clearFolderRelationship(account, feed, folderName);
          account.addFeedToTreeAtTopLevel(feed);
        }
      }

      // Add any feeds not yet in the folder.
      const folderFeedIDs: string[] = folder.topLevelFeeds.map((f: Feed) => f.feedID);
      for (const tagging of groupedTaggings) {
        const taggingFeedID: string = String(tagging.feedID);
        if (folderFeedIDs.includes(taggingFeedID)) {
          continue;
        }
        const feed: Feed | undefined = account.existingFeedWithFeedID(taggingFeedID);
        if (feed === undefined) {
          continue;
        }
        await this.saveFolderRelationship(account, feed, folderName, String(tagging.taggingID));
        folder.addFeedToTreeAtTopLevel(feed);
      }
    }

    // Remove every tagged feed from the account container.
    const taggedFeedIDs: Set<string> =
      setOf(taggings.map((t: FeedbinTagging) => String(t.feedID)));
    for (const feed of account.model.topLevelFeeds.slice()) {
      if (taggedFeedIDs.has(feed.feedID)) {
        account.removeFeedFromTreeAtTopLevel(feed);
      }
    }
    account.structureDidChange();
  }

  private async renameFolderRelationship(account: AccountService, fromName: string,
    toName: string): Promise<void> {
    for (const feed of account.flattenedFeeds()) {
      const relationship: Map<string, string> | undefined = feed.folderRelationship;
      if (relationship === undefined) {
        continue;
      }
      const value: string | undefined = relationship.get(fromName);
      relationship.delete(fromName);
      if (value !== undefined) {
        relationship.set(toName, value);
      }
      feed.folderRelationship = relationship;
      await account.persistFeedSettings(feed);
    }
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

  private async deleteTagging(account: AccountService, feed: Feed,
    container: ContainerRef): Promise<void> {
    const folder: Folder | undefined = container.folder;
    if (folder === undefined) {
      account.removeFeedFromTreeAtTopLevel(feed);
      return;
    }
    const folderName: string = folder.name === undefined ? '' : folder.name;
    const relationship: Map<string, string> | undefined = feed.folderRelationship;
    const taggingID: string | undefined =
      relationship === undefined ? undefined : relationship.get(folderName);
    if (taggingID === undefined) {
      folder.removeFeedFromTreeAtTopLevel(feed);
      return;
    }

    this.refreshProgress.addTask();
    try {
      await this.caller.deleteTagging(taggingID);
      await this.clearFolderRelationship(account, feed, folderName);
      folder.removeFeedFromTreeAtTopLevel(feed);
      account.addFeedIfNotInAnyFolder(feed);
    } catch (e) {
      throw account.wrapError(e as Error);
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  private async deleteSubscription(account: AccountService, feed: Feed): Promise<void> {
    const subscriptionID: string | undefined = feed.externalID;
    if (subscriptionID === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    this.refreshProgress.addTask();
    try {
      await this.caller.deleteSubscription(subscriptionID);
    } catch (e) {
      // Remove it locally anyway and keep going, as the source does.
      hilog.error(DOMAIN, TAG, 'Unable to remove feed from Feedbin: %{public}s', String(e));
      account.postSyncError(e as Error, 'Removing feed');
    } finally {
      this.refreshProgress.completeTask();
    }
    account.clearFeedSettings(feed);
    account.removeAllInstancesOfFeedFromTreeAtAllLevels(feed);
  }

  private async refreshArticles(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshArticles);
    this.articlesRefreshedCount = 0;
    try {
      const page: EntriesPage = await this.caller.retrieveEntries();
      if (page.lastPageNumber !== undefined && page.lastPageNumber > 1) {
        this.refreshProgress.addTasks(page.lastPageNumber - 1);
      }
      this.articlesRefreshedCount += page.entries === undefined ? 0 : page.entries.length;
      await this.processEntries(account, page.entries);
      this.refreshProgress.completeTask();

      await this.refreshArticlesPaged(account, page.nextPage, page.fetchDate);
      account.logActivityComplete(activityID, this.articlesRefreshedCount + ' articles');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      account.postSyncError(e as Error, 'Refreshing articles');
      throw e as Error;
    }
  }

  private async refreshArticlesPaged(account: AccountService, page: string | undefined,
    updateFetchDate: Date | undefined): Promise<void> {
    let nextPage: string | undefined = page;
    while (nextPage !== undefined) {
      const result: EntriesPage = await this.caller.retrieveEntriesForPage(nextPage);
      this.articlesRefreshedCount += result.entries === undefined ? 0 : result.entries.length;
      await this.processEntries(account, result.entries);
      this.refreshProgress.completeTask();
      nextPage = result.nextPage;
    }
    if (updateFetchDate !== undefined) {
      account.lastArticleFetchStartTime = updateFetchDate;
      account.lastRefreshCompletedDate = new Date();
    }
  }

  private async refreshMissingArticles(account: AccountService): Promise<void> {
    const activityID: number = account.logActivityStart(ActivityKindType.refreshMissingArticles);
    let savedError: Error | undefined = undefined;
    try {
      const fetched: Set<string> =
        await account.fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate();
      for (const chunk of chunked(arrayOf(fetched), 100)) {
        try {
          const entries: FeedbinEntry[] = await this.caller.retrieveEntriesWithArticleIDs(chunk);
          await this.processEntries(account, entries);
        } catch (e) {
          savedError = e as Error;
          hilog.error(DOMAIN, TAG, 'Refresh missing articles error: %{public}s', String(e));
        }
      }
      if (savedError !== undefined) {
        account.postSyncError(savedError, 'Refreshing missing articles');
        throw savedError;
      }
      account.logActivityComplete(activityID);
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      this.refreshProgress.completeTask();
    }
  }

  private async processEntries(account: AccountService,
    entries?: FeedbinEntry[]): Promise<void> {
    const parsedItems: ParsedItem[] = FeedbinAccountDelegate.mapEntriesToParsedItems(entries);
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

  private static mapEntriesToParsedItems(entries?: FeedbinEntry[]): ParsedItem[] {
    if (entries === undefined) {
      return [];
    }
    const parsedItems: ParsedItem[] = [];
    for (const entry of entries) {
      const jsonFeed: FeedbinEntryJSONFeed | undefined = entry.jsonFeed;
      const jsonFeedAuthor: FeedbinEntryJSONFeedAuthor | undefined =
        jsonFeed === undefined ? undefined : jsonFeed.jsonFeedAuthor;
      const author: ParsedAuthor = {
        name: entry.authorName,
        url: jsonFeedAuthor === undefined ? undefined : jsonFeedAuthor.url,
        avatarURL: jsonFeedAuthor === undefined ? undefined : jsonFeedAuthor.avatarURL,
        emailAddress: undefined
      };
      const item: ParsedItem = {
        syncServiceID: String(entry.articleID),
        uniqueID: String(entry.articleID),
        feedURL: String(entry.feedID),
        url: entry.url,
        externalURL: jsonFeed === undefined ? undefined : jsonFeed.jsonFeedExternalURL,
        title: entry.title,
        contentHTML: entry.contentHTML,
        summary: entry.summary,
        datePublished: parseDate(entry.datePublished),
        authors: [author]
      };
      parsedItems.push(item);
    }
    return parsedItems;
  }

  /** Feedbin's unread set is authoritative except for statuses we have not sent yet. */
  private async syncArticleReadState(account: AccountService,
    articleIDs?: number[]): Promise<number> {
    if (articleIDs === undefined) {
      return 0;
    }
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingReadStatusArticleIDs());
    const remoteUnread: Set<string> = setOf(articleIDs.map((id: number) => String(id)));
    const localUnread: Set<string> = await account.fetchUnreadArticleIDs();

    const toMarkUnread: Set<string> =
      subtractingIDs(subtractingIDs(remoteUnread, localUnread), pending);
    const markedUnread: string[] = await account.markAsUnread(toMarkUnread);

    const toMarkRead: Set<string> =
      subtractingIDs(subtractingIDs(localUnread, remoteUnread), pending);
    const markedRead: string[] = await account.markAsRead(toMarkRead);

    return markedUnread.length + markedRead.length;
  }

  private async syncArticleStarredState(account: AccountService,
    articleIDs?: number[]): Promise<number> {
    if (articleIDs === undefined) {
      return 0;
    }
    const pending: Set<string> =
      setOf(await this.syncDatabase.selectPendingStarredStatusArticleIDs());
    const remoteStarred: Set<string> = setOf(articleIDs.map((id: number) => String(id)));
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
