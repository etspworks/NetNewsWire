/**
 * CloudKitFeed / CloudKitContainer / CloudKitArticle / CloudKitArticleStatus — port of the
 * record schemas in Modules/Account/Sources/Account/CloudKit/{CloudKitAccountZone,
 * CloudKitArticlesZone}.swift
 *
 * CloudKit itself has no HarmonyOS counterpart, so these carry the record-type and field
 * names verbatim: they are the schema of the already-synced iCloud data and of the local
 * mirrors the iCloud screens read. Note "AccountWebFeed" and "webFeedURL" — the wire names
 * predate the WebFeed -> Feed rename and must not be modernized.
 */

interface CloudKitFeedRecordShape {
  recordType: string;
  url: string;
  name: string;
  editedName: string;
  homePageURL: string;
  containerExternalIDs: string;
}

export const CloudKitFeedRecord: CloudKitFeedRecordShape = {
  recordType: 'AccountWebFeed',
  url: 'url',
  name: 'name',
  editedName: 'editedName',
  homePageURL: 'homePageURL',
  containerExternalIDs: 'containerExternalIDs',
};

export interface CloudKitFeed {
  externalID: string;
  url: string;
  name?: string;
  editedName?: string;
  homePageURL?: string;
  /** The account or folder records this feed belongs to. */
  containerExternalIDs: string[];
}

interface CloudKitContainerRecordShape {
  recordType: string;
  isAccount: string;
  name: string;
}

export const CloudKitContainerRecord: CloudKitContainerRecordShape = {
  recordType: 'AccountContainer',
  isAccount: 'isAccount',
  name: 'name',
};

export interface CloudKitContainer {
  externalID: string;
  /** True for the account's root container, false for a folder. */
  isAccount: boolean;
  name?: string;
}

export class CloudKitArticleRecord {
  static readonly recordType: string = 'Article';
  static readonly articleStatus: string = 'articleStatus';
  static readonly feedURL: string = 'webFeedURL';
  static readonly uniqueID: string = 'uniqueID';
  static readonly title: string = 'title';
  static readonly contentHTML: string = 'contentHTML';
  static readonly contentHTMLData: string = 'contentHTMLData';
  static readonly contentText: string = 'contentText';
  static readonly contentTextData: string = 'contentTextData';
  static readonly url: string = 'url';
  static readonly externalURL: string = 'externalURL';
  static readonly summary: string = 'summary';
  static readonly imageURL: string = 'imageURL';
  static readonly datePublished: string = 'datePublished';
  static readonly dateModified: string = 'dateModified';
  static readonly parsedAuthors: string = 'parsedAuthors';
}

export interface CloudKitArticle {
  externalID: string;
  /** Reference to the article's CloudKitArticleStatus record. */
  articleStatus?: string;
  feedURL: string;
  uniqueID: string;
  title?: string;
  contentHTML?: string;
  contentText?: string;
  url?: string;
  externalURL?: string;
  summary?: string;
  imageURL?: string;
  datePublished?: Date;
  dateModified?: Date;
  /** JSON-encoded ParsedAuthor list, as the record stores it. */
  parsedAuthors?: string[];
}

export class CloudKitArticleStatusRecord {
  static readonly recordType: string = 'ArticleStatus';
  static readonly feedExternalID: string = 'webFeedExternalID';
  static readonly read: string = 'read';
  static readonly starred: string = 'starred';
}

export interface CloudKitArticleStatus {
  externalID: string;
  feedExternalID?: string;
  read: boolean;
  starred: boolean;
}
