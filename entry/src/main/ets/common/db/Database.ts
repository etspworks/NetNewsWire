/**
 * Database — the small relationalStore wrapper the six databases share.
 *
 * Replaces RSDatabase's FMDatabase/DatabaseQueue: open a store, run create statements,
 * query rows, insert-or-replace, run in a transaction, vacuum. The one rule the source
 * enforces everywhere and this enforces here: a ResultSet is ALWAYS closed in `finally`.
 */

import { relationalStore } from '@kit.ArkData';
import { AppContext } from '../util/AppContext';

/** Re-exported so the table modules never import relationalStore directly. */
export type ValueType = relationalStore.ValueType;
export type ValuesBucket = relationalStore.ValuesBucket;

/** A row read out of a ResultSet, by column name. */
export class Row {
  private readonly values: Map<string, relationalStore.ValueType> =
    new Map<string, relationalStore.ValueType>();

  set(column: string, value: relationalStore.ValueType): void {
    this.values.set(column, value);
  }

  isNull(column: string): boolean {
    const value: relationalStore.ValueType | undefined = this.values.get(column);
    return value === undefined || value === null;
  }

  getString(column: string): string | undefined {
    const value: relationalStore.ValueType | undefined = this.values.get(column);
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value as string;
    }
    if (typeof value === 'number') {
      return (value as number).toString();
    }
    return undefined;
  }

  getStringOrEmpty(column: string): string {
    const value: string | undefined = this.getString(column);
    return value === undefined ? '' : value;
  }

  getNumber(column: string): number | undefined {
    const value: relationalStore.ValueType | undefined = this.values.get(column);
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === 'number') {
      return value as number;
    }
    if (typeof value === 'string') {
      const parsed: number = Number.parseFloat(value as string);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    if (typeof value === 'boolean') {
      return (value as boolean) ? 1 : 0;
    }
    return undefined;
  }

  getNumberOrZero(column: string): number {
    const value: number | undefined = this.getNumber(column);
    return value === undefined ? 0 : value;
  }

  getBoolean(column: string): boolean {
    const value: number | undefined = this.getNumber(column);
    return value !== undefined && value !== 0;
  }

  /** Column stored as a Unix-epoch seconds double, as every RSDatabase date column is. */
  getDate(column: string): Date | undefined {
    const seconds: number | undefined = this.getNumber(column);
    return seconds === undefined ? undefined : new Date(seconds * 1000);
  }
}

export class Database {
  readonly databasePath: string;
  private store?: relationalStore.RdbStore;

  constructor(databaseFileName: string) {
    this.databasePath = databaseFileName;
  }

  /** The bare file name — what `StoreConfig.name` accepts. */
  private static fileNameOf(path: string): string {
    const cut: number = path.lastIndexOf('/');
    return cut < 0 ? path : path.substring(cut + 1);
  }

  /**
   * The caller's folder as a path relative to the context's database dir, or '' when the
   * caller passed a bare file name. Callers build absolute folders from
   * `AppContext.dataSubfolder(...)`, i.e. under filesDir, so that prefix is stripped; a
   * leading '/' is dropped either way, since `customDir` must be relative.
   */
  private static customDirOf(path: string): string {
    const cut: number = path.lastIndexOf('/');
    if (cut < 0) {
      return '';
    }
    let dir: string = path.substring(0, cut);
    const filesDir: string = AppContext.dataFolder();
    if (dir.startsWith(filesDir)) {
      dir = dir.substring(filesDir.length);
    }
    while (dir.startsWith('/')) {
      dir = dir.substring(1);
    }
    return dir;
  }

  /**
   * The folder the store's FILES actually land in. relationalStore does not write to the
   * caller's path: a store opened with `customDir` lives under `<databaseDir>/rdb/<customDir>`.
   * Anything that stats a database on disk (Account Stats' Databases row) must look here,
   * not at the path handed to the constructor.
   */
  static storeFolder(databasePath: string): string {
    const base: string = AppContext.get().databaseDir + '/rdb';
    const dir: string = Database.customDirOf(databasePath);
    return dir.length > 0 ? base + '/' + dir : base;
  }

  /** Opens the store and runs the create statements. Safe to call more than once. */
  async open(createStatements: string[]): Promise<void> {
    if (this.store !== undefined) {
      return;
    }
    // relationalStore rejects a path in `name` ("The StoreConfig.name must be a file name
    // without path"), so a caller's folder goes to `customDir` instead — the directory
    // RELATIVE to the context's database dir. Keeping it is not cosmetic: every account
    // builds its own dataFolder, and collapsing to the bare file name would put every
    // account's articles in ONE store. Callers that pass a bare name are unaffected.
    const config: relationalStore.StoreConfig = {
      name: Database.fileNameOf(this.databasePath),
      securityLevel: relationalStore.SecurityLevel.S1
    };
    const relativeDir: string = Database.customDirOf(this.databasePath);
    if (relativeDir.length > 0) {
      config.customDir = relativeDir;
    }
    this.store = await relationalStore.getRdbStore(AppContext.get(), config);
    for (const statement of createStatements) {
      await this.execute(statement);
    }
  }

  isOpen(): boolean {
    return this.store !== undefined;
  }

  private requireStore(): relationalStore.RdbStore {
    const store: relationalStore.RdbStore | undefined = this.store;
    if (store === undefined) {
      throw new Error('Database ' + this.databasePath + ' is not open');
    }
    return store;
  }

  /** DDL / DML. Never throws — a failed statement is logged by the caller's catch. */
  async execute(sql: string, args?: relationalStore.ValueType[]): Promise<void> {
    await this.requireStore().executeSql(sql, args === undefined ? [] : args);
  }

  /** SELECT returning every row, with the ResultSet closed in `finally`. */
  async query(sql: string, args?: relationalStore.ValueType[]): Promise<Row[]> {
    const resultSet: relationalStore.ResultSet =
      await this.requireStore().querySql(sql, args === undefined ? [] : args);
    const rows: Row[] = [];
    try {
      const columnNames: string[] = resultSet.columnNames;
      while (resultSet.goToNextRow()) {
        const row: Row = new Row();
        for (const columnName of columnNames) {
          const index: number = resultSet.getColumnIndex(columnName);
          if (index < 0) {
            continue;
          }
          row.set(columnName, resultSet.isColumnNull(index)
            ? null
            : resultSet.getValue(index));
        }
        rows.push(row);
      }
    } finally {
      resultSet.close();
    }
    return rows;
  }

  /** `select count(*) …` — returns 0 when the query produced no row. */
  async count(sql: string, args?: relationalStore.ValueType[]): Promise<number> {
    const resultSet: relationalStore.ResultSet =
      await this.requireStore().querySql(sql, args === undefined ? [] : args);
    try {
      if (!resultSet.goToNextRow()) {
        return 0;
      }
      return resultSet.getLong(0);
    } finally {
      resultSet.close();
    }
  }

  async insert(table: string, values: relationalStore.ValuesBucket,
    replaceOnConflict: boolean = false): Promise<number> {
    return await this.requireStore().insert(table, values, replaceOnConflict
      ? relationalStore.ConflictResolution.ON_CONFLICT_REPLACE
      : relationalStore.ConflictResolution.ON_CONFLICT_NONE);
  }

  async insertRows(table: string, rows: relationalStore.ValuesBucket[],
    replaceOnConflict: boolean = false): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const store: relationalStore.RdbStore = this.requireStore();
    store.beginTransaction();
    try {
      for (const row of rows) {
        await store.insert(table, row, replaceOnConflict
          ? relationalStore.ConflictResolution.ON_CONFLICT_REPLACE
          : relationalStore.ConflictResolution.ON_CONFLICT_NONE);
      }
      store.commit();
    } catch (e) {
      store.rollBack();
      throw e as Error;
    }
  }

  /** Runs `work` inside one transaction, rolling back on any error. */
  async inTransaction(work: () => Promise<void>): Promise<void> {
    const store: relationalStore.RdbStore = this.requireStore();
    store.beginTransaction();
    try {
      await work();
      store.commit();
    } catch (e) {
      store.rollBack();
      throw e as Error;
    }
  }

  /** `(?, ?, ?)` for `count` placeholders — RSDatabase's rs_SQLValueList. */
  static placeholders(count: number): string {
    if (count < 1) {
      return '()';
    }
    let s: string = '(';
    for (let i: number = 0; i < count; i++) {
      s += i === 0 ? '?' : ', ?';
    }
    return s + ')';
  }

  async vacuum(): Promise<void> {
    await this.execute('VACUUM;');
  }

  async close(): Promise<void> {
    const store: relationalStore.RdbStore | undefined = this.store;
    if (store === undefined) {
      return;
    }
    try {
      await store.close();
    } finally {
      this.store = undefined;
    }
  }
}
