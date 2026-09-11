/**
 * SmartFeed / UnreadFeed / TodayFeedDelegate / StarredFeedDelegate — port of
 * Shared/SmartFeeds/{SmartFeed,UnreadFeed,TodayFeedDelegate,StarredFeedDelegate}.swift
 *
 * The three pseudo-feeds at the top of the sidebar. Swift splits them into a SmartFeed
 * wrapper plus a delegate per feed; the only thing that varies is identity, name, fetch
 * type, read-filter default and icon, so one type with three factories covers it.
 *
 * The sidebarItemID strings are String(describing:) of the Swift types and must not change:
 * state restoration reads them.
 */

import { FetchType } from './FetchType';
import { IconImage } from './IconImage';
import { ReadFilterType, SidebarItemIdentifier } from './SidebarItemIdentifier';

/**
 * IconImage.preferredColor for the three smart feeds (Shared/Assets.swift, iOS block):
 *   todayFeed   sun.max.fill            preferredColor UIColor.systemOrange
 *   unreadFeed  largecircle.fill.circle preferredColor Assets.Colors.secondaryAccent
 *   starredFeed star.fill               preferredColor Assets.Colors.star
 * The accent/star values are the app colors already migrated into color.json
 * (secondary_accent_color, star_color); systemOrange is iOS's own #FF9500.
 */
const systemOrange: number = 0xFF9500;
const secondaryAccentColor: number = 0x086AEE;
const starColor: number = 0xF9C634;

export class SmartFeed {
  readonly sidebarItemID: SidebarItemIdentifier;
  readonly nameForDisplay: string;
  readonly fetchType: FetchType;
  readonly defaultReadFilterType: ReadFilterType;
  readonly smallIcon: IconImage;
  unreadCount: number = 0;

  constructor(sidebarItemID: SidebarItemIdentifier, nameForDisplay: string, fetchType: FetchType,
    defaultReadFilterType: ReadFilterType, smallIcon: IconImage) {
    this.sidebarItemID = sidebarItemID;
    this.nameForDisplay = nameForDisplay;
    this.fetchType = fetchType;
    this.defaultReadFilterType = defaultReadFilterType;
    this.smallIcon = smallIcon;
  }

  /** "All Unread" — the global unread count; always shows read articles too. */
  static unreadFeed(): SmartFeed {
    return new SmartFeed(
      SidebarItemIdentifier.smartFeed('UnreadFeed'),
      'All Unread',
      FetchType.unread(),
      ReadFilterType.alwaysRead,
      new IconImage(undefined, 'largecircle.fill.circle', true, true, secondaryAccentColor)
    );
  }

  static todayFeed(): SmartFeed {
    return new SmartFeed(
      SidebarItemIdentifier.smartFeed('TodayFeedDelegate'),
      'Today',
      FetchType.today(),
      ReadFilterType.none,
      new IconImage(undefined, 'sun.max.fill', true, true, systemOrange)
    );
  }

  static starredFeed(): SmartFeed {
    return new SmartFeed(
      SidebarItemIdentifier.smartFeed('StarredFeedDelegate'),
      'Starred',
      FetchType.starred(),
      ReadFilterType.none,
      new IconImage(undefined, 'star.fill', true, true, starColor)
    );
  }
}
