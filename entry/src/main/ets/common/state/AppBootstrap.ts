/**
 * AppBootstrap — the ordered startup the source performs across AppDelegate.init,
 * application(_:didFinishLaunchingWithOptions:) and SceneDelegate.scene(_:willConnectTo:).
 *
 * On iOS most of this was synchronous at init time. On HarmonyOS the sandbox paths only
 * exist once the UIAbility hands over its Context, and account/database opening is async,
 * so the whole sequence is one awaited call:
 *
 *   EntryAbility.onCreate:            await AppBootstrap.start(this.context)
 *   EntryAbility.onWindowStageCreate: await AppBootstrap.restoreState()
 *   EntryAbility.onForeground:        AppBootstrap.willEnterForeground()
 *   EntryAbility.onBackground:        AppBootstrap.didEnterBackground()
 *   EntryAbility.onDestroy:           AppBootstrap.shutDown()
 *
 * ORDER MATTERS: AppContext must be set before AppDefaults.load(), and AppDefaults must
 * be loaded before AccountManager.start() — every database and disk cache resolves its
 * path through AppContext, and every account setting through AppDefaults.
 */

import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppContext } from '../util/AppContext';
import { AppDefaults } from '../prefs/AppDefaults';
import { AccountManager } from '../account/AccountManager';
import { AccountChange, AccountService } from '../account/Account';
import { ArticleThemesManager, rawfileText } from '../article/ArticleThemesManager';
import { ImageMetadataDatabase } from '../images/IconImageCache';
import { OPMLFile } from '../parser/OPML';
import { SceneCoordinator } from '../SceneCoordinator';
import { UserNotificationManager } from '../notify/UserNotificationManager';
import {
  AccountRefreshTimer, ArticleStatusSyncTimer, scheduleBackgroundRefresh
} from '../timer/RefreshTimers';

const DOMAIN: number = 0x0001;
const TAG: string = 'AppBootstrap';
/** Bundle.main.url(forResource: "DefaultFeeds", withExtension: "opml") */
const defaultFeedsRawfile: string = 'DefaultFeeds.opml';
/** AppDelegate.prepareAccountsForForeground: `lastRefresh.addingTimeInterval(15 * 60)`. */
const foregroundRefreshIntervalMillis: number = 15 * 60 * 1000;

export class AppBootstrap {
  /** The in-flight (or finished) start(); doubles as the run-once flag. */
  private static startPromise?: Promise<void>;

  /**
   * Call FIRST from EntryAbility.onCreate, with the ability's context.
   * `abilityName` is the ability notification actions and background work should reach.
   */
  static start(context: common.UIAbilityContext,
    abilityName: string = 'EntryAbility'): Promise<void> {
    let pending: Promise<void> | undefined = AppBootstrap.startPromise;
    if (pending === undefined) {
      pending = AppBootstrap.runStart(context, abilityName);
      AppBootstrap.startPromise = pending;
    }
    return pending;
  }

  private static async runStart(context: common.UIAbilityContext,
    abilityName: string): Promise<void> {
    AppContext.setContext(context);
    AppDefaults.load();

    try {
      await AccountManager.shared.start();
      AppBootstrap.importDefaultFeedsIfNeeded();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'account startup failed: %{public}s', (e as Error).message);
    }

    // The favicon / feed-icon / download-failure ledger. Nothing opened it, so every icon
    // lookup logged "Database ImageMetadata.db is not open": a resolved favicon URL was never
    // remembered and a dead icon URL was retried on every launch instead of being backed off.
    try {
      await ImageMetadataDatabase.shared.open();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'image metadata db open failed: %{public}s', (e as Error).message);
    }

    ArticleThemesManager.shared.start();
    ArticleStatusSyncTimer.shared.start();
    AccountRefreshTimer.shared.update();

    // AppDelegate's `unreadCount` didSet -> updateBadge() (iOS/AppDelegate.swift:40-46), which
    // is the ONLY thing that keeps the launcher badge current. Nothing subscribed to
    // AccountManager here, so the app icon never carried a count at all.
    AccountManager.shared.addListener((change: AccountChange,
      account?: AccountService): void => {
      if (change === AccountChange.unreadCount) {
        UserNotificationManager.shared.updateBadge(AccountManager.shared.unreadCount);
      }
      // The other half of iOS/SceneCoordinator.swift:361-370: the coordinator is the app's one
      // account observer and every screen renders what it publishes. Nothing subscribed it, so
      // an account change reached a screen only when that screen happened to rebuild by hand.
      SceneCoordinator.shared.accountDidChange(change);
    });

    const bundleName: string = context.applicationInfo.name;
    await UserNotificationManager.shared.start(bundleName, abilityName);
    scheduleBackgroundRefresh(bundleName);
  }

  /**
   * DefaultFeedsImporter.swift, called from AppDelegate.didFinishLaunchingWithOptions under
   * the same guard: first run AND no account has a feed, so an existing library is never
   * re-seeded and a second launch never duplicates the feeds.
   *
   * The source fires the import and forgets it (`importOPML(url) { _ in }`). Account.importOPML
   * ends in a network refreshAll, so awaiting it here would hold onCreate open for the whole
   * refresh; the sidebar and unread counts are rebuilt when it lands instead.
   *
   * DefaultFeeds.opml lives in rawfile, which has no filesystem path, and importOPML takes a
   * path — so the bundled text is spilled into the (evictable) cache folder and that path is
   * imported. Cheaper than adding a text-taking importOPML to AccountDelegate and all six
   * delegates that implement it.
   */
  private static importDefaultFeedsIfNeeded(): void {
    if (!AppDefaults.isFirstRun || AccountManager.shared.anyAccountHasAtLeastOneFeed()) {
      return;
    }
    const text: string | undefined = rawfileText(defaultFeedsRawfile);
    if (text === undefined) {
      hilog.error(DOMAIN, TAG, 'DefaultFeeds.opml is missing from rawfile');
      return;
    }
    const path: string = AppContext.cacheFolder() + '/' + defaultFeedsRawfile;
    OPMLFile.writeDocument(path, text);
    AccountManager.shared.defaultAccount.importOPML(path)
      .then((): Promise<void> => {
        hilog.info(DOMAIN, TAG, 'default feeds imported');
        return SceneCoordinator.shared.unreadCountDidChange();
      })
      .catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'default feeds import failed: %{public}s', String(e));
      });
  }

  /**
   * Call from EntryAbility.onWindowStageCreate, after start().
   *
   * onCreate cannot await start() (UIAbility lifecycle callbacks are sync), so
   * onWindowStageCreate can fire while accounts are still opening — and restoreWindowState
   * builds the sidebar tree from AccountManager.sortedActiveAccounts. Building it too early
   * yields a tree with NO accounts, and since nothing rebuilds it afterwards the sidebar
   * stays stuck on Smart Feeds for the whole session. Wait for the sequence start() owns.
   */
  static async restoreState(restoreSelection: boolean = true): Promise<void> {
    const pending: Promise<void> | undefined = AppBootstrap.startPromise;
    if (pending !== undefined) {
      await pending;
    }
    await SceneCoordinator.shared.restoreWindowState(restoreSelection);
    // AppDelegate.didFinishLaunching's trailing `DispatchQueue.main.async { self.unreadCount =
    // AccountManager.shared.unreadCount }`: the smart feeds carry no count until something
    // asks for one, so a restored session opened with a blank Today/All Unread.
    await SceneCoordinator.shared.unreadCountDidChange();
    // "Force the badge to update on launch" (iOS/AppDelegate.swift:90): the listener only
    // fires on a CHANGE, and a relaunch that restores the same count posts nothing.
    UserNotificationManager.shared.updateBadge(AccountManager.shared.unreadCount);
  }

  static willEnterForeground(): void {
    AccountRefreshTimer.shared.isSystemSleeping = false;
    AccountRefreshTimer.shared.resume();
    ArticleStatusSyncTimer.shared.fireOldTimer();
    SceneCoordinator.shared.willEnterForeground().catch((error: Error) => {
      hilog.warn(DOMAIN, TAG, 'foreground refresh failed: %{public}s', error.message);
    });
    AppBootstrap.prepareAccountsForForeground().catch((error: Error) => {
      hilog.error(DOMAIN, TAG, 'prepareAccountsForForeground: %{public}s', error.message);
    });
  }

  /**
   * AppDelegate.prepareAccountsForForeground — the iOS app refreshes every time it enters the
   * foreground, a cold launch included: a full refresh when the last one is older than 15
   * minutes, an article-status sync otherwise.
   *
   * The Shared AccountRefreshTimer this port also carries cannot stand in for it: in the source
   * `refreshInterval` exists only in Mac/AppDefaults, so on iOS the timer reads `.manually` and
   * never fires. Unported, the migrated app fetched articles on pull-to-refresh only, and
   * `AppDefaults.lastRefresh` had neither a reader nor a writer.
   */
  private static async prepareAccountsForForeground(): Promise<void> {
    const pending: Promise<void> | undefined = AppBootstrap.startPromise;
    if (pending !== undefined) {
      await pending;
    }
    const lastRefresh: Date | undefined = AppDefaults.lastRefresh;
    if (lastRefresh !== undefined
      && Date.now() <= lastRefresh.getTime() + foregroundRefreshIntervalMillis) {
      await AccountManager.shared.syncArticleStatusAll();
      return;
    }
    await AccountManager.shared.refreshAll((error: Error): void => {
      hilog.error(DOMAIN, TAG, 'foreground refresh failed: %{public}s', error.message);
    });
    AppDefaults.lastRefresh = new Date();
    await SceneCoordinator.shared.unreadCountDidChange();
  }

  static didEnterBackground(): void {
    // applicationDidEnterBackground -> updateBadge() (iOS/AppDelegate.swift:135) — the moment
    // the launcher icon is actually looked at.
    UserNotificationManager.shared.updateBadge(AccountManager.shared.unreadCount);
    SceneCoordinator.shared.didEnterBackground();
    AccountManager.shared.saveAll();
    AccountRefreshTimer.shared.isSystemSleeping = true;
    AccountRefreshTimer.shared.suspend();
  }

  static shutDown(): void {
    AccountRefreshTimer.shared.shuttingDown = true;
    AccountRefreshTimer.shared.invalidate();
    ArticleStatusSyncTimer.shared.stop();
    AccountManager.shared.saveAll();
  }
}

/**
 * Credentials that were Xcode build-time secrets (`SecretKey.*`) and have no self-signed
 * equivalent. They live in preferences so the Settings screen can accept them; every
 * consumer reports "not configured" when they are missing rather than failing silently.
 *
 * - Feedly OAuth: client ID + secret (Modules/Account FeedlyAccountDelegate).
 * - Inoreader: AppId/AppKey, carried as `account.externalID` in the form "id:key".
 * - Reader View: the Mercury client ID + secret (see article/ArticleExtractor.ts).
 */
export class ExternalCredentialKeys {
  static readonly feedlyClientID: string = 'feedlyClientID';
  static readonly feedlyClientSecret: string = 'feedlyClientSecret';
  static readonly mercuryClientID: string = 'mercuryClientID';
  static readonly mercuryClientSecret: string = 'mercuryClientSecret';
}

export class ExternalCredentials {
  static get feedlyClientID(): string | undefined {
    return AppDefaults.stringValue(ExternalCredentialKeys.feedlyClientID);
  }

  static set feedlyClientID(value: string | undefined) {
    AppDefaults.setString(ExternalCredentialKeys.feedlyClientID, value);
  }

  static get feedlyClientSecret(): string | undefined {
    return AppDefaults.stringValue(ExternalCredentialKeys.feedlyClientSecret);
  }

  static set feedlyClientSecret(value: string | undefined) {
    AppDefaults.setString(ExternalCredentialKeys.feedlyClientSecret, value);
  }

  static get isFeedlyConfigured(): boolean {
    const id: string | undefined = ExternalCredentials.feedlyClientID;
    const secret: string | undefined = ExternalCredentials.feedlyClientSecret;
    return id !== undefined && id.length > 0 && secret !== undefined && secret.length > 0;
  }

  static get mercuryClientID(): string | undefined {
    return AppDefaults.stringValue(ExternalCredentialKeys.mercuryClientID);
  }

  static set mercuryClientID(value: string | undefined) {
    AppDefaults.setString(ExternalCredentialKeys.mercuryClientID, value);
  }

  static get mercuryClientSecret(): string | undefined {
    return AppDefaults.stringValue(ExternalCredentialKeys.mercuryClientSecret);
  }

  static set mercuryClientSecret(value: string | undefined) {
    AppDefaults.setString(ExternalCredentialKeys.mercuryClientSecret, value);
  }

  static get isReaderViewConfigured(): boolean {
    const id: string | undefined = ExternalCredentials.mercuryClientID;
    const secret: string | undefined = ExternalCredentials.mercuryClientSecret;
    return id !== undefined && id.length > 0 && secret !== undefined && secret.length > 0;
  }

  /**
   * Inoreader's AppId/AppKey pair, stored as the account's externalID ("id:key") because
   * that is where the ported ReaderAPI delegate reads it from.
   */
  static inoreaderAppCredentials(externalID?: string): string[] | undefined {
    if (externalID === undefined) {
      return undefined;
    }
    const separator: number = externalID.indexOf(':');
    if (separator <= 0 || separator === externalID.length - 1) {
      return undefined;
    }
    return [externalID.substring(0, separator), externalID.substring(separator + 1)];
  }

  static inoreaderExternalID(appID: string, appKey: string): string {
    return appID + ':' + appKey;
  }
}
