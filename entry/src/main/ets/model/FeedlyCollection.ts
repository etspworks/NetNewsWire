/**
 * FeedlyCollection / FeedlyFeed / FeedlyEntry / FeedlyStream — port of
 * Modules/Account/Sources/Account/Feedly/FeedlyModel.swift
 *
 * The Feedly wire model plus the parsing rules the source keeps next to it: the RTL-text
 * sanitizer, the external-URL resolution across canonical/alternate links, the
 * published-vs-crawled date rule, and the "feed/" resource-ID prefix.
 */

export interface FeedlyCategory {
  label: string;
  id: string;
}

export interface FeedlyFeed {
  id: string;
  title?: string;
  updated?: Date;
  website?: string;
}

export interface FeedlyCollection {
  feeds: FeedlyFeed[];
  label: string;
  id: string;
}

export interface FeedlyLink {
  href: string;
  /** MIME type of the resource; undefined probably means a web page. */
  type?: string;
}

export interface FeedlyOriginWire {
  title?: string;
  streamId?: string;
  htmlUrl?: string;
}

export interface FeedlyOrigin {
  title?: string;
  streamID?: string;
  htmlURL?: string;
}

export function feedlyOriginFromJSON(wire: FeedlyOriginWire): FeedlyOrigin {
  const origin: FeedlyOrigin = {
    title: wire.title,
    streamID: wire.streamId,
    htmlURL: wire.htmlUrl
  };
  return origin;
}

export enum FeedlyContentDirection {
  leftToRight = 'ltr',
  rightToLeft = 'rtl'
}

export interface FeedlyContent {
  content?: string;
  direction?: FeedlyContentDirection;
}

export interface FeedlyTag {
  id: string;
  label?: string;
}

export interface FeedlyEntry {
  /** The unique, immutable ID of this article. */
  id: string;
  /** The article title, without HTML markup. */
  title?: string;
  content?: FeedlyContent;
  summary?: FeedlyContent;
  author?: string;
  /** When Feedly's servers processed the article. */
  crawled: Date;
  /** When Feedly re-processed and updated the article. */
  recrawled?: Date;
  /** When the article was published, as reported by the feed. */
  published?: Date;
  origin?: FeedlyOrigin;
  /** Helps find the URL to visit an article on a web site. */
  canonical?: FeedlyLink[];
  alternate?: FeedlyLink[];
  unread: boolean;
  tags?: FeedlyTag[];
  categories?: FeedlyCategory[];
  /** Media links (video, image, sound) provided by the feed. */
  enclosure?: FeedlyLink[];
}

export interface FeedlyStream {
  id: string;
  /** Of the most recent entry for this stream, regardless of continuation. */
  updated?: Date;
  /** Cursor for the next page; absent means the end of the stream. */
  continuation?: string;
  items: FeedlyEntry[];
}

export interface FeedlyStreamIDs {
  continuation?: string;
  ids: string[];
}

export function feedlyStreamIsEnd(continuation?: string): boolean {
  return continuation === undefined;
}

export interface FeedlyFeedsSearchResultWire {
  title: string;
  feedId: string;
}

export interface FeedlyFeedsSearchResponseWire {
  results: FeedlyFeedsSearchResultWire[];
}

const rightToLeftPrefix: string = '<div style="direction:rtl;text-align:right">';
const rightToLeftSuffix: string = '</div>';

/** Strips the RTL wrapper div Feedly adds around right-to-left text. */
export function sanitizeFeedlyText(sourceText?: string): string | undefined {
  if (sourceText === undefined || sourceText.length === 0) {
    return sourceText;
  }
  if (!sourceText.startsWith(rightToLeftPrefix) || !sourceText.endsWith(rightToLeftSuffix)) {
    return sourceText;
  }
  return sourceText.substring(rightToLeftPrefix.length,
    sourceText.length - rightToLeftSuffix.length);
}

/** The feed a Feedly entry belongs to; an entry without one is dropped by the source. */
export function feedlyEntryFeedURL(entry: FeedlyEntry): string | undefined {
  const origin: FeedlyOrigin | undefined = entry.origin;
  return origin === undefined ? undefined : origin.streamID;
}

/** First canonical-or-alternate link that is a web page (no type, or text/html). */
export function feedlyEntryExternalURL(entry: FeedlyEntry): string | undefined {
  const links: FeedlyLink[] = [];
  const canonical: FeedlyLink[] | undefined = entry.canonical;
  if (canonical !== undefined) {
    for (const link of canonical) {
      links.push(link);
    }
  }
  const alternate: FeedlyLink[] | undefined = entry.alternate;
  if (alternate !== undefined) {
    for (const link of alternate) {
      links.push(link);
    }
  }
  for (const link of links) {
    if (link.type === undefined || link.type === 'text/html') {
      return link.href;
    }
  }
  return undefined;
}

export function feedlyEntryContentHTML(entry: FeedlyEntry): string | undefined {
  const content: FeedlyContent | undefined = entry.content;
  if (content !== undefined && content.content !== undefined) {
    return content.content;
  }
  const summary: FeedlyContent | undefined = entry.summary;
  return summary === undefined ? undefined : summary.content;
}

export function feedlyEntrySummary(entry: FeedlyEntry): string | undefined {
  const summary: FeedlyContent | undefined = entry.summary;
  return sanitizeFeedlyText(summary === undefined ? undefined : summary.content);
}

/**
 * The publisher's date when the feed provides one. `crawled` is when Feedly processed the
 * article — using it dated a newly added feed's whole archive "now". Publisher dates are
 * not always reliable, so a future-dated article falls back to crawled rather than pinning
 * itself to the top of a date-sorted timeline.
 */
export function feedlyEntryDatePublished(entry: FeedlyEntry): Date {
  const published: Date | undefined = entry.published;
  if (published !== undefined && published.getTime() <= entry.crawled.getTime()) {
    return published;
  }
  return entry.crawled;
}

/** Feedly prefixes source feed URLs with "feed/"; the URL is the ID without it. */
export function feedlyFeedResourceURL(id: string): string {
  return id.startsWith('feed/') ? id.substring('feed/'.length) : id;
}

export function feedlyFeedResourceID(url: string): string {
  return 'feed/' + url;
}

export function feedlyUncategorizedResourceID(userID: string): string {
  return 'user/' + userID + '/category/global.uncategorized';
}

export function feedlyAllResourceID(userID: string): string {
  return 'user/' + userID + '/category/global.all';
}

export function feedlyMustReadResourceID(userID: string): string {
  return 'user/' + userID + '/category/global.must';
}

export function feedlySavedResourceID(userID: string): string {
  return 'user/' + userID + '/tag/global.saved';
}
