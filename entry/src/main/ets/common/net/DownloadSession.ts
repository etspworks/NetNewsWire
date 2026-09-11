/**
 * DownloadSession — port of the RSWeb networking layer:
 *   DownloadSession.swift      the feed-refresh session with its politeness policy
 *   Downloader.swift           the one-shot downloader with a short response cache
 *   DownloadCache.swift        that cache
 *   HTTPResponse429.swift      the per-host Retry-After ledger
 *   UserAgent / HTTPMethod / HTTPRequestHeader / HTTPResponseHeader / HTTPResponseCode
 *
 * Every `http.createHttp()` is destroyed in a `finally` — a leaked HttpRequest leaks
 * native sockets.
 *
 * One platform difference, called out rather than papered over: `@ohos.net.http` follows
 * redirects internally and does not report the hops, so the permanent-redirect cache can
 * only be filled when a 3xx actually reaches us with a Location header (some servers
 * return one on a HEAD-ish response). Everything else in the policy — conditional GET,
 * 304 short-circuit, Cache-Control clamped at 5h, the 429 Retry-After per-host
 * cancellation, the 4xx skip list and the bounded task queue — is intact.
 */

import { connection, http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DownloadResponse } from '../../model/DownloadResponse';
import { HTTPConditionalGetInfo, conditionalGetRequestHeaders }
  from '../../model/HTTPConditionalGetInfo';
import { ProgressInfo } from '../../model/ProgressInfo';
import { AppDefaults, AppDefaultsKey } from '../prefs/AppDefaults';
import { isOpenRSSOrgURL, isRachelByTheBayURL, isYoutubeURL, hostOf } from '../util/Urls';

const DOMAIN: number = 0x0001;
const TAG: string = 'DownloadSession';

export class HTTPMethod {
  static readonly get: string = 'GET';
  static readonly post: string = 'POST';
  static readonly put: string = 'PUT';
  static readonly patch: string = 'PATCH';
  static readonly delete: string = 'DELETE';
}

export class HTTPRequestHeader {
  static readonly userAgent: string = 'User-Agent';
  static readonly authorization: string = 'Authorization';
  static readonly contentType: string = 'Content-Type';
  static readonly ifModifiedSince: string = 'If-Modified-Since';
  static readonly ifNoneMatch: string = 'If-None-Match';
}

export class HTTPResponseHeader {
  static readonly contentType: string = 'Content-Type';
  static readonly location: string = 'Location';
  static readonly link: string = 'Links';
  static readonly date: string = 'Date';
  static readonly lastModified: string = 'Last-Modified';
  static readonly etag: string = 'Etag';
  static readonly cacheControl: string = 'Cache-Control';
  static readonly retryAfter: string = 'Retry-After';
}

export class HTTPResponseCode {
  static readonly OK: number = 200;
  static readonly notModified: number = 304;
  static readonly redirectPermanent: number = 301;
  static readonly redirectTemporary: number = 302;
  static readonly redirectVeryTemporary: number = 307;
  static readonly redirectPermanentPreservingMethod: number = 308;
  static readonly tooManyRequests: number = 429;
}

export enum UserAgentStyle {
  /** The app's normal feed-reader user agent — the session default. */
  feed = 'feed',
  /** The extended feed-reader user agent that some hosts require. */
  specialCaseFeed = 'specialCaseFeed',
  /** The browser-style user agent that matches the article web view. */
  browser = 'browser'
}

export class UserAgent {
  static readonly feedUserAgent: string = 'NetNewsWire (RSS Reader)';
  static readonly extendedUserAgent: string =
    'NetNewsWire (RSS Reader; HarmonyOS; https://netnewswire.com/)';
  /** Replaced at startup with the article Web component's real user agent. */
  static browserUserAgent: string =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) NetNewsWire';

  static forStyle(style: UserAgentStyle): string {
    if (style === UserAgentStyle.browser) {
      return UserAgent.browserUserAgent;
    }
    if (style === UserAgentStyle.specialCaseFeed) {
      return UserAgent.extendedUserAgent;
    }
    return UserAgent.feedUserAgent;
  }

  /** Host requirements win over the requested style — RSWeb's addSpecialCaseUserAgentIfNeeded. */
  static resolve(urlString: string, style: UserAgentStyle): string {
    if (isOpenRSSOrgURL(urlString) || isRachelByTheBayURL(urlString)) {
      return UserAgent.extendedUserAgent;
    }
    return UserAgent.forStyle(style);
  }
}

/**
 * Header names are stored under the canonical spelling the rest of the app looks them up
 * by (model/HTTPConditionalGetInfo reads 'Last-Modified' / 'Etag'); @ohos.net.http hands
 * back whatever casing the server sent, usually all-lowercase.
 */
const CANONICAL_HEADER_NAMES: Map<string, string> = buildCanonicalHeaderNames();

function buildCanonicalHeaderNames(): Map<string, string> {
  const m: Map<string, string> = new Map<string, string>();
  m.set('last-modified', HTTPResponseHeader.lastModified);
  m.set('etag', HTTPResponseHeader.etag);
  m.set('cache-control', HTTPResponseHeader.cacheControl);
  m.set('retry-after', HTTPResponseHeader.retryAfter);
  m.set('content-type', HTTPResponseHeader.contentType);
  m.set('location', HTTPResponseHeader.location);
  m.set('date', HTTPResponseHeader.date);
  m.set('links', HTTPResponseHeader.link);
  m.set('link', HTTPResponseHeader.link);
  return m;
}

export function headersToMap(header: Object): Map<string, string> {
  const map: Map<string, string> = new Map<string, string>();
  const record: Record<string, Object> = header as Record<string, Object>;
  for (const key of Object.keys(record)) {
    const rawValue: Object | undefined = record[key];
    let value: string | undefined = undefined;
    if (typeof rawValue === 'string') {
      value = rawValue as string;
    } else if (Array.isArray(rawValue)) {
      const values: Object[] = rawValue as Object[];
      if (values.length > 0 && typeof values[0] === 'string') {
        value = values[0] as string;
      }
    }
    if (value === undefined) {
      continue;
    }
    const canonical: string | undefined = CANONICAL_HEADER_NAMES.get(key.toLowerCase());
    map.set(canonical === undefined ? key : canonical, value);
  }
  return map;
}

/** Case-insensitive header lookup. */
export function headerValue(headers: Map<string, string>, name: string): string | undefined {
  const direct: string | undefined = headers.get(name);
  if (direct !== undefined) {
    return direct;
  }
  const target: string = name.toLowerCase();
  let found: string | undefined = undefined;
  headers.forEach((value: string, key: string) => {
    if (found === undefined && key.toLowerCase() === target) {
      found = value;
    }
  });
  return found;
}

function statusIsOK(statusCode: number): boolean {
  return statusCode >= 200 && statusCode <= 299;
}

/** 429 Too Many Requests — RSWeb/HTTPResponse429.swift. */
class HTTPResponse429 {
  readonly host: string;
  readonly dateCreated: Date;
  readonly retryAfterSeconds: number;

  constructor(host: string, retryAfterSeconds: number) {
    this.host = host.toLowerCase();
    this.retryAfterSeconds = retryAfterSeconds;
    this.dateCreated = new Date();
  }

  get resumeDate(): Date {
    return new Date(this.dateCreated.getTime() + this.retryAfterSeconds * 1000);
  }

  get canResume(): boolean {
    return Date.now() >= this.resumeDate.getTime();
  }
}

class HTTP4xxResponse {
  readonly statusCode: number;
  readonly date: Date;

  constructor(statusCode: number) {
    this.statusCode = statusCode;
    this.date = new Date();
  }
}

/** The DownloadSessionDelegate protocol. */
export interface DownloadSessionDelegate {
  conditionalGetInfoFor(urlString: string): HTTPConditionalGetInfo | undefined;
  didReceiveResponse(urlString: string): void;
  didSkip(urlString: string, reason: string): void;
  downloadDidComplete(urlString: string, response: DownloadResponse, error?: Error): void;
  /** False cancels the download mid-flight (the source uses it to reject non-feed data). */
  shouldContinueAfterReceivingData(data: ArrayBuffer, urlString: string): boolean;
  httpError(statusCode: number, urlString: string): void;
  didFollowRedirect(urlString: string, fromURL: string, toURL: string,
    statusCode: number): void;
  downloadSessionDidComplete(): void;
}

export type ProgressListener = (progressInfo: ProgressInfo) => void;

// One request, executed and always torn down.
async function performRequest(urlString: string, headers: Map<string, string>,
  method: string, body?: string): Promise<DownloadResponse> {
  const request: http.HttpRequest = http.createHttp();
  try {
    const headerObject: Record<string, string> = {};
    headers.forEach((value: string, key: string) => {
      headerObject[key] = value;
    });
    // @ohos.net.http's RequestMethod has no PATCH. The wire-compatible substitution is a
    // POST carrying X-HTTP-Method-Override, which the sync services accept.
    if (method === HTTPMethod.patch) {
      headerObject['X-HTTP-Method-Override'] = 'PATCH';
    }
    const options: http.HttpRequestOptions = {
      method: (method === HTTPMethod.post || method === HTTPMethod.patch)
        ? http.RequestMethod.POST
        : (method === HTTPMethod.put ? http.RequestMethod.PUT
          : (method === HTTPMethod.delete ? http.RequestMethod.DELETE
            : http.RequestMethod.GET)),
      header: headerObject,
      extraData: body,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      // The source's session config uses .reloadIgnoringLocalCacheData — no URL cache.
      usingCache: false,
      connectTimeout: 15000,
      readTimeout: 60000
    };
    const response: http.HttpResponse = await request.request(urlString, options);
    const responseHeaders: Map<string, string> = headersToMap(response.header);
    const data: ArrayBuffer | undefined = response.result instanceof ArrayBuffer
      ? response.result as ArrayBuffer
      : undefined;
    return new DownloadResponse(data, response.responseCode as number, responseHeaders,
      urlString, false);
  } finally {
    request.destroy();
  }
}

/** Extra headers ArkTS needs to send explicitly (URLSession set the UA on the config). */
function baseHeaders(urlString: string, style: UserAgentStyle): Map<string, string> {
  const headers: Map<string, string> = new Map<string, string>();
  headers.set(HTTPRequestHeader.userAgent, UserAgent.resolve(urlString, style));
  return headers;
}

class DownloadCacheRecord {
  readonly dateCreated: Date = new Date();
  readonly response: DownloadResponse;

  constructor(response: DownloadResponse) {
    this.response = response;
  }
}

/**
 * Downloader — the one-shot downloader for an image or a web page. GET responses are
 * cached for 3 minutes and concurrent callers for the same URL are coalesced onto one
 * request, exactly as Downloader.swift does.
 */
export class Downloader {
  static readonly shared: Downloader = new Downloader();

  private static readonly timeToLiveMillis: number = 3 * 60 * 1000;

  private cache: Map<string, DownloadCacheRecord> = new Map<string, DownloadCacheRecord>();
  private inFlight: Map<string, Promise<DownloadResponse>> =
    new Map<string, Promise<DownloadResponse>>();

  async download(urlString: string,
    style: UserAgentStyle = UserAgentStyle.feed): Promise<DownloadResponse> {
    const lower: string = urlString.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      hilog.debug(DOMAIN, 'Downloader', 'skipping non-http(s) URL: %{public}s', urlString);
      return new DownloadResponse(undefined, undefined, undefined, urlString, false);
    }

    const cached: DownloadCacheRecord | undefined = this.cache.get(urlString);
    if (cached !== undefined) {
      if (Date.now() - cached.dateCreated.getTime() < Downloader.timeToLiveMillis) {
        const response: DownloadResponse = cached.response;
        return new DownloadResponse(response.data, response.statusCode, response.headers,
          response.url, true);
      }
      this.cache.delete(urlString);
    }

    // Coalesce onto an in-progress download for the same URL.
    const existing: Promise<DownloadResponse> | undefined = this.inFlight.get(urlString);
    if (existing !== undefined) {
      const response: DownloadResponse = await existing;
      return new DownloadResponse(response.data, response.statusCode, response.headers,
        response.url, true);
    }

    const pending: Promise<DownloadResponse> =
      performRequest(urlString, baseHeaders(urlString, style), HTTPMethod.get);
    this.inFlight.set(urlString, pending);
    try {
      const response: DownloadResponse = await pending;
      // Errors are not cached — a retry should hit the network.
      this.cache.set(urlString, new DownloadCacheRecord(response));
      return response;
    } finally {
      this.inFlight.delete(urlString);
    }
  }

  /** A request with explicit method / headers / body — the sync delegates' web-service call. */
  async send(urlString: string, method: string, headers: Map<string, string>,
    body?: string, style: UserAgentStyle = UserAgentStyle.feed): Promise<DownloadResponse> {
    const merged: Map<string, string> = baseHeaders(urlString, style);
    headers.forEach((value: string, key: string) => {
      merged.set(key, value);
    });
    return await performRequest(urlString, merged, method, body);
  }

  emptyCache(): void {
    this.cache.clear();
  }
}

/**
 * DownloadSession — the feed-refresh session. `download(urls)` runs the whole set through
 * a bounded queue, reporting each result to the delegate and progress to its listeners.
 */
export class DownloadSession {
  /** The source caps pending tasks at 500 and queues the rest. */
  private static readonly maximumConcurrentTasks: number = 500;
  /** Default for sites like Reddit that send no Retry-After value: 10 minutes. */
  private static readonly defaultRetryAfterSeconds: number = 10 * 60;
  /** A 4xx is remembered for 53 hours. */
  private static readonly fourXXCacheHours: number = 53;
  /** Allow one openrss.org feed per refresh session. */
  private static readonly openRSSOrgIntervalMillis: number = 60 * 60 * 10 * 1000;

  private readonly delegate: DownloadSessionDelegate;
  private readonly progressListeners: ProgressListener[] = [];

  private urlsInSession: Set<string> = new Set<string>();
  private queue: string[] = [];
  private tasksInProgress: Set<string> = new Set<string>();
  private redirectCache: Map<string, string> = new Map<string, string>();
  private retryAfterMessages: Map<string, HTTPResponse429> = new Map<string, HTTPResponse429>();
  private http4xxResponses: Map<string, HTTP4xxResponse> = new Map<string, HTTP4xxResponse>();
  private cancelled: boolean = false;

  progressInfo: ProgressInfo = new ProgressInfo();

  constructor(delegate: DownloadSessionDelegate) {
    this.delegate = delegate;
  }

  addProgressListener(listener: ProgressListener): void {
    this.progressListeners.push(listener);
  }

  removeProgressListener(listener: ProgressListener): void {
    const index: number = this.progressListeners.indexOf(listener);
    if (index >= 0) {
      this.progressListeners.splice(index, 1);
    }
  }

  cancelAll(): void {
    this.cancelled = true;
    this.queue = [];
    this.tasksInProgress.clear();
    this.updateProgress();
  }

  /** Downloads every URL, honoring the politeness policy. Resolves when all are done. */
  async download(urls: string[]): Promise<void> {
    this.cleanUp4xxResponsesCache();
    this.cancelled = false;

    const filtered: string[] = DownloadSession.filteredURLs(urls);
    this.urlsInSession = new Set<string>(filtered);
    this.queue = filtered.slice();
    this.updateProgress();

    const workerCount: number = Math.min(DownloadSession.maximumConcurrentTasks,
      this.queue.length);
    const workers: Promise<void>[] = [];
    for (let i: number = 0; i < workerCount; i++) {
      workers.push(this.runQueue());
    }
    await Promise.all(workers);

    if (this.urlsInSession.size > 0) {
      this.delegate.downloadSessionDidComplete();
      this.urlsInSession = new Set<string>();
    }
    this.updateProgress();
  }

  private async runQueue(): Promise<void> {
    while (!this.cancelled) {
      const url: string | undefined = this.queue.shift();
      if (url === undefined) {
        return;
      }
      await this.performDownload(url);
    }
  }

  private async performDownload(url: string): Promise<void> {
    // If a permanent redirect was seen earlier, use that URL.
    const cachedRedirect: string | undefined = this.cachedRedirect(url);
    const urlToUse: string = cachedRedirect === undefined ? url : cachedRedirect;

    if (this.requestShouldBeDroppedDueToActive429(urlToUse)) {
      hilog.info(DOMAIN, TAG, 'dropping request for previous 429: %{public}s', urlToUse);
      this.delegate.didSkip(url, 'Skipped — previous 429 Too Many Requests');
      this.taskFinished();
      return;
    }
    if (this.requestShouldBeDroppedDueToPrevious400(urlToUse)) {
      hilog.info(DOMAIN, TAG, 'dropping request for previous 400-499: %{public}s', urlToUse);
      this.delegate.didSkip(url, 'Skipped — previous 4xx error');
      this.taskFinished();
      return;
    }

    const headers: Map<string, string> = baseHeaders(urlToUse, UserAgentStyle.feed);
    const conditionalGetInfo: HTTPConditionalGetInfo | undefined =
      this.delegate.conditionalGetInfoFor(url);
    if (conditionalGetInfo !== undefined) {
      conditionalGetRequestHeaders(conditionalGetInfo).forEach((value: string, key: string) => {
        headers.set(key, value);
      });
    }

    this.tasksInProgress.add(urlToUse);
    this.updateProgress();

    try {
      const response: DownloadResponse =
        await performRequest(urlToUse, headers, HTTPMethod.get);
      this.delegate.didReceiveResponse(url);

      const statusCode: number = response.statusCode === undefined ? 0 : response.statusCode;
      this.noteRedirectIfNeeded(url, statusCode, response.headers);

      if (statusCode >= 400) {
        hilog.debug(DOMAIN, TAG, 'canceling task due to >= 400 response %{public}d', statusCode);
        this.delegate.httpError(statusCode, url);
        if (statusCode === HTTPResponseCode.tooManyRequests) {
          this.handle429Response(urlToUse, response.headers);
        } else if (statusCode <= 499) {
          this.cache4xxResponse(urlToUse, new HTTP4xxResponse(statusCode));
        }
        this.delegate.downloadDidComplete(url, response, undefined);
        return;
      }

      const data: ArrayBuffer | undefined = response.data;
      if (data !== undefined
        && !this.delegate.shouldContinueAfterReceivingData(data, url)) {
        this.delegate.downloadDidComplete(url, response, undefined);
        return;
      }

      this.delegate.downloadDidComplete(url, response, undefined);
    } catch (e) {
      const response: DownloadResponse =
        new DownloadResponse(undefined, undefined, undefined, url, false);
      this.delegate.downloadDidComplete(url, response, e as Error);
    } finally {
      this.tasksInProgress.delete(urlToUse);
      this.taskFinished();
    }
  }

  private taskFinished(): void {
    this.updateProgress();
  }

  private updateProgress(): void {
    const numberOfTasks: number = this.urlsInSession.size;
    let numberRemaining: number = 0;
    let numberCompleted: number = 0;
    if (numberOfTasks > 0) {
      numberRemaining = this.tasksInProgress.size + this.queue.length;
      numberCompleted = numberOfTasks - numberRemaining;
    }
    const updated: ProgressInfo =
      new ProgressInfo(numberOfTasks, numberCompleted, numberRemaining);
    if (updated.equals(this.progressInfo)) {
      return;
    }
    this.progressInfo = updated;
    for (const listener of this.progressListeners) {
      listener(updated);
    }
  }

  // MARK: - Redirects

  private noteRedirectIfNeeded(url: string, statusCode: number,
    headers?: Map<string, string>): void {
    if (headers === undefined) {
      return;
    }
    const isRedirect: boolean = statusCode === HTTPResponseCode.redirectPermanent
      || statusCode === HTTPResponseCode.redirectTemporary
      || statusCode === HTTPResponseCode.redirectVeryTemporary
      || statusCode === HTTPResponseCode.redirectPermanentPreservingMethod;
    if (!isRedirect) {
      return;
    }
    const location: string | undefined = headerValue(headers, HTTPResponseHeader.location);
    if (location === undefined || location.length === 0) {
      return;
    }
    this.cacheRedirect(url, location);
    this.delegate.didFollowRedirect(url, url, location, statusCode);
  }

  /** Hotels and captive portals often do permanent redirects; catch the obvious ones. */
  private urlStringIsDisallowedRedirect(urlString: string): boolean {
    const s: string = urlString.toLowerCase();
    const badStrings: string[] = ['solutionip', 'lodgenet', 'monzoon', 'landingpage',
      'btopenzone', 'register', 'login', 'authentic'];
    for (const badString of badStrings) {
      if (s.indexOf(badString) >= 0) {
        return true;
      }
    }
    return false;
  }

  private cacheRedirect(oldURL: string, newURL: string): void {
    if (this.urlStringIsDisallowedRedirect(newURL)) {
      return;
    }
    this.redirectCache.set(oldURL, newURL);
  }

  /** Follows chains of redirects, avoiding loops — undefined when there is no redirect. */
  private cachedRedirect(url: string): string | undefined {
    const seen: Set<string> = new Set<string>();
    seen.add(url);
    let currentURL: string = url;
    while (true) {
      const next: string | undefined = this.redirectCache.get(currentURL);
      if (next === undefined) {
        break;
      }
      if (seen.has(next)) {
        return undefined; // Cycle. Bail.
      }
      seen.add(next);
      currentURL = next;
    }
    return currentURL === url ? undefined : currentURL;
  }

  // MARK: - 429 Too Many Requests

  private handle429Response(urlString: string, headers?: Map<string, string>): void {
    const host: string | undefined = hostOf(urlString);
    if (host === undefined) {
      return;
    }
    let retryAfter: number = DownloadSession.defaultRetryAfterSeconds;
    if (headers !== undefined) {
      const raw: string | undefined = headerValue(headers, HTTPResponseHeader.retryAfter);
      if (raw !== undefined) {
        const parsed: number = Number.parseFloat(raw);
        if (!Number.isNaN(parsed) && parsed > 0) {
          retryAfter = parsed;
        }
      }
    }
    const message: HTTPResponse429 = new HTTPResponse429(host, retryAfter);
    this.retryAfterMessages.set(message.host, message);
    this.cancelAndRemoveQueuedURLsWithHost(message.host);
  }

  private cancelAndRemoveQueuedURLsWithHost(host: string): void {
    const lowercaseHost: string = host.toLowerCase();
    this.queue = this.queue.filter((urlString: string): boolean => {
      const urlHost: string | undefined = hostOf(urlString);
      return urlHost === undefined || urlHost.toLowerCase().indexOf(lowercaseHost) < 0;
    });
    this.updateProgress();
  }

  private requestShouldBeDroppedDueToActive429(urlString: string): boolean {
    const host: string | undefined = hostOf(urlString);
    if (host === undefined) {
      return false;
    }
    const message: HTTPResponse429 | undefined = this.retryAfterMessages.get(host);
    if (message === undefined) {
      return false;
    }
    if (message.canResume) {
      this.retryAfterMessages.delete(host);
      return false;
    }
    return true;
  }

  // MARK: - 400-499 responses

  private cache4xxResponse(urlString: string, response: HTTP4xxResponse): void {
    if (isYoutubeURL(urlString)) {
      return;
    }
    this.http4xxResponses.set(urlString, response);
  }

  private cleanUp4xxResponsesCache(): void {
    const cutoff: number = Date.now() - DownloadSession.fourXXCacheHours * 60 * 60 * 1000;
    const expired: string[] = [];
    this.http4xxResponses.forEach((response: HTTP4xxResponse, urlString: string) => {
      if (response.date.getTime() < cutoff) {
        expired.push(urlString);
      }
    });
    for (const urlString of expired) {
      this.http4xxResponses.delete(urlString);
    }
  }

  private requestShouldBeDroppedDueToPrevious400(urlString: string): boolean {
    if (this.http4xxResponses.has(urlString)) {
      return true;
    }
    const redirected: string | undefined = this.cachedRedirect(urlString);
    return redirected !== undefined && this.http4xxResponses.has(redirected);
  }

  // MARK: - Filtering URLs

  private static canDownloadFromOpenRSSOrg(): boolean {
    if (!AppDefaults.isLoaded()) {
      return true;
    }
    const last: Date | undefined =
      AppDefaults.dateValue(AppDefaultsKey.lastOpenRSSOrgFeedRefresh);
    if (last === undefined) {
      return true;
    }
    return Date.now() > last.getTime() + DownloadSession.openRSSOrgIntervalMillis;
  }

  /** Allow only one openrss.org feed per refresh session. */
  static filteredURLs(urls: string[]): string[] {
    const openRSSOrgURLs: string[] = urls.filter((u: string) => isOpenRSSOrgURL(u));
    const others: string[] = urls.filter((u: string) => !isOpenRSSOrgURL(u));

    if (openRSSOrgURLs.length === 0) {
      return urls;
    }
    if (!DownloadSession.canDownloadFromOpenRSSOrg()) {
      return others;
    }
    if (AppDefaults.isLoaded()) {
      AppDefaults.setDate(AppDefaultsKey.lastOpenRSSOrgFeedRefresh, new Date());
    }
    if (openRSSOrgURLs.length === 1) {
      return urls;
    }
    const index: number = Math.floor(Math.random() * openRSSOrgURLs.length);
    return others.concat([openRSSOrgURLs[index]]);
  }
}

/** Convenience for a caller that just wants "did this succeed". */
export function responseIsOK(response: DownloadResponse): boolean {
  return response.statusCode !== undefined && statusIsOK(response.statusCode);
}

/**
 * @ohos.net.http reports libcurl failures as BusinessError codes of 2300000 + CURLcode.
 * These are the HarmonyOS equivalents of the NSURLError codes LocalAccountRefresher.swift:369-375
 * treats as connectivity-related:
 *   2300007 CURLE_COULDNT_CONNECT     ← NSURLErrorCannotConnectToHost
 *   2300028 CURLE_OPERATION_TIMEDOUT  ← NSURLErrorTimedOut
 *   2300055 CURLE_SEND_ERROR          ← NSURLErrorNetworkConnectionLost
 *   2300056 CURLE_RECV_ERROR          ← NSURLErrorNetworkConnectionLost
 * Everything else — TLS failures, an empty reply, a body that will not parse, and every
 * HTTP status, which never arrives here as an error anyway — is the feed's own fault.
 */
const connectivityErrorCodes: number[] = [2300007, 2300028, 2300055, 2300056];

/**
 * CURLE_COULDNT_RESOLVE_HOST. Ambiguous on its own: URLSession answers
 * NSURLErrorNotConnectedToInternet for an offline device because it consults the network
 * path before resolving, whereas curl only ever reports the failed lookup. So this counts
 * as connectivity only while the device has no default network; with a network up it is a
 * dead domain, which the source penalises (NSURLErrorCannotFindHost is not on its list).
 */
const couldNotResolveHostErrorCode: number = 2300006;

/** Port of LocalAccountRefresher.errorIsConnectivityRelated (LocalAccountRefresher.swift:369). */
export function errorIsConnectivityRelated(error?: Error): boolean {
  if (error === undefined) {
    return false;
  }
  const code: number | undefined = (error as BusinessError).code;
  if (code === undefined) {
    return false;
  }
  if (connectivityErrorCodes.includes(code)) {
    return true;
  }
  return code === couldNotResolveHostErrorCode && !deviceHasNetworkConnection();
}

function deviceHasNetworkConnection(): boolean {
  try {
    return connection.hasDefaultNetSync();
  } catch (e) {
    // The net stack would not answer. Assume online, so a broken feed still gets throttled.
    hilog.warn(DOMAIN, TAG, 'hasDefaultNetSync failed: %{public}s', String(e));
    return true;
  }
}
