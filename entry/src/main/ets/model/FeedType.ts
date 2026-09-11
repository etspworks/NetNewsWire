/**
 * FeedType — port of Modules/RSParser/Sources/RSParser/Feeds/FeedType.swift
 *
 * The `feedType(parserData)` sniffing function itself lives in the parser service; this is
 * the type it returns, plus the byte threshold below which sniffing must answer `unknown`.
 */

export enum FeedType {
  rss = 'rss',
  atom = 'atom',
  jsonFeed = 'jsonFeed',
  rssInJSON = 'rssInJSON',
  unknown = 'unknown',
  notAFeed = 'notAFeed'
}

/** Below this many bytes, sniffing returns `unknown` — ask again with more data. */
export const minNumberOfBytesRequired: number = 128;
