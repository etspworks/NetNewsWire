/**
 * AccountDelegate — port of Modules/Account/Sources/Account/AccountDelegate.swift,
 * AccountBehaviors.swift, AccountError.swift, SyncRateLimiter.swift and
 * CombinedRefreshProgress.swift.
 *
 * The pluggable-sync interface plus the dispatch over all 9 AccountType cases. Six
 * implementations serve the nine types: ReaderAPIAccountDelegate serves four of them
 * (freshRSS / inoreader / bazQux / theOldReader) with provider-conditional behavior.
 *
 * This module also carries the small webservice helpers every delegate shares
 * (@ohos.net.http through the wave-B Downloader): error shapes, response decoding,
 * auth headers and form encoding.
 */

import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { AccountType, accountTypeDisplayName } from '../../model/AccountType';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Credentials, CredentialsType } from '../../model/Credentials';
import { DownloadResponse } from '../../model/DownloadResponse';
import { Feed } from '../../model/Feed';
import { Folder } from '../../model/Folder';
import { ProgressInfo } from '../../model/ProgressInfo';
import { HTTPResponseHeader, headerValue } from '../net/DownloadSession';
import { ErrorLogDatabase } from '../db/ErrorLogDatabase';
import { JsonObject, parseJson, asObject, asArray } from '../util/Json';
import { AccountService, ContainerRef } from './Account';
import { CloudKitAccountDelegate } from './CloudKitAccountDelegate';
import { FeedbinAccountDelegate } from './FeedbinAccountDelegate';
import { FeedlyAccountDelegate } from './FeedlyAccountDelegate';
import { LocalAccountDelegate } from './LocalAccountDelegate';
import { NewsBlurAccountDelegate } from './NewsBlurAccountDelegate';
import { ReaderAPIAccountDelegate, ReaderAPIVariant } from './ReaderAPIAccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'AccountDelegate';

// MARK: - Webservice errors

export enum WebserviceErrorKind {
  httpError = 'httpError',
  tooManyRequests = 'tooManyRequests',
  noData = 'noData',
  noURL = 'noURL',
  suspended = 'suspended',
  invalidResponse = 'invalidResponse'
}

export class WebserviceError extends Error {
  readonly kind: WebserviceErrorKind;
  readonly status: number;
  /** Seconds from a 429's Retry-After, when the server sent one. */
  readonly retryAfter?: number;

  constructor(kind: WebserviceErrorKind, status: number = 0, retryAfter?: number) {
    super(WebserviceError.describe(kind, status));
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  static httpError(status: number): WebserviceError {
    return new WebserviceError(WebserviceErrorKind.httpError, status);
  }

  static suspended(): WebserviceError {
    return new WebserviceError(WebserviceErrorKind.suspended);
  }

  private static describe(kind: WebserviceErrorKind, status: number): string {
    if (kind === WebserviceErrorKind.httpError) {
      return 'HTTP error ' + status;
    }
    if (kind === WebserviceErrorKind.tooManyRequests) {
      return 'Too many requests (HTTP 429)';
    }
    if (kind === WebserviceErrorKind.noData) {
      return 'The server returned no data.';
    }
    if (kind === WebserviceErrorKind.noURL) {
      return 'The request had no URL.';
    }
    if (kind === WebserviceErrorKind.suspended) {
      return 'Network activity is suspended.';
    }
    return 'There was an invalid response from the server.';
  }
}

export function isCredentialsErrorStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// MARK: - Account errors

export enum AccountErrorKind {
  createErrorNotFound = 'createErrorNotFound',
  createErrorAlreadySubscribed = 'createErrorAlreadySubscribed',
  opmlImportInProgress = 'opmlImportInProgress',
  invalidParameter = 'invalidParameter',
  invalidResponse = 'invalidResponse',
  urlNotFound = 'urlNotFound',
  unknown = 'unknown',
  wrappedError = 'wrappedError'
}

export class AccountError extends Error {
  readonly kind: AccountErrorKind;
  readonly accountID?: string;
  readonly accountName?: string;
  readonly accountType?: AccountType;
  readonly underlying?: Error;

  constructor(kind: AccountErrorKind, underlying?: Error, accountID?: string,
    accountName?: string, accountType?: AccountType) {
    super(AccountError.describe(kind, underlying, accountName, accountType));
    this.kind = kind;
    this.underlying = underlying;
    this.accountID = accountID;
    this.accountName = accountName;
    this.accountType = accountType;
  }

  static of(kind: AccountErrorKind): AccountError {
    return new AccountError(kind);
  }

  /** AccountError.wrapped(error, account) — carries the account for the error message. */
  static wrapped(error: Error, accountID: string, accountName: string,
    accountType: AccountType): AccountError {
    return new AccountError(AccountErrorKind.wrappedError, error, accountID, accountName,
      accountType);
  }

  get isCredentialsError(): boolean {
    const underlying: Error | undefined = this.underlying;
    if (underlying instanceof WebserviceError) {
      const webserviceError: WebserviceError = underlying as WebserviceError;
      return webserviceError.kind === WebserviceErrorKind.httpError
        && isCredentialsErrorStatus(webserviceError.status);
    }
    return false;
  }

  get recoverySuggestion(): string {
    if (this.kind === AccountErrorKind.wrappedError && this.isCredentialsError) {
      return 'Please update your credentials for this account, or ensure that your account'
        + ' with this service is still valid.';
    }
    if (this.kind === AccountErrorKind.createErrorNotFound
      || this.kind === AccountErrorKind.createErrorAlreadySubscribed) {
      return '';
    }
    return 'Please try again later.';
  }

  /** AccountError.detailedErrorMessage — domain + code + underlying, as in the source. */
  static detailedErrorMessage(error: Error): string {
    let message: string = error.message;
    if (error instanceof WebserviceError) {
      const webserviceError: WebserviceError = error as WebserviceError;
      message += ' (Webservice ' + webserviceError.status + ')';
    }
    if (error instanceof AccountError) {
      const accountError: AccountError = error as AccountError;
      const underlying: Error | undefined = accountError.underlying;
      if (underlying !== undefined) {
        message += ' -- underlying: ' + underlying.message;
      }
    }
    return message;
  }

  private static describe(kind: AccountErrorKind, underlying?: Error, accountName?: string,
    accountType?: AccountType): string {
    if (kind === AccountErrorKind.createErrorNotFound) {
      return 'The feed couldn’t be found and can’t be added.';
    }
    if (kind === AccountErrorKind.createErrorAlreadySubscribed) {
      return 'You are already subscribed to this feed and can’t add it again.';
    }
    if (kind === AccountErrorKind.opmlImportInProgress) {
      return 'An OPML import for this account is already running.';
    }
    if (kind === AccountErrorKind.invalidParameter) {
      return 'Couldn’t fulfill the request due to an invalid parameter.';
    }
    if (kind === AccountErrorKind.invalidResponse) {
      return 'There was an invalid response from the server.';
    }
    if (kind === AccountErrorKind.urlNotFound) {
      return 'The URL request resulted in a not found error.';
    }
    if (kind === AccountErrorKind.unknown || underlying === undefined) {
      return 'Unknown error';
    }
    const name: string = accountName === undefined ? '' : accountName;
    if (underlying instanceof WebserviceError) {
      const webserviceError: WebserviceError = underlying as WebserviceError;
      if (webserviceError.kind === WebserviceErrorKind.httpError
        && isCredentialsErrorStatus(webserviceError.status)) {
        return 'Your “' + name + '” credentials are invalid or expired.';
      }
    }
    const typeName: string = accountType === undefined ? '' : accountTypeDisplayName(accountType);
    return 'An error occurred while syncing the ' + typeName + ' account “' + name + '”: '
      + AccountError.detailedErrorMessage(underlying);
  }
}

/** Posts an entry to the Error Log — the ArkTS form of Account.postSyncError. */
export function postSyncError(accountName: string, accountType: AccountType, error: Error,
  operation: string): void {
  hilog.error(DOMAIN, TAG, '%{public}s: %{public}s', operation, error.message);
  ErrorLogDatabase.shared.logError(accountName, accountType as number, operation,
    AccountError.detailedErrorMessage(error)).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'error log write failed: %{public}s', String(e));
    });
}

// MARK: - SyncRateLimiter

/**
 * Pauses syncing after a rate-limit response until the server's Retry-After (or a default)
 * elapses. Feedly reports its abuse ban as a 403, so it treats forbidden as rate limited.
 */
export class SyncRateLimiter {
  private static readonly defaultRetryAfterSeconds: number = 60 * 60;

  private readonly serviceName: string;
  private readonly treatsForbiddenAsRateLimited: boolean;
  private resumeDateValue?: Date;

  constructor(serviceName: string, treatsForbiddenAsRateLimited: boolean) {
    this.serviceName = serviceName;
    this.treatsForbiddenAsRateLimited = treatsForbiddenAsRateLimited;
  }

  get resumeDate(): Date | undefined {
    return this.resumeDateValue;
  }

  shouldSkip(): boolean {
    const resumeDate: Date | undefined = this.resumeDateValue;
    if (resumeDate === undefined) {
      return false;
    }
    if (resumeDate.getTime() <= Date.now()) {
      this.resumeDateValue = undefined;
      return false;
    }
    hilog.info(DOMAIN, TAG, '%{public}s: skipping — rate limited', this.serviceName);
    return true;
  }

  /** Pauses syncing and posts ONE Error Log entry per rate-limit episode. */
  noteRateLimited(error: Error, account: AccountService, operation: string): void {
    const previous: Date | undefined = this.resumeDateValue;
    const alreadyRateLimited: boolean = previous !== undefined
      && previous.getTime() > Date.now();
    let seconds: number = SyncRateLimiter.defaultRetryAfterSeconds;
    if (error instanceof WebserviceError) {
      const webserviceError: WebserviceError = error as WebserviceError;
      if (webserviceError.retryAfter !== undefined) {
        seconds = webserviceError.retryAfter;
      }
    }
    this.resumeDateValue = new Date(Date.now() + seconds * 1000);
    if (!alreadyRateLimited) {
      account.postSyncError(error, operation);
    }
  }

  isRateLimitError(error: Error): boolean {
    if (!(error instanceof WebserviceError)) {
      return false;
    }
    const webserviceError: WebserviceError = error as WebserviceError;
    if (webserviceError.kind === WebserviceErrorKind.tooManyRequests) {
      return true;
    }
    if (webserviceError.kind === WebserviceErrorKind.httpError
      && webserviceError.status === 429) {
      return true;
    }
    return this.treatsForbiddenAsRateLimited
      && webserviceError.kind === WebserviceErrorKind.httpError
      && webserviceError.status === 403;
  }
}

// MARK: - CombinedRefreshProgress

export type ProgressChangeListener = () => void;

/** Combines the refresh progress of every active account for the refresh status view. */
export class CombinedRefreshProgress {
  static readonly shared: CombinedRefreshProgress = new CombinedRefreshProgress();

  private listeners: ProgressChangeListener[] = [];
  private started: boolean = false;
  progressInfo: ProgressInfo = new ProgressInfo();

  addListener(listener: ProgressChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: ProgressChangeListener): void {
    this.listeners = this.listeners.filter((l: ProgressChangeListener) => l !== listener);
  }

  get isComplete(): boolean {
    return !this.started || this.progressInfo.numberRemaining < 1;
  }

  start(): void {
    if (!this.started) {
      this.started = true;
      this.progressInfo = new ProgressInfo();
      this.postDidChange();
    }
  }

  stop(): void {
    if (this.started) {
      this.started = false;
      this.progressInfo = new ProgressInfo();
      this.postDidChange();
    }
  }

  /** Called when any account's progress changes; monotonic, as in the source. */
  update(accountProgressInfos: ProgressInfo[]): void {
    if (!this.started) {
      return;
    }
    const current: ProgressInfo = this.progressInfo;
    const updated: ProgressInfo = ProgressInfo.combined(accountProgressInfos);

    let numberOfTasks: number = updated.numberOfTasks;
    let numberCompleted: number = updated.numberCompleted;
    if (numberOfTasks < current.numberOfTasks) {
      numberOfTasks = current.numberOfTasks;
    }
    if (numberCompleted < current.numberCompleted) {
      numberCompleted = current.numberCompleted;
    }
    if (numberCompleted > updated.numberOfTasks) {
      numberOfTasks = numberCompleted;
    }
    const numberRemaining: number = numberOfTasks - numberCompleted;

    const next: ProgressInfo = new ProgressInfo(numberOfTasks, numberCompleted, numberRemaining);
    if (!next.equals(this.progressInfo)) {
      this.progressInfo = next;
      this.postDidChange();
    }
  }

  private postDidChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// MARK: - The delegate interface

/**
 * The pluggable-sync interface. `account` is set by the AccountService during its init,
 * before accountDidInitialize() is called.
 */
export interface AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[];
  isOPMLImportInProgress: boolean;
  readonly server?: string;
  credentials?: Credentials;
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo;
  /** Set by the account so a progress change can be republished. */
  onProgressChange?: ProgressChangeListener;

  receiveRemoteNotification(userInfo: Map<string, string>): Promise<void>;

  refreshAll(): Promise<void>;
  /** True when meaningful work was done (statuses sent or local statuses changed). */
  syncArticleStatus(): Promise<boolean>;
  sendArticleStatus(): Promise<void>;
  refreshArticleStatus(): Promise<void>;

  importOPML(opmlFilePath: string): Promise<void>;

  createFolder(name: string): Promise<Folder>;
  renameFolder(folder: Folder, name: string): Promise<void>;
  removeFolder(folder: Folder): Promise<void>;

  createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed>;
  renameFeed(feed: Feed, name: string): Promise<void>;
  addFeed(feed: Feed, container: ContainerRef): Promise<void>;
  removeFeed(feed: Feed, container: ContainerRef): Promise<void>;
  moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void>;

  restoreFeed(feed: Feed, container: ContainerRef): Promise<void>;
  restoreFolder(folder: Folder): Promise<void>;

  markArticles(articleIDs: string[], statusKey: ArticleStatusKey, flag: boolean): Promise<void>;

  /** Called at the end of the account's init. */
  accountDidInitialize(): void;
  accountWillBeDeleted(): void;

  vacuumDatabases(): Promise<void>;

  suspendNetwork(): void;
  resume(): void;
}

// MARK: - Registry / dispatch over all 9 AccountType cases

/**
 * Account.init's switch over AccountType. All 9 cases are covered by 6 implementations —
 * none may be dropped, or the Add Account screen ships inert rows.
 */
export function createAccountDelegate(type: AccountType, dataFolder: string): AccountDelegate {
  if (type === AccountType.onMyMac) {
    return new LocalAccountDelegate();
  }
  if (type === AccountType.cloudKit) {
    return new CloudKitAccountDelegate(dataFolder);
  }
  if (type === AccountType.feedbin) {
    return new FeedbinAccountDelegate(dataFolder);
  }
  if (type === AccountType.feedly) {
    return new FeedlyAccountDelegate(dataFolder);
  }
  if (type === AccountType.newsBlur) {
    return new NewsBlurAccountDelegate(dataFolder);
  }
  if (type === AccountType.freshRSS) {
    return new ReaderAPIAccountDelegate(dataFolder, ReaderAPIVariant.freshRSS);
  }
  if (type === AccountType.inoreader) {
    return new ReaderAPIAccountDelegate(dataFolder, ReaderAPIVariant.inoreader);
  }
  if (type === AccountType.bazQux) {
    return new ReaderAPIAccountDelegate(dataFolder, ReaderAPIVariant.bazQux);
  }
  return new ReaderAPIAccountDelegate(dataFolder, ReaderAPIVariant.theOldReader);
}

/** The credential type each account type stores after a successful validation. */
export function credentialsTypeForAccountType(type: AccountType): CredentialsType | undefined {
  if (type === AccountType.feedbin) {
    return CredentialsType.basic;
  }
  if (type === AccountType.newsBlur) {
    return CredentialsType.newsBlurSessionID;
  }
  if (type === AccountType.feedly) {
    return CredentialsType.oauthAccessToken;
  }
  if (type === AccountType.freshRSS || type === AccountType.inoreader
    || type === AccountType.bazQux || type === AccountType.theOldReader) {
    return CredentialsType.readerAPIKey;
  }
  return undefined;
}

/**
 * Account.validateCredentials(type:credentials:endpoint:) — the static dispatch used by
 * every credential screen. Returns undefined when the credentials are rejected; the local
 * and CloudKit types have nothing to validate.
 */
export async function validateCredentialsForAccountType(type: AccountType,
  credentials: Credentials, endpointURL?: string): Promise<Credentials | undefined> {
  if (type === AccountType.feedbin) {
    return await FeedbinAccountDelegate.validateCredentials(credentials, endpointURL);
  }
  if (type === AccountType.newsBlur) {
    return await NewsBlurAccountDelegate.validateCredentials(credentials, endpointURL);
  }
  if (type === AccountType.freshRSS || type === AccountType.inoreader
    || type === AccountType.bazQux || type === AccountType.theOldReader) {
    return await ReaderAPIAccountDelegate.validateCredentials(credentials,
      readerAPIEndpointFor(type, endpointURL));
  }
  return undefined;
}

/**
 * The endpoint a ReaderAPI account talks to: the variant host, or — for FreshRSS, which is
 * self-hosted — the URL the user typed.
 */
export function readerAPIEndpointFor(type: AccountType,
  userEndpointURL?: string): string | undefined {
  if (type === AccountType.inoreader) {
    return 'https://www.inoreader.com';
  }
  if (type === AccountType.bazQux) {
    return 'https://bazqux.com';
  }
  if (type === AccountType.theOldReader) {
    return 'https://theoldreader.com';
  }
  return userEndpointURL;
}

// MARK: - Webservice helpers shared by the delegates

export function textOf(response: DownloadResponse): string {
  const data: ArrayBuffer | undefined = response.data;
  if (data === undefined || data.byteLength === 0) {
    return '';
  }
  const options: util.TextDecoderOptions = { ignoreBOM: true };
  return util.TextDecoder.create('utf-8', options).decodeToString(new Uint8Array(data));
}

export function statusCodeOf(response: DownloadResponse): number {
  return response.statusCode === undefined ? 0 : response.statusCode;
}

export function statusIsOK(statusCode: number): boolean {
  return statusCode >= 200 && statusCode <= 299;
}

/** Turns a non-2xx response into the error the source's session would have thrown. */
export function requireOK(response: DownloadResponse): void {
  const statusCode: number = statusCodeOf(response);
  if (statusIsOK(statusCode)) {
    return;
  }
  if (statusCode === 429) {
    throw new WebserviceError(WebserviceErrorKind.tooManyRequests, 429,
      retryAfterSecondsOf(response));
  }
  throw WebserviceError.httpError(statusCode);
}

export function retryAfterSecondsOf(response: DownloadResponse): number | undefined {
  const headers: Map<string, string> | undefined = response.headers;
  if (headers === undefined) {
    return undefined;
  }
  const value: string | undefined = headerValue(headers, HTTPResponseHeader.retryAfter);
  if (value === undefined) {
    return undefined;
  }
  const seconds: number = Number.parseInt(value, 10);
  return Number.isNaN(seconds) ? undefined : seconds;
}

export function responseHeader(response: DownloadResponse, name: string): string | undefined {
  const headers: Map<string, string> | undefined = response.headers;
  return headers === undefined ? undefined : headerValue(headers, name);
}

/** The `Date:` header, which the paging fetches use as the fetch watermark. */
export function responseDate(response: DownloadResponse): Date | undefined {
  const value: string | undefined = responseHeader(response, HTTPResponseHeader.date);
  if (value === undefined) {
    return undefined;
  }
  const time: number = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
}

export function jsonObjectOf(response: DownloadResponse): JsonObject | undefined {
  const parsed: Object | undefined = parseJson(textOf(response));
  return parsed === undefined ? undefined : asObject(parsed);
}

export function jsonArrayOf(response: DownloadResponse): Object[] | undefined {
  const parsed: Object | undefined = parseJson(textOf(response));
  return parsed === undefined ? undefined : asArray(parsed);
}

export function jsonObjectArrayOf(response: DownloadResponse): JsonObject[] | undefined {
  const items: Object[] | undefined = jsonArrayOf(response);
  if (items === undefined) {
    return undefined;
  }
  const out: JsonObject[] = [];
  for (const item of items) {
    const obj: JsonObject | undefined = asObject(item);
    if (obj !== undefined) {
      out.push(obj);
    }
  }
  return out;
}

export function base64Encode(s: string): string {
  const bytes: Uint8Array = new util.TextEncoder().encodeInto(s);
  return new util.Base64Helper().encodeToStringSync(bytes);
}

/** HTTP Basic — Feedbin's auth. */
export function basicAuthValue(username: string, password: string): string {
  return 'Basic ' + base64Encode(username + ':' + password);
}

/** URLComponents.enhancedPercentEncodedQuery — `+` must be escaped, not left literal. */
export function formEncode(pairs: Map<string, string>): string {
  const parts: string[] = [];
  pairs.forEach((value: string, key: string) => {
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  });
  return parts.join('&');
}

/** Repeated-key form body (story_hash=a&story_hash=b) — NewsBlur's status calls. */
export function formEncodeRepeated(key: string, values: string[]): string {
  const parts: string[] = [];
  for (const value of values) {
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  }
  return parts.join('&');
}

export function appendQueryItems(urlString: string, items: Map<string, string>): string {
  const query: string = formEncode(items);
  if (query.length === 0) {
    return urlString;
  }
  return urlString + (urlString.includes('?') ? '&' : '?') + query;
}

export function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i: number = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, Math.min(i + size, items.length)));
  }
  return chunks;
}

export function subtractingIDs(ids: Set<string>, other: Set<string>): Set<string> {
  const out: Set<string> = new Set<string>();
  ids.forEach((id: string) => {
    if (!other.has(id)) {
      out.add(id);
    }
  });
  return out;
}

export function setOf(ids: string[]): Set<string> {
  return new Set<string>(ids);
}

export function arrayOf(ids: Set<string>): string[] {
  const out: string[] = [];
  ids.forEach((id: string) => out.push(id));
  return out;
}

/**
 * FreshRSS escapes & < > as their fullwidth equivalents in titles, author names and feed
 * names. Map them back. (ReaderAPIAccountDelegate.decodingFullwidthEscapedCharacters)
 */
export function decodingFullwidthEscapedCharacters(s?: string): string | undefined {
  if (s === undefined) {
    return undefined;
  }
  if (!s.includes('＆') && !s.includes('＜') && !s.includes('＞')) {
    return s;
  }
  return s.replace(/＆/g, '&').replace(/＜/g, '<').replace(/＞/g, '>');
}
