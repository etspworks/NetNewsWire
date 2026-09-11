/**
 * FeedSettingsDatabase — port of
 * Modules/Account/Sources/Account/FeedSettingsDatabase.swift over relationalStore.
 *
 * A write-through store keyed by feedURL. Written on every REFRESH (contentHash,
 * conditional-GET info, lastCheckDate, lastResponseCode) as well as by the feed inspector,
 * and read as ONE bulk load into the account cache at startup — `allRows()` is the only
 * read path, exactly as in the source.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Author } from '../../model/Author';
import { CacheControlInfo } from '../../model/CacheControlInfo';
import { HTTPConditionalGetInfo, makeConditionalGetInfo }
  from '../../model/HTTPConditionalGetInfo';
import { Database, Row, ValuesBucket, ValueType } from './Database';

const DOMAIN: number = 0x0001;
const TAG: string = 'FeedSettingsDatabase';

const TABLE_NAME: string = 'feedSettings';

/** The source's Column enum — the raw values ARE the column names. */
export enum FeedSettingsColumn {
  feedID = 'feedID',
  homePageURL = 'homePageURL',
  iconURL = 'iconURL',
  faviconURL = 'faviconURL',
  editedName = 'editedName',
  contentHash = 'contentHash',
  newArticleNotificationsEnabled = 'newArticleNotificationsEnabled',
  readerViewAlwaysEnabled = 'readerViewAlwaysEnabled',
  authors = 'authors',
  conditionalGetInfoLastModified = 'conditionalGetInfoLastModified',
  conditionalGetInfoEtag = 'conditionalGetInfoEtag',
  conditionalGetInfoDate = 'conditionalGetInfoDate',
  cacheControlInfoDateCreated = 'cacheControlInfoDateCreated',
  cacheControlInfoMaxAge = 'cacheControlInfoMaxAge',
  externalID = 'externalID',
  folderRelationship = 'folderRelationship',
  lastCheckDate = 'lastCheckDate',
  lastResponseCode = 'lastResponseCode'
}

/** One row of feedSettings, as the account cache loads it. */
export interface FeedSettingsRow {
  feedID: string;
  homePageURL?: string;
  iconURL?: string;
  faviconURL?: string;
  editedName?: string;
  contentHash?: string;
  newArticleNotificationsEnabled: boolean;
  readerViewAlwaysEnabled: boolean;
  authors?: Author[];
  conditionalGetInfo?: HTTPConditionalGetInfo;
  conditionalGetInfoDate?: Date;
  cacheControlInfo?: CacheControlInfo;
  externalID?: string;
  folderRelationship?: Map<string, string>;
  lastCheckDate?: Date;
  lastResponseCode?: number;
}

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE IF NOT EXISTS feedSettings (feedURL TEXT PRIMARY KEY,'
    + ' feedID TEXT NOT NULL DEFAULT \'\', homePageURL TEXT, iconURL TEXT, faviconURL TEXT,'
    + ' editedName TEXT, contentHash TEXT,'
    + ' newArticleNotificationsEnabled INTEGER NOT NULL DEFAULT 0,'
    + ' readerViewAlwaysEnabled INTEGER NOT NULL DEFAULT 0, authors TEXT,'
    + ' conditionalGetInfoLastModified TEXT, conditionalGetInfoEtag TEXT,'
    + ' conditionalGetInfoDate REAL, cacheControlInfoDateCreated REAL,'
    + ' cacheControlInfoMaxAge REAL, externalID TEXT, folderRelationship TEXT,'
    + ' lastCheckDate REAL, lastResponseCode INTEGER);'
];

/**
 * Dates are stored as seconds since the reference date (2001-01-01), which is what
 * `timeIntervalSinceReferenceDate` writes — an existing database must keep reading.
 */
const REFERENCE_DATE_OFFSET_SECONDS: number = 978307200;

function toReferenceSeconds(date: Date): number {
  return date.getTime() / 1000 - REFERENCE_DATE_OFFSET_SECONDS;
}

function fromReferenceSeconds(seconds: number): Date {
  return new Date((seconds + REFERENCE_DATE_OFFSET_SECONDS) * 1000);
}

export function authorsToJSON(authors: Author[]): string {
  return JSON.stringify(authors);
}

export function authorsFromJSON(json: string): Author[] | undefined {
  try {
    const parsed: Object = JSON.parse(json) as Object;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Author[];
  } catch (e) {
    return undefined;
  }
}

export class FeedSettingsDatabase {
  readonly databasePath: string;
  private readonly database: Database;

  constructor(databaseFileName: string) {
    this.databasePath = databaseFileName;
    this.database = new Database(databaseFileName);
  }

  async open(): Promise<void> {
    if (this.database.isOpen()) {
      return;
    }
    await this.database.open(CREATE_STATEMENTS);
    await this.database.vacuum();
  }

  async vacuum(): Promise<void> {
    await this.database.vacuum();
  }

  async isEmpty(): Promise<boolean> {
    const rows: Row[] = await this.database.query('SELECT 1 FROM feedSettings LIMIT 1;');
    return rows.length === 0;
  }

  // MARK: - Feed existence

  async ensureFeedExists(feedURL: string, feedID: string): Promise<void> {
    await this.database.execute(
      'INSERT OR IGNORE INTO feedSettings (feedURL, feedID) VALUES (?, ?);',
      [feedURL, feedID]);
  }

  async insertRow(feedURL: string, columnValues: Map<FeedSettingsColumn, ValueType>):
    Promise<void> {
    const values: ValuesBucket = { 'feedURL': feedURL };
    columnValues.forEach((value: ValueType, column: FeedSettingsColumn) => {
      values[column as string] = value;
    });
    await this.database.insert(TABLE_NAME, values, true);
  }

  // MARK: - Fetching (the one bulk read at startup)

  /** feedURL -> row. */
  async allRows(): Promise<Map<string, FeedSettingsRow>> {
    const result: Map<string, FeedSettingsRow> = new Map<string, FeedSettingsRow>();
    let rows: Row[] = [];
    try {
      rows = await this.database.query('SELECT * FROM feedSettings;');
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'allRows failed: %{public}s', String(e));
      return result;
    }
    for (const row of rows) {
      const feedURL: string | undefined = row.getString('feedURL');
      if (feedURL === undefined) {
        continue;
      }
      result.set(feedURL, FeedSettingsDatabase.rowFrom(row));
    }
    return result;
  }

  // MARK: - Typed setters

  async setString(value: string | undefined, feedURL: string,
    column: FeedSettingsColumn): Promise<void> {
    if (value === undefined) {
      await this.database.execute('UPDATE feedSettings SET ' + (column as string)
        + ' = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET ' + (column as string)
      + ' = ? WHERE feedURL = ?;', [value, feedURL]);
  }

  async setBool(value: boolean, feedURL: string, column: FeedSettingsColumn): Promise<void> {
    await this.database.execute('UPDATE feedSettings SET ' + (column as string)
      + ' = ? WHERE feedURL = ?;', [value, feedURL]);
  }

  async setInt(value: number | undefined, feedURL: string,
    column: FeedSettingsColumn): Promise<void> {
    if (value === undefined) {
      await this.database.execute('UPDATE feedSettings SET ' + (column as string)
        + ' = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET ' + (column as string)
      + ' = ? WHERE feedURL = ?;', [value, feedURL]);
  }

  async setDate(value: Date | undefined, feedURL: string,
    column: FeedSettingsColumn): Promise<void> {
    if (value === undefined) {
      await this.database.execute('UPDATE feedSettings SET ' + (column as string)
        + ' = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET ' + (column as string)
      + ' = ? WHERE feedURL = ?;', [toReferenceSeconds(value), feedURL]);
  }

  // MARK: - Compound types

  async setConditionalGetInfo(info: HTTPConditionalGetInfo | undefined,
    feedURL: string): Promise<void> {
    if (info === undefined) {
      await this.database.execute('UPDATE feedSettings SET conditionalGetInfoLastModified'
        + ' = NULL, conditionalGetInfoEtag = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET conditionalGetInfoLastModified = ?,'
      + ' conditionalGetInfoEtag = ? WHERE feedURL = ?;',
      [info.lastModified === undefined ? null : info.lastModified,
        info.etag === undefined ? null : info.etag, feedURL]);
  }

  async setCacheControlInfo(info: CacheControlInfo | undefined,
    feedURL: string): Promise<void> {
    if (info === undefined) {
      await this.database.execute('UPDATE feedSettings SET cacheControlInfoDateCreated = NULL,'
        + ' cacheControlInfoMaxAge = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET cacheControlInfoDateCreated = ?,'
      + ' cacheControlInfoMaxAge = ? WHERE feedURL = ?;',
      [toReferenceSeconds(info.dateCreated), info.maxAge, feedURL]);
  }

  async setAuthors(authors: Author[] | undefined, feedURL: string): Promise<void> {
    if (authors === undefined) {
      await this.database.execute(
        'UPDATE feedSettings SET authors = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    await this.database.execute('UPDATE feedSettings SET authors = ? WHERE feedURL = ?;',
      [authorsToJSON(authors), feedURL]);
  }

  async setFolderRelationship(relationship: Map<string, string> | undefined,
    feedURL: string): Promise<void> {
    if (relationship === undefined) {
      await this.database.execute(
        'UPDATE feedSettings SET folderRelationship = NULL WHERE feedURL = ?;', [feedURL]);
      return;
    }
    const plain: Record<string, string> = {};
    relationship.forEach((value: string, key: string) => {
      plain[key] = value;
    });
    await this.database.execute(
      'UPDATE feedSettings SET folderRelationship = ? WHERE feedURL = ?;',
      [JSON.stringify(plain), feedURL]);
  }

  // MARK: - Deletion

  async deleteSettings(feedURL: string): Promise<void> {
    await this.database.execute('DELETE FROM feedSettings WHERE feedURL = ?;', [feedURL]);
  }

  /** Startup cleanup: drop settings for feeds the account no longer subscribes to. */
  async deleteSettingsForFeedsNotIn(feedURLs: string[]): Promise<void> {
    if (feedURLs.length === 0) {
      return;
    }
    await this.database.execute('DELETE FROM feedSettings WHERE feedURL NOT IN '
      + Database.placeholders(feedURLs.length) + ';', feedURLs);
  }

  private static rowFrom(row: Row): FeedSettingsRow {
    const lastModified: string | undefined =
      row.getString(FeedSettingsColumn.conditionalGetInfoLastModified as string);
    const etag: string | undefined =
      row.getString(FeedSettingsColumn.conditionalGetInfoEtag as string);

    let conditionalGetInfoDate: Date | undefined = undefined;
    const conditionalGetInfoSeconds: number | undefined =
      row.getNumber(FeedSettingsColumn.conditionalGetInfoDate as string);
    if (conditionalGetInfoSeconds !== undefined) {
      conditionalGetInfoDate = fromReferenceSeconds(conditionalGetInfoSeconds);
    }

    let cacheControlInfo: CacheControlInfo | undefined = undefined;
    const cacheControlSeconds: number | undefined =
      row.getNumber(FeedSettingsColumn.cacheControlInfoDateCreated as string);
    const maxAge: number | undefined =
      row.getNumber(FeedSettingsColumn.cacheControlInfoMaxAge as string);
    if (cacheControlSeconds !== undefined && maxAge !== undefined) {
      cacheControlInfo = new CacheControlInfo(fromReferenceSeconds(cacheControlSeconds), maxAge);
    }

    let authors: Author[] | undefined = undefined;
    const authorsJSON: string | undefined = row.getString(FeedSettingsColumn.authors as string);
    if (authorsJSON !== undefined && authorsJSON.length > 0) {
      authors = authorsFromJSON(authorsJSON);
    }

    let folderRelationship: Map<string, string> | undefined = undefined;
    const folderJSON: string | undefined =
      row.getString(FeedSettingsColumn.folderRelationship as string);
    if (folderJSON !== undefined && folderJSON.length > 0) {
      try {
        const parsed: Record<string, Object> = JSON.parse(folderJSON) as Record<string, Object>;
        const map: Map<string, string> = new Map<string, string>();
        for (const key of Object.keys(parsed)) {
          const value: Object | undefined = parsed[key];
          if (typeof value === 'string') {
            map.set(key, value as string);
          }
        }
        folderRelationship = map;
      } catch (e) {
        folderRelationship = undefined;
      }
    }

    let lastCheckDate: Date | undefined = undefined;
    const lastCheckSeconds: number | undefined =
      row.getNumber(FeedSettingsColumn.lastCheckDate as string);
    if (lastCheckSeconds !== undefined) {
      lastCheckDate = fromReferenceSeconds(lastCheckSeconds);
    }

    const settingsRow: FeedSettingsRow = {
      feedID: row.getStringOrEmpty(FeedSettingsColumn.feedID as string),
      homePageURL: row.getString(FeedSettingsColumn.homePageURL as string),
      iconURL: row.getString(FeedSettingsColumn.iconURL as string),
      faviconURL: row.getString(FeedSettingsColumn.faviconURL as string),
      editedName: row.getString(FeedSettingsColumn.editedName as string),
      contentHash: row.getString(FeedSettingsColumn.contentHash as string),
      newArticleNotificationsEnabled:
        row.getBoolean(FeedSettingsColumn.newArticleNotificationsEnabled as string),
      readerViewAlwaysEnabled:
        row.getBoolean(FeedSettingsColumn.readerViewAlwaysEnabled as string),
      authors: authors,
      conditionalGetInfo: makeConditionalGetInfo(lastModified, etag),
      conditionalGetInfoDate: conditionalGetInfoDate,
      cacheControlInfo: cacheControlInfo,
      externalID: row.getString(FeedSettingsColumn.externalID as string),
      folderRelationship: folderRelationship,
      lastCheckDate: lastCheckDate,
      lastResponseCode: row.getNumber(FeedSettingsColumn.lastResponseCode as string)
    };
    return settingsRow;
  }
}
