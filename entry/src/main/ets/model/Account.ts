/**
 * Account — port of Modules/Account/Sources/Account/Account.swift
 *
 * The Swift class also owns its delegate, ArticlesDatabase and OPML file; those are
 * service-layer concerns and live in the account services. What remains here is the
 * account's data: identity, settings-backed properties and the feed/folder tree.
 */

import { AccountBehavior } from './AccountBehavior';
import { AccountSettings } from './AccountSettings';
import { AccountType, accountTypeDisplayName } from './AccountType';
import { ContainerIdentifier } from './ContainerIdentifier';
import { Feed } from './Feed';
import { Folder, sortedFolders } from './Folder';
import { ProgressInfo } from './ProgressInfo';

export class Account {
  readonly accountID: string;
  readonly type: AccountType;
  readonly dataFolder: string;
  readonly defaultName: string;
  settings: AccountSettings;

  isDeleted: boolean = false;
  topLevelFeeds: Feed[] = [];
  folders?: Folder[] = [];
  unreadCount: number = 0;
  refreshInProgress: boolean = false;
  progressInfo: ProgressInfo = new ProgressInfo();
  behaviors: AccountBehavior[] = [];
  areUnreadCountsInitialized: boolean = false;
  /** feedID -> unread count. */
  unreadCounts: Map<string, number> = new Map<string, number>();

  constructor(accountID: string, type: AccountType, dataFolder: string, settings: AccountSettings) {
    this.accountID = accountID;
    this.type = type;
    this.dataFolder = dataFolder;
    this.defaultName = accountTypeDisplayName(type);
    this.settings = settings;
  }

  get containerID(): ContainerIdentifier {
    return ContainerIdentifier.account(this.accountID);
  }

  get name(): string | undefined {
    return this.settings.name;
  }

  set name(value: string | undefined) {
    this.settings.name = value;
  }

  get nameForDisplay(): string {
    const name: string | undefined = this.settings.name;
    if (name === undefined || name.length === 0) {
      return this.defaultName;
    }
    return name;
  }

  get isActive(): boolean {
    return this.settings.isActive;
  }

  set isActive(value: boolean) {
    this.settings.isActive = value;
  }

  get username(): string | undefined {
    return this.settings.username;
  }

  set username(value: string | undefined) {
    this.settings.username = value;
  }

  get externalID(): string | undefined {
    return this.settings.externalID;
  }

  set externalID(value: string | undefined) {
    this.settings.externalID = value;
  }

  get endpointURL(): string | undefined {
    return this.settings.endpointURL;
  }

  set endpointURL(value: string | undefined) {
    this.settings.endpointURL = value;
  }

  get lastArticleFetchStartTime(): Date | undefined {
    return this.settings.lastArticleFetchStartTime;
  }

  set lastArticleFetchStartTime(value: Date | undefined) {
    this.settings.lastArticleFetchStartTime = value;
  }

  get lastRefreshCompletedDate(): Date | undefined {
    return this.settings.lastRefreshCompletedDate;
  }

  set lastRefreshCompletedDate(value: Date | undefined) {
    this.settings.lastRefreshCompletedDate = value;
  }

  get sortedFolders(): Folder[] | undefined {
    const folders: Folder[] | undefined = this.folders;
    return folders === undefined ? undefined : sortedFolders(folders);
  }

  /** Every feed in the account: top-level feeds plus each folder's feeds. */
  flattenedFeeds(): Feed[] {
    const feeds: Feed[] = this.topLevelFeeds.slice();
    const folders: Folder[] | undefined = this.folders;
    if (folders !== undefined) {
      for (const folder of folders) {
        for (const feed of folder.flattenedFeeds()) {
          feeds.push(feed);
        }
      }
    }
    return feeds;
  }

  flattenedFeedURLs(): string[] {
    const urls: string[] = [];
    for (const feed of this.flattenedFeeds()) {
      urls.push(feed.url);
    }
    return urls;
  }

  /** feedID -> Feed, over every feed in the account. */
  idToFeedDictionary(): Map<string, Feed> {
    const d: Map<string, Feed> = new Map<string, Feed>();
    for (const feed of this.flattenedFeeds()) {
      d.set(feed.feedID, feed);
    }
    return d;
  }

  /** externalID -> Feed, for the feeds that carry one. */
  externalIDToFeedDictionary(): Map<string, Feed> {
    const d: Map<string, Feed> = new Map<string, Feed>();
    for (const feed of this.flattenedFeeds()) {
      const externalID: string | undefined = feed.externalID;
      if (externalID !== undefined) {
        d.set(externalID, feed);
      }
    }
    return d;
  }

  unreadCountFor(feed: Feed): number {
    const count: number | undefined = this.unreadCounts.get(feed.feedID);
    return count === undefined ? 0 : count;
  }

  setUnreadCountFor(count: number, feed: Feed): void {
    this.unreadCounts.set(feed.feedID, count);
    feed.unreadCount = count;
  }

  equals(other: Account): boolean {
    return this.accountID === other.accountID;
  }
}
