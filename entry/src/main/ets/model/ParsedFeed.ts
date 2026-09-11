/**
 * ParsedFeed — port of Modules/RSParser/Sources/RSParser/Feeds/ParsedFeed.swift
 *
 * The source's init normalizes homePageURL to nil when it is empty or whitespace only.
 */

import { FeedType } from './FeedType';
import { ParsedAuthor } from './ParsedAuthor';
import { ParsedHub } from './ParsedHub';
import { ParsedItem } from './ParsedItem';

export interface ParsedFeed {
  type: FeedType;
  title?: string;
  homePageURL?: string;
  feedURL?: string;
  language?: string;
  feedDescription?: string;
  nextURL?: string;
  iconURL?: string;
  faviconURL?: string;
  authors?: ParsedAuthor[];
  expired: boolean;
  hubs?: ParsedHub[];
  items: ParsedItem[];
}

/** homePageURL is nil-if-empty-or-whitespace in the source's init. */
export function normalizedHomePageURL(homePageURL?: string): string | undefined {
  if (homePageURL === undefined) {
    return undefined;
  }
  const trimmed: string = homePageURL.trim();
  return trimmed.length === 0 ? undefined : homePageURL;
}
