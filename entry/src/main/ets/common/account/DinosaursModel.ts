/**
 * DinosaursModel — port of Shared/Dinosaurs/DinosaursViewModel.swift
 *
 * The stale-feed query: every feed across the ACTIVE accounts whose newest article is
 * older than now minus `monthThreshold` months (default 6), sorted with a feed-URL
 * tiebreaker, plus the multi-container delete and its restore (the undo path).
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Feed } from '../../model/Feed';
import { AccountService, ContainerRef } from './Account';
import { AccountManager } from './AccountManager';

const DOMAIN: number = 0x0001;
const TAG: string = 'Dinosaurs';

export enum DinosaurSortKey {
  feedName = 'feedName',
  feedURL = 'feedURL',
  accountName = 'accountName',
  lastArticleDate = 'lastArticleDate',
  lastResponseCode = 'lastResponseCode'
}

export class DinosaurRow {
  readonly id: string;
  readonly feed: Feed;
  readonly account: AccountService;
  readonly accountName: string;
  readonly feedName: string;
  readonly feedURL: string;
  readonly lastArticleDate?: Date;
  readonly lastResponseCode?: number;

  constructor(feed: Feed, account: AccountService, lastArticleDate?: Date,
    lastResponseCode?: number) {
    this.id = feed.url + account.accountID;
    this.feed = feed;
    this.account = account;
    this.accountName = account.nameForDisplay;
    this.feedName = feed.nameForDisplay;
    this.feedURL = feed.url;
    this.lastArticleDate = lastArticleDate;
    this.lastResponseCode = lastResponseCode;
  }
}

/** One feed's removal, with every container it was in — enough to restore it. */
export class DinosaurDeletion {
  readonly feed: Feed;
  readonly account: AccountService;
  readonly containers: ContainerRef[];

  constructor(feed: Feed, account: AccountService, containers: ContainerRef[]) {
    this.feed = feed;
    this.account = account;
    this.containers = containers;
  }
}

export class DinosaursModel {
  rows: DinosaurRow[] = [];
  showAccountColumn: boolean = false;
  /** The staleness picker: 3 / 6 / 12 / 24 months, default 6. */
  monthThreshold: number = 6;

  private sortKey: DinosaurSortKey = DinosaurSortKey.feedName;
  private sortAscending: boolean = true;

  async refresh(): Promise<void> {
    const accounts: AccountService[] = AccountManager.shared.activeAccounts;
    const cutoff: Date = new Date();
    cutoff.setMonth(cutoff.getMonth() - this.monthThreshold);

    const newRows: DinosaurRow[] = [];
    for (const account of accounts) {
      const latestDates: Map<string, Date> = await account.fetchLastUpdateDates();
      for (const feed of account.flattenedFeeds()) {
        const latestDate: Date | undefined = latestDates.get(feed.feedID);
        // A feed with no articles at all is not a dinosaur, as in the source.
        if (latestDate === undefined || latestDate.getTime() >= cutoff.getTime()) {
          continue;
        }
        newRows.push(new DinosaurRow(feed, account, latestDate, feed.lastResponseCode));
      }
    }

    this.rows = newRows;
    this.showAccountColumn = accounts.length > 1;
    this.applySort();
    hilog.info(DOMAIN, TAG, 'refresh: %{public}d rows', this.rows.length);
  }

  clear(): void {
    this.rows = [];
  }

  sortBy(key: DinosaurSortKey, ascending: boolean): void {
    this.sortKey = key;
    this.sortAscending = ascending;
    this.applySort();
  }

  private applySort(): void {
    const ascending: boolean = this.sortAscending;
    const key: DinosaurSortKey = this.sortKey;
    this.rows.sort((a: DinosaurRow, b: DinosaurRow): number => {
      let result: number = DinosaursModel.compare(a, b, key);
      if (result === 0) {
        result = a.feedURL.localeCompare(b.feedURL);
      }
      return ascending ? result : -result;
    });
  }

  private static compare(a: DinosaurRow, b: DinosaurRow, key: DinosaurSortKey): number {
    if (key === DinosaurSortKey.feedURL) {
      return a.feedURL.localeCompare(b.feedURL);
    }
    if (key === DinosaurSortKey.accountName) {
      return a.accountName.localeCompare(b.accountName);
    }
    if (key === DinosaurSortKey.lastArticleDate) {
      const aTime: number = a.lastArticleDate === undefined ? 0 : a.lastArticleDate.getTime();
      const bTime: number = b.lastArticleDate === undefined ? 0 : b.lastArticleDate.getTime();
      return aTime - bTime;
    }
    if (key === DinosaurSortKey.lastResponseCode) {
      const aCode: number = a.lastResponseCode === undefined ? 0 : a.lastResponseCode;
      const bCode: number = b.lastResponseCode === undefined ? 0 : b.lastResponseCode;
      return aCode - bCode;
    }
    return a.feedName.localeCompare(b.feedName);
  }

  /** Deletes the feeds at the given row indexes, returning what to restore on undo. */
  async deleteFeeds(indexes: number[]): Promise<DinosaurDeletion[]> {
    const deletions: DinosaurDeletion[] = [];
    for (const index of indexes) {
      if (index < 0 || index >= this.rows.length) {
        continue;
      }
      const row: DinosaurRow = this.rows[index];
      deletions.push(new DinosaurDeletion(row.feed, row.account,
        row.account.existingContainersWithFeed(row.feed)));
    }
    await this.performDeletions(deletions);
    return deletions;
  }

  async performDeletions(deletions: DinosaurDeletion[]): Promise<void> {
    for (const deletion of deletions) {
      for (const container of deletion.containers) {
        try {
          await deletion.account.removeFeed(deletion.feed, container);
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'removeFeed failed: %{public}s', String(e));
        }
      }
    }
  }

  async performRestorations(deletions: DinosaurDeletion[]): Promise<void> {
    for (const deletion of deletions) {
      for (const container of deletion.containers) {
        try {
          await deletion.account.restoreFeed(deletion.feed, container);
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'restoreFeed failed: %{public}s', String(e));
        }
      }
    }
  }
}
