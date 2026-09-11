/**
 * FeedSpecifier — port of Modules/FeedFinder/Sources/FeedFinder/FeedSpecifier.swift
 *
 * A candidate feed found while resolving a URL the user typed. The scoring rules pick which
 * candidate becomes the subscription, so they are ported exactly.
 */

export enum FeedSpecifierSource {
  userEntered = 0,
  HTMLHead = 1,
  HTMLLink = 2
}

export interface FeedSpecifier {
  title?: string;
  urlString: string;
  source: FeedSpecifierSource;
  orderFound: number;
}

function sourceIsEqualToOrBetterThan(a: FeedSpecifierSource, b: FeedSpecifierSource): boolean {
  return (a as number) <= (b as number);
}

export function feedSpecifierScore(specifier: FeedSpecifier): number {
  let score: number = 0;

  if (specifier.source === FeedSpecifierSource.userEntered) {
    return 1000;
  } else if (specifier.source === FeedSpecifierSource.HTMLHead) {
    score += 50;
  }

  score -= (specifier.orderFound - 1) * 5;

  const url: string = specifier.urlString.toLowerCase();
  if (url.includes('comments')) {
    score -= 10;
  }
  if (url.includes('podcast')) {
    score -= 10;
  }
  if (url.includes('rss')) {
    score += 5;
  }
  if (specifier.urlString.endsWith('/index.xml')) {
    score += 5;
  }
  if (specifier.urlString.endsWith('/feed/')) {
    score += 5;
  }
  if (specifier.urlString.endsWith('/feed')) {
    score += 4;
  }
  if (url.includes('json')) {
    score += 3;
  }

  const title: string | undefined = specifier.title;
  if (title !== undefined && title.toLowerCase().includes('comments')) {
    score -= 10;
  }

  return score;
}

/** Takes the best data — non-nil title, better source, earlier order — into a new specifier. */
export function mergeFeedSpecifiers(a: FeedSpecifier, b: FeedSpecifier): FeedSpecifier {
  const merged: FeedSpecifier = {
    title: a.title !== undefined ? a.title : b.title,
    urlString: a.urlString,
    source: sourceIsEqualToOrBetterThan(a.source, b.source) ? a.source : b.source,
    orderFound: a.orderFound < b.orderFound ? a.orderFound : b.orderFound
  };
  return merged;
}

export function bestFeed(feedSpecifiers: FeedSpecifier[]): FeedSpecifier | undefined {
  if (feedSpecifiers.length === 0) {
    return undefined;
  }
  if (feedSpecifiers.length === 1) {
    return feedSpecifiers[0];
  }
  let currentHighScore: number = Number.MIN_SAFE_INTEGER;
  let currentBestFeed: FeedSpecifier | undefined = undefined;
  for (const specifier of feedSpecifiers) {
    const score: number = feedSpecifierScore(specifier);
    if (score > currentHighScore) {
      currentHighScore = score;
      currentBestFeed = specifier;
    }
  }
  return currentBestFeed;
}
