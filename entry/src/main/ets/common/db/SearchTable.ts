/**
 * SearchTable — port of Modules/ArticlesDatabase/Sources/ArticlesDatabase/SearchTable.swift
 *
 * The FTS4 index over (title, body), kept in sync on every article insert/update, plus
 * indexUnindexedArticles at startup. Deletion is handled by the after-delete trigger the
 * schema declares, so nothing here removes rows.
 *
 * `normalizedForSearchIndex` matters: the tokenizer treats non-ASCII punctuation as word
 * characters, so "'BeReal'" would index as a token that a search for "bereal" can't match.
 */

import { Article } from '../../model/Article';
import { Author } from '../../model/Author';
import { normalizedForSearchIndex, decodingHTMLEntities, strippingHTML } from '../util/Strings';
import { Database, Row, ValuesBucket } from './Database';

export const SEARCH_TABLE_NAME: string = 'search';

/** The searchable projection of an article — the source's ArticleSearchInfo. */
export class ArticleSearchInfo {
  readonly articleID: string;
  readonly title?: string;
  readonly titleForIndex: string;
  readonly bodyForIndex: string;
  readonly searchRowID?: number;

  constructor(articleID: string, title: string | undefined, contentHTML: string | undefined,
    contentText: string | undefined, summary: string | undefined,
    authorsNames: string | undefined, searchRowID?: number) {
    this.articleID = articleID;
    this.title = title;
    this.searchRowID = searchRowID;
    this.titleForIndex = normalizedForSearchIndex(title === undefined ? '' : title);

    let preferredText: string = '';
    if (contentHTML !== undefined && contentHTML.length > 0) {
      preferredText = contentHTML;
    } else if (contentText !== undefined && contentText.length > 0) {
      preferredText = contentText;
    } else if (summary !== undefined) {
      preferredText = summary;
    }

    let sanitizedBody: string = strippingHTML(decodingHTMLEntities(preferredText));
    if (authorsNames !== undefined) {
      sanitizedBody = sanitizedBody + ' ' + authorsNames;
    }
    this.bodyForIndex = normalizedForSearchIndex(sanitizedBody);
  }

  static fromArticle(article: Article): ArticleSearchInfo {
    let authorsNames: string | undefined = undefined;
    const authors: Author[] | undefined = article.authors;
    if (authors !== undefined) {
      const names: string[] = [];
      for (const author of authors) {
        if (author.name !== undefined) {
          names.push(author.name);
        }
      }
      authorsNames = names.length === 0 ? undefined : names.join(' ');
    }
    return new ArticleSearchInfo(article.articleID, article.title, article.contentHTML,
      article.contentText, article.summary, authorsNames, undefined);
  }
}

class SearchInfo {
  readonly rowID: number;
  readonly title: string;
  readonly body: string;

  constructor(rowID: number, title: string, body: string) {
    this.rowID = rowID;
    this.title = title;
    this.body = body;
  }
}

export class SearchTable {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  /** Index new articles — they have no searchRowID yet. (Source: indexNewArticles.) */
  async addNewArticlesToIndex(articles: Article[]): Promise<void> {
    const infos: ArticleSearchInfo[] = [];
    for (const article of articles) {
      infos.push(ArticleSearchInfo.fromArticle(article));
    }
    await this.performInitialIndexForArticles(infos);
  }

  /**
   * Index updated articles — they may or may not already have a searchRowID.
   * (Source: indexUpdatedArticles.)
   */
  async updateIndexForArticles(articles: Article[]): Promise<void> {
    const articleIDs: string[] = [];
    for (const article of articles) {
      articleIDs.push(article.articleID);
    }
    await this.ensureIndexedArticles(articleIDs);
  }

  /** Add to, or update, the search index for articles with the given IDs. */
  async ensureIndexedArticles(articleIDs: string[]): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    const infos: ArticleSearchInfo[] = await this.fetchArticleSearchInfos(articleIDs);
    const unindexed: ArticleSearchInfo[] = [];
    const indexed: ArticleSearchInfo[] = [];
    for (const info of infos) {
      if (info.searchRowID === undefined) {
        unindexed.push(info);
      } else {
        indexed.push(info);
      }
    }
    await this.performInitialIndexForArticles(unindexed);
    await this.updateIndexEntries(indexed);
  }

  /** Startup sweep: 500 unindexed articles at a time, as the source does. */
  async indexUnindexedArticles(): Promise<void> {
    const rows: Row[] = await this.database.query(
      'select articleID from articles where searchRowID is null limit 500;');
    const articleIDs: string[] = [];
    for (const row of rows) {
      const articleID: string | undefined = row.getString('articleID');
      if (articleID !== undefined) {
        articleIDs.push(articleID);
      }
    }
    if (articleIDs.length === 0) {
      return;
    }
    await this.ensureIndexedArticles(articleIDs);
  }

  /** `search match ?` -> the search rowids that matched. */
  async searchRowIDsMatching(sqliteSearchString: string): Promise<number[]> {
    const rows: Row[] = await this.database.query(
      'select rowid from ' + SEARCH_TABLE_NAME + ' where ' + SEARCH_TABLE_NAME + ' match ?;',
      [sqliteSearchString]);
    const rowIDs: number[] = [];
    for (const row of rows) {
      const rowID: number | undefined = row.getNumber('rowid');
      if (rowID !== undefined) {
        rowIDs.push(rowID);
      }
    }
    return rowIDs;
  }

  private async fetchArticleSearchInfos(articleIDs: string[]): Promise<ArticleSearchInfo[]> {
    const rows: Row[] = await this.database.query(
      'select articleID, title, contentHTML, contentText, summary, searchRowID, authors'
        + ' from articles where articleID in ' + Database.placeholders(articleIDs.length) + ';',
      articleIDs);
    const infos: ArticleSearchInfo[] = [];
    for (const row of rows) {
      const articleID: string | undefined = row.getString('articleID');
      if (articleID === undefined) {
        continue;
      }
      infos.push(new ArticleSearchInfo(articleID, row.getString('title'),
        row.getString('contentHTML'), row.getString('contentText'), row.getString('summary'),
        SearchTable.authorsNamesFromJSON(row.getString('authors')),
        row.getNumber('searchRowID')));
    }
    return infos;
  }

  private static authorsNamesFromJSON(json?: string): string | undefined {
    if (json === undefined || json.length === 0) {
      return undefined;
    }
    try {
      const parsed: Object = JSON.parse(json) as Object;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      const names: string[] = [];
      for (const element of parsed as Object[]) {
        const record: Record<string, Object> = element as Record<string, Object>;
        const name: Object | undefined = record.name;
        if (typeof name === 'string') {
          names.push(name as string);
        }
      }
      return names.length === 0 ? undefined : names.join(' ');
    } catch (e) {
      return undefined;
    }
  }

  private async performInitialIndexForArticles(articles: ArticleSearchInfo[]): Promise<void> {
    for (const article of articles) {
      await this.performInitialIndex(article);
    }
  }

  private async performInitialIndex(article: ArticleSearchInfo): Promise<void> {
    const row: ValuesBucket = {
      'body': article.bodyForIndex,
      'title': article.titleForIndex
    };
    const rowID: number = await this.database.insert(SEARCH_TABLE_NAME, row);
    if (rowID < 0) {
      return;
    }
    await this.database.execute(
      'update articles set searchRowID = ? where articleID = ?;', [rowID, article.articleID]);
  }

  private async updateIndexEntries(articles: ArticleSearchInfo[]): Promise<void> {
    if (articles.length === 0) {
      return;
    }
    const searchInfos: Map<number, SearchInfo> | undefined =
      await this.fetchSearchInfos(articles);
    if (searchInfos === undefined) {
      // The articles here have a non-nil searchRowID, so rows should have been found.
      // Recover by doing an initial index.
      await this.performInitialIndexForArticles(articles);
      return;
    }
    for (const article of articles) {
      await this.updateIndexForArticle(article, searchInfos);
    }
  }

  private async updateIndexForArticle(article: ArticleSearchInfo,
    searchInfos: Map<number, SearchInfo>): Promise<void> {
    const searchRowID: number | undefined = article.searchRowID;
    if (searchRowID === undefined) {
      return;
    }
    const searchInfo: SearchInfo | undefined = searchInfos.get(searchRowID);
    if (searchInfo === undefined) {
      // The article has a searchRowID but no row in the search table. Easy to recover from.
      await this.performInitialIndex(article);
      return;
    }
    if (article.titleForIndex === searchInfo.title
      && article.bodyForIndex === searchInfo.body) {
      return;
    }
    if (article.titleForIndex !== searchInfo.title
      && article.bodyForIndex !== searchInfo.body) {
      await this.database.execute('update ' + SEARCH_TABLE_NAME
        + ' set title = ?, body = ? where rowid = ?;',
        [article.titleForIndex, article.bodyForIndex, searchRowID]);
      return;
    }
    if (article.titleForIndex !== searchInfo.title) {
      await this.database.execute('update ' + SEARCH_TABLE_NAME
        + ' set title = ? where rowid = ?;', [article.titleForIndex, searchRowID]);
      return;
    }
    await this.database.execute('update ' + SEARCH_TABLE_NAME
      + ' set body = ? where rowid = ?;', [article.bodyForIndex, searchRowID]);
  }

  private async fetchSearchInfos(
    articles: ArticleSearchInfo[]): Promise<Map<number, SearchInfo> | undefined> {
    const searchRowIDs: number[] = [];
    for (const article of articles) {
      const searchRowID: number | undefined = article.searchRowID;
      if (searchRowID !== undefined) {
        searchRowIDs.push(searchRowID);
      }
    }
    if (searchRowIDs.length === 0) {
      return undefined;
    }
    const rows: Row[] = await this.database.query('select rowid, title, body from '
      + SEARCH_TABLE_NAME + ' where rowid in '
      + Database.placeholders(searchRowIDs.length) + ';', searchRowIDs);
    const result: Map<number, SearchInfo> = new Map<number, SearchInfo>();
    for (const row of rows) {
      const rowID: number | undefined = row.getNumber('rowid');
      if (rowID === undefined) {
        continue;
      }
      result.set(rowID, new SearchInfo(rowID, row.getStringOrEmpty('title'),
        row.getStringOrEmpty('body')));
    }
    return result;
  }
}

/**
 * ArticlesTable.sqliteSearchString — each word gets a `*` suffix so search is
 * prefix-matching, except the FTS operators AND / OR.
 */
export function sqliteSearchString(searchString: string): string {
  let s: string = '';
  const words: string[] = searchString.split(/\s+/);
  for (const word of words) {
    if (word.length === 0) {
      continue;
    }
    s += word;
    if (word !== 'AND' && word !== 'OR') {
      s += '*';
    }
    s += ' ';
  }
  return s;
}
