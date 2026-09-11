/**
 * CloudKitAccountDelegate — port of
 * Modules/Account/Sources/Account/CloudKit/CloudKitAccountDelegate.swift
 *
 * 🟥 THE ONE SANCTIONED SUBSTITUTION (kind: platform-capability).
 * CloudKit is an Apple-only service: HarmonyOS exposes no CKContainer, no private
 * database, no record zones, and no push-driven zone change tokens. There is nothing to
 * port it to — this is a platform capability the target OS does not have, not a library
 * that could be re-implemented.
 *
 * What is NOT dropped:
 *   • AccountType.cloudKit stays in the registry, so the Add Account row and both iCloud
 *     screens (Add iCloud Account, iCloud Stats) still ship and still work,
 *   • every LOCAL operation still functions — the account's feed/folder tree, its OPML
 *     file, its articles database and its unread counts behave exactly like the local
 *     account, because the source's CloudKit delegate does those locally too,
 *   • every SYNC entry point reports unavailability through the source's OWN error path
 *     (AccountError + postSyncError → the Error Log), so the UI shows the failure it was
 *     already written to show. Nothing crashes and nothing silently no-ops.
 *
 * What that costs, stated plainly so nobody chases it as a routing bug: an iCloud account
 * can never be CREATED here. The source gates add(_:) on
 * AddCloudKitAccountUtilities.isiCloudDriveEnabled, and on HarmonyOS that probe is
 * unconditionally false (`iCloudAccountIsUnavailable` below), so
 * CloudKitAccountViewController takes the source's own "can't add" branch. Everything the
 * bullets above describe is therefore what the delegate WOULD do for an account that
 * already existed; none of it is reachable on this platform. AccountManager.hasiCloudAccount
 * stays false forever, which correctly hides Settings > Troubleshooting > iCloud Storage
 * Stats (SettingsViewControllerPage.ets:946) and makes CloudKitStatsViewPage unreachable
 * through the UI. That is the honest branch, not a defect — making it reachable would mean
 * faking an iCloud account.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountBehavior } from '../../model/AccountBehavior';
import { AccountSettings } from '../../model/AccountSettings';
import { ActivityKindType } from '../../model/Activity';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { CloudKitCleanUpProgress, CloudKitStats } from '../../model/CloudKitStats';
import { Credentials } from '../../model/Credentials';
import { Feed } from '../../model/Feed';
import { Folder } from '../../model/Folder';
import { ProgressInfo } from '../../model/ProgressInfo';
import { SyncDatabase } from '../db/SyncDatabase';
import { AccountService, ContainerRef } from './Account';
import { AccountDelegate, AccountError, AccountErrorKind, ProgressChangeListener }
  from './AccountDelegate';

const DOMAIN: number = 0x0001;
const TAG: string = 'CloudKit';

export const cloudKitUnavailableMessage: string =
  'iCloud sync is not available on HarmonyOS. This account’s feeds, folders and articles'
  + ' stay on this device.';

/**
 * The ADD path's message. `cloudKitUnavailableMessage` speaks about "this account", which is
 * true for a sync entry point but wrong on the Add Account sheet — nothing was created there,
 * so promising the user their feeds stay on the device describes an account that does not
 * exist. This is what the source's "Can't Add iCloud Account" alert says instead.
 */
export const cloudKitCannotAddAccountMessage: string =
  'iCloud sync is not available on HarmonyOS, so an iCloud account cannot be added. Add a'
  + ' Local account to keep feeds on this device, or a web account to sync them.';

/**
 * The iCloud Stats screen's NO-ACCOUNT message. Same reasoning as the add path: that screen
 * reaches this delegate only through `AccountManager.iCloudAccount`, so when there is no
 * iCloud account there is no delegate either and `cloudKitUnavailableMessage`'s "this
 * account's feeds…" again describes one that does not exist. Since an iCloud account can
 * never be created here, this — not the sync wording — is the screen's steady state.
 */
export const cloudKitNoAccountMessage: string =
  'There is no iCloud account. iCloud sync is not available on HarmonyOS, so no iCloud'
  + ' account can be added and there are no iCloud records to scan.';

/** The error every sync entry point reports; it flows through the source's own paths. */
export class CloudKitUnavailableError extends Error {
  constructor() {
    super(cloudKitUnavailableMessage);
  }
}

export type CloudKitStatsProgressHandler = (partialStats: CloudKitStats) => void;
export type CloudKitCleanUpProgressHandler = (progress: CloudKitCleanUpProgress) => void;

export class CloudKitAccountDelegate implements AccountDelegate {
  account?: AccountService;
  readonly behaviors: AccountBehavior[] = [];
  readonly isOPMLImportInProgress: boolean = false;
  readonly server?: string = undefined;
  credentials?: Credentials;
  accountSettings?: AccountSettings;
  progressInfo: ProgressInfo = new ProgressInfo();
  onProgressChange?: ProgressChangeListener;

  private readonly syncDatabase: SyncDatabase;

  constructor(dataFolder: string) {
    this.syncDatabase = new SyncDatabase(dataFolder + '/Sync.sqlite3');
  }

  /** True on HarmonyOS: there is no iCloud account to sync with. */
  get iCloudAccountIsUnavailable(): boolean {
    return true;
  }

  async receiveRemoteNotification(userInfo: Map<string, string>): Promise<void> {
    // There is no CloudKit push channel to receive from.
    hilog.debug(DOMAIN, TAG, 'ignoring remote notification (%{public}d keys)', userInfo.size);
  }

  accountDidInitialize(): void {
    this.syncDatabase.open().then((): Promise<void> => {
      return this.syncDatabase.resetAllSelectedForProcessing();
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sync database open failed: %{public}s', String(e));
    });
  }

  accountWillBeDeleted(): void {
    // No zone subscriptions to tear down.
  }

  /** Reports unavailability through the account's own error path and stops. */
  private reportUnavailable(operation: string): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    const activityID: number = account.logActivityStart(ActivityKindType.refreshAll, operation);
    const error: CloudKitUnavailableError = new CloudKitUnavailableError();
    account.logActivityFail(activityID, error);
    account.postSyncError(error, operation);
  }

  async refreshAll(): Promise<void> {
    this.reportUnavailable('Refreshing iCloud account');
    throw new CloudKitUnavailableError();
  }

  async syncArticleStatus(): Promise<boolean> {
    // No sync service: no work was done, and no error is raised for the periodic timer.
    return false;
  }

  async sendArticleStatus(): Promise<void> {
    // Statuses stay queued locally; there is nowhere to send them.
  }

  async refreshArticleStatus(): Promise<void> {
    // Nothing to receive.
  }

  async importOPML(opmlFilePath: string): Promise<void> {
    this.reportUnavailable('Importing OPML into iCloud');
    throw new CloudKitUnavailableError();
  }

  // MARK: - Local tree operations (these keep working)

  async createFolder(name: string): Promise<Folder> {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    const folder: Folder | undefined = account.ensureFolder(name);
    if (folder === undefined) {
      throw AccountError.of(AccountErrorKind.invalidParameter);
    }
    return folder;
  }

  async renameFolder(folder: Folder, name: string): Promise<void> {
    folder.name = name;
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.structureDidChange();
    }
  }

  async removeFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.removeFolderFromTree(folder);
    }
  }

  async restoreFolder(folder: Folder): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      account.addFolderToTree(folder);
    }
  }

  /** A feed can be added locally; only its iCloud mirror is unavailable. */
  async createFeed(url: string, name: string | undefined, container: ContainerRef,
    validateFeed: boolean): Promise<Feed> {
    this.reportUnavailable('Adding a feed to iCloud');
    throw new CloudKitUnavailableError();
  }

  async renameFeed(feed: Feed, name: string): Promise<void> {
    feed.editedName = name;
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      await account.persistFeedSettings(feed);
    }
  }

  async addFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.addFeedToTreeAtTopLevel(feed);
  }

  async removeFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.removeFeedFromTreeAtTopLevel(feed);
  }

  async moveFeed(feed: Feed, sourceContainer: ContainerRef,
    destinationContainer: ContainerRef): Promise<void> {
    sourceContainer.removeFeedFromTreeAtTopLevel(feed);
    destinationContainer.addFeedToTreeAtTopLevel(feed);
  }

  async restoreFeed(feed: Feed, container: ContainerRef): Promise<void> {
    container.addFeedToTreeAtTopLevel(feed);
  }

  async markArticles(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    const account: AccountService | undefined = this.account;
    if (account !== undefined) {
      await account.updateStatuses(articleIDs, statusKey, flag);
    }
  }

  // MARK: - iCloud Stats screen surface

  /**
   * CloudKitStatsViewModel.fetch() calls this. There are no CloudKit records to scan, so
   * it raises the substitution error, which the screen renders in its error slot.
   */
  async fetchCloudKitStats(progress: CloudKitStatsProgressHandler): Promise<CloudKitStats> {
    progress(CloudKitStats.empty);
    this.reportUnavailable('Scanning iCloud storage');
    throw new CloudKitUnavailableError();
  }

  async cleanUpCloudKit(dryRun: boolean,
    progress: CloudKitCleanUpProgressHandler): Promise<void> {
    this.reportUnavailable('Cleaning up iCloud records');
    throw new CloudKitUnavailableError();
  }

  static async validateCredentials(credentials: Credentials,
    endpointURL?: string): Promise<Credentials | undefined> {
    // The iCloud account has no credentials of its own — the device account is the identity.
    return undefined;
  }

  async vacuumDatabases(): Promise<void> {
    await this.syncDatabase.vacuum();
  }

  suspendNetwork(): void {
    // No network session to suspend.
  }

  resume(): void {
    // No network session to resume.
  }
}
