/**
 * Activity — port of Modules/ActivityLog/Sources/ActivityLog/{Activity,ActivityKind,
 * ActivityOwner,ActivityState}.swift
 *
 * One entry of the in-memory activity log the Settings > Activity Log screen renders.
 * ActivityKind and ActivityOwner are Swift enums with associated values; the payload rides
 * alongside the discriminator here.
 */

export enum ActivityState {
  pending = 'pending',
  running = 'running',
  completed = 'completed',
  failed = 'failed'
}

export enum ActivityOwnerKind {
  app = 'app',
  account = 'account',
  feedFinder = 'feedFinder',
  feedImageDownloader = 'feedImageDownloader',
  faviconDownloader = 'faviconDownloader',
  avatarDownloader = 'avatarDownloader',
  htmlMetadataDownloader = 'htmlMetadataDownloader'
}

export class ActivityOwner {
  readonly kind: ActivityOwnerKind;
  /** account only. */
  readonly accountID?: string;
  /** account only — the account's display name at creation time. */
  readonly accountDisplayName?: string;

  constructor(kind: ActivityOwnerKind, accountID?: string, accountDisplayName?: string) {
    this.kind = kind;
    this.accountID = accountID;
    this.accountDisplayName = accountDisplayName;
  }

  static account(accountID: string, displayName: string): ActivityOwner {
    return new ActivityOwner(ActivityOwnerKind.account, accountID, displayName);
  }

  get displayName(): string {
    if (this.kind === ActivityOwnerKind.app) {
      return 'NetNewsWire';
    }
    if (this.kind === ActivityOwnerKind.account) {
      return this.accountDisplayName !== undefined ? this.accountDisplayName : '';
    }
    if (this.kind === ActivityOwnerKind.feedFinder) {
      return 'Feed Finder';
    }
    if (this.kind === ActivityOwnerKind.feedImageDownloader) {
      return 'Feed Images';
    }
    if (this.kind === ActivityOwnerKind.faviconDownloader) {
      return 'Favicons';
    }
    if (this.kind === ActivityOwnerKind.avatarDownloader) {
      return 'Avatars';
    }
    return 'HTML Metadata';
  }

  /** Identity for `.account` is the accountID alone, so a rename mid-flight is harmless. */
  equals(other: ActivityOwner): boolean {
    if (this.kind !== other.kind) {
      return false;
    }
    if (this.kind === ActivityOwnerKind.account) {
      return this.accountID === other.accountID;
    }
    return true;
  }
}

export enum ActivityKindType {
  // Account-related
  sendArticleStatuses = 'sendArticleStatuses',
  refreshArticleStatuses = 'refreshArticleStatuses',
  refreshFeedList = 'refreshFeedList',
  /** Per-feed; carries the feed URL. */
  refreshFeedContent = 'refreshFeedContent',
  followFeedRedirect = 'followFeedRedirect',
  refreshArticles = 'refreshArticles',
  fetchArticleIDs = 'fetchArticleIDs',
  refreshMissingArticles = 'refreshMissingArticles',
  importOPML = 'importOPML',
  // CloudKit user-action edits
  subscribeFeed = 'subscribeFeed',
  renameFeed = 'renameFeed',
  removeFeed = 'removeFeed',
  moveFeed = 'moveFeed',
  addFeed = 'addFeed',
  restoreFeed = 'restoreFeed',
  createFolder = 'createFolder',
  renameFolder = 'renameFolder',
  removeFolder = 'removeFolder',
  restoreFolder = 'restoreFolder',
  // CloudKit background work
  cleanUpCloudKitRecords = 'cleanUpCloudKitRecords',
  subscribeToCloudKitZone = 'subscribeToCloudKitZone',
  fetchCloudKitStats = 'fetchCloudKitStats',
  scanCloudKitStatusRecords = 'scanCloudKitStatusRecords',
  scanCloudKitArticleRecords = 'scanCloudKitArticleRecords',
  receiveCloudKitNotification = 'receiveCloudKitNotification',
  // Maintenance and lifecycle
  vacuumDatabase = 'vacuumDatabase',
  validateCredentials = 'validateCredentials',
  exportOPML = 'exportOPML',
  // App-level
  refreshAll = 'refreshAll',
  // Non-account; each carries a URL
  findFeed = 'findFeed',
  fetchFeedCandidate = 'fetchFeedCandidate',
  downloadFeedImage = 'downloadFeedImage',
  downloadFavicon = 'downloadFavicon',
  downloadAvatar = 'downloadAvatar',
  downloadHTMLMetadata = 'downloadHTMLMetadata'
}

export class ActivityKind {
  readonly type: ActivityKindType;
  /** Set for the URL-bearing kinds only. */
  readonly urlString?: string;

  constructor(type: ActivityKindType, urlString?: string) {
    this.type = type;
    this.urlString = urlString;
  }

  /**
   * Display name for the kinds that do not carry a URL to show separately.
   * Undefined for the URL-bearing cases — those render primary + URL via displayName().
   */
  get simpleDisplayName(): string | undefined {
    const names: Map<ActivityKindType, string> = ActivityKind.simpleDisplayNames;
    return names.get(this.type);
  }

  private static readonly simpleDisplayNames: Map<ActivityKindType, string> =
    ActivityKind.buildSimpleDisplayNames();

  private static buildSimpleDisplayNames(): Map<ActivityKindType, string> {
    const names: Map<ActivityKindType, string> = new Map<ActivityKindType, string>();
    names.set(ActivityKindType.refreshAll, 'Refresh all');
    names.set(ActivityKindType.sendArticleStatuses, 'Sending statuses');
    names.set(ActivityKindType.refreshArticleStatuses, 'Refreshing statuses');
    names.set(ActivityKindType.refreshFeedList, 'Refreshing feed list');
    names.set(ActivityKindType.followFeedRedirect, 'Feed redirect');
    names.set(ActivityKindType.refreshArticles, 'Refreshing articles');
    names.set(ActivityKindType.fetchArticleIDs, 'Fetching article IDs');
    names.set(ActivityKindType.refreshMissingArticles, 'Refreshing missing articles');
    names.set(ActivityKindType.importOPML, 'Importing OPML');
    names.set(ActivityKindType.subscribeFeed, 'Subscribing to feed');
    names.set(ActivityKindType.renameFeed, 'Renaming feed');
    names.set(ActivityKindType.removeFeed, 'Removing feed');
    names.set(ActivityKindType.moveFeed, 'Moving feed');
    names.set(ActivityKindType.addFeed, 'Adding feed');
    names.set(ActivityKindType.restoreFeed, 'Restoring feed');
    names.set(ActivityKindType.createFolder, 'Creating folder');
    names.set(ActivityKindType.renameFolder, 'Renaming folder');
    names.set(ActivityKindType.removeFolder, 'Removing folder');
    names.set(ActivityKindType.restoreFolder, 'Restoring folder');
    names.set(ActivityKindType.cleanUpCloudKitRecords, 'Cleaning up iCloud records');
    names.set(ActivityKindType.fetchCloudKitStats, 'Fetching iCloud stats');
    names.set(ActivityKindType.scanCloudKitStatusRecords, 'Scanning iCloud status records');
    names.set(ActivityKindType.scanCloudKitArticleRecords, 'Scanning iCloud article records');
    names.set(ActivityKindType.receiveCloudKitNotification, 'Receiving sync notification');
    names.set(ActivityKindType.subscribeToCloudKitZone, 'Subscribing to zone changes');
    names.set(ActivityKindType.vacuumDatabase, 'Vacuuming database');
    names.set(ActivityKindType.validateCredentials, 'Validating credentials');
    names.set(ActivityKindType.exportOPML, 'Exporting OPML');
    return names;
  }

  /** For URL-bearing kinds, `detail` supplies the feed name, falling back to the URL. */
  displayName(detail?: string): string {
    const simple: string | undefined = this.simpleDisplayName;
    if (simple !== undefined) {
      return simple;
    }
    const url: string = this.urlString !== undefined ? this.urlString : '';
    if (this.type === ActivityKindType.refreshFeedContent) {
      return 'Refreshing feed: ' + (detail !== undefined ? detail : url);
    }
    if (this.type === ActivityKindType.findFeed) {
      return 'Finding feed ' + url;
    }
    if (this.type === ActivityKindType.fetchFeedCandidate) {
      return 'Fetching ' + url;
    }
    if (this.type === ActivityKindType.downloadFeedImage) {
      return 'Downloading image ' + url;
    }
    if (this.type === ActivityKindType.downloadFavicon) {
      return 'Downloading favicon ' + url;
    }
    if (this.type === ActivityKindType.downloadAvatar) {
      return 'Downloading avatar ' + url;
    }
    if (this.type === ActivityKindType.downloadHTMLMetadata) {
      return 'Downloading metadata ' + url;
    }
    return '';
  }

  equals(other: ActivityKind): boolean {
    return this.type === other.type && this.urlString === other.urlString;
  }
}

export class Activity {
  readonly id: number;
  readonly owner: ActivityOwner;
  readonly kind: ActivityKind;
  readonly detail?: string;

  state: ActivityState = ActivityState.pending;
  startDate?: Date;
  endDate?: Date;
  error?: Error;
  completionMessage?: string;
  returnedFromCache: boolean = false;
  /** Hide or show the duration in the UI. */
  durationIsSignificant: boolean = true;

  constructor(id: number, owner: ActivityOwner, kind: ActivityKind, detail?: string) {
    this.id = id;
    this.owner = owner;
    this.kind = kind;
    this.detail = detail;
  }

  didStart(): void {
    this.state = ActivityState.running;
    this.startDate = new Date();
  }

  /**
   * Pending -> running without a startDate, for an activity that completes without ever
   * truly starting (a cached or skipped download).
   */
  didStartWithoutTimestamp(): void {
    this.state = ActivityState.running;
  }

  didComplete(message?: string, returnedFromCache: boolean = false): void {
    this.state = ActivityState.completed;
    this.endDate = new Date();
    this.completionMessage = message;
    this.returnedFromCache = returnedFromCache;
  }

  didFail(error: Error): void {
    this.state = ActivityState.failed;
    this.endDate = new Date();
    this.error = error;
  }

  /** "0.45s", "12.3s" or "2m 15s"; undefined when the duration is not significant. */
  get formattedDuration(): string | undefined {
    const startDate: Date | undefined = this.startDate;
    const endDate: Date | undefined = this.endDate;
    if (!this.durationIsSignificant || startDate === undefined || endDate === undefined) {
      return undefined;
    }
    return Activity.formatDuration((endDate.getTime() - startDate.getTime()) / 1000);
  }

  static formatDuration(duration: number): string {
    if (duration < 10.0) {
      return duration.toFixed(2) + 's';
    }
    if (duration < 60.0) {
      return duration.toFixed(1) + 's';
    }
    const minutes: number = Math.floor(duration / 60);
    const seconds: number = Math.floor(duration) % 60;
    return minutes + 'm ' + seconds + 's';
  }
}

/** Maximum number of completed activities the log retains. */
export const completedActivitiesLimit: number = 500;
