/**
 * ArticleStatus — port of Modules/Articles/Sources/Articles/ArticleStatus.swift
 *
 * Read/starred state for one article. Mutable in the source (behind a lock);
 * ArkTS is single-threaded per worker so plain mutable fields are equivalent.
 */

export enum ArticleStatusKey {
  read = 'read',
  starred = 'starred'
}

export class ArticleStatus {
  /** ~6 months. Marks old articles read on arrival; detects stale CloudKit status records. */
  static readonly staleIntervalInSeconds: number = 183 * 24 * 60 * 60;

  readonly articleID: string;
  readonly dateArrived: Date;
  read: boolean;
  starred: boolean;

  constructor(articleID: string, read: boolean, starred: boolean, dateArrived: Date) {
    this.articleID = articleID;
    this.read = read;
    this.starred = starred;
    this.dateArrived = dateArrived;
  }

  boolStatus(key: ArticleStatusKey): boolean {
    if (key === ArticleStatusKey.read) {
      return this.read;
    }
    return this.starred;
  }

  setBoolStatus(status: boolean, key: ArticleStatusKey): void {
    if (key === ArticleStatusKey.read) {
      this.read = status;
    } else {
      this.starred = status;
    }
  }

  equals(other: ArticleStatus): boolean {
    return this.articleID === other.articleID
      && this.dateArrived.getTime() === other.dateArrived.getTime()
      && this.read === other.read
      && this.starred === other.starred;
  }
}

export function articleStatusIDs(statuses: ArticleStatus[]): string[] {
  const ids: string[] = [];
  for (const status of statuses) {
    ids.push(status.articleID);
  }
  return ids;
}
