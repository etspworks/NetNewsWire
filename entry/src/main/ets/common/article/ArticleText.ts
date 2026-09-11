/**
 * ArticleText — port of Shared/Extensions/ArticleUtilities.swift,
 * Shared/Extensions/ArticleStringFormatter.swift, Shared/Timeline/ArticleArray.swift and
 * Shared/Timeline/ArticleSorter.swift.
 *
 * The Article model is a plain interface (no Swift extensions), so everything the source
 * gets from `article.preferredLink` / `article.body` / `[Article].articlesAbove(…)` lives
 * here as a function over an Article or an Article[].
 */

import url from '@ohos.url';
import { Article } from '../../model/Article';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { AccountService } from '../account/Account';
import { AccountManager } from '../account/AccountManager';
import { markAsUnreadPeriodDays } from '../../model/AccountBehavior';
import { Feed } from '../../model/Feed';
import { SortDirection } from '../prefs/AppDefaults';
import { collapsingWhitespace, decodingHTMLEntities, strippingHTML } from '../util/Strings';
import { parseURL } from '../util/Urls';

// MARK: - Links and dates (ArticleUtilities.swift)

/** URL.encodeSpacesIfNeeded — the source repairs raw links through URL before using them. */
function repairedLink(raw?: string): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed: url.URL | undefined =
    parseURL(raw.indexOf(' ') >= 0 ? raw.replace(/ /g, '%20') : raw);
  return parsed === undefined ? raw : parsed.href;
}

export function articleLink(article: Article): string | undefined {
  return repairedLink(article.rawLink);
}

export function articleExternalLink(article: Article): string | undefined {
  return repairedLink(article.rawExternalLink);
}

export function articleImageLink(article: Article): string | undefined {
  return repairedLink(article.rawImageLink);
}

export function preferredLink(article: Article): string | undefined {
  const link: string | undefined = articleLink(article);
  if (link !== undefined && link.length > 0) {
    return link;
  }
  const externalLink: string | undefined = articleExternalLink(article);
  if (externalLink !== undefined && externalLink.length > 0) {
    return externalLink;
  }
  return undefined;
}

export function articleBody(article: Article): string | undefined {
  if (article.contentHTML !== undefined) {
    return article.contentHTML;
  }
  if (article.contentText !== undefined) {
    return article.contentText;
  }
  return article.summary;
}

export function logicalDatePublished(article: Article): Date {
  if (article.datePublished !== undefined) {
    return article.datePublished;
  }
  if (article.dateModified !== undefined) {
    return article.dateModified;
  }
  return article.status.dateArrived;
}

export function articleAccount(article: Article): AccountService | undefined {
  return AccountManager.shared.accountForArticle(article);
}

export function articleFeed(article: Article): Feed | undefined {
  return AccountManager.shared.feedForArticle(article);
}

/**
 * The base URL the article body's relative links resolve against. A URL with a fragment
 * cannot be used as a base URL — the web view will not load — so the fragment is dropped.
 */
export function articleBaseURL(article: Article): string | undefined {
  let s: string | undefined = articleLink(article);
  const feed: Feed | undefined = articleFeed(article);
  if (s === undefined && feed !== undefined) {
    s = feed.homePageURL;
  }
  if (s === undefined && feed !== undefined) {
    s = feed.url;
  }
  if (s === undefined) {
    return undefined;
  }
  const parsed: url.URL | undefined = parseURL(s);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  parsed.hash = '';
  return parsed.href;
}

/** The account behavior `disallowMarkAsUnreadAfterPeriod(days)` closes the unread window. */
export function isAvailableToMarkUnread(article: Article): boolean {
  const account: AccountService | undefined = articleAccount(article);
  if (account === undefined) {
    return true;
  }
  const markUnreadWindowDays: number | undefined = markAsUnreadPeriodDays(account.behaviors);
  if (markUnreadWindowDays === undefined) {
    return true;
  }
  const cutoff: number =
    logicalDatePublished(article).getTime() + markUnreadWindowDays * 24 * 60 * 60 * 1000;
  return cutoff > Date.now();
}

// MARK: - Marking (ArticleUtilities.swift)

export function articleIDsByAccountID(articles: Article[]): Map<string, string[]> {
  const d: Map<string, string[]> = new Map<string, string[]>();
  for (const article of articles) {
    const existing: string[] | undefined = d.get(article.accountID);
    if (existing === undefined) {
      d.set(article.accountID, [article.articleID]);
    } else if (existing.indexOf(article.articleID) < 0) {
      existing.push(article.articleID);
    }
  }
  return d;
}

export async function markArticleIDs(byAccountID: Map<string, string[]>,
  statusKey: ArticleStatusKey, flag: boolean): Promise<void> {
  const accountIDs: string[] = Array.from(byAccountID.keys());
  for (const accountID of accountIDs) {
    const account: AccountService | undefined = AccountManager.shared.existingAccount(accountID);
    if (account === undefined) {
      continue;
    }
    const articleIDs: string[] | undefined = byAccountID.get(accountID);
    if (articleIDs === undefined || articleIDs.length === 0) {
      continue;
    }
    await account.markArticles(articleIDs, statusKey, flag);
  }
}

export async function markArticles(articles: Article[], statusKey: ArticleStatusKey,
  flag: boolean): Promise<void> {
  await markArticleIDs(articleIDsByAccountID(articles), statusKey, flag);
}

// MARK: - ArticleArray.swift

export function articleAtRow(articles: Article[], row: number): Article | undefined {
  if (row < 0 || row > articles.length - 1) {
    return undefined;
  }
  return articles[row];
}

export function indexOfArticle(articles: Article[], article: Article): number {
  for (let i: number = 0; i < articles.length; i++) {
    if (articles[i].articleID === article.articleID
      && articles[i].accountID === article.accountID) {
      return i;
    }
  }
  return -1;
}

export function articleMatchingSpecifier(articles: Article[], accountID: string,
  articleID: string): Article | undefined {
  for (const article of articles) {
    if (article.accountID === accountID && article.articleID === articleID) {
      return article;
    }
  }
  return undefined;
}

export function anyArticleIsUnread(articles: Article[]): boolean {
  for (const article of articles) {
    if (!article.status.read) {
      return true;
    }
  }
  return false;
}

export function canMarkAllAsRead(articles: Article[]): boolean {
  return anyArticleIsUnread(articles);
}

export function articlesAbove(articles: Article[], article: Article): Article[] {
  const position: number = indexOfArticle(articles, article);
  if (position < 0) {
    return [];
  }
  return articles.slice(0, position);
}

export function articlesBelow(articles: Article[], article: Article): Article[] {
  const position: number = indexOfArticle(articles, article);
  if (position < 0 || position + 1 >= articles.length) {
    return [];
  }
  return articles.slice(position + 1);
}

// MARK: - ArticleSorter.swift

function sortedByDateOnly(articles: Article[], sortDirection: SortDirection): Article[] {
  const sorted: Article[] = articles.slice();
  sorted.sort((a: Article, b: Article): number => {
    const dateA: number = logicalDatePublished(a).getTime();
    const dateB: number = logicalDatePublished(b).getTime();
    if (dateA === dateB) {
      return a.articleID < b.articleID ? -1 : (a.articleID > b.articleID ? 1 : 0);
    }
    if (sortDirection === SortDirection.orderedDescending) {
      return dateB - dateA;
    }
    return dateA - dateB;
  });
  return sorted;
}

function sortableFeedName(article: Article): string {
  const feed: Feed | undefined = articleFeed(article);
  return feed === undefined ? '' : feed.nameForDisplay;
}

/**
 * Grouped by FEED ID (not name) so two feeds sharing a display name stay in distinct
 * groups, then the groups sorted case-insensitively by name with the feed ID as tiebreak.
 */
export function sortedByDate(articles: Article[], sortDirection: SortDirection,
  groupByFeed: boolean): Article[] {
  if (!groupByFeed) {
    return sortedByDateOnly(articles, sortDirection);
  }

  const groups: Map<string, Article[]> = new Map<string, Article[]>();
  for (const article of articles) {
    const existing: Article[] | undefined = groups.get(article.feedID);
    if (existing === undefined) {
      groups.set(article.feedID, [article]);
    } else {
      existing.push(article);
    }
  }

  const feedIDs: string[] = Array.from(groups.keys());
  feedIDs.sort((lhs: string, rhs: string): number => {
    const lhsArticles: Article[] = groups.get(lhs) as Article[];
    const rhsArticles: Article[] = groups.get(rhs) as Article[];
    const lhsName: string = sortableFeedName(lhsArticles[0]).toLowerCase();
    const rhsName: string = sortableFeedName(rhsArticles[0]).toLowerCase();
    if (lhsName < rhsName) {
      return -1;
    }
    if (lhsName > rhsName) {
      return 1;
    }
    return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
  });

  let out: Article[] = [];
  for (const feedID of feedIDs) {
    out = out.concat(sortedByDateOnly(groups.get(feedID) as Article[], sortDirection));
  }
  return out;
}

// MARK: - ArticleStringFormatter.swift

const allowedTitleTags: string[] = ['b', 'i', 'em', 'strong', 'code', 'sub', 'sup', 'abbr',
  'cite', 'del', 'ins', 'kbd', 'mark', 'q', 's', 'small', 'span', 'u', 'var'];

function isASCIILetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Sanitize a title that may contain HTML. A tag is allowed or disallowed by its NAME
 * alone (attributes ignored). allowed+forHTML -> kept; allowed+!forHTML -> tag dropped,
 * contents kept; disallowed+forHTML -> escaped; disallowed+!forHTML -> kept literally
 * (a later strippingHTML pass removes it).
 */
export function sanitizedTitle(title: string | undefined, forHTML: boolean): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  if (title.length === 0) {
    return '';
  }

  let out: string = '';
  let i: number = 0;
  const count: number = title.length;

  while (i < count) {
    const c: string = title.charAt(i);
    if (c !== '<') {
      out += c;
      i += 1;
      continue;
    }

    let j: number = i + 1;
    while (j < count && title.charAt(j) !== '>') {
      j += 1;
    }

    const tagStart: number = i + 1;
    const tagEnd: number = j;
    if (tagStart === tagEnd) {
      i += 1;
      continue;
    }

    let nameStart: number = tagStart;
    if (nameStart < tagEnd && title.charAt(nameStart) === '/') {
      nameStart += 1;
    }
    let nameEnd: number = nameStart;
    while (nameEnd < tagEnd && isASCIILetter(title.charAt(nameEnd))) {
      nameEnd += 1;
    }
    const tagName: string = title.substring(nameStart, nameEnd).toLowerCase();
    const isAllowed: boolean = allowedTitleTags.indexOf(tagName) >= 0;
    const tagBody: string = title.substring(tagStart, tagEnd);

    if (isAllowed) {
      if (forHTML) {
        out += '<' + tagBody + '>';
      }
    } else if (forHTML) {
      out += '&lt;' + tagBody + '&gt;';
    } else {
      out += '<' + tagBody + '>';
    }

    i = j < count ? j + 1 : count;
  }

  return out;
}

const maxTitleLength: number = 1000;
const maxFeedNameLength: number = 100;
const maxSummaryLength: number = 300;

export function truncatedFeedName(feedName: string): string {
  return feedName.length <= maxFeedNameLength ? feedName : feedName.substring(0, maxFeedNameLength);
}

export function truncatedTitle(article: Article, forHTML: boolean = false): string {
  const rawTitle: string | undefined = article.title;
  if (rawTitle === undefined || rawTitle.length === 0) {
    return '';
  }
  const sanitized: string | undefined = sanitizedTitle(rawTitle, forHTML);
  if (sanitized === undefined) {
    return '';
  }

  // Replace with " " rather than "" so words do not fuse; collapsingWhitespace removes doubles.
  let s: string = sanitized.replace(/[\n\r\t]/g, ' ');
  if (!forHTML) {
    s = decodingHTMLEntities(s);
  }
  s = collapsingWhitespace(s);
  return s.length <= maxTitleLength ? s : s.substring(0, maxTitleLength);
}

export function truncatedSummary(article: Article): string {
  const body: string | undefined = articleBody(article);
  if (body === undefined) {
    return '';
  }
  // Strip first, then decode: strip bounds the decode input and preserves entity-encoded tags.
  let s: string = strippingHTML(body, maxSummaryLength);
  s = decodingHTMLEntities(s);
  if (s === 'Comments') { // Hacker News.
    return '';
  }
  return s;
}
