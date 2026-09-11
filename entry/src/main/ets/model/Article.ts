/**
 * Article — port of Modules/Articles/Sources/Articles/Article.swift
 *
 * rawLink / rawExternalLink / rawImageLink hold the raw source values exactly as the
 * Swift model does; the computed url / externalURL / imageURL live in the data layer
 * (Shared/Extensions/ArticleUtilities.swift).
 */

import { ArticleStatus } from './ArticleStatus';
import { Author } from './Author';

export interface Article {
  /** Unique database ID (possibly a sync-service ID). */
  articleID: string;
  accountID: string;
  /** Likely a URL, but not necessarily. */
  feedID: string;
  /** Unique per feed (RSS guid, for example). */
  uniqueID: string;
  title?: string;
  contentHTML?: string;
  contentText?: string;
  markdown?: string;
  /** Raw source value; use the computed url/link elsewhere. */
  rawLink?: string;
  /** Raw source value; use the computed externalURL/externalLink elsewhere. */
  rawExternalLink?: string;
  summary?: string;
  /** Raw source value; use the computed imageURL/imageLink elsewhere. */
  rawImageLink?: string;
  datePublished?: Date;
  dateModified?: Date;
  authors?: Author[];
  status: ArticleStatus;
}

/** "<feedID> <uniqueID>" — md5 of this is Article.calculatedArticleID. */
export function articleIDSeed(feedID: string, uniqueID: string): string {
  return feedID + ' ' + uniqueID;
}

export function articleIDs(articles: Article[]): string[] {
  const ids: string[] = [];
  for (const article of articles) {
    ids.push(article.articleID);
  }
  return ids;
}

export function unreadArticles(articles: Article[]): Article[] {
  const unread: Article[] = [];
  for (const article of articles) {
    if (!article.status.read) {
      unread.push(article);
    }
  }
  return unread;
}

export function articlesContain(articles: Article[], accountID: string, articleID: string): boolean {
  for (const article of articles) {
    if (article.accountID === accountID && article.articleID === articleID) {
      return true;
    }
  }
  return false;
}
