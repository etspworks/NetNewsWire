/**
 * ArticlesDatabase — port of Modules/ArticlesDatabase (ArticlesDatabase.swift,
 * ArticlesTable.swift, StatusesTable.swift, Constants.swift) over relationalStore.
 *
 * One store per account (DB.sqlite3): the articles table, the statuses table and the FTS
 * search table. The SQL is carried over verbatim — the `natural join statuses` fetches, the
 * `articles_after_delete_trigger_delete_search_text` trigger, the 90-day article cutoff, the
 * 30-day feed-based deletion window and the retention-style-dependent status cleanup.
 *
 * The Swift version is asynchronous through DatabaseQueue + MainThreadOperationQueue;
 * relationalStore is already promise-based, so every entry point is simply `async`.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { ArticleStatus, ArticleStatusKey } from '../../model/ArticleStatus';
import { Author } from '../../model/Author';
import { ParsedItem } from '../../model/ParsedItem';
import { articleID as computeArticleID, authorID as computeAuthorID } from '../util/Hashing';
import { Database, Row, ValuesBucket, ValueType } from './Database';
import { SearchTable, sqliteSearchString } from './SearchTable';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticlesDatabase';

export class DatabaseTableName {
  static readonly articles: string = 'articles';
  static readonly statuses: string = 'statuses';
}

export class DatabaseKey {
  static readonly articleID: string = 'articleID';
  static readonly url: string = 'url';
  static readonly title: string = 'title';
  static readonly feedID: string = 'feedID';
  static readonly uniqueID: string = 'uniqueID';
  static readonly contentHTML: string = 'contentHTML';
  static readonly contentText: string = 'contentText';
  static readonly markdown: string = 'markdown';
  static readonly externalURL: string = 'externalURL';
  static readonly summary: string = 'summary';
  static readonly imageURL: string = 'imageURL';
  static readonly bannerImageURL: string = 'bannerImageURL';
  static readonly datePublished: string = 'datePublished';
  static readonly dateModified: string = 'dateModified';
  static readonly authors: string = 'authors';
  static readonly searchRowID: string = 'searchRowID';
  static readonly read: string = 'read';
  static readonly starred: string = 'starred';
  static readonly dateArrived: string = 'dateArrived';
  static readonly body: string = 'body';
  static readonly rowID: string = 'rowid';
}

/** Local and iCloud define retention by feed contents; sync systems define it remotely. */
export enum RetentionStyle {
  feedBased = 'feedBased',
  syncSystem = 'syncSystem'
}

/** feedID -> unread count. */
export type UnreadCountDictionary = Map<string, number>;

export class ArticleChanges {
  readonly newArticles: Article[];
  readonly updatedArticles: Article[];
  readonly deletedArticles: Article[];

  constructor(newArticles: Article[] = [], updatedArticles: Article[] = [],
    deletedArticles: Article[] = []) {
    this.newArticles = newArticles;
    this.updatedArticles = updatedArticles;
    this.deletedArticles = deletedArticles;
  }
}

/** Aggregate counts for one account's articles database. */
export class ArticleCounts {
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly starredCount: number;
  readonly statusesCount: number;

  constructor(totalCount: number, unreadCount: number, starredCount: number,
    statusesCount: number) {
    this.totalCount = totalCount;
    this.unreadCount = unreadCount;
    this.starredCount = starredCount;
    this.statusesCount = statusesCount;
  }
}

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE if not EXISTS articles (articleID TEXT NOT NULL PRIMARY KEY,'
    + ' feedID TEXT NOT NULL, uniqueID TEXT NOT NULL, title TEXT, contentHTML TEXT,'
    + ' contentText TEXT, markdown TEXT, url TEXT, externalURL TEXT, summary TEXT,'
    + ' imageURL TEXT, bannerImageURL TEXT, datePublished DATE, dateModified DATE,'
    + ' searchRowID INTEGER, authors TEXT);',
  'CREATE TABLE if not EXISTS statuses (articleID TEXT NOT NULL PRIMARY KEY,'
    + ' read BOOL NOT NULL DEFAULT 0, starred BOOL NOT NULL DEFAULT 0,'
    + ' dateArrived DATE NOT NULL DEFAULT 0);',
  'CREATE INDEX if not EXISTS articles_feedID_datePublished_articleID'
    + ' on articles (feedID, datePublished, articleID);',
  'CREATE INDEX if not EXISTS statuses_starred_index on statuses (starred);',
  'CREATE VIRTUAL TABLE if not EXISTS search using fts4(title, body);',
  'CREATE TRIGGER if not EXISTS articles_after_delete_trigger_delete_search_text'
    + ' after delete on articles begin delete from search where rowid = OLD.searchRowID; end;',
  'CREATE INDEX if not EXISTS articles_searchRowID on articles(searchRowID);'
];

function dateToDatabaseValue(date?: Date): ValueType {
  return date === undefined ? null : date.getTime() / 1000;
}

function authorsToJSON(authors?: Author[]): ValueType {
  if (authors === undefined || authors.length === 0) {
    return null;
  }
  return JSON.stringify(authors);
}

function authorsFromJSON(json?: string): Author[] | undefined {
  if (json === undefined || json.length === 0) {
    return undefined;
  }
  try {
    const parsed: Object = JSON.parse(json) as Object;
    return Array.isArray(parsed) ? parsed as Author[] : undefined;
  } catch (e) {
    return undefined;
  }
}

/** Articles.Author's failable init + calculated authorID, now that md5 is available. */
export function makeAuthor(name?: string, url?: string, avatarURL?: string,
  emailAddress?: string, authorID?: string): Author | undefined {
  if (name === undefined && url === undefined && emailAddress === undefined) {
    return undefined;
  }
  const author: Author = {
    authorID: authorID === undefined
      ? computeAuthorID(name, url, avatarURL, emailAddress) : authorID,
    name: name,
    url: url,
    avatarURL: avatarURL,
    emailAddress: emailAddress
  };
  return author;
}

/** Article.articlesWithParsedItems — the ParsedItem -> Article mapper. */
export function articleWithParsedItem(item: ParsedItem, feedID: string, accountID: string,
  status: ArticleStatus): Article {
  let authors: Author[] | undefined = undefined;
  if (item.authors !== undefined) {
    const built: Author[] = [];
    for (const parsedAuthor of item.authors) {
      const author: Author | undefined = makeAuthor(parsedAuthor.name, parsedAuthor.url,
        parsedAuthor.avatarURL, parsedAuthor.emailAddress);
      if (author !== undefined) {
        built.push(author);
      }
    }
    authors = built.length === 0 ? undefined : built;
  }
  const article: Article = {
    articleID: computeArticleID(feedID, item.uniqueID),
    accountID: accountID,
    feedID: feedID,
    uniqueID: item.uniqueID,
    title: item.title,
    contentHTML: item.contentHTML,
    contentText: item.contentText,
    markdown: item.markdown,
    rawLink: item.url,
    rawExternalLink: item.externalURL,
    summary: item.summary,
    rawImageLink: item.imageURL,
    datePublished: item.datePublished,
    dateModified: item.dateModified,
    authors: authors,
    status: status
  };
  return article;
}

function articleDatabaseDictionary(article: Article): ValuesBucket {
  const values: ValuesBucket = {
    'articleID': article.articleID,
    'feedID': article.feedID,
    'uniqueID': article.uniqueID,
    'title': article.title === undefined ? null : article.title,
    'contentHTML': article.contentHTML === undefined ? null : article.contentHTML,
    'contentText': article.contentText === undefined ? null : article.contentText,
    'markdown': article.markdown === undefined ? null : article.markdown,
    'url': article.rawLink === undefined ? null : article.rawLink,
    'externalURL': article.rawExternalLink === undefined ? null : article.rawExternalLink,
    'summary': article.summary === undefined ? null : article.summary,
    'imageURL': article.rawImageLink === undefined ? null : article.rawImageLink,
    'datePublished': dateToDatabaseValue(article.datePublished),
    'dateModified': dateToDatabaseValue(article.dateModified),
    'authors': authorsToJSON(article.authors)
  };
  return values;
}

/** True when the two articles differ in any persisted column. */
function articlesDiffer(a: Article, b: Article): boolean {
  return a.title !== b.title || a.contentHTML !== b.contentHTML
    || a.contentText !== b.contentText || a.markdown !== b.markdown
    || a.rawLink !== b.rawLink || a.rawExternalLink !== b.rawExternalLink
    || a.summary !== b.summary || a.rawImageLink !== b.rawImageLink
    || a.uniqueID !== b.uniqueID
    || dateValue(a.datePublished) !== dateValue(b.datePublished)
    || dateValue(a.dateModified) !== dateValue(b.dateModified)
    || authorsToJSON(a.authors) !== authorsToJSON(b.authors);
}

function dateValue(date?: Date): number {
  return date === undefined ? 0 : date.getTime();
}

export class ArticlesDatabase {
  readonly databasePath: string;
  readonly accountID: string;
  readonly retentionStyle: RetentionStyle;

  private readonly database: Database;
  private readonly searchTable: SearchTable;
  /** In-memory statuses, the source's StatusCache — the newer side of a lost write. */
  private readonly statusCache: Map<string, ArticleStatus> = new Map<string, ArticleStatus>();
  /** TODO in the source too: the cutoff is fixed at 90 days. */
  private readonly articleCutoffDate: Date;

  constructor(databaseFileName: string, accountID: string, retentionStyle: RetentionStyle) {
    this.databasePath = databaseFileName;
    this.accountID = accountID;
    this.retentionStyle = retentionStyle;
    this.database = new Database(databaseFileName);
    this.searchTable = new SearchTable(this.database);
    this.articleCutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  }

  async open(): Promise<void> {
    if (this.database.isOpen()) {
      return;
    }
    await this.database.open(CREATE_STATEMENTS);
    // Schema migrations the source performs on an existing database.
    await this.addColumnIfMissing('searchRowID', 'INTEGER');
    await this.addColumnIfMissing('markdown', 'TEXT');
    await this.addColumnIfMissing('authors', 'TEXT');
    await this.database.execute('DROP TABLE if EXISTS tags;');
    await this.database.execute('DROP INDEX if EXISTS tags_tagName_index;');
    await this.database.execute('DROP INDEX if EXISTS articles_feedID_index;');
    await this.database.execute('DROP INDEX if EXISTS statuses_read_index;');
    await this.database.execute('DROP TABLE if EXISTS attachments;');
    await this.database.execute('DROP TABLE if EXISTS attachmentsLookup;');
    await this.searchTable.indexUnindexedArticles();
  }

  async vacuum(): Promise<void> {
    await this.database.vacuum();
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  // MARK: - Fetching articles

  async fetchArticlesForFeedID(feedID: string): Promise<Article[]> {
    return await this.articlesWithWhereClause('feedID = ?', [feedID]);
  }

  async fetchArticles(feedIDs: string[]): Promise<Article[]> {
    if (feedIDs.length === 0) {
      return [];
    }
    return await this.articlesWithWhereClause(
      'feedID in ' + Database.placeholders(feedIDs.length), feedIDs);
  }

  async fetchArticlesWithArticleIDs(articleIDs: string[]): Promise<Article[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    return await this.articlesWithWhereClause(
      'articleID in ' + Database.placeholders(articleIDs.length), articleIDs);
  }

  async fetchUnreadArticles(feedIDs: string[], limit?: number): Promise<Article[]> {
    if (feedIDs.length === 0) {
      return [];
    }
    let whereClause: string = 'feedID in ' + Database.placeholders(feedIDs.length)
      + ' and read=0';
    if (limit !== undefined) {
      whereClause += ' order by coalesce(datePublished, dateModified, dateArrived) desc'
        + ' limit ' + limit;
    }
    return await this.articlesWithWhereClause(whereClause, feedIDs);
  }

  /** Today = the last 24 hours; the Today feed must not empty out at midnight. */
  async fetchTodayArticles(feedIDs: string[], limit?: number): Promise<Article[]> {
    return await this.fetchArticlesSince(feedIDs, ArticlesDatabase.todayCutoffDate(), limit);
  }

  async fetchArticlesSince(feedIDs: string[], cutoffDate: Date,
    limit?: number): Promise<Article[]> {
    if (feedIDs.length === 0) {
      return [];
    }
    const cutoff: number = cutoffDate.getTime() / 1000;
    let whereClause: string = 'feedID in ' + Database.placeholders(feedIDs.length)
      + ' and (datePublished > ? or (datePublished is null and dateArrived > ?))';
    if (limit !== undefined) {
      whereClause += ' order by coalesce(datePublished, dateModified, dateArrived) desc'
        + ' limit ' + limit;
    }
    const parameters: ValueType[] = (feedIDs as ValueType[]).concat([cutoff, cutoff]);
    return await this.articlesWithWhereClause(whereClause, parameters);
  }

  async fetchStarredArticles(feedIDs: string[], limit?: number): Promise<Article[]> {
    if (feedIDs.length === 0) {
      return [];
    }
    let whereClause: string = 'feedID in ' + Database.placeholders(feedIDs.length)
      + ' and starred=1';
    if (limit !== undefined) {
      whereClause += ' order by coalesce(datePublished, dateModified, dateArrived) desc'
        + ' limit ' + limit;
    }
    return await this.articlesWithWhereClause(whereClause, feedIDs);
  }

  async fetchStarredArticlesCount(feedIDs: string[]): Promise<number> {
    if (feedIDs.length === 0) {
      return 0;
    }
    return await this.database.count('select count(*) from articles natural join statuses'
      + ' where feedID in ' + Database.placeholders(feedIDs.length) + ' and starred=1;',
      feedIDs);
  }

  async fetchArticleCounts(feedIDs: string[]): Promise<ArticleCounts> {
    const statusesCount: number =
      await this.database.count('select count(*) from statuses;');
    if (feedIDs.length === 0) {
      return new ArticleCounts(0, 0, 0, statusesCount);
    }
    const feedIDClause: string = 'feedID in ' + Database.placeholders(feedIDs.length);
    const totalCount: number = await this.database.count(
      'select count(*) from articles natural join statuses where ' + feedIDClause + ';',
      feedIDs);
    const unreadCount: number = await this.database.count(
      'select count(*) from articles natural join statuses where ' + feedIDClause
        + ' and read=0;', feedIDs);
    const starredCount: number = await this.database.count(
      'select count(*) from articles natural join statuses where ' + feedIDClause
        + ' and starred=1;', feedIDs);
    return new ArticleCounts(totalCount, unreadCount, starredCount, statusesCount);
  }

  /** feedID -> the date of that feed's latest article. */
  async fetchLastUpdateDates(): Promise<Map<string, Date>> {
    const rows: Row[] = await this.database.query(
      'SELECT feedID, MAX(coalesce(datePublished, dateModified, dateArrived)) as latestDate'
        + ' FROM articles natural join statuses GROUP BY feedID;');
    const result: Map<string, Date> = new Map<string, Date>();
    for (const row of rows) {
      const feedID: string | undefined = row.getString('feedID');
      const latestDate: Date | undefined = row.getDate('latestDate');
      if (feedID !== undefined && latestDate !== undefined) {
        result.set(feedID, latestDate);
      }
    }
    return result;
  }

  // MARK: - Search

  async fetchArticlesMatching(searchString: string, feedIDs: string[]): Promise<Article[]> {
    const articles: Article[] = await this.articlesMatching(searchString);
    const feedIDSet: Set<string> = new Set<string>(feedIDs);
    return articles.filter((article: Article) => feedIDSet.has(article.feedID));
  }

  async fetchArticlesMatchingWithArticleIDs(searchString: string,
    articleIDs: string[]): Promise<Article[]> {
    const articles: Article[] = await this.articlesMatching(searchString);
    const articleIDSet: Set<string> = new Set<string>(articleIDs);
    return articles.filter((article: Article) => articleIDSet.has(article.articleID));
  }

  private async articlesMatching(searchString: string): Promise<Article[]> {
    const searchRowIDs: number[] =
      await this.searchTable.searchRowIDsMatching(sqliteSearchString(searchString));
    if (searchRowIDs.length === 0) {
      return [];
    }
    return await this.articlesWithWhereClause(
      'searchRowID in ' + Database.placeholders(searchRowIDs.length), searchRowIDs);
  }

  // MARK: - Updating (feed-based: local and iCloud)

  /**
   * Update articles and save new ones for a feed-based account.
   * 1 ensure statuses, 2 build incoming articles, 4 fetch the feed's articles,
   * 5 save new, 6 save updated, 7 report, 8 delete articles no longer in the feed,
   * 9 update the search index.
   */
  async updateParsedItems(parsedItems: ParsedItem[], feedID: string,
    deleteOlder: boolean): Promise<ArticleChanges> {
    if (parsedItems.length === 0) {
      return new ArticleChanges();
    }

    // Articles older than ~6 months arrive read.
    const cutoffDate: number = Date.now() - ArticleStatus.staleIntervalInSeconds * 1000;
    const oldArticleIDs: string[] = [];
    const recentArticleIDs: string[] = [];
    const allArticleIDs: string[] = [];
    for (const item of parsedItems) {
      const id: string = computeArticleID(feedID, item.uniqueID);
      allArticleIDs.push(id);
      const published: number = item.datePublished === undefined
        ? Number.MAX_SAFE_INTEGER : item.datePublished.getTime();
      if (published < cutoffDate) {
        oldArticleIDs.push(id);
      } else {
        recentArticleIDs.push(id);
      }
    }

    const statuses: Map<string, ArticleStatus> = new Map<string, ArticleStatus>();
    const recentStatuses: Map<string, ArticleStatus> =
      await this.ensureStatusesForArticleIDs(recentArticleIDs, false);
    recentStatuses.forEach((status: ArticleStatus, id: string) => statuses.set(id, status));
    const oldStatuses: Map<string, ArticleStatus> =
      await this.ensureStatusesForArticleIDs(oldArticleIDs, true);
    oldStatuses.forEach((status: ArticleStatus, id: string) => {
      if (!statuses.has(id)) {
        statuses.set(id, status);
      }
    });

    const incomingArticles: Article[] = [];
    for (const item of parsedItems) {
      const id: string = computeArticleID(feedID, item.uniqueID);
      const status: ArticleStatus | undefined = statuses.get(id);
      if (status === undefined) {
        continue;
      }
      incomingArticles.push(articleWithParsedItem(item, feedID, this.accountID, status));
    }
    if (incomingArticles.length === 0) {
      return new ArticleChanges();
    }

    const fetchedArticles: Article[] = await this.fetchArticlesForFeedID(feedID);
    const fetchedByID: Map<string, Article> = ArticlesDatabase.articlesByID(fetchedArticles);

    const newArticles: Article[] = await this.findAndSaveNewArticles(incomingArticles,
      fetchedByID);
    const updatedArticles: Article[] = await this.findAndSaveUpdatedArticles(incomingArticles,
      fetchedByID);

    // Articles to delete are 1) not starred, 2) older than 30 days, 3) no longer in the feed.
    let articlesToDelete: Article[] = [];
    if (deleteOlder) {
      const deletionCutoff: number = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const incomingIDs: Set<string> = new Set<string>(allArticleIDs);
      articlesToDelete = fetchedArticles.filter((article: Article) =>
        !article.status.starred && article.status.dateArrived.getTime() < deletionCutoff
          && !incomingIDs.has(article.articleID));
    }

    if (articlesToDelete.length > 0) {
      const idsToDelete: string[] = [];
      for (const article of articlesToDelete) {
        idsToDelete.push(article.articleID);
      }
      await this.removeArticles(idsToDelete);
    }

    await this.searchTable.addNewArticlesToIndex(newArticles);
    await this.searchTable.updateIndexForArticles(updatedArticles);

    return new ArticleChanges(newArticles, updatedArticles, articlesToDelete);
  }

  // MARK: - Updating (sync systems: Feedbin, Feedly, …)

  /**
   * Update articles and save new ones for a sync-system account. Incoming articles that
   * are read, unstarred and older than the cutoff are ignored — the remote system owns
   * retention.
   */
  async updateFeedIDsAndItems(feedIDsAndItems: Map<string, ParsedItem[]>,
    defaultRead: boolean): Promise<ArticleChanges> {
    if (feedIDsAndItems.size === 0) {
      return new ArticleChanges();
    }

    const articleIDs: string[] = [];
    feedIDsAndItems.forEach((items: ParsedItem[], feedID: string) => {
      for (const item of items) {
        articleIDs.push(computeArticleID(feedID, item.uniqueID));
      }
    });

    const statuses: Map<string, ArticleStatus> =
      await this.ensureStatusesForArticleIDs(articleIDs, defaultRead);

    const allIncomingArticles: Article[] = [];
    feedIDsAndItems.forEach((items: ParsedItem[], feedID: string) => {
      for (const item of items) {
        const status: ArticleStatus | undefined =
          statuses.get(computeArticleID(feedID, item.uniqueID));
        if (status !== undefined) {
          allIncomingArticles.push(
            articleWithParsedItem(item, feedID, this.accountID, status));
        }
      }
    });
    if (allIncomingArticles.length === 0) {
      return new ArticleChanges();
    }

    const incomingArticles: Article[] =
      allIncomingArticles.filter((article: Article) => !this.articleIsIgnorable(article));
    if (incomingArticles.length === 0) {
      return new ArticleChanges();
    }

    const incomingArticleIDs: string[] = [];
    for (const article of incomingArticles) {
      incomingArticleIDs.push(article.articleID);
    }
    const fetchedArticles: Article[] =
      await this.fetchArticlesWithArticleIDs(incomingArticleIDs);
    const fetchedByID: Map<string, Article> = ArticlesDatabase.articlesByID(fetchedArticles);

    const newArticles: Article[] =
      await this.findAndSaveNewArticles(incomingArticles, fetchedByID);
    const updatedArticles: Article[] =
      await this.findAndSaveUpdatedArticles(incomingArticles, fetchedByID);

    await this.searchTable.addNewArticlesToIndex(newArticles);
    await this.searchTable.updateIndexForArticles(updatedArticles);

    return new ArticleChanges(newArticles, updatedArticles, []);
  }

  async deleteArticles(articleIDs: string[]): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    await this.removeArticles(articleIDs);
  }

  // MARK: - Unread counts

  /** Every non-zero unread count. */
  async fetchAllUnreadCounts(): Promise<UnreadCountDictionary> {
    const rows: Row[] = await this.database.query(
      'select distinct feedID, count(*) as unreadCount from articles natural join statuses'
        + ' where read=0 group by feedID;');
    return ArticlesDatabase.unreadCountsFromRows(rows);
  }

  async fetchUnreadCounts(feedIDs: string[]): Promise<UnreadCountDictionary> {
    if (feedIDs.length === 0) {
      return new Map<string, number>();
    }
    const rows: Row[] = await this.database.query(
      'select distinct feedID, count(*) as unreadCount from articles natural join statuses'
        + ' where feedID in ' + Database.placeholders(feedIDs.length)
        + ' and read=0 group by feedID;', feedIDs);
    return ArticlesDatabase.unreadCountsFromRows(rows);
  }

  async fetchUnreadCountForFeedID(feedID: string): Promise<number> {
    const counts: UnreadCountDictionary = await this.fetchUnreadCounts([feedID]);
    const count: number | undefined = counts.get(feedID);
    return count === undefined ? 0 : count;
  }

  async fetchUnreadCountForToday(feedIDs: string[]): Promise<number> {
    return await this.fetchUnreadCountSince(feedIDs, ArticlesDatabase.todayCutoffDate());
  }

  async fetchUnreadCountSince(feedIDs: string[], since: Date): Promise<number> {
    if (feedIDs.length === 0) {
      return 0;
    }
    const cutoff: number = since.getTime() / 1000;
    const parameters: ValueType[] = (feedIDs as ValueType[]).concat([cutoff, cutoff]);
    return await this.database.count('select count(*) from articles natural join statuses'
      + ' where feedID in ' + Database.placeholders(feedIDs.length)
      + ' and (datePublished > ? or (datePublished is null and dateArrived > ?))'
      + ' and read=0;', parameters);
  }

  async fetchUnreadCountForStarredArticles(feedIDs: string[]): Promise<number> {
    if (feedIDs.length === 0) {
      return 0;
    }
    return await this.database.count('select count(*) from articles natural join statuses'
      + ' where feedID in ' + Database.placeholders(feedIDs.length)
      + ' and read=0 and starred=1;', feedIDs);
  }

  async fetchTodayArticlesCount(feedIDs: string[]): Promise<number> {
    if (feedIDs.length === 0) {
      return 0;
    }
    const cutoff: number = ArticlesDatabase.todayCutoffDate().getTime() / 1000;
    const parameters: ValueType[] = (feedIDs as ValueType[]).concat([cutoff, cutoff]);
    return await this.database.count('select count(*) from articles natural join statuses'
      + ' where feedID in ' + Database.placeholders(feedIDs.length)
      + ' and (datePublished > ? or (datePublished is null and dateArrived > ?));',
      parameters);
  }

  // MARK: - Article IDs

  async fetchUnreadArticleIDs(): Promise<string[]> {
    return await this.fetchArticleIDs('select articleID from statuses where read=0;');
  }

  async fetchStarredArticleIDs(): Promise<string[]> {
    return await this.fetchArticleIDs('select articleID from statuses where starred=1;');
  }

  /** Articles we should have but don't — starred, or newer than the article cutoff. */
  async fetchArticleIDsForStatusesWithoutArticlesNewerThanCutoffDate(): Promise<string[]> {
    const rows: Row[] = await this.database.query(
      'select articleID from statuses s where (starred=1 or dateArrived>?)'
        + ' and not exists (select 1 from articles a where a.articleID = s.articleID);',
      [this.articleCutoffDate.getTime() / 1000]);
    const ids: string[] = [];
    for (const row of rows) {
      const id: string | undefined = row.getString(DatabaseKey.articleID);
      if (id !== undefined) {
        ids.push(id);
      }
    }
    return ids;
  }

  // MARK: - Statuses

  /** Marks statuses. Returns the articleIDs whose status actually changed. */
  async mark(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<string[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    const statuses: Map<string, ArticleStatus> =
      await this.ensureStatusesForArticleIDs(articleIDs, flag);

    const changedArticleIDs: string[] = [];
    statuses.forEach((status: ArticleStatus, id: string) => {
      if (status.boolStatus(statusKey) !== flag) {
        status.setBoolStatus(flag, statusKey);
        changedArticleIDs.push(id);
      }
    });

    // Update every requested articleID, not just the ones that changed in memory — the
    // `!= ?` guard means a row that already matches is not rewritten.
    await this.markArticleIDs(articleIDs, statusKey, flag);
    return changedArticleIDs;
  }

  /** Marks and returns the articleIDs whose statuses had to be created. */
  async markAndFetchNew(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<string[]> {
    const newStatusIDs: string[] = await this.articleIDsNeedingStatus(articleIDs);
    await this.mark(articleIDs, statusKey, flag);
    return newStatusIDs;
  }

  /** Creates statuses for articleIDs that have none — new ones are read and unstarred. */
  async createStatusesIfNeeded(articleIDs: string[]): Promise<void> {
    await this.ensureStatusesForArticleIDs(articleIDs, true);
  }

  /**
   * Repair status rows that disagree with their in-memory statuses, which can happen when
   * a database write was lost. Only cached statuses can disagree.
   */
  async repairStatuses(): Promise<void> {
    const cachedStatuses: ArticleStatus[] = [];
    this.statusCache.forEach((status: ArticleStatus) => cachedStatuses.push(status));
    if (cachedStatuses.length === 0) {
      return;
    }
    // Stay well under SQLite's bind-variable limit.
    const chunkSize: number = 500;
    const statusesNeedingRepair: ArticleStatus[] = [];
    for (let start: number = 0; start < cachedStatuses.length; start += chunkSize) {
      const chunk: ArticleStatus[] =
        cachedStatuses.slice(start, Math.min(start + chunkSize, cachedStatuses.length));
      const stale: ArticleStatus[] = await this.staleStatuses(chunk);
      for (const status of stale) {
        statusesNeedingRepair.push(status);
      }
    }
    if (statusesNeedingRepair.length === 0) {
      return;
    }
    hilog.info(DOMAIN, TAG, 'repairing %{public}d stale statuses',
      statusesNeedingRepair.length);
    for (const status of statusesNeedingRepair) {
      await this.database.execute(
        'update statuses set read=?, starred=? where articleID=?;',
        [status.read, status.starred, status.articleID]);
    }
  }

  // MARK: - Caches

  /** Frees memory when the app is backgrounded. Does not empty every cache. */
  emptyCaches(): void {
    this.statusCache.clear();
  }

  // MARK: - Cleanup (startup only)

  /**
   * Keeps the database from growing forever. Sync-system accounts delete old articles;
   * every account deletes articles for feeds it no longer subscribes to, and old statuses.
   */
  async cleanupDatabaseAtStartup(subscribedToFeedIDs: string[]): Promise<void> {
    if (this.retentionStyle === RetentionStyle.syncSystem) {
      await this.deleteOldArticles();
    }
    await this.deleteArticlesNotInSubscribedToFeedIDs(subscribedToFeedIDs);
    await this.deleteOldStatuses();
  }

  // MARK: - Private

  private static todayCutoffDate(): Date {
    // 24 hours ago — the Today smart feed must not empty out at midnight.
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  private static articlesByID(articles: Article[]): Map<string, Article> {
    const map: Map<string, Article> = new Map<string, Article>();
    for (const article of articles) {
      map.set(article.articleID, article);
    }
    return map;
  }

  private static unreadCountsFromRows(rows: Row[]): UnreadCountDictionary {
    const counts: UnreadCountDictionary = new Map<string, number>();
    for (const row of rows) {
      const feedID: string | undefined = row.getString(DatabaseKey.feedID);
      if (feedID === undefined) {
        continue;
      }
      counts.set(feedID, row.getNumberOrZero('unreadCount'));
    }
    return counts;
  }

  private async addColumnIfMissing(columnName: string, columnType: string): Promise<void> {
    const rows: Row[] = await this.database.query('PRAGMA table_info(articles);');
    for (const row of rows) {
      if (row.getString('name') === columnName) {
        return;
      }
    }
    await this.database.execute('ALTER TABLE articles add column ' + columnName + ' '
      + columnType + ';');
  }

  private async articlesWithWhereClause(whereClause: string,
    parameters: ValueType[]): Promise<Article[]> {
    const rows: Row[] = await this.database.query(
      'select * from articles natural join statuses where ' + whereClause + ';', parameters);
    const articles: Article[] = [];
    for (const row of rows) {
      const article: Article | undefined = this.articleWithRow(row);
      if (article !== undefined) {
        articles.push(article);
      }
    }
    return articles;
  }

  /**
   * The query is a JOIN with statuses, so the status comes from the same row — no extra
   * lookup. A cached status wins, since it is the newer side of a lost write.
   */
  private articleWithRow(row: Row): Article | undefined {
    const articleID: string | undefined = row.getString(DatabaseKey.articleID);
    if (articleID === undefined) {
      return undefined;
    }
    let status: ArticleStatus | undefined = this.statusCache.get(articleID);
    if (status === undefined) {
      const dateArrived: Date | undefined = row.getDate(DatabaseKey.dateArrived);
      status = new ArticleStatus(articleID, row.getBoolean(DatabaseKey.read),
        row.getBoolean(DatabaseKey.starred),
        dateArrived === undefined ? new Date(0) : dateArrived);
      this.statusCache.set(articleID, status);
    }
    const article: Article = {
      articleID: articleID,
      accountID: this.accountID,
      feedID: row.getStringOrEmpty(DatabaseKey.feedID),
      uniqueID: row.getStringOrEmpty(DatabaseKey.uniqueID),
      title: row.getString(DatabaseKey.title),
      contentHTML: row.getString(DatabaseKey.contentHTML),
      contentText: row.getString(DatabaseKey.contentText),
      markdown: row.getString(DatabaseKey.markdown),
      rawLink: row.getString(DatabaseKey.url),
      rawExternalLink: row.getString(DatabaseKey.externalURL),
      summary: row.getString(DatabaseKey.summary),
      rawImageLink: row.getString(DatabaseKey.imageURL),
      datePublished: row.getDate(DatabaseKey.datePublished),
      dateModified: row.getDate(DatabaseKey.dateModified),
      authors: authorsFromJSON(row.getString(DatabaseKey.authors)),
      status: status
    };
    return article;
  }

  private async fetchArticleIDs(sql: string): Promise<string[]> {
    const rows: Row[] = await this.database.query(sql);
    const ids: string[] = [];
    for (const row of rows) {
      const id: string | undefined = row.getString(DatabaseKey.articleID);
      if (id !== undefined) {
        ids.push(id);
      }
    }
    return ids;
  }

  private async findAndSaveNewArticles(incomingArticles: Article[],
    fetchedByID: Map<string, Article>): Promise<Article[]> {
    const newArticles: Article[] =
      incomingArticles.filter((article: Article) => !fetchedByID.has(article.articleID));
    if (newArticles.length === 0) {
      return [];
    }
    const rows: ValuesBucket[] = [];
    for (const article of newArticles) {
      rows.push(articleDatabaseDictionary(article));
    }
    await this.database.insertRows(DatabaseTableName.articles, rows, true);
    return newArticles;
  }

  private async findAndSaveUpdatedArticles(incomingArticles: Article[],
    fetchedByID: Map<string, Article>): Promise<Article[]> {
    const updatedArticles: Article[] = [];
    for (const incoming of incomingArticles) {
      const existing: Article | undefined = fetchedByID.get(incoming.articleID);
      if (existing !== undefined && articlesDiffer(existing, incoming)) {
        updatedArticles.push(incoming);
      }
    }
    for (const article of updatedArticles) {
      // Only what changed is written — better performance, less fragmentation.
      const existing: Article | undefined = fetchedByID.get(article.articleID);
      if (existing === undefined) {
        await this.database.insertRows(DatabaseTableName.articles,
          [articleDatabaseDictionary(article)], true);
        continue;
      }
      await this.saveChangedColumns(article, existing);
    }
    return updatedArticles;
  }

  private async saveChangedColumns(article: Article, existing: Article): Promise<void> {
    const assignments: string[] = [];
    const parameters: ValueType[] = [];
    const incomingValues: ValuesBucket = articleDatabaseDictionary(article);
    const existingValues: ValuesBucket = articleDatabaseDictionary(existing);
    for (const column of Object.keys(incomingValues)) {
      if (column === DatabaseKey.articleID) {
        continue;
      }
      const incomingValue: ValueType = incomingValues[column];
      if (incomingValue === existingValues[column]) {
        continue;
      }
      assignments.push(column + ' = ?');
      parameters.push(incomingValue);
    }
    if (assignments.length === 0) {
      return;
    }
    parameters.push(article.articleID);
    await this.database.execute('update articles set ' + assignments.join(', ')
      + ' where articleID = ?;', parameters);
  }

  private async removeArticles(articleIDs: string[]): Promise<void> {
    await this.database.execute('delete from articles where articleID in '
      + Database.placeholders(articleIDs.length) + ';', articleIDs);
  }

  // MARK: - Statuses (StatusesTable.swift)

  private async articleIDsNeedingStatus(articleIDs: string[]): Promise<string[]> {
    if (articleIDs.length === 0) {
      return [];
    }
    const existing: Set<string> = new Set<string>();
    const rows: Row[] = await this.database.query(
      'select articleID from statuses where articleID in '
        + Database.placeholders(articleIDs.length) + ';', articleIDs);
    for (const row of rows) {
      const id: string | undefined = row.getString(DatabaseKey.articleID);
      if (id !== undefined) {
        existing.add(id);
      }
    }
    return articleIDs.filter((id: string) => !existing.has(id));
  }

  /**
   * Returns a status for every requested articleID, creating any that are missing with the
   * given `read` value and a `dateArrived` of now.
   */
  private async ensureStatusesForArticleIDs(articleIDs: string[],
    read: boolean): Promise<Map<string, ArticleStatus>> {
    const result: Map<string, ArticleStatus> = new Map<string, ArticleStatus>();
    if (articleIDs.length === 0) {
      return result;
    }

    const uncached: string[] = [];
    for (const articleID of articleIDs) {
      const cached: ArticleStatus | undefined = this.statusCache.get(articleID);
      if (cached === undefined) {
        uncached.push(articleID);
      } else {
        result.set(articleID, cached);
      }
    }

    if (uncached.length > 0) {
      const rows: Row[] = await this.database.query(
        'select articleID, read, starred, dateArrived from statuses where articleID in '
          + Database.placeholders(uncached.length) + ';', uncached);
      for (const row of rows) {
        const articleID: string | undefined = row.getString(DatabaseKey.articleID);
        if (articleID === undefined) {
          continue;
        }
        const dateArrived: Date | undefined = row.getDate(DatabaseKey.dateArrived);
        const status: ArticleStatus = new ArticleStatus(articleID,
          row.getBoolean(DatabaseKey.read), row.getBoolean(DatabaseKey.starred),
          dateArrived === undefined ? new Date(0) : dateArrived);
        this.statusCache.set(articleID, status);
        result.set(articleID, status);
      }
    }

    const needingStatus: string[] = articleIDs.filter((id: string) => !result.has(id));
    if (needingStatus.length > 0) {
      const now: Date = new Date();
      const rows: ValuesBucket[] = [];
      for (const articleID of needingStatus) {
        const status: ArticleStatus = new ArticleStatus(articleID, read, false, now);
        this.statusCache.set(articleID, status);
        result.set(articleID, status);
        const row: ValuesBucket = {
          'articleID': articleID,
          'read': read,
          'starred': false,
          'dateArrived': now.getTime() / 1000
        };
        rows.push(row);
      }
      // orIgnore: an existing row wins.
      await this.database.insertRows(DatabaseTableName.statuses, rows, false);
    }
    return result;
  }

  private async markArticleIDs(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    const key: string = statusKey as string;
    const parameters: ValueType[] = ([flag] as ValueType[])
      .concat(articleIDs as ValueType[]).concat([flag]);
    await this.database.execute('update statuses set ' + key + '=? where articleID in '
      + Database.placeholders(articleIDs.length) + ' and ' + key + '!=?;', parameters);
  }

  /** The cached statuses whose database rows disagree with them. */
  private async staleStatuses(statuses: ArticleStatus[]): Promise<ArticleStatus[]> {
    const byArticleID: Map<string, ArticleStatus> = new Map<string, ArticleStatus>();
    const articleIDs: string[] = [];
    for (const status of statuses) {
      if (!byArticleID.has(status.articleID)) {
        byArticleID.set(status.articleID, status);
        articleIDs.push(status.articleID);
      }
    }
    const rows: Row[] = await this.database.query(
      'select articleID, read, starred from statuses where articleID in '
        + Database.placeholders(articleIDs.length) + ';', articleIDs);
    const stale: ArticleStatus[] = [];
    for (const row of rows) {
      const articleID: string | undefined = row.getString(DatabaseKey.articleID);
      if (articleID === undefined) {
        continue;
      }
      const status: ArticleStatus | undefined = byArticleID.get(articleID);
      if (status === undefined) {
        continue;
      }
      if (status.read !== row.getBoolean(DatabaseKey.read)
        || status.starred !== row.getBoolean(DatabaseKey.starred)) {
        stale.push(status);
      }
    }
    return stale;
  }

  // MARK: - Cleanup helpers

  private articleIsIgnorable(article: Article): boolean {
    if (article.status.starred || !article.status.read) {
      return false;
    }
    return article.status.dateArrived.getTime() < this.articleCutoffDate.getTime();
  }

  /**
   * Sync systems only. Deletes read, unstarred articles older than the cutoff — and, when
   * a long time has passed since the last run, walks the cutoff back in day-sized steps
   * so a huge backlog is not deleted in one statement.
   */
  private async deleteOldArticles(): Promise<void> {
    const sql: string = 'delete from articles where articleID in (select articleID from'
      + ' articles natural join statuses where dateArrived<? and read=1 and starred=0);';
    const startTime: number = Date.now();
    // Deleting a big backlog can block the database for too long, so walk the cutoff back
    // in steps and stop after 2 seconds — the rest goes on the next launch.
    const dayIntervals: number[] = [365, 300, 225, 150];
    for (const dayInterval of dayIntervals) {
      const cutoff: number = startTime - dayInterval * 24 * 60 * 60 * 1000;
      await this.database.execute(sql, [cutoff / 1000]);
      if (Date.now() - startTime > 2000) {
        return;
      }
    }
    await this.database.execute(sql, [this.articleCutoffDate.getTime() / 1000]);
  }

  private async deleteOldStatuses(): Promise<void> {
    let sql: string;
    let cutoff: Date;
    if (this.retentionStyle === RetentionStyle.syncSystem) {
      sql = 'delete from statuses where dateArrived<? and read=1 and starred=0 and'
        + ' articleID not in (select articleID from articles);';
      cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    } else {
      sql = 'delete from statuses where dateArrived<? and starred=0 and articleID not in'
        + ' (select articleID from articles);';
      cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }
    await this.database.execute(sql, [cutoff.getTime() / 1000]);
  }

  private async deleteArticlesNotInSubscribedToFeedIDs(feedIDs: string[]): Promise<void> {
    if (feedIDs.length === 0) {
      return;
    }
    const rows: Row[] = await this.database.query(
      'select articleID from articles where feedID not in '
        + Database.placeholders(feedIDs.length) + ';', feedIDs);
    const articleIDs: string[] = [];
    for (const row of rows) {
      const id: string | undefined = row.getString(DatabaseKey.articleID);
      if (id !== undefined) {
        articleIDs.push(id);
      }
    }
    if (articleIDs.length === 0) {
      return;
    }
    await this.removeArticles(articleIDs);
    await this.database.execute('delete from statuses where articleID in '
      + Database.placeholders(articleIDs.length) + ';', articleIDs);
  }
}
