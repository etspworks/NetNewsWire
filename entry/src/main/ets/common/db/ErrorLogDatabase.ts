/**
 * ErrorLogDatabase — port of Modules/ErrorLog/Sources/ErrorLog/{ErrorLogDatabase,
 * ErrorLogTable,ErrorLogNotification}.swift over relationalStore.
 *
 * Every error path in the app writes here; the Error Log screen reads it. The table is
 * pruned to the 200 most recent rows at startup, exactly as the source does.
 *
 * The source posts an `.appDidEncounterError` notification that the database observes;
 * HarmonyOS has no NotificationCenter, so `logError` IS the entry point and callers call
 * it directly.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { ErrorLogEntry, ErrorLogEntryKeys } from '../../model/ErrorLogEntry';
import { Database, Row, ValuesBucket } from './Database';

const DOMAIN: number = 0x0001;
const TAG: string = 'ErrorLogDatabase';

const TABLE_NAME: string = 'errors';
const PRUNE_LIMIT: number = 200;

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE if not EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, date REAL NOT NULL,'
    + ' sourceName TEXT NOT NULL, sourceID INTEGER NOT NULL, operation TEXT NOT NULL DEFAULT \'\','
    + ' fileName TEXT NOT NULL DEFAULT \'\', functionName TEXT NOT NULL DEFAULT \'\','
    + ' lineNumber INTEGER NOT NULL DEFAULT 0, errorMessage TEXT NOT NULL);'
];

export class ErrorLogDatabase {
  static readonly shared: ErrorLogDatabase = new ErrorLogDatabase();

  private readonly database: Database = new Database('ErrorLog.sqlite3');

  /** Opens the store, prunes to the 200 most recent entries and vacuums. */
  async open(): Promise<void> {
    if (this.database.isOpen()) {
      return;
    }
    await this.database.open(CREATE_STATEMENTS);
    await this.pruneEntries(PRUNE_LIMIT);
    await this.database.vacuum();
  }

  async vacuum(): Promise<void> {
    await this.database.vacuum();
  }

  /**
   * The `.appDidEncounterError` entry point. Never throws — an error while logging an
   * error must not take a caller down.
   */
  async addEntry(sourceName: string, sourceID: number, operation: string, fileName: string,
    functionName: string, lineNumber: number, errorMessage: string): Promise<void> {
    try {
      if (!this.database.isOpen()) {
        await this.open();
      }
      const row: ValuesBucket = {
        'date': Date.now() / 1000,
        'sourceName': sourceName,
        'sourceID': sourceID,
        'operation': operation,
        'fileName': fileName,
        'functionName': functionName,
        'lineNumber': lineNumber,
        'errorMessage': errorMessage
      };
      await this.database.insert(TABLE_NAME, row);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'addEntry failed: %{public}s', String(e));
    }
  }

  /** Convenience for the common call: source, operation and the error itself. */
  async logError(sourceName: string, sourceID: number, operation: string,
    error: Error | string, fileName: string = '', functionName: string = '',
    lineNumber: number = 0): Promise<void> {
    const message: string = typeof error === 'string' ? error as string : (error as Error).message;
    await this.addEntry(sourceName, sourceID, operation, fileName, functionName, lineNumber,
      message);
  }

  /** Every entry, oldest first — the order the Error Log screen shows. */
  async allEntries(): Promise<ErrorLogEntry[]> {
    if (!this.database.isOpen()) {
      await this.open();
    }
    const rows: Row[] = await this.database.query(
      'select * from ' + TABLE_NAME + ' order by id asc');
    const entries: ErrorLogEntry[] = [];
    for (const row of rows) {
      const sourceName: string | undefined = row.getString(ErrorLogEntryKeys.sourceName);
      const errorMessage: string | undefined = row.getString(ErrorLogEntryKeys.errorMessage);
      if (sourceName === undefined || errorMessage === undefined) {
        continue;
      }
      const dateValue: Date | undefined = row.getDate(ErrorLogEntryKeys.date);
      const entry: ErrorLogEntry = {
        id: row.getNumberOrZero(ErrorLogEntryKeys.id),
        date: dateValue === undefined ? new Date(0) : dateValue,
        sourceName: sourceName,
        sourceID: row.getNumberOrZero(ErrorLogEntryKeys.sourceID),
        operation: row.getStringOrEmpty(ErrorLogEntryKeys.operation),
        fileName: row.getStringOrEmpty(ErrorLogEntryKeys.fileName),
        functionName: row.getStringOrEmpty(ErrorLogEntryKeys.functionName),
        lineNumber: row.getNumberOrZero(ErrorLogEntryKeys.lineNumber),
        errorMessage: errorMessage
      };
      entries.push(entry);
    }
    return entries;
  }

  async deleteAllEntries(): Promise<void> {
    await this.database.execute('delete from ' + TABLE_NAME + ';');
  }

  private async pruneEntries(limit: number): Promise<void> {
    await this.database.execute('delete from ' + TABLE_NAME + ' where id not in'
      + ' (select id from ' + TABLE_NAME + ' order by id desc limit ' + limit + ')');
  }
}

/** Source IDs: 0-99 are AccountType raw values, 100 and up are other components. */
export class ErrorLogSourceID {
  static readonly credentialsManager: number = 100;
  static readonly feedFinder: number = 101;
  static readonly htmlMetadataDownloader: number = 102;
  static readonly imageDownloader: number = 103;
  static readonly articlesDatabase: number = 104;
  static readonly opml: number = 105;
  static readonly articleExtractor: number = 106;
  static readonly themes: number = 107;
}
