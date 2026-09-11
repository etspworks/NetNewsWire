/**
 * Feed — port of Modules/Account/Sources/Account/Feed.swift
 * (formerly WebFeed; renamed in this checkout.)
 *
 * The Swift class holds a weak `account` back-reference; here only accountID is stored and
 * the account is resolved through AccountManager, which keeps the model layer acyclic.
 * Every public property that reads/writes through `settings` in the source does so here too.
 */

import { Author } from './Author';
import { CacheControlInfo } from './CacheControlInfo';
import { FeedSettings } from './FeedSettings';
import { HTTPConditionalGetInfo } from './HTTPConditionalGetInfo';
import { ReadFilterType, SidebarItemIdentifier } from './SidebarItemIdentifier';

export class Feed {
  readonly feedID: string;
  readonly accountID: string;
  readonly url: string;
  readonly sidebarItemID: SidebarItemIdentifier;
  settings: FeedSettings;

  /** The feed's own name, as published by the feed. */
  name?: string;
  /** Cached unread count; the account owns the authoritative value. */
  unreadCount: number = 0;

  constructor(accountID: string, url: string, settings: FeedSettings) {
    this.accountID = accountID;
    this.feedID = settings.feedID;
    this.sidebarItemID = SidebarItemIdentifier.feed(accountID, settings.feedID);
    this.url = url;
    this.settings = settings;
  }

  get defaultReadFilterType(): ReadFilterType {
    return ReadFilterType.none;
  }

  get homePageURL(): string | undefined {
    return this.settings.homePageURL;
  }

  set homePageURL(value: string | undefined) {
    this.settings.homePageURL = (value !== undefined && value.length > 0) ? value : undefined;
  }

  get iconURL(): string | undefined {
    return this.settings.iconURL;
  }

  set iconURL(value: string | undefined) {
    this.settings.iconURL = value;
  }

  get faviconURL(): string | undefined {
    return this.settings.faviconURL;
  }

  set faviconURL(value: string | undefined) {
    this.settings.faviconURL = value;
  }

  get authors(): Author[] | undefined {
    return this.settings.authors;
  }

  set authors(value: Author[] | undefined) {
    this.settings.authors = value;
  }

  /** Never "" — the source coerces an empty edited name back to nil. */
  get editedName(): string | undefined {
    const s: string | undefined = this.settings.editedName;
    return (s !== undefined && s.length > 0) ? s : undefined;
  }

  set editedName(value: string | undefined) {
    this.settings.editedName = (value !== undefined && value.length > 0) ? value : undefined;
  }

  get conditionalGetInfo(): HTTPConditionalGetInfo | undefined {
    return this.settings.conditionalGetInfo;
  }

  set conditionalGetInfo(value: HTTPConditionalGetInfo | undefined) {
    this.settings.conditionalGetInfo = value;
    this.settings.conditionalGetInfoDate = value === undefined ? undefined : new Date();
  }

  get conditionalGetInfoDate(): Date | undefined {
    return this.settings.conditionalGetInfoDate;
  }

  set conditionalGetInfoDate(value: Date | undefined) {
    this.settings.conditionalGetInfoDate = value;
  }

  get cacheControlInfo(): CacheControlInfo | undefined {
    return this.settings.cacheControlInfo;
  }

  set cacheControlInfo(value: CacheControlInfo | undefined) {
    this.settings.cacheControlInfo = value;
  }

  get contentHash(): string | undefined {
    return this.settings.contentHash;
  }

  set contentHash(value: string | undefined) {
    this.settings.contentHash = value;
  }

  get newArticleNotificationsEnabled(): boolean {
    return this.settings.newArticleNotificationsEnabled;
  }

  set newArticleNotificationsEnabled(value: boolean) {
    this.settings.newArticleNotificationsEnabled = value;
  }

  get readerViewAlwaysEnabled(): boolean {
    return this.settings.readerViewAlwaysEnabled;
  }

  set readerViewAlwaysEnabled(value: boolean) {
    this.settings.readerViewAlwaysEnabled = value;
  }

  get externalID(): string | undefined {
    return this.settings.externalID;
  }

  set externalID(value: string | undefined) {
    this.settings.externalID = value;
  }

  /** Folder name -> sync-service relationship ID. */
  get folderRelationship(): Map<string, string> | undefined {
    return this.settings.folderRelationship;
  }

  set folderRelationship(value: Map<string, string> | undefined) {
    this.settings.folderRelationship = value;
  }

  get lastCheckDate(): Date | undefined {
    return this.settings.lastCheckDate;
  }

  set lastCheckDate(value: Date | undefined) {
    this.settings.lastCheckDate = value;
  }

  get lastResponseCode(): number | undefined {
    return this.settings.lastResponseCode;
  }

  set lastResponseCode(value: number | undefined) {
    this.settings.lastResponseCode = value;
  }

  get nameForDisplay(): string {
    const edited: string | undefined = this.editedName;
    if (edited !== undefined && edited.length > 0) {
      return edited;
    }
    const name: string | undefined = this.name;
    if (name !== undefined && name.length > 0) {
      return name;
    }
    return 'Untitled';
  }

  get notificationDisplayName(): string {
    if (this.url.includes('www.reddit.com')) {
      return 'Notify about new posts';
    }
    return 'Notify about new articles';
  }

  dropConditionalGetInfo(): void {
    this.conditionalGetInfo = undefined;
    this.contentHash = undefined;
  }

  equals(other: Feed): boolean {
    return this.feedID === other.feedID && this.accountID === other.accountID;
  }
}

export function feedIDs(feeds: Feed[]): string[] {
  const ids: string[] = [];
  for (const feed of feeds) {
    ids.push(feed.feedID);
  }
  return ids;
}

/** Sorted by display name, falling back to url when the names compare equal. */
export function sortedFeeds(feeds: Feed[]): Feed[] {
  const sorted: Feed[] = feeds.slice();
  sorted.sort((a: Feed, b: Feed): number => {
    const result: number = a.nameForDisplay.localeCompare(b.nameForDisplay);
    if (result !== 0) {
      return result;
    }
    return a.url < b.url ? -1 : (a.url > b.url ? 1 : 0);
  });
  return sorted;
}
