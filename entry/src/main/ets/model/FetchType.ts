/**
 * FetchType — port of the enum in Modules/Account/Sources/Account/Account.swift
 *
 * Swift enum with associated values -> discriminator + payload fields.
 *   starred(Int?) / unread(Int?) / today(Int?)  -> limit
 *   folder(Folder, Bool)                        -> folder + includeChildren flag
 *   feed(Feed)                                  -> feed
 *   articleIDs(Set<String>)                     -> articleIDs
 *   search(String)                              -> searchString
 *   searchWithArticleIDs(String, Set<String>)   -> searchString + articleIDs
 */

import { Feed } from './Feed';
import { Folder } from './Folder';

export enum FetchTypeKind {
  starred = 'starred',
  unread = 'unread',
  today = 'today',
  folder = 'folder',
  feed = 'feed',
  articleIDs = 'articleIDs',
  search = 'search',
  searchWithArticleIDs = 'searchWithArticleIDs'
}

export class FetchType {
  readonly kind: FetchTypeKind;
  readonly limit?: number;
  readonly folder?: Folder;
  readonly folderFlag?: boolean;
  readonly feed?: Feed;
  readonly articleIDs?: string[];
  readonly searchString?: string;

  constructor(kind: FetchTypeKind, limit?: number, folder?: Folder, folderFlag?: boolean,
    feed?: Feed, articleIDs?: string[], searchString?: string) {
    this.kind = kind;
    this.limit = limit;
    this.folder = folder;
    this.folderFlag = folderFlag;
    this.feed = feed;
    this.articleIDs = articleIDs;
    this.searchString = searchString;
  }

  static starred(limit?: number): FetchType {
    return new FetchType(FetchTypeKind.starred, limit);
  }

  static unread(limit?: number): FetchType {
    return new FetchType(FetchTypeKind.unread, limit);
  }

  static today(limit?: number): FetchType {
    return new FetchType(FetchTypeKind.today, limit);
  }

  static forFolder(folder: Folder, flag: boolean): FetchType {
    return new FetchType(FetchTypeKind.folder, undefined, folder, flag);
  }

  static forFeed(feed: Feed): FetchType {
    return new FetchType(FetchTypeKind.feed, undefined, undefined, undefined, feed);
  }

  static forArticleIDs(articleIDs: string[]): FetchType {
    return new FetchType(FetchTypeKind.articleIDs, undefined, undefined, undefined, undefined,
      articleIDs);
  }

  static search(searchString: string): FetchType {
    return new FetchType(FetchTypeKind.search, undefined, undefined, undefined, undefined,
      undefined, searchString);
  }

  static searchWithArticleIDs(searchString: string, articleIDs: string[]): FetchType {
    return new FetchType(FetchTypeKind.searchWithArticleIDs, undefined, undefined, undefined,
      undefined, articleIDs, searchString);
  }
}
