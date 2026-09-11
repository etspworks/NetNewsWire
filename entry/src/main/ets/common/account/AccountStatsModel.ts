/**
 * AccountStatsModel — port of Shared/AccountStats/AccountStatsViewModel.swift
 *
 * Per-account counts (feeds, folders, articles, statuses, unread, starred) plus the
 * on-disk size of that account's three databases, and the VACUUM maintenance call the
 * screen's second button runs.
 */

import { ArticleCounts } from '../db/ArticlesDatabase';
import { AccountService } from './Account';
import { AccountManager } from './AccountManager';

/** One row of the Account Stats screen. */
export class AccountStatsRowData {
  readonly accountID: string;
  readonly name: string;
  readonly typeName: string;
  readonly isActive: boolean;
  readonly feedCount: number;
  readonly folderCount: number;
  readonly articleCount: number;
  readonly statusesCount: number;
  readonly unreadCount: number;
  readonly starredCount: number;
  readonly databaseSizeBytes: number;

  constructor(accountID: string, name: string, typeName: string, isActive: boolean,
    feedCount: number, folderCount: number, articleCount: number, statusesCount: number,
    unreadCount: number, starredCount: number, databaseSizeBytes: number) {
    this.accountID = accountID;
    this.name = name;
    this.typeName = typeName;
    this.isActive = isActive;
    this.feedCount = feedCount;
    this.folderCount = folderCount;
    this.articleCount = articleCount;
    this.statusesCount = statusesCount;
    this.unreadCount = unreadCount;
    this.starredCount = starredCount;
    this.databaseSizeBytes = databaseSizeBytes;
  }
}

/** The Totals section — present only when there is more than one account. */
export class AccountStatsTotals {
  readonly feedCount: number;
  readonly folderCount: number;
  readonly articleCount: number;
  readonly statusesCount: number;
  readonly unreadCount: number;
  readonly starredCount: number;
  readonly databaseSizeBytes: number;

  constructor(rows: AccountStatsRowData[]) {
    let feedCount: number = 0;
    let folderCount: number = 0;
    let articleCount: number = 0;
    let statusesCount: number = 0;
    let unreadCount: number = 0;
    let starredCount: number = 0;
    let databaseSizeBytes: number = 0;
    for (const row of rows) {
      feedCount += row.feedCount;
      folderCount += row.folderCount;
      articleCount += row.articleCount;
      statusesCount += row.statusesCount;
      unreadCount += row.unreadCount;
      starredCount += row.starredCount;
      databaseSizeBytes += row.databaseSizeBytes;
    }
    this.feedCount = feedCount;
    this.folderCount = folderCount;
    this.articleCount = articleCount;
    this.statusesCount = statusesCount;
    this.unreadCount = unreadCount;
    this.starredCount = starredCount;
    this.databaseSizeBytes = databaseSizeBytes;
  }
}

export enum AccountStatsSortKey {
  name = 'name',
  databaseSizeBytes = 'databaseSizeBytes',
  feedCount = 'feedCount',
  folderCount = 'folderCount',
  articleCount = 'articleCount',
  statusesCount = 'statusesCount',
  unreadCount = 'unreadCount',
  starredCount = 'starredCount'
}

export class AccountStatsModel {
  sortedAccountStats: AccountStatsRowData[] = [];
  totals: AccountStatsTotals = new AccountStatsTotals([]);
  sortKey: AccountStatsSortKey = AccountStatsSortKey.name;
  sortAscending: boolean = true;

  /** Re-queries every account's database sizes and row counts. */
  async refresh(): Promise<void> {
    // A deep-linked screen reaches aboutToAppear before the ability's bootstrap has opened
    // the accounts; start() hands back the in-flight run, so this waits instead of
    // reading an empty account list and rendering nothing.
    await AccountManager.shared.start();
    const rows: AccountStatsRowData[] = [];
    for (const account of AccountManager.shared.sortedAccounts) {
      const counts: ArticleCounts = await account.fetchArticleCounts();
      rows.push(new AccountStatsRowData(
        account.accountID,
        account.nameForDisplay,
        account.typeDisplayName,
        account.isActive,
        account.flattenedFeeds().length,
        account.folders().length,
        counts.totalCount,
        counts.statusesCount,
        counts.unreadCount,
        counts.starredCount,
        account.databaseSizeBytes()
      ));
    }
    this.totals = new AccountStatsTotals(rows);
    this.sortedAccountStats = rows;
    this.applySort();
  }

  sortBy(key: AccountStatsSortKey, ascending: boolean): void {
    this.sortKey = key;
    this.sortAscending = ascending;
    this.applySort();
  }

  applySort(): void {
    const ascending: boolean = this.sortAscending;
    const key: AccountStatsSortKey = this.sortKey;
    this.sortedAccountStats.sort((a: AccountStatsRowData, b: AccountStatsRowData): number => {
      const result: number = key === AccountStatsSortKey.name
        ? a.name.localeCompare(b.name)
        : AccountStatsModel.valueFor(a, key) - AccountStatsModel.valueFor(b, key);
      return ascending ? result : -result;
    });
  }

  private static valueFor(row: AccountStatsRowData, key: AccountStatsSortKey): number {
    if (key === AccountStatsSortKey.databaseSizeBytes) {
      return row.databaseSizeBytes;
    }
    if (key === AccountStatsSortKey.feedCount) {
      return row.feedCount;
    }
    if (key === AccountStatsSortKey.folderCount) {
      return row.folderCount;
    }
    if (key === AccountStatsSortKey.articleCount) {
      return row.articleCount;
    }
    if (key === AccountStatsSortKey.statusesCount) {
      return row.statusesCount;
    }
    if (key === AccountStatsSortKey.unreadCount) {
      return row.unreadCount;
    }
    return row.starredCount;
  }

  /** The Vacuum Databases button: SQLite VACUUM on every account database, then refresh. */
  async vacuumAllDatabases(): Promise<void> {
    await AccountManager.shared.vacuumAccountDatabases();
    await this.refresh();
  }

  /** The Databases row's value, formatted as the screen shows it. */
  static formattedByteCount(bytes: number): string {
    if (bytes < 1024) {
      return bytes + ' bytes';
    }
    const units: string[] = ['KB', 'MB', 'GB', 'TB'];
    let value: number = bytes / 1024;
    let unitIndex: number = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value = value / 1024;
      unitIndex += 1;
    }
    return value.toFixed(1) + ' ' + units[unitIndex];
  }

  accountFor(accountID: string): AccountService | undefined {
    return AccountManager.shared.existingAccount(accountID);
  }
}
