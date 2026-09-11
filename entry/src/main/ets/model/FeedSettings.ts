/**
 * FeedSettings — port of Modules/Account/Sources/Account/FeedSettings.swift
 * (formerly FeedMetadata; renamed in this checkout.)
 *
 * The Swift type write-throughs to FeedSettingsDatabase from every didSet; here the model
 * carries the row's values and the FeedSettingsDatabase service owns the persistence.
 * Field set matches FeedSettingsDatabase.Row exactly.
 */

import { Author } from './Author';
import { HTTPConditionalGetInfo } from './HTTPConditionalGetInfo';
import { CacheControlInfo } from './CacheControlInfo';

/** The setting keys the source posts a change notification for (Feed.SettingKey). */
export enum FeedSettingKey {
  feedID = 'feedID',
  homePageURL = 'homePageURL',
  iconURL = 'iconURL',
  faviconURL = 'faviconURL',
  editedName = 'editedName',
  authors = 'authors',
  contentHash = 'contentHash',
  newArticleNotificationsEnabled = 'newArticleNotificationsEnabled',
  readerViewAlwaysEnabled = 'readerViewAlwaysEnabled',
  conditionalGetInfo = 'conditionalGetInfo',
  conditionalGetInfoDate = 'conditionalGetInfoDate',
  cacheControlInfo = 'cacheControlInfo',
  externalID = 'externalID',
  folderRelationship = 'folderRelationship',
  lastCheckDate = 'lastCheckDate',
  lastResponseCode = 'lastResponseCode'
}

export class FeedSettings {
  readonly feedURL: string;
  /** Reassign only before a Feed is built from these settings — Feed copies feedID at init. */
  feedID: string;
  homePageURL?: string;
  /** Available only when the feed itself carried an icon URL (a JSON Feed feature). */
  iconURL?: string;
  /** Available only when the feed itself carried a favicon URL (a JSON Feed feature). */
  faviconURL?: string;
  editedName?: string;
  contentHash?: string;
  newArticleNotificationsEnabled: boolean = false;
  readerViewAlwaysEnabled: boolean = false;
  authors?: Author[];
  conditionalGetInfo?: HTTPConditionalGetInfo;
  conditionalGetInfoDate?: Date;
  cacheControlInfo?: CacheControlInfo;
  externalID?: string;
  /** Folder name -> sync-service relationship ID. */
  folderRelationship?: Map<string, string>;
  /** Last time an attempt was made to read the feed (not necessarily a successful one). */
  lastCheckDate?: Date;
  /** HTTP status code from the most recent feed download attempt. */
  lastResponseCode?: number;

  constructor(feedURL: string, feedID: string) {
    this.feedURL = feedURL;
    this.feedID = feedID;
  }
}
