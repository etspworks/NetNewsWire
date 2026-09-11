/**
 * SyncDatabase — port of Modules/SyncDatabase/Sources/SyncDatabase/{SyncDatabase,
 * SyncStatusTable,Constants}.swift over relationalStore.
 *
 * The queue of status changes waiting to be sent upstream, with the claim/commit/reset
 * protocol the delegates depend on:
 *   selectForProcessing  claims rows (selected = true) — SELECT first, then mark only the
 *                        rows actually returned, so rows past the limit are not flagged
 *                        in-flight (a nil-key delete would otherwise drop an unsent status)
 *   deleteSelectedForProcessing  on a successful send
 *   resetSelectedForProcessing   on a failed send
 *   resetAllSelectedForProcessing at delegate init
 *
 * NewsBlur points its SyncDatabase at DB.sqlite3, sharing the file with ArticlesDatabase
 * (NewsBlurAccountDelegate.swift:52). That is a real quirk of the app — the constructor
 * takes the file name so the caller can reproduce it.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { SyncStatus, SyncStatusKey, makeSyncStatus } from '../../model/SyncStatus';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Database, Row, ValuesBucket } from './Database';

const DOMAIN: number = 0x0001;
const TAG: string = 'SyncDatabase';

const TABLE_NAME: string = 'syncStatus';

export class SyncDatabaseKey {
  static readonly articleID: string = 'articleID';
  static readonly key: string = 'key';
  static readonly flag: string = 'flag';
  static readonly selected: string = 'selected';
}

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE if not EXISTS syncStatus (articleID TEXT NOT NULL, key TEXT NOT NULL,'
    + ' flag BOOL NOT NULL DEFAULT 0, selected BOOL NOT NULL DEFAULT 0,'
    + ' PRIMARY KEY (articleID, key));'
];

function syncStatusFromRow(row: Row): SyncStatus | undefined {
  const articleID: string | undefined = row.getString(SyncDatabaseKey.articleID);
  const rawKey: string | undefined = row.getString(SyncDatabaseKey.key);
  if (articleID === undefined || rawKey === undefined) {
    return undefined;
  }
  if (rawKey !== SyncStatusKey.read && rawKey !== SyncStatusKey.starred
    && rawKey !== SyncStatusKey.deleted && rawKey !== SyncStatusKey.new) {
    return undefined;
  }
  return makeSyncStatus(articleID, rawKey as SyncStatusKey,
    row.getBoolean(SyncDatabaseKey.flag), row.getBoolean(SyncDatabaseKey.selected));
}

export class SyncDatabase {
  readonly databasePath: string;
  private readonly database: Database;

  /** NewsBlur passes 'DB.sqlite3' here, sharing the file with ArticlesDatabase. */
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

  async insertStatuses(statuses: SyncStatus[]): Promise<void> {
    if (statuses.length === 0) {
      return;
    }
    const rows: ValuesBucket[] = [];
    for (const status of statuses) {
      const row: ValuesBucket = {
        'articleID': status.articleID,
        'key': status.key as string,
        'flag': status.flag,
        'selected': status.selected
      };
      rows.push(row);
    }
    await this.database.insertRows(TABLE_NAME, rows, true);
  }

  /**
   * Claims up to `limit` queued statuses. Selects first, then marks exactly the rows being
   * returned — marking every row would flag rows past the limit as in-flight.
   */
  async selectForProcessing(limit?: number): Promise<SyncStatus[]> {
    let sql: string = 'select * from ' + TABLE_NAME;
    if (limit !== undefined) {
      sql += ' limit ' + limit;
    }

    let statuses: SyncStatus[] = [];
    try {
      await this.database.inTransaction(async () => {
        const rows: Row[] = await this.database.query(sql);
        for (const row of rows) {
          const status: SyncStatus | undefined = syncStatusFromRow(row);
          if (status !== undefined) {
            statuses.push(status);
          }
        }
        if (statuses.length === 0) {
          return;
        }
        // An articleID can have both a read row and a starred row, so match on the pair.
        const conditions: string[] = [];
        const parameters: string[] = [];
        for (const status of statuses) {
          conditions.push('(articleID = ? and key = ?)');
          parameters.push(status.articleID);
          parameters.push(status.key as string);
        }
        await this.database.execute('update ' + TABLE_NAME + ' set selected = 1 where '
          + conditions.join(' or '), parameters);
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'selectForProcessing failed: %{public}s', String(e));
      return [];
    }

    const claimed: SyncStatus[] = [];
    for (const status of statuses) {
      claimed.push(makeSyncStatus(status.articleID, status.key, status.flag, true));
    }
    return claimed;
  }

  async selectPendingCount(): Promise<number> {
    return await this.database.count('select count(*) from ' + TABLE_NAME);
  }

  async selectPendingReadStatusArticleIDs(): Promise<string[]> {
    return await this.selectPendingArticleIDs(ArticleStatusKey.read);
  }

  async selectPendingStarredStatusArticleIDs(): Promise<string[]> {
    return await this.selectPendingArticleIDs(ArticleStatusKey.starred);
  }

  async resetAllSelectedForProcessing(): Promise<void> {
    await this.database.execute('update ' + TABLE_NAME + ' set selected = 0');
  }

  /**
   * Pass `key` when sending one status kind at a time. An undefined key matches all kinds —
   * correct only when every queued kind for these articleIDs was sent together.
   */
  async resetSelectedForProcessing(articleIDs: string[], key?: SyncStatusKey): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    const parameters: string[] = articleIDs.slice();
    let sql: string = 'update ' + TABLE_NAME + ' set selected = 0 where articleID in '
      + Database.placeholders(articleIDs.length);
    if (key !== undefined) {
      sql += ' and key = ?';
      parameters.push(key as string);
    }
    await this.database.execute(sql, parameters);
  }

  async deleteSelectedForProcessing(articleIDs: string[], key?: SyncStatusKey): Promise<void> {
    if (articleIDs.length === 0) {
      return;
    }
    const parameters: string[] = articleIDs.slice();
    let sql: string = 'delete from ' + TABLE_NAME + ' where selected = 1 and articleID in '
      + Database.placeholders(articleIDs.length);
    if (key !== undefined) {
      sql += ' and key = ?';
      parameters.push(key as string);
    }
    await this.database.execute(sql, parameters);
  }

  /**
   * Includes rows that are selected — a send in flight hasn't been confirmed by the server
   * yet, and skipping those let a concurrent refresh revert the change the send carried.
   * <https://github.com/Ranchero-Software/NetNewsWire/issues/4280>
   */
  private async selectPendingArticleIDs(statusKey: ArticleStatusKey): Promise<string[]> {
    const rows: Row[] = await this.database.query(
      'select articleID from ' + TABLE_NAME + ' where key = ?;', [statusKey as string]);
    const articleIDs: string[] = [];
    for (const row of rows) {
      const articleID: string | undefined = row.getString(SyncDatabaseKey.articleID);
      if (articleID !== undefined) {
        articleIDs.push(articleID);
      }
    }
    return articleIDs;
  }
}
