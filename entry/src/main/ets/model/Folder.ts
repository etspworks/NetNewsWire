/**
 * Folder — port of Modules/Account/Sources/Account/Folder.swift
 *
 * Sub-folders are not supported, so `folders` is always undefined and flattenedFeeds()
 * is just the top-level feeds. The weak `account` back-reference is replaced by accountID.
 */

import { ContainerIdentifier } from './ContainerIdentifier';
import { Feed, sortedFeeds } from './Feed';
import { ReadFilterType, SidebarItemIdentifier } from './SidebarItemIdentifier';

export class Folder {
  static readonly untitledName: string = 'Untitled ƒ';
  private static incrementingID: number = 0;

  readonly accountID: string;
  /** Not saved: per-run only. */
  readonly folderID: number;
  name?: string;
  externalID?: string;
  topLevelFeeds: Feed[] = [];
  /** Sub-folders are not supported, so this is always undefined. */
  folders?: Folder[];
  unreadCount: number = 0;

  constructor(accountID: string, name?: string) {
    this.accountID = accountID;
    this.name = name;
    this.folderID = Folder.incrementingID;
    Folder.incrementingID += 1;
  }

  get defaultReadFilterType(): ReadFilterType {
    return ReadFilterType.read;
  }

  get nameForDisplay(): string {
    return this.name !== undefined ? this.name : Folder.untitledName;
  }

  get containerID(): ContainerIdentifier {
    return ContainerIdentifier.folder(this.accountID, this.nameForDisplay);
  }

  get sidebarItemID(): SidebarItemIdentifier {
    return SidebarItemIdentifier.folder(this.accountID, this.nameForDisplay);
  }

  updateUnreadCount(): void {
    let updated: number = 0;
    for (const feed of this.topLevelFeeds) {
      updated += feed.unreadCount;
    }
    this.unreadCount = updated;
  }

  flattenedFeeds(): Feed[] {
    return this.topLevelFeeds;
  }

  objectIsChild(feed: Feed): boolean {
    return this.containsFeed(feed);
  }

  containsFeed(feed: Feed): boolean {
    for (const candidate of this.topLevelFeeds) {
      if (candidate.equals(feed)) {
        return true;
      }
    }
    return false;
  }

  addFeedToTreeAtTopLevel(feed: Feed): void {
    if (!this.containsFeed(feed)) {
      this.topLevelFeeds.push(feed);
    }
  }

  addFeeds(feeds: Feed[]): void {
    for (const feed of feeds) {
      this.addFeedToTreeAtTopLevel(feed);
    }
  }

  removeFeedFromTreeAtTopLevel(feed: Feed): void {
    const remaining: Feed[] = [];
    for (const candidate of this.topLevelFeeds) {
      if (!candidate.equals(feed)) {
        remaining.push(candidate);
      }
    }
    this.topLevelFeeds = remaining;
  }

  removeFeedsFromTreeAtTopLevel(feeds: Feed[]): void {
    for (const feed of feeds) {
      this.removeFeedFromTreeAtTopLevel(feed);
    }
  }

  /** Replace the entire top-level feed set in one shot. */
  replaceTopLevelFeeds(feeds: Feed[]): void {
    this.topLevelFeeds = feeds;
  }

  sortedTopLevelFeeds(): Feed[] {
    return sortedFeeds(this.topLevelFeeds);
  }

  equals(other: Folder): boolean {
    return this === other;
  }
}

export function sortedFolders(folders: Folder[]): Folder[] {
  const sorted: Folder[] = folders.slice();
  sorted.sort((a: Folder, b: Folder): number => a.nameForDisplay.localeCompare(b.nameForDisplay));
  return sorted;
}
