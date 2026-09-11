/**
 * SyncStatus — port of Modules/SyncDatabase/Sources/SyncDatabase/SyncStatus.swift
 *
 * One pending status change queued for upstream send. The database column names are the
 * source's DatabaseKey values.
 */

import { ArticleStatusKey } from './ArticleStatus';

export enum SyncStatusKey {
  read = 'read',
  starred = 'starred',
  deleted = 'deleted',
  new = 'new'
}

export function syncStatusKeyFromArticleStatusKey(key: ArticleStatusKey): SyncStatusKey {
  return key === ArticleStatusKey.read ? SyncStatusKey.read : SyncStatusKey.starred;
}

export interface SyncStatus {
  articleID: string;
  key: SyncStatusKey;
  flag: boolean;
  /** Marks the rows a send is currently working on. */
  selected: boolean;
}

export function makeSyncStatus(articleID: string, key: SyncStatusKey, flag: boolean,
  selected: boolean = false): SyncStatus {
  const status: SyncStatus = {
    articleID: articleID,
    key: key,
    flag: flag,
    selected: selected
  };
  return status;
}
