/**
 * SmartFeedsController — port of Shared/SmartFeeds/{SmartFeedsController,SmartFeedDelegate,
 * UnreadFeed,TodayFeedDelegate,StarredFeedDelegate,SearchFeedDelegate,
 * SearchTimelineFeedDelegate}.swift
 *
 * Section 0 of the sidebar: Today / All Unread / Starred. Their unread counts are
 * recomputed on any unread-count change, on app activation and on a day change (Today's
 * cutoff moves at midnight), plus the two search-backed smart feeds the search field makes.
 *
 * The sidebarItemID strings are String(describing:) of the Swift delegate types and must
 * not change: state restoration reads them.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { ContainerIdentifier } from '../../model/ContainerIdentifier';
import { FetchType } from '../../model/FetchType';
import { IconImage } from '../../model/IconImage';
import { ReadFilterType, SidebarItemIdentifier, SidebarItemIdentifierType }
  from '../../model/SidebarItemIdentifier';
import { SmartFeed } from '../../model/SmartFeed';
import { AccountService } from './Account';
import { AccountManager } from './AccountManager';

const DOMAIN: number = 0x0001;
const TAG: string = 'SmartFeedsController';

export const searchFeedIdentifier: string = 'SearchFeedDelegate';
export const searchTimelineFeedIdentifier: string = 'SearchTimelineFeedDelegate';
const searchNamePrefix: string = 'Search: ';

export type SmartFeedsChangeListener = () => void;

export class SmartFeedsController {
  static readonly shared: SmartFeedsController = new SmartFeedsController();

  readonly containerID: ContainerIdentifier = ContainerIdentifier.smartFeedController();
  readonly nameForDisplay: string = 'Smart Feeds';

  readonly todayFeed: SmartFeed = SmartFeed.todayFeed();
  readonly unreadFeed: SmartFeed = SmartFeed.unreadFeed();
  readonly starredFeed: SmartFeed = SmartFeed.starredFeed();
  readonly smartFeeds: SmartFeed[] = [this.todayFeed, this.unreadFeed, this.starredFeed];

  private listeners: SmartFeedsChangeListener[] = [];
  private lastRefreshDay: number = -1;

  addListener(listener: SmartFeedsChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: SmartFeedsChangeListener): void {
    this.listeners = this.listeners.filter((l: SmartFeedsChangeListener) => l !== listener);
  }

  find(sidebarItemID: SidebarItemIdentifier): SmartFeed | undefined {
    if (sidebarItemID.type !== SidebarItemIdentifierType.smartFeed) {
      return undefined;
    }
    for (const smartFeed of this.smartFeeds) {
      if (smartFeed.sidebarItemID.id === sidebarItemID.id) {
        return smartFeed;
      }
    }
    return undefined;
  }

  /**
   * Recomputes all three counts across the active accounts. Call on an unread-count
   * change, on app activation, and on a day change.
   */
  async refreshUnreadCounts(): Promise<void> {
    const manager: AccountManager = AccountManager.shared;
    let unread: number = 0;
    let today: number = 0;
    let starred: number = 0;

    for (const account of manager.activeAccounts) {
      unread += account.unreadCount;
      today += await account.fetchUnreadCountForToday();
      starred += await account.fetchUnreadCountForStarredArticles();
    }

    const changed: boolean = this.unreadFeed.unreadCount !== unread
      || this.todayFeed.unreadCount !== today
      || this.starredFeed.unreadCount !== starred;

    this.unreadFeed.unreadCount = unread;
    this.todayFeed.unreadCount = today;
    this.starredFeed.unreadCount = starred;
    this.lastRefreshDay = new Date().getDate();

    if (changed) {
      this.postDidChange();
    }
  }

  /** Today's cutoff moves at midnight, so the counts have to be recomputed then. */
  async refreshIfDayChanged(): Promise<void> {
    const today: number = new Date().getDate();
    if (today !== this.lastRefreshDay) {
      hilog.debug(DOMAIN, TAG, 'day changed — recomputing smart feed counts');
      await this.refreshUnreadCounts();
    }
  }

  /** The search field's smart feed: every article matching the string. */
  static searchFeed(searchString: string): SmartFeed {
    return new SmartFeed(
      SidebarItemIdentifier.smartFeed(searchFeedIdentifier),
      searchNamePrefix + searchString,
      FetchType.search(searchString),
      ReadFilterType.none,
      new IconImage(undefined, 'magnifyingglass', true, true)
    );
  }

  /** The timeline-scoped search: the same string, restricted to the visible articles. */
  static searchTimelineFeed(searchString: string, articleIDs: string[]): SmartFeed {
    return new SmartFeed(
      SidebarItemIdentifier.smartFeed(searchTimelineFeedIdentifier),
      searchNamePrefix + searchString,
      FetchType.searchWithArticleIDs(searchString, articleIDs),
      ReadFilterType.none,
      new IconImage(undefined, 'magnifyingglass', true, true)
    );
  }

  /** The source's SmartFeedDelegate.fetchUnreadCount(account:), per smart feed. */
  static async unreadCountFor(smartFeed: SmartFeed, account: AccountService): Promise<number> {
    const id: string | undefined = smartFeed.sidebarItemID.id;
    if (id === 'UnreadFeed') {
      return account.unreadCount;
    }
    if (id === 'TodayFeedDelegate') {
      return await account.fetchUnreadCountForToday();
    }
    if (id === 'StarredFeedDelegate') {
      return await account.fetchUnreadCountForStarredArticles();
    }
    // The search feeds report no unread count, as in the source.
    return 0;
  }

  private postDidChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
