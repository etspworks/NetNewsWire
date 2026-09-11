/**
 * FeedFinder — port of Modules/FeedFinder/Sources/FeedFinder/{FeedFinder,HTMLFeedFinder}.swift
 *
 * Resolves whatever the user typed into a set of candidate feeds, through the five
 * strategies the source tries in order:
 *   specialCase    a known feed URL for this host (FeedSpecifier.knownFeedSpecifier)
 *   microblogJSON  a 404 on micro.blog retries the same path with `.json`
 *   directFeed     the URL itself parses as a feed
 *   htmlHead       <link rel="alternate"> feeds in the page's <head> are trusted outright
 *   candidates     otherwise every feed-looking <a> in the body is downloaded and tested
 *
 * FeedSpecifier.bestFeed (in the model) does the final scoring.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { FeedSpecifier, FeedSpecifierSource, mergeFeedSpecifiers }
  from '../../model/FeedSpecifier';
import { DownloadResponse } from '../../model/DownloadResponse';
import { HTMLMetadataRecord } from '../../model/HTMLMetadataRecord';
import { ActivityKind, ActivityKindType, ActivityOwner, ActivityOwnerKind }
  from '../../model/Activity';
import { ActivityLog } from '../log/ActivityLog';
import { canParse, ParserData } from '../parser/FeedParser';
import { decodeXmlBytes } from '../parser/XmlScan';
import { htmlMetadata, htmlLinks, HTMLLink } from './HTMLMetadata';
import { Downloader, responseIsOK } from './DownloadSession';
import { appendingPathComponent, appendingPathSuffix, normalizedURL, hostOf, pathOf,
  SpecialCase, isRachelByTheBayURL } from '../util/Urls';

const DOMAIN: number = 0x0001;
const TAG: string = 'FeedFinder';

export class FeedFinderError extends Error {
  constructor() {
    super('The feed couldn’t be found and can’t be added.');
  }
}

/** Which discovery path produced the result — used for the activity's completion message. */
export enum FindStrategy {
  specialCase = 'specialCase',
  microblogJSON = 'microblogJSON',
  directFeed = 'directFeed',
  htmlHead = 'htmlHead',
  candidates = 'candidates'
}

class FindResult {
  readonly feedSpecifiers: FeedSpecifier[];
  readonly strategy: FindStrategy;

  constructor(feedSpecifiers: FeedSpecifier[], strategy: FindStrategy) {
    this.feedSpecifiers = feedSpecifiers;
    this.strategy = strategy;
  }
}

const FEED_URL_WORDS_TO_MATCH: string[] = ['feed', 'xml', 'rss', 'atom', 'json'];

/**
 * FeedSpecifier.knownFeedSpecifier — the two hosts whose pages don't advertise the feed
 * the user actually wants.
 */
function knownFeedSpecifier(urlString: string): FeedSpecifier | undefined {
  if (isRachelByTheBayURL(urlString)) {
    const specifier: FeedSpecifier = {
      title: 'writing - rachelbythebay',
      urlString: 'https://rachelbythebay.com/w/atom.xml',
      source: FeedSpecifierSource.userEntered,
      orderFound: 0
    };
    return specifier;
  }
  // The Relay FM blog page only advertises the master podcast feed in its <head>, so the
  // finder would otherwise miss the blog feed.
  // <https://github.com/Ranchero-Software/NetNewsWire/issues/5299>
  if (SpecialCase.urlStringMatchesDomain(urlString, [SpecialCase.relayFMHostName])) {
    const path: string = pathOf(urlString);
    if (path === '/blog' || path.startsWith('/blog/')) {
      const specifier: FeedSpecifier = {
        title: 'Relay FM Blog',
        urlString: 'https://www.relay.fm/blog/feed',
        source: FeedSpecifierSource.userEntered,
        orderFound: 0
      };
      return specifier;
    }
  }
  return undefined;
}

function isProbablyHTML(data: ArrayBuffer): boolean {
  const bytes: Uint8Array = new Uint8Array(data);
  const limit: number = Math.min(bytes.length, 4096);
  let ascii: string = '';
  for (let i: number = 0; i < limit; i++) {
    ascii += String.fromCharCode(bytes[i]);
  }
  const lower: string = ascii.toLowerCase();
  return lower.indexOf('<html') >= 0 || lower.indexOf('<!doctype html') >= 0
    || lower.indexOf('<head') >= 0 || lower.indexOf('<body') >= 0;
}

function isFeed(data: ArrayBuffer, urlString: string): boolean {
  return canParse(new ParserData(urlString, data));
}

function urlStringMightBeFeed(urlString: string): boolean {
  // "buzzfeed" contains "feed" but is not a hint — the source masks it out first.
  const massaged: string = urlString.toLowerCase().replace(/buzzfeed/g, '_');
  for (const word of FEED_URL_WORDS_TO_MATCH) {
    if (massaged.indexOf(word) >= 0) {
      return true;
    }
  }
  return false;
}

function addFeedSpecifier(feedSpecifier: FeedSpecifier,
  feedSpecifiers: Map<string, FeedSpecifier>): void {
  // Merge with an existing specifier so the best title and source win.
  const existing: FeedSpecifier | undefined = feedSpecifiers.get(feedSpecifier.urlString);
  feedSpecifiers.set(feedSpecifier.urlString,
    existing === undefined ? feedSpecifier : mergeFeedSpecifiers(existing, feedSpecifier));
}

/** HTMLFeedFinder — <head> feed links plus feed-looking <a> hrefs in the body. */
function possibleFeedsInHTMLPage(html: string, urlString: string): FeedSpecifier[] {
  const feedSpecifiers: Map<string, FeedSpecifier> = new Map<string, FeedSpecifier>();
  let orderFound: number = 0;

  const metadata: HTMLMetadataRecord = htmlMetadata(html, urlString);
  for (const feedLink of metadata.feedLinks) {
    const raw: string | undefined = feedLink.urlString;
    if (raw === undefined) {
      continue;
    }
    orderFound += 1;
    const specifier: FeedSpecifier = {
      title: feedLink.title,
      urlString: normalizedURL(raw),
      source: FeedSpecifierSource.HTMLHead,
      orderFound: orderFound
    };
    addFeedSpecifier(specifier, feedSpecifiers);
  }

  const bodyLinks: HTMLLink[] = htmlLinks(html, urlString);
  for (const link of bodyLinks) {
    const raw: string | undefined = link.urlString;
    if (raw === undefined || !urlStringMightBeFeed(raw)) {
      continue;
    }
    orderFound += 1;
    const specifier: FeedSpecifier = {
      title: link.text,
      urlString: normalizedURL(raw),
      source: FeedSpecifierSource.HTMLLink,
      orderFound: orderFound
    };
    addFeedSpecifier(specifier, feedSpecifiers);
  }

  const result: FeedSpecifier[] = [];
  feedSpecifiers.forEach((specifier: FeedSpecifier) => result.push(specifier));

  if (result.length === 0) {
    // Odds are decent it's a WordPress site and /feed/ will work; /index.xml is also common.
    const feedURL: string = appendingPathComponent(urlString, 'feed', true);
    const wordpress: FeedSpecifier = {
      urlString: feedURL,
      source: FeedSpecifierSource.HTMLLink,
      orderFound: 1
    };
    result.push(wordpress);
    const indexXML: FeedSpecifier = {
      urlString: appendingPathComponent(urlString, 'index.xml', false),
      source: FeedSpecifierSource.HTMLLink,
      orderFound: 1
    };
    result.push(indexXML);
  }
  return result;
}

export class FeedFinder {

  /** Finds every candidate feed for `urlString`. Throws FeedFinderError when there is none. */
  static async find(urlString: string): Promise<FeedSpecifier[]> {
    const activityLog: ActivityLog = ActivityLog.shared;
    const owner: ActivityOwner = new ActivityOwner(ActivityOwnerKind.feedFinder);
    const kind: ActivityKind = new ActivityKind(ActivityKindType.findFeed, urlString);
    const activityID: number = activityLog.createActivity(owner, kind);
    activityLog.didStartWithID(activityID);

    try {
      const result: FindResult = await FeedFinder.performFind(urlString);
      activityLog.didCompleteWithID(activityID,
        FeedFinder.parentCompletionMessage(result.feedSpecifiers.length, result.strategy));
      return result.feedSpecifiers;
    } catch (e) {
      activityLog.didFailWithID(activityID, e as Error);
      throw e as Error;
    }
  }

  /**
   * Wraps a download with a per-URL activity entry so the fetch shows up in the Feed Finder
   * activity stream. Public so feed-finding-adjacent fetches can join the same stream.
   */
  static async downloadAndLog(urlString: string): Promise<DownloadResponse> {
    const activityLog: ActivityLog = ActivityLog.shared;
    const owner: ActivityOwner = new ActivityOwner(ActivityOwnerKind.feedFinder);
    const kind: ActivityKind =
      new ActivityKind(ActivityKindType.fetchFeedCandidate, urlString);
    const activityID: number = activityLog.createActivity(owner, kind);
    activityLog.didStartWithID(activityID);

    try {
      const response: DownloadResponse = await Downloader.shared.download(urlString);
      activityLog.didCompleteWithID(activityID,
        FeedFinder.fetchCompletionMessage(response), !response.returnedFromCache,
        response.returnedFromCache);
      return response;
    } catch (e) {
      activityLog.didFailWithID(activityID, e as Error);
      throw e as Error;
    }
  }

  private static async performFind(urlString: string): Promise<FindResult> {
    // Special cases first.
    const known: FeedSpecifier | undefined = knownFeedSpecifier(urlString);
    if (known !== undefined) {
      hilog.info(DOMAIN, TAG, 'found special case feed URL: %{public}s', known.urlString);
      return new FindResult([known], FindStrategy.specialCase);
    }

    const response: DownloadResponse = await FeedFinder.downloadAndLog(urlString);
    const data: ArrayBuffer | undefined = response.data;

    if (response.statusCode === 404) {
      // micro.blog serves the JSON feed at <path>.json.
      const host: string | undefined = hostOf(urlString);
      if (host === 'micro.blog') {
        const jsonURL: string | undefined = appendingPathSuffix(urlString, '.json');
        if (jsonURL !== undefined) {
          const microblog: FeedSpecifier = {
            urlString: jsonURL,
            source: FeedSpecifierSource.HTMLLink,
            orderFound: 1
          };
          return new FindResult([microblog], FindStrategy.microblogJSON);
        }
      }
      throw new FeedFinderError();
    }

    if (data === undefined || !responseIsOK(response) || data.byteLength === 0) {
      throw new FeedFinderError();
    }

    if (isFeed(data, urlString)) {
      const direct: FeedSpecifier = {
        urlString: urlString,
        source: FeedSpecifierSource.userEntered,
        orderFound: 1
      };
      return new FindResult([direct], FindStrategy.directFeed);
    }

    if (!isProbablyHTML(data)) {
      throw new FeedFinderError();
    }

    return await FeedFinder.findFeedsInHTMLPage(decodeXmlBytes(data), urlString);
  }

  /**
   * Feeds found in `<head>` are trusted outright. With none there, the feed-looking body
   * links are downloaded individually and kept only if they really parse as feeds.
   */
  private static async findFeedsInHTMLPage(html: string,
    urlString: string): Promise<FindResult> {
    const possible: FeedSpecifier[] = possibleFeedsInHTMLPage(html, urlString);
    const feedSpecifiers: Map<string, FeedSpecifier> = new Map<string, FeedSpecifier>();
    const toDownload: FeedSpecifier[] = [];
    let didFindFeedInHTMLHead: boolean = false;

    for (const specifier of possible) {
      if (specifier.source === FeedSpecifierSource.HTMLHead) {
        addFeedSpecifier(specifier, feedSpecifiers);
        didFindFeedInHTMLHead = true;
      } else if (!feedSpecifiers.has(specifier.urlString)) {
        toDownload.push(specifier);
      }
    }

    if (didFindFeedInHTMLHead) {
      const result: FeedSpecifier[] = [];
      feedSpecifiers.forEach((specifier: FeedSpecifier) => result.push(specifier));
      return new FindResult(result, FindStrategy.htmlHead);
    }
    if (toDownload.length === 0) {
      throw new FeedFinderError();
    }

    const checks: Promise<FeedSpecifier | undefined>[] = [];
    for (const specifier of toDownload) {
      checks.push(FeedFinder.checkCandidate(specifier));
    }
    const results: (FeedSpecifier | undefined)[] = await Promise.all(checks);
    for (const specifier of results) {
      if (specifier !== undefined) {
        addFeedSpecifier(specifier, feedSpecifiers);
      }
    }

    const result: FeedSpecifier[] = [];
    feedSpecifiers.forEach((specifier: FeedSpecifier) => result.push(specifier));
    return new FindResult(result, FindStrategy.candidates);
  }

  private static async checkCandidate(
    specifier: FeedSpecifier): Promise<FeedSpecifier | undefined> {
    try {
      const response: DownloadResponse =
        await FeedFinder.downloadAndLog(specifier.urlString);
      const data: ArrayBuffer | undefined = response.data;
      if (data !== undefined && responseIsOK(response)
        && isFeed(data, specifier.urlString)) {
        return specifier;
      }
    } catch (e) {
      // The per-URL activity already recorded the failure; one bad candidate must not
      // fail the whole find.
    }
    return undefined;
  }

  private static parentCompletionMessage(count: number, strategy: FindStrategy): string {
    if (count === 0) {
      return strategy === FindStrategy.candidates
        ? 'No feeds found in candidate URLs' : 'No feeds found';
    }
    const plural: string = count === 1 ? 'feed' : 'feeds';
    if (strategy === FindStrategy.specialCase) {
      return count + ' ' + plural + ' (special case match)';
    }
    if (strategy === FindStrategy.microblogJSON) {
      return count + ' ' + plural + ' via Micro.blog .json fallback';
    }
    if (strategy === FindStrategy.directFeed) {
      return 'Direct feed';
    }
    if (strategy === FindStrategy.htmlHead) {
      return count + ' ' + plural + ' via HTML <head>';
    }
    return count + ' ' + plural + ' via candidate URLs';
  }

  private static fetchCompletionMessage(response: DownloadResponse): string {
    const statusCode: number | undefined = response.statusCode;
    if (statusCode === undefined) {
      return 'No response';
    }
    const statusPart: string = FeedFinder.formattedStatus(statusCode);
    const data: ArrayBuffer | undefined = response.data;
    if (responseIsOK(response) && data !== undefined && data.byteLength > 0) {
      return statusPart + ' · ' + ActivityLog.dataSizeMessage(data.byteLength);
    }
    return statusPart;
  }

  private static formattedStatus(statusCode: number): string {
    if (statusCode === 0) {
      return 'No status';
    }
    if (statusCode === 200) {
      return '200 OK';
    }
    if (statusCode === 304) {
      return '304 Not Modified';
    }
    if (statusCode === 404) {
      return '404 Not Found';
    }
    if (statusCode === 410) {
      return '410 Gone';
    }
    if (statusCode === 429) {
      return '429 Too Many Requests';
    }
    if (statusCode >= 500) {
      return statusCode + ' Server Error';
    }
    return statusCode + ' Error';
  }
}
