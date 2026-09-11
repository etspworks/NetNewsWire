/**
 * CloudKitStats / CloudKitCleanUpPlan / CloudKitCleanUpProgress — port of
 * Modules/Account/Sources/Account/CloudKit/CloudKitStats.swift
 *
 * What the iCloud Stats screen shows, the clean-up it offers, and the progress it reports
 * while running.
 */

export class CloudKitStats {
  static readonly empty: CloudKitStats = new CloudKitStats(0, 0, 0, 0, 0, 0, 0, 0, 0);

  readonly statusCount: number;
  readonly starredStatusCount: number;
  readonly unreadStatusCount: number;
  readonly readStatusCount: number;
  readonly staleStatusCount: number;
  readonly articleCount: number;
  readonly starredArticleCount: number;
  readonly unreadArticleCount: number;
  readonly readArticleCount: number;

  constructor(statusCount: number, starredStatusCount: number, unreadStatusCount: number,
    readStatusCount: number, staleStatusCount: number, articleCount: number,
    starredArticleCount: number, unreadArticleCount: number, readArticleCount: number) {
    this.statusCount = statusCount;
    this.starredStatusCount = starredStatusCount;
    this.unreadStatusCount = unreadStatusCount;
    this.readStatusCount = readStatusCount;
    this.staleStatusCount = staleStatusCount;
    this.articleCount = articleCount;
    this.starredArticleCount = starredArticleCount;
    this.unreadArticleCount = unreadArticleCount;
    this.readArticleCount = readArticleCount;
  }

  cleanUpPlan(syncUnreadContent: boolean): CloudKitCleanUpPlan {
    return new CloudKitCleanUpPlan(
      this.staleStatusCount,
      this.readArticleCount,
      syncUnreadContent ? 0 : this.unreadArticleCount
    );
  }
}

export class CloudKitCleanUpPlan {
  readonly staleStatusCount: number;
  readonly readContentCount: number;
  readonly unreadContentCount: number;

  constructor(staleStatusCount: number, readContentCount: number, unreadContentCount: number) {
    this.staleStatusCount = staleStatusCount;
    this.readContentCount = readContentCount;
    this.unreadContentCount = unreadContentCount;
  }

  get totalCount(): number {
    return this.readContentCount + this.unreadContentCount;
  }

  get isEmpty(): boolean {
    return this.totalCount === 0;
  }
}

export enum CloudKitCleanUpPhase {
  deletingStaleStatus = 'deletingStaleStatus',
  deletingReadContent = 'deletingReadContent',
  deletingUnreadContent = 'deletingUnreadContent',
  completed = 'completed'
}

export class CloudKitCleanUpProgress {
  readonly phase: CloudKitCleanUpPhase;
  readonly staleStatusDeleted: number;
  readonly readContentDeleted: number;
  readonly unreadContentDeleted: number;

  constructor(phase: CloudKitCleanUpPhase, staleStatusDeleted: number,
    readContentDeleted: number, unreadContentDeleted: number) {
    this.phase = phase;
    this.staleStatusDeleted = staleStatusDeleted;
    this.readContentDeleted = readContentDeleted;
    this.unreadContentDeleted = unreadContentDeleted;
  }

  get totalDeleted(): number {
    return this.readContentDeleted + this.unreadContentDeleted;
  }
}
