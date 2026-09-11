/**
 * LocalAccountDelegate — port of
 * Modules/Account/Sources/Account/LocalAccount/{LocalAccountDelegate,LocalAccountRefresher,
 * InitialFeedDownloader}.swift
 *
 * AccountType.onMyMac: no sync service, so refreshAll downloads and parses every feed
 * itself through the wave-B DownloadSession. The politeness policy travels with it —
 *   • a 9-minute per-feed floor (waived for the hosts we have permission from),
 *   • Cache-Control honored but clamped at 5 hours (openrss.org unclamped),
 *   • twitter.com / x.com never fetched — they return no feeds,
 *   • Reddit one feed per minute (the least-recently-checked one wins),
 *   • conditional-GET info dropped after 8 days, because some servers 304 unconditionally,
 *   • an MD5 contentHash short-circuit that skips parsing an unchanged body.
 */

import fs from '@ohos.file.fs';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { ActivityKind, ActivityKindType, ActivityOwner } from '../../model/Activity';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { CacheControlInfo } from '../../model/CacheControlInfo';
import { Credentials } from '../../model/Credentials';
import { DownloadResponse } from '../../model/DownloadResponse';
import { Feed } from '../../model/Feed';
import { FeedSpecifier, bestFeed } from '../../model/FeedSpecifier';
import { Folder } from '../../model/Folder';
import { HTTPConditionalGetInfo, conditionalGetInfoFromHeaders }
  from '../../model/HTTPConditionalGetInfo';
import { OPMLDocument, OPMLItem } from '../../model/OPMLDocument';
import { ParsedFeed } from '../../model/ParsedFeed';
import { ProgressInfo } from '../../model/ProgressInfo';
import { ArticleChanges } from '../db/ArticlesDatabase';
import { ActivityLog } from '../log/ActivityLog';
import { FeedFinder } from '../net/FeedFinder';
import {
  DownloadSession, DownloadSessionDelegate, HTTPResponseCode, HTTPResponseHeader,
  errorIsConnectivityRelated, headerValue
} from '../net/DownloadSession';
import { ParserData, contentHash, parseFeed } from '../parser/FeedParser';
import { parseOPML } from '../parser/OPML';
import { SpecialCase, hostOf, isRedditURL } from '../util/Urls';
import { AccountService, ContainerRef } from './Account';
import { AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener }
  from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'LocalAccountDelegate';

/** These hosts will never return a feed. */
const badHosts: string[] = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'];

/**
 * Hosts exempt from the minimum time between refreshes even when they send no
 * Cache-Control. We have permission from each of these feed owners.
 */
const domainsWithNoMinimumTime: string[] = [
  'inessential.com', 'ranchero.com', 'netnewswire.blog',
  'daringfireball.net', 'redsweater.com', 'indiestack.com',
  'blog.plunkitup.com', 'bitsplitting.org', 'allenpike.com',
  'hypercritical.co', 'micro.inessential.com', 'discourse.netnewswire.com',
  'onefoottsunami.com', 'manton.org', 'randsinrepose.com',
  'micro.blog', 'shapeof.com', 'flyingmeat.com'
];

const minimumTimeBetweenChecksMillis: number = 9 * 60 * 1000;
const cacheControlMaxMaxAgeSeconds: number = 5 * 60 * 60;
const conditionalGetInfoMaxAgeMillis: number = 8 * 24 * 60 * 60 * 1000;
const specialCaseCutoffHours: number = 25;

class SkipDecision {
  readonly shouldSkip: boolean;
  readonly reason?: string;

  constructor(shouldSkip: boolean, reason?: string) {
    this.shouldSkip = shouldSkip;
    this.reason = reason;
  }
}

function timeString(date: Date): string {
  const hours: number = date.getHours();
  const minutes: number = date.getMinutes();
  return (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes;
}

function pluralized(count: number, singular: string): string {
  return count + ' ' + singular + (count === 1 ? '' : 's');
}

/**
 * LocalAccountRefresher — owns the politeness policy and the DownloadSession callbacks.
 */
export class LocalAccountRefresher implements DownloadSessionDelegate {
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;
  accountID?: string;
  publishesRefreshActivity: boolean = true;

  private readonly session: DownloadSession = new DownloadSession(this);
  private urlToFeed: Map<string, Feed> = new Map<string, Feed>();
  private account?: AccountService;
  private refreshActivityID?: number;
  private feedsTotal: number = 0;
  private feedsSkipped: number = 0;
  private feedsErrored: number = 0;
  private newArticlesCount: number = 0;
  private updatedArticlesCount: number = 0;
  private outstandingParseTasks: number = 0;
  private downloadSessionIsComplete: boolean = false;
  private suspended: boolean = false;

  constructor() {
    this.session.addProgressListener((progressInfo: ProgressInfo): void => {
      if (!progressInfo.equals(this.progressInfo)) {
        this.progressInfo = progressInfo;
        if (this.onProgressChange !== undefined) {
          this.onProgressChange();
        }
      }
    });
  }

  get refreshStatsMessage(): string {
    const parts: string[] = [];
    parts.push(pluralized(this.feedsTotal, 'feed'));
    if (this.feedsSkipped > 0) {
      parts.push(this.feedsSkipped + ' skipped');
    }
    if (this.feedsErrored > 0) {
      parts.push(pluralized(this.feedsErrored, 'error'));
    }
    parts.push(pluralized(this.newArticlesCount, 'new article'));
    parts.push(pluralized(this.updatedArticlesCount, 'updated article'));
    return parts.join(', ');
  }

  async refreshFeeds(account: AccountService, feeds: Feed[]): Promise<void> {
    this.account = account;
    this.accountID = account.accountID;

    const specialCaseCutoffDate: Date =
      new Date(Date.now() - specialCaseCutoffHours * 60 * 60 * 1000);
    const redditURLToRefresh: string | undefined =
      LocalAccountRefresher.redditURLToRefresh(feeds);

    const filteredFeeds: Feed[] = [];
    const skippedFeeds: Feed[] = [];
    const skipReasons: string[] = [];

    for (const feed of feeds) {
      const decision: SkipDecision =
        LocalAccountRefresher.feedShouldBeSkipped(feed, specialCaseCutoffDate, redditURLToRefresh);
      if (decision.shouldSkip && decision.reason !== undefined) {
        skippedFeeds.push(feed);
        skipReasons.push(decision.reason);
      } else {
        filteredFeeds.push(feed);
      }
    }

    this.feedsTotal = feeds.length;
    this.feedsSkipped = skippedFeeds.length;
    this.feedsErrored = 0;
    this.newArticlesCount = 0;
    this.updatedArticlesCount = 0;
    this.outstandingParseTasks = 0;
    this.downloadSessionIsComplete = false;

    const owner: ActivityOwner = account.activityOwner;
    if (this.publishesRefreshActivity) {
      this.refreshActivityID = account.logActivityStart(ActivityKindType.refreshAll);
    }
    for (const feed of filteredFeeds) {
      ActivityLog.shared.createActivity(owner,
        new ActivityKind(ActivityKindType.refreshFeedContent, feed.url), feed.nameForDisplay);
    }
    // The source logs every drop through Logger (LocalAccountRefresher.swift); this port only
    // wrote them to the in-app ActivityLog, so on-device a polite skip looked identical to a
    // silently lost feed. One greppable line per decision restores that.
    hilog.info(DOMAIN, TAG, 'refreshing %{public}d of %{public}d feeds',
      filteredFeeds.length, feeds.length);
    for (let i: number = 0; i < skippedFeeds.length; i++) {
      ActivityLog.shared.logCompletedActivity(owner,
        new ActivityKind(ActivityKindType.refreshFeedContent, skippedFeeds[i].url),
        skippedFeeds[i].nameForDisplay, skipReasons[i]);
      hilog.info(DOMAIN, TAG, 'not refreshing %{public}s — %{public}s',
        skippedFeeds[i].url, skipReasons[i]);
    }

    if (filteredFeeds.length === 0) {
      // Every feed was skipped; the parent activity still has to complete.
      this.downloadSessionIsComplete = true;
      this.completeRefreshActivityIfReady();
      return;
    }

    this.urlToFeed.clear();
    const urls: string[] = [];
    for (const feed of filteredFeeds) {
      this.urlToFeed.set(feed.url, feed);
      urls.push(feed.url);
    }

    await this.session.download(urls);
  }

  suspend(): void {
    this.session.cancelAll();
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  // MARK: - DownloadSessionDelegate

  conditionalGetInfoFor(urlString: string): HTTPConditionalGetInfo | undefined {
    const feed: Feed | undefined = this.urlToFeed.get(urlString);
    if (feed === undefined) {
      return undefined;
    }
    const info: HTTPConditionalGetInfo | undefined = feed.conditionalGetInfo;
    if (info === undefined) {
      return undefined;
    }
    // Some servers 304 whenever ANY conditional-GET info is sent, so those feeds would
    // never update. Drop the info every 8 days to force a real fetch.
    const infoDate: Date | undefined = feed.conditionalGetInfoDate;
    if (infoDate !== undefined
      && Date.now() - infoDate.getTime() > conditionalGetInfoMaxAgeMillis) {
      if (!SpecialCase.urlStringContainSpecialCase(urlString,
        [SpecialCase.openRSSOrgHostName, SpecialCase.rachelByTheBayHostName])) {
        hilog.info(DOMAIN, TAG, 'dropping conditional GET info — older than 8 days');
        feed.conditionalGetInfo = undefined;
        return undefined;
      }
    }
    return info;
  }

  didReceiveResponse(urlString: string): void {
    const feed: Feed | undefined = this.urlToFeed.get(urlString);
    const account: AccountService | undefined = this.account;
    if (feed === undefined || account === undefined) {
      return;
    }
    ActivityLog.shared.didStart(account.activityOwner,
      new ActivityKind(ActivityKindType.refreshFeedContent, feed.url));
  }

  didSkip(urlString: string, reason: string): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const kind: ActivityKind = new ActivityKind(ActivityKindType.refreshFeedContent, urlString);
    ActivityLog.shared.startIfNeeded(account.activityOwner, kind);
    ActivityLog.shared.didComplete(account.activityOwner, kind, reason, false);
  }

  didFollowRedirect(urlString: string, fromURL: string, toURL: string,
    statusCode: number): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const feed: Feed | undefined = this.urlToFeed.get(urlString);
    ActivityLog.shared.logCompletedActivity(account.activityOwner,
      new ActivityKind(ActivityKindType.followFeedRedirect),
      feed === undefined ? undefined : feed.nameForDisplay,
      statusCode + ': ' + fromURL + ' → ' + toURL);
  }

  downloadDidComplete(urlString: string, response: DownloadResponse, error?: Error): void {
    const feed: Feed | undefined = this.urlToFeed.get(urlString);
    const account: AccountService | undefined = this.account;
    if (feed === undefined || account === undefined) {
      return;
    }
    const kind: ActivityKind = new ActivityKind(ActivityKindType.refreshFeedContent, feed.url);

    // LocalAccountRefresher.swift:239-242 — a failed download still stamps lastCheckDate, so a
    // feed that keeps failing waits out the 9-minute floor like any other. The one exception is
    // a connectivity error: an offline device must not penalise every feed it could not reach.
    if (!errorIsConnectivityRelated(error)) {
      feed.lastCheckDate = new Date();
    }

    if (error !== undefined) {
      this.reportFeedRefreshError(account, feed, error, kind);
      return;
    }

    const statusCode: number | undefined = response.statusCode;
    if (statusCode === undefined) {
      this.reportFeedRefreshError(account, feed,
        new Error('Unexpected response (not HTTP)'), kind);
      return;
    }
    feed.lastResponseCode = statusCode;

    const isOK: boolean = statusCode >= 200 && statusCode <= 299;
    if (!isOK && statusCode !== HTTPResponseCode.notModified) {
      this.reportFeedRefreshError(account, feed, new Error('HTTP ' + statusCode), kind);
      return;
    }

    const headers: Map<string, string> | undefined = response.headers;
    if (headers !== undefined) {
      const info: HTTPConditionalGetInfo | undefined = conditionalGetInfoFromHeaders(headers);
      feed.conditionalGetInfo = info;
    }

    if (!isOK) {
      // 304 Not Modified.
      ActivityLog.shared.didComplete(account.activityOwner, kind, '304 Not Modified', false);
      this.persist(account, feed);
      return;
    }

    if (headers !== undefined) {
      const cacheControl: string | undefined =
        headerValue(headers, HTTPResponseHeader.cacheControl);
      if (cacheControl !== undefined) {
        const info: CacheControlInfo | undefined = CacheControlInfo.fromHeaderValue(cacheControl);
        if (info !== undefined) {
          feed.cacheControlInfo = info;
        }
      }
    }

    const data: ArrayBuffer | undefined = response.data;
    if (data === undefined || data.byteLength === 0) {
      ActivityLog.shared.didComplete(account.activityOwner, kind, '0 bytes');
      this.persist(account, feed);
      return;
    }

    const dataSizeMessage: string = ActivityLog.dataSizeMessage(data.byteLength);
    const dataHash: string = contentHash(data);
    if (dataHash === feed.contentHash) {
      ActivityLog.shared.didComplete(account.activityOwner, kind,
        dataSizeMessage + ', content unchanged');
      this.persist(account, feed);
      return;
    }

    this.outstandingParseTasks += 1;
    this.parseAndUpdate(account, feed, data, dataHash, dataSizeMessage, kind);
  }

  private parseAndUpdate(account: AccountService, feed: Feed, data: ArrayBuffer,
    dataHash: string, dataSizeMessage: string, kind: ActivityKind): void {
    let parsedFeed: ParsedFeed | undefined = undefined;
    try {
      parsedFeed = parseFeed(new ParserData(feed.url, data));
    } catch (e) {
      this.outstandingParseTasks -= 1;
      this.completeRefreshActivityIfReady();
      ActivityLog.shared.didFail(account.activityOwner, kind, e as Error);
      this.feedsErrored += 1;
      account.postSyncError(e as Error, 'Parsing feed');
      return;
    }

    if (parsedFeed === undefined) {
      this.outstandingParseTasks -= 1;
      this.completeRefreshActivityIfReady();
      ActivityLog.shared.didComplete(account.activityOwner, kind, dataSizeMessage);
      this.persist(account, feed);
      return;
    }

    const resolved: ParsedFeed = parsedFeed;
    account.updateFeedWithParsedFeed(feed, resolved).then((changes: ArticleChanges): void => {
      this.newArticlesCount += changes.newArticles.length;
      this.updatedArticlesCount += changes.updatedArticles.length;
      feed.contentHash = dataHash;
      ActivityLog.shared.didComplete(account.activityOwner, kind, dataSizeMessage);
      this.persist(account, feed);
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'update failed: %{public}s', String(e));
      ActivityLog.shared.didFail(account.activityOwner, kind, new Error(String(e)));
      this.feedsErrored += 1;
    }).finally((): void => {
      this.outstandingParseTasks -= 1;
      this.completeRefreshActivityIfReady();
    });
  }

  private persist(account: AccountService, feed: Feed): void {
    account.persistFeedSettings(feed).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'persistFeedSettings failed: %{public}s', String(e));
    });
  }

  httpError(statusCode: number, urlString: string): void {
    const feed: Feed | undefined = this.urlToFeed.get(urlString);
    const account: AccountService | undefined = this.account;
    if (feed === undefined || account === undefined) {
      return;
    }
    feed.lastCheckDate = new Date();
    feed.lastResponseCode = statusCode;
    this.reportFeedRefreshError(account, feed,
      new Error('HTTP ' + statusCode + ': ' + urlString),
      new ActivityKind(ActivityKindType.refreshFeedContent, feed.url));
  }

  shouldContinueAfterReceivingData(data: ArrayBuffer, urlString: string): boolean {
    return !this.suspended && !LocalAccountRefresher.isDefinitelyNotFeed(data);
  }

  downloadSessionDidComplete(): void {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      this.completeRemainingActivities(account);
    }
    this.downloadSessionIsComplete = true;
    this.completeRefreshActivityIfReady();
  }

  // MARK: - Activity helpers

  private completeRefreshActivityIfReady(): void {
    if (!this.downloadSessionIsComplete || this.outstandingParseTasks !== 0) {
      return;
    }
    const id: number | undefined = this.refreshActivityID;
    if (id === undefined) {
      return;
    }
    ActivityLog.shared.didCompleteWithID(id, this.refreshStatsMessage);
    this.refreshActivityID = undefined;
  }

  private completeRemainingActivities(account: AccountService): void {
    const owner: ActivityOwner = account.activityOwner;
    for (const activity of ActivityLog.shared.pendingActivitiesFor(owner)) {
      if (activity.kind.type !== ActivityKindType.refreshFeedContent) {
        continue;
      }
      ActivityLog.shared.startIfNeeded(owner, activity.kind);
      ActivityLog.shared.didComplete(owner, activity.kind);
    }
    for (const activity of ActivityLog.shared.runningActivitiesFor(owner)) {
      if (activity.kind.type !== ActivityKindType.refreshFeedContent) {
        continue;
      }
      ActivityLog.shared.didComplete(owner, activity.kind);
    }
  }

  private reportFeedRefreshError(account: AccountService, feed: Feed, error: Error,
    kind: ActivityKind): void {
    ActivityLog.shared.didFail(account.activityOwner, kind, error);
    this.feedsErrored += 1;
    account.postSyncError(error, 'Downloading feed: ' + feed.url);
    this.persist(account, feed);
  }

  // MARK: - The politeness policy

  static feedShouldBeSkipped(feed: Feed, specialCaseCutoffDate: Date,
    redditURLToRefresh?: string): SkipDecision {
    const cacheControl: SkipDecision = LocalAccountRefresher.skipForCacheControl(feed);
    if (cacheControl.shouldSkip) {
      return cacheControl;
    }
    const disallowedHost: SkipDecision = LocalAccountRefresher.skipForDisallowedHost(feed);
    if (disallowedHost.shouldSkip) {
      return disallowedHost;
    }
    const reddit: SkipDecision = LocalAccountRefresher.skipForReddit(feed, redditURLToRefresh);
    if (reddit.shouldSkip) {
      return reddit;
    }
    return LocalAccountRefresher.skipForTiming(feed, specialCaseCutoffDate);
  }

  /** Reddit rate-limits to one feed per minute — refresh the least recently checked one. */
  static redditURLToRefresh(feeds: Feed[]): string | undefined {
    let winner: Feed | undefined = undefined;
    for (const feed of feeds) {
      if (!isRedditURL(feed.url)) {
        continue;
      }
      if (winner === undefined) {
        winner = feed;
        continue;
      }
      const winnerDate: number = winner.lastCheckDate === undefined
        ? 0 : winner.lastCheckDate.getTime();
      const candidateDate: number = feed.lastCheckDate === undefined
        ? 0 : feed.lastCheckDate.getTime();
      if (candidateDate < winnerDate) {
        winner = feed;
      }
    }
    return winner === undefined ? undefined : winner.url;
  }

  private static skipForReddit(feed: Feed, redditURLToRefresh?: string): SkipDecision {
    if (!isRedditURL(feed.url)) {
      return new SkipDecision(false);
    }
    if (feed.url === redditURLToRefresh) {
      return new SkipDecision(false);
    }
    let reason: string = 'Skipped — Reddit allows only one feed per minute';
    if (redditURLToRefresh !== undefined) {
      reason += ' — refreshing ' + redditURLToRefresh + ' this time';
    }
    return new SkipDecision(true, reason);
  }

  private static skipForDisallowedHost(feed: Feed): SkipDecision {
    const host: string | undefined = hostOf(feed.url);
    if (host === undefined) {
      return new SkipDecision(true, 'Skipped — no host');
    }
    const lowercaseHost: string = host.toLowerCase();
    for (const badHost of badHosts) {
      if (lowercaseHost === badHost) {
        return new SkipDecision(true, 'Skipped — host does not provide feeds');
      }
    }
    return new SkipDecision(false);
  }

  private static skipForTiming(feed: Feed, specialCaseCutoffDate: Date): SkipDecision {
    const lastCheckDate: Date | undefined = feed.lastCheckDate;
    if (lastCheckDate === undefined) {
      return new SkipDecision(false);
    }
    // Feeds that send Cache-Control are handled by skipForCacheControl.
    if (feed.cacheControlInfo !== undefined) {
      return new SkipDecision(false);
    }
    if (SpecialCase.urlStringMatchesDomain(feed.url, domainsWithNoMinimumTime)) {
      return new SkipDecision(false);
    }

    const minutesAgo: number = Math.floor((Date.now() - lastCheckDate.getTime()) / 60000);
    const minutesAgoText: string = pluralized(minutesAgo, 'minute') + ' ago';

    if (SpecialCase.urlStringContainSpecialCase(feed.url,
      [SpecialCase.rachelByTheBayHostName, SpecialCase.openRSSOrgHostName])) {
      if (lastCheckDate.getTime() > specialCaseCutoffDate.getTime()) {
        return new SkipDecision(true, 'Skipped — previous check was ' + minutesAgoText
          + ' — minimum is ' + pluralized(specialCaseCutoffHours, 'hour'));
      }
    }

    if (Date.now() - lastCheckDate.getTime() < minimumTimeBetweenChecksMillis) {
      return new SkipDecision(true, 'Skipped — previous check was ' + minutesAgoText
        + ' — minimum is ' + pluralized(minimumTimeBetweenChecksMillis / 60000, 'minute'));
    }
    return new SkipDecision(false);
  }

  private static skipForCacheControl(feed: Feed): SkipDecision {
    const info: CacheControlInfo | undefined = feed.cacheControlInfo;
    if (info === undefined || info.canResume()) {
      return new SkipDecision(false);
    }
    // openrss.org gets unclamped Cache-Control — they configure it correctly.
    if (SpecialCase.urlStringContainSpecialCase(feed.url, [SpecialCase.openRSSOrgHostName])) {
      return new SkipDecision(true,
        'Skipped — Cache-Control, ready at ' + timeString(info.resumeDate()));
    }
    // Everything else: honor Cache-Control with a 5-hour ceiling, because many sites
    // misconfigure it (max-age as long as 16 years has been seen).
    if (!info.canResumeWithMaxMaxAge(cacheControlMaxMaxAgeSeconds)) {
      const clamped: number = Math.min(cacheControlMaxMaxAgeSeconds, info.maxAge);
      const readyDate: Date = new Date(info.dateCreated.getTime() + clamped * 1000);
      return new SkipDecision(true, 'Skipped — Cache-Control, ready at ' + timeString(readyDate));
    }
    return new SkipDecision(false);
  }

  /** Data.isDefinitelyNotFeed() — a few image magic numbers, as in the source. */
  private static isDefinitelyNotFeed(data: ArrayBuffer): boolean {
    const bytes: Uint8Array = new Uint8Array(data);
    if (bytes.length < 4) {
      return false;
    }
    // PNG, GIF, JPEG.
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return true;
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return true;
    }
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
}

// MARK: - The delegate

export class LocalAccountDelegate implements AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[] = [];
  isOPMLImportInProgress: boolean = false;
  readonly server?: string = undefined;
  credentials?: Credentials;
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  private readonly refresher: LocalAccountRefresher = new LocalAccountRefresher();

  constructor() {
    this.refresher.onProgressChange = (): void => {
      this.progressInfo = this.refresher.progressInfo;
      if (this.onProgressChange !== undefined) {
        this.onProgressChange();
      }
    };
  }

  async receiveRemoteNotification(userInfo: Map<string, string>): Promise<void> {
    // The local account has no push channel.
    hilog.debug(DOMAIN, TAG, 'ignoring remote notification (%{public}d keys)', userInfo.size);
  }

  async refreshAll(): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined || !this.progressInfo.isComplete) {
      return;
    }
    await this.refresher.refreshFeeds(account, account.flattenedFeeds());
    account.lastRefreshCompletedDate = new Date();
  }

  async syncArticleStatus(): Promise<boolean> {
    return false;
  }

  async sendArticleStatus(): Promise<void> {
    // Nothing to send: no sync service.
  }

  async refreshArticleStatus(): Promise<void> {
    // Nothing to refresh: no sync service.
  }

  async importOPML(opmlFilePath: string): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.importOPML,
      opmlFilePath);
    let file: fs.File | undefined = undefined;
    try {
      const size: number = fs.statSync(opmlFilePath).size;
      file = fs.openSync(opmlFilePath, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      fs.readSync(file.fd, buffer);
      const document: OPMLDocument = parseOPML(new ParserData(opmlFilePath, buffer));
      const children: OPMLItem[] | undefined = document.children;
      if (children === undefined) {
        account.logActivityComplete(activityID, 'Empty OPML');
        return;
      }
      account.loadOPMLItems(children);
      account.logActivityComplete(activityID, children.length + ' items');
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const activityID: number = account.logActivityStart(ActivityKindType.subscribeFeed, url);
    try {
      const specifiers: FeedSpecifier[] = await FeedFinder.find(url);
      const best: FeedSpecifier | undefined = bestFeed(specifiers);
      if (best === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }
      if (account.hasFeedWithURL(best.urlString)) {
        throw AccountError.of(AccountErrorKind.createErrorAlreadySubscribed);
      }

      const response: DownloadResponse = await FeedFinder.downloadAndLog(best.urlString);
      const data: ArrayBuffer | undefined = response.data;
      if (data === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }
      const parsedFeed: ParsedFeed | undefined =
        parseFeed(new ParserData(best.urlString, data));
      if (parsedFeed === undefined) {
        throw AccountError.of(AccountErrorKind.createErrorNotFound);
      }

      const feed: Feed = account.createFeedWith(undefined, best.urlString, best.urlString,
        undefined);
      feed.lastCheckDate = new Date();
      // Save conditional GET info so the first refresh uses a conditional GET.
      const headers: Map<string, string> | undefined = response.headers;
      if (headers !== undefined) {
        feed.conditionalGetInfo = conditionalGetInfoFromHeaders(headers);
      }
      feed.editedName = name;
      container.addFeedToTreeAtTopLevel(feed);

      await account.updateFeedWithParsedFeed(feed, parsedFeed);
      await account.persistFeedSettings(feed);
      account.logActivityComplete(activityID, feed.nameForDisplay);
      return feed;
    } catch (e) {
      account.logActivityFail(activityID, e as Error);
      throw e as Error;
    }
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    feed.editedName = name;
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      await account.persistFeedSettings(feed);
    }
  }

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.removeFeedFromTreeAtTopLevel(feed);
  }

  async moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void> {
    sourceContainer.removeFeedFromTreeAtTopLevel(feed);
    destinationContainer.addFeedToTreeAtTopLevel(feed);
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.addFeedToTreeAtTopLevel(feed);
  }

  async restoreFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.addFeedToTreeAtTopLevel(feed);
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
    folder.name = name;
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.structureDidChange();
    }
  }

  async removeFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.removeFolderFromTree(folder);
    }
  }

  async restoreFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.addFolderToTree(folder);
    }
  }

  async markArticles(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      await account.updateStatuses(articleIDs, statusKey, flag);
    }
  }

  accountDidInitialize(): void {
    // Nothing to restore: the local account has no sync queue.
  }

  accountWillBeDeleted(): void {
    // Nothing to log out of.
  }

  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    // The local account has no credentials to validate.
    return undefined;
  }

  async vacuumDatabases(): Promise<void> {
    // The account's own databases are vacuumed by AccountService.
  }

  suspendNetwork(): void {
    this.refresher.suspend();
  }

  resume(): void {
    this.refresher.resume();
  }
}
