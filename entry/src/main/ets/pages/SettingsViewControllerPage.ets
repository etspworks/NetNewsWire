/**
 * SettingsViewControllerPage
 * (source: iOS/Settings/SettingsViewController.swift + Settings.storyboard).
 *
 * Presented as an overlay sheet over its host (presentation: modal, hostScreen
 * the root split component), exactly as the source presents it over RootSplitViewController.
 *
 * The eight storyboard sections are reproduced with the source's runtime row-count
 * conditionals as ArkUI `if`, not as an always-on list:
 *   - Accounts is accounts.count + 1 (the extra row is Add Account);
 *   - Feeds drops "Add NetNewsWire News Feed" when there is no active account or one
 *     already subscribes to it;
 *   - Articles drops "Enable Full Screen Articles" off the phone idiom;
 *   - Troubleshooting drops "iCloud Storage Stats" when there is no iCloud account.
 *
 * An invented "Advanced" section used to carry the Feedly/Mercury client ID and secret
 * (Xcode build-time secrets in the source, Secrets.swift) plus the refresh interval. It
 * has since been removed — the shipped version has no such section, and its absence is what
 * the source actually looks like. The credential preferences themselves stay (the Feedly
 * delegate and ArticleExtractor still read them); only the UI is gone. The refresh
 * interval — the one live setting the section held — moved into "Feeds".
 */

import common from '@ohos.app.ability.common';
import bundleManager from '@ohos.bundle.bundleManager';
import deviceInfo from '@ohos.deviceInfo';
import fs from '@ohos.file.fs';
import notificationManager from '@ohos.notificationManager';
import { picker } from '@kit.CoreFileKit';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ActivityKindType } from '../model/Activity';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { AccountManager, netNewsWireNewsURL } from '../common/account/AccountManager';
import { AccountService } from '../common/account/Account';
import { ArticleThemesManager } from '../common/article/ArticleThemesManager';
import { AppDefaults, SortDirection, UserInterfaceColorPalette } from '../common/prefs/AppDefaults';
import { opmlDocumentString } from '../common/parser/OPML';
import { BrowserService } from '../common/system/BrowserService';
import { AppContext } from '../common/util/AppContext';
import {
  RefreshInterval,
  allRefreshIntervals,
  currentRefreshInterval,
  refreshIntervalDescription,
  setCurrentRefreshInterval
} from '../common/timer/RefreshTimers';
import { SettingsComboTableViewCell } from '../components/SettingsComboCell';
import { accountImageResource } from '../components/ImageHeaderView';
import {
  VibrantBasicTableViewCell,
  VibrantButton,
  VibrantSectionHeader,
  VibrantSwitchTableViewCell
} from '../components/VibrantCell';

const DOMAIN: number = 0x0001;
const TAG: string = 'SettingsViewControllerPage';

/** Shared/HelpURL.swift. */
class HelpURL {
  static readonly helpHome: string = 'https://netnewswire.com/help/';
  static readonly discourse: string = 'https://discourse.netnewswire.com/';
  static readonly releaseNotes: string =
    'https://github.com/Ranchero-Software/NetNewsWire/releases/';
  static readonly bugTracker: string = 'https://github.com/Ranchero-Software/NetNewsWire/issues';
}

/** One Help row — the four of them are the same shape and share an `itemroot` id. */
class HelpRowItem {
  readonly title: string;
  readonly url: string;

  constructor(title: string, url: string) {
    this.title = title;
    this.url = url;
  }
}

const helpRows: HelpRowItem[] = [
  new HelpRowItem('NetNewsWire Help', HelpURL.helpHome),
  new HelpRowItem('NetNewsWire Forum', HelpURL.discourse),
  new HelpRowItem('Release Notes', HelpURL.releaseNotes),
  new HelpRowItem('Bug Tracker', HelpURL.bugTracker)
];

function colorPaletteDescription(palette: UserInterfaceColorPalette): string {
  if (palette === UserInterfaceColorPalette.light) {
    return 'Light';
  }
  if (palette === UserInterfaceColorPalette.dark) {
    return 'Dark';
  }
  return 'Automatic';
}

@Entry
@Component
struct SettingsViewControllerPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State overlayShown: boolean = true;

  /** AccountManager.sortedAccounts — the Accounts section is accounts.count + 1 rows. */
  @State accounts: AccountService[] = [];

  // The switches. The source reads each one in viewWillAppear and writes it in its
  // IBAction, so these mirror AppDefaults rather than living in AppStorage.
  @State sortOldestToNewest: boolean = false;
  @State groupByFeed: boolean = false;
  @State refreshClearsReadArticles: boolean = false;
  @State confirmMarkAllAsRead: boolean = true;
  /** AppDefaults.useSystemBrowser, INVERTED for display. */
  @State openLinksInApp: boolean = true;
  @State enableJavaScript: boolean = true;
  @State fullscreenArticles: boolean = false;

  /** The Theme row's detail label. */
  @State currentThemeName: string = '';
  /** The Color Palette row's detail label. */
  @State colorPalette: string = 'Automatic';

  // Runtime row-count conditionals.
  @State showsAddNewsFeedRow: boolean = false;
  @State hasiCloudAccount: boolean = false;

  /** tableFooterView — "<appName> <version> (Build <n>)". */
  @State buildLabel: string = '';

  /** The "Refresh Interval" row's detail (no source UI counterpart — see the file header). */
  @State refreshIntervalLabel: string = '';

  /** The account chosen by the import/export account picker (`opmlAccount`). */
  private opmlAccount?: AccountService;

  aboutToAppear(): void {
    this.reloadData();
    this.loadBuildLabel();
    // AccountManager.start() is async (databases + OPML) and EntryAbility does NOT await the
    // bootstrap, so a cold start that lands straight on Settings reads an empty account list:
    // the Accounts section renders only "Add Account" and never recovers, because nothing
    // re-reads it. start() returns the in-flight promise and doubles as the run-once flag, so
    // this waits for the load already running rather than starting a second one. The feed list
    // handles the same race through its own listener.
    AccountManager.shared.start()
      .then(() => {
        this.reloadData();
      })
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'accounts did not load: %{public}s', err.message);
      });
  }

  /** viewWillAppear — every value is re-read when the screen comes back. */
  onPageShow(): void {
    // This page's own root is an empty Stack — all of its content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown to
    // false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
    this.reloadData();
  }

  // MARK: - Data

  /** viewWillAppear + accountsDidChange/displayNameDidChange reloadData(). */
  private reloadData(): void {
    this.accounts = AccountManager.shared.sortedAccounts;
    this.sortOldestToNewest =
      AppDefaults.timelineSortDirection === SortDirection.orderedAscending;
    this.groupByFeed = AppDefaults.timelineGroupByFeed;
    this.refreshClearsReadArticles = AppDefaults.refreshClearsReadArticles;
    this.confirmMarkAllAsRead = AppDefaults.confirmMarkAllAsRead;
    this.openLinksInApp = !AppDefaults.useSystemBrowser;
    this.enableJavaScript = AppDefaults.isArticleContentJavascriptEnabled;
    this.fullscreenArticles = AppDefaults.articleFullscreenAvailable;
    this.currentThemeName = ArticleThemesManager.shared.currentThemeName;
    this.colorPalette = colorPaletteDescription(AppDefaults.userInterfaceColorPalette);
    this.hasiCloudAccount = AccountManager.shared.hasiCloudAccount;
    this.showsAddNewsFeedRow = AccountManager.shared.activeAccounts.length > 0
      && !AccountManager.shared.anyAccountHasNetNewsWireNewsSubscription();

    this.refreshIntervalLabel = refreshIntervalDescription(currentRefreshInterval());
  }

  private loadBuildLabel(): void {
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      this.buildLabel = 'NetNewsWire ' + info.versionName + ' (Build ' + info.versionCode + ')';
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'bundle info unavailable: %{public}s', String(e));
      this.buildLabel = 'NetNewsWire';
    }
  }

  /** The Full Screen Articles row is iPhone-only in the source. */
  private isPhoneIdiom(): boolean {
    return deviceInfo.deviceType === 'phone' || deviceInfo.deviceType === 'default';
  }

  private uiAbilityContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  // MARK: - Navigation

  /** the settings screen -> pages/AddAccountViewControllerPage */
  private goToAddAccountViewController(): void {
    router.pushUrl({ url: 'pages/AddAccountViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/AddAccountViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/TimelineCustomizerCollectionViewControllerPage */
  private goToTimelineCustomizerCollectionViewController(): void {
    router.pushUrl({ url: 'pages/TimelineCustomizerCollectionViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/TimelineCustomizerCollectionViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/ArticleThemesTableViewControllerPage */
  private goToArticleThemesTableViewController(): void {
    router.pushUrl({ url: 'pages/ArticleThemesTableViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/ArticleThemesTableViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/ColorPaletteTableViewControllerPage */
  private goToColorPaletteTableViewController(): void {
    router.pushUrl({ url: 'pages/ColorPaletteTableViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/ColorPaletteTableViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/ErrorLogViewPage */
  private goToErrorLogView(): void {
    router.pushUrl({ url: 'pages/ErrorLogViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/ErrorLogViewPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/ActivityLogViewPage */
  private goToActivityLogView(): void {
    router.pushUrl({ url: 'pages/ActivityLogViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/ActivityLogViewPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/AccountStatsViewPage */
  private goToAccountStatsView(): void {
    router.pushUrl({ url: 'pages/AccountStatsViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/AccountStatsViewPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/DinosaursViewPage */
  private goToDinosaursView(): void {
    router.pushUrl({ url: 'pages/DinosaursViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/DinosaursViewPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/CloudKitStatsViewPage */
  private goToCloudKitStatsView(): void {
    router.pushUrl({ url: 'pages/CloudKitStatsViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/CloudKitStatsViewPage failed: %{public}s', err.message);
      });
  }

  /** the settings screen -> pages/AboutViewPage */
  private goToAboutView(): void {
    router.pushUrl({ url: 'pages/AboutViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/AboutViewPage failed: %{public}s', err.message);
      });
  }

  private done(): void {
    this.overlayShown = false;
    router.back();
  }

  /** Accounts row -> AccountInspectorViewController for that account. */
  private openAccountInspector(account: AccountService): void {
    AppStorage.setOrCreate<string>('nnwInspectedAccountID', account.accountID);
    const params: Record<string, string> = { 'accountID': account.accountID };
    router.pushUrl({ url: 'pages/AccountInspectorViewControllerPage', params: params })
      .catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'push account inspector failed: %{public}s', err.message);
    });
  }

  /**
   * `addFeed()` — dismisses Settings, then presents Add Feed prefilled with the
   * NetNewsWire news feed.
   */
  private addNetNewsWireNewsFeed(): void {
    this.overlayShown = false;
    const params: Record<string, string> = {
      'initialFeed': netNewsWireNewsURL,
      'initialFeedName': 'NetNewsWire News'
    };
    router.pushUrl({ url: 'pages/AddFeedViewControllerPage', params: params })
      .catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'push add feed failed: %{public}s', err.message);
    });
  }

  /**
   * The Notifications/Badge/Data row. `UIApplication.openSettingsURLString` has no
   * general HarmonyOS counterpart (per the platform docs, "APIs related to startup
   * settings are under planning"); the notification management screen is the one system
   * settings surface an app may open, and it is what this section is about.
   */
  private openSystemSettings(): void {
    notificationManager.openNotificationSettings(this.uiAbilityContext())
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'openNotificationSettings failed: %{public}s', err.message);
      });
  }

  /** openURL(_:) — the source's SFSafariViewController .pageSheet. */
  private openHelpURL(urlString: string): void {
    BrowserService.shared.openLink(this.uiAbilityContext(), urlString)
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'open %{public}s failed: %{public}s', urlString, err.message);
      });
  }

  // MARK: - Switch actions

  private switchTimelineOrder(value: boolean): void {
    this.sortOldestToNewest = value;
    AppDefaults.timelineSortDirection =
      value ? SortDirection.orderedAscending : SortDirection.orderedDescending;
    // The coordinator caches the sort parameters (restoreWindowState reads them once). The
    // source refreshed that copy off UserDefaults.didChangeNotification, which has no
    // HarmonyOS counterpart, so the write reached the store and the timeline kept the
    // start-up order until the next launch.
    SceneCoordinator.shared.sortParametersDidChange();
  }

  private switchGroupByFeed(value: boolean): void {
    this.groupByFeed = value;
    AppDefaults.timelineGroupByFeed = value;
    // Same cached copy as the sort direction — see switchTimelineOrder.
    SceneCoordinator.shared.sortParametersDidChange();
  }

  private switchClearsReadArticles(value: boolean): void {
    this.refreshClearsReadArticles = value;
    AppDefaults.refreshClearsReadArticles = value;
  }

  private switchConfirmMarkAllAsRead(value: boolean): void {
    this.confirmMarkAllAsRead = value;
    AppDefaults.confirmMarkAllAsRead = value;
  }

  /** "Open Links in NetNewsWire" is the INVERSE of useSystemBrowser. */
  private switchBrowserPreference(value: boolean): void {
    this.openLinksInApp = value;
    AppDefaults.useSystemBrowser = !value;
  }

  private switchJavaScriptPreference(value: boolean): void {
    this.enableJavaScript = value;
    AppDefaults.isArticleContentJavascriptEnabled = value;
  }

  private switchFullscreenArticles(value: boolean): void {
    this.fullscreenArticles = value;
    AppDefaults.articleFullscreenAvailable = value;
  }

  // MARK: - OPML import / export

  private presentError(title: string, message: string): void {
    AlertDialog.show({
      title: title,
      message: message,
      confirm: {
        value: 'OK',
        action: () => {
          hilog.info(DOMAIN, TAG, 'error alert dismissed');
        }
      }
    });
  }

  /** importOPML(sourceView:sourceRect:) — 0 / 1 / many active accounts. */
  private importOPML(): void {
    const active: AccountService[] = AccountManager.shared.activeAccounts;
    if (active.length === 0) {
      this.presentError('Error', 'You must have at least one active account.');
      return;
    }
    if (active.length === 1) {
      this.opmlAccount = active[0];
      this.importOPMLDocumentPicker();
      return;
    }
    this.presentAccountPicker(
      'Choose an account to receive the imported feeds and folders',
      AccountManager.shared.sortedActiveAccounts,
      (account: AccountService): void => {
        this.opmlAccount = account;
        this.importOPMLDocumentPicker();
      });
  }

  /** exportOPML(sourceView:sourceRect:) — one account exports straight away. */
  private exportOPML(): void {
    const all: AccountService[] = AccountManager.shared.accounts;
    if (all.length === 0) {
      this.presentError('Error', 'You must have at least one active account.');
      return;
    }
    if (all.length === 1) {
      this.opmlAccount = all[0];
      this.exportOPMLDocumentPicker();
      return;
    }
    this.presentAccountPicker(
      'Choose an account with the subscriptions to export',
      AccountManager.shared.sortedAccounts,
      (account: AccountService): void => {
        this.opmlAccount = account;
        this.exportOPMLDocumentPicker();
      });
  }

  private presentAccountPicker(title: string, accounts: AccountService[],
    onPick: (account: AccountService) => void): void {
    const sheets: SheetInfo[] = [];
    for (const account of accounts) {
      sheets.push({
        title: account.nameForDisplay,
        action: () => {
          onPick(account);
        }
      });
    }
    ActionSheet.show({
      title: title,
      // UIAlertController(title:message:preferredStyle:.actionSheet) — the source passes nil.
      message: '',
      sheets: sheets,
      confirm: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'account picker cancelled');
        }
      }
    });
  }

  /** UIDocumentPickerViewController(forOpeningContentTypes:) for OPML. */
  private importOPMLDocumentPicker(): void {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = ['.opml', '.xml'];
    const documentPicker: picker.DocumentViewPicker =
      new picker.DocumentViewPicker(this.uiAbilityContext());
    documentPicker.select(options)
      .then((uris: string[]) => {
        if (uris.length === 0) {
          return;
        }
        this.importPickedOPML(uris[0]);
      })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'document select failed: %{public}s', err.message);
      });
  }

  /**
   * The picker hands back a URI, and the account importer reads a sandbox path, so the
   * document is copied in first.
   */
  private importPickedOPML(uri: string): void {
    const account: AccountService | undefined = this.opmlAccount;
    if (account === undefined) {
      return;
    }
    const localPath: string = AppContext.cacheSubfolder('opml') + '/import.opml';
    let sourceFile: fs.File | undefined = undefined;
    try {
      sourceFile = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      fs.copyFileSync(sourceFile.fd, localPath);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'copying the picked OPML failed: %{public}s', String(e));
      this.presentError('Import Failed', 'We were unable to process the selected file. '
        + ' Please ensure that it is a properly formatted OPML file.');
      return;
    } finally {
      if (sourceFile !== undefined) {
        fs.closeSync(sourceFile);
      }
    }
    // The import is expected to show an activity indication while it runs. The source's is
    // ActivityLog's running-activity button on the FEED screen (MainFeedCollectionViewController
    // .swift:112-113), not on this one — and the remote path's upload leaves this screen silent.
    // A toast is the same non-blocking shape: it adds no node to this page's build(), it cannot
    // cover or delay the AlertDialog below, and the text is the source's own activity name
    // (ActivityKind.swift:87-88 = model/Activity.ts:155). The trailing refreshAll is NOT covered
    // here — RefreshProgressView already draws that on the Feeds screen.
    // ponytail: a toast caps at 10s; the upload is one POST, so it lands well inside that.
    let toastID: number = -1;
    let finished: boolean = false;
    const endToast: () => void = (): void => {
      finished = true;
      if (toastID >= 0) {
        this.getUIContext().getPromptAction().closeToast(toastID);
        toastID = -1;
      }
    };
    // Only opened if the import is still running after a beat, so the local account's instant
    // import never flashes it.
    setTimeout((): void => {
      if (finished) {
        return;
      }
      this.getUIContext().getPromptAction()
        .openToast({ message: 'Importing OPML', duration: 10000 })
        .then((id: number): void => {
          if (finished) {
            this.getUIContext().getPromptAction().closeToast(id);
          } else {
            toastID = id;
          }
        })
        .catch((err: BusinessError): void => {
          hilog.warn(DOMAIN, TAG, 'import toast failed: %{public}s', err.message);
        });
    }, 700);
    // The imported feeds are in the account tree, but the Feeds screen renders the
    // coordinator's CACHED sidebar rows and nothing rebuilds them on an account change, so an
    // import was invisible until the next launch rebuilt the tree. The rebuild used to hang off
    // the promise BELOW — which only settles once importOPML's trailing refreshAll has
    // downloaded every feed of the account, minutes on a large OPML import. It
    // now runs off the callback, as soon as the feeds are in the tree; the `then` rebuild stays
    // for the unread counts the refresh brings in.
    account.importOPML(localPath, (): void => {
      endToast();
      SceneCoordinator.shared.rebuildBackingStores();
      this.reloadData();
    })
      .then(() => {
        SceneCoordinator.shared.rebuildBackingStores();
        this.reloadData();
      })
      .catch((err: BusinessError) => {
        // Closed BEFORE the dialog: the error alert is the thing that must be seen.
        endToast();
        hilog.error(DOMAIN, TAG, 'importOPML failed: %{public}s', err.message);
        this.presentError('Import Failed', 'We were unable to process the selected file. '
          + ' Please ensure that it is a properly formatted OPML file.');
      });
  }

  /** exportOPMLDocumentPicker() — write Subscriptions-<Account>.opml, then hand it over. */
  private exportOPMLDocumentPicker(): void {
    const account: AccountService | undefined = this.opmlAccount;
    if (account === undefined) {
      return;
    }
    const accountName: string = account.nameForDisplay.split(' ').join('').trim();
    const filename: string = 'Subscriptions-' + accountName + '.opml';
    const tempFile: string = AppContext.cacheSubfolder('opml') + '/' + filename;
    const activityID: number = account.logActivityStart(ActivityKindType.exportOPML, filename);
    let file: fs.File | undefined = undefined;
    try {
      const contents: string = opmlDocumentString(filename, account.opmlString());
      file = fs.openSync(tempFile, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE
        | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, contents);
      account.logActivityComplete(activityID);
    } catch (e) {
      account.logActivityFail(activityID, new Error(String(e)));
      this.presentError('OPML Export Error', String(e));
      return;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
    this.saveExportedOPML(tempFile, filename);
  }

  private saveExportedOPML(tempFile: string, filename: string): void {
    const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    options.newFileNames = [filename];
    const documentPicker: picker.DocumentViewPicker =
      new picker.DocumentViewPicker(this.uiAbilityContext());
    documentPicker.save(options)
      .then((uris: string[]) => {
        if (uris.length === 0) {
          return;
        }
        let destination: fs.File | undefined = undefined;
        try {
          destination = fs.openSync(uris[0], fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
          fs.copyFileSync(tempFile, destination.fd);
        } catch (e) {
          hilog.error(DOMAIN, TAG, 'writing the exported OPML failed: %{public}s', String(e));
          this.presentError('OPML Export Error', String(e));
        } finally {
          if (destination !== undefined) {
            fs.closeSync(destination);
          }
        }
      })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'document save failed: %{public}s', err.message);
      });
  }

  private pickRefreshInterval(): void {
    const sheets: SheetInfo[] = [];
    for (const interval of allRefreshIntervals) {
      sheets.push({
        title: refreshIntervalDescription(interval),
        action: () => {
          this.applyRefreshInterval(interval);
        }
      });
    }
    ActionSheet.show({
      title: 'Refresh Interval',
      // UIAlertController(title:message:preferredStyle:.actionSheet) — the source passes nil.
      message: '',
      sheets: sheets,
      confirm: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'refresh interval picker cancelled');
        }
      }
    });
  }

  private applyRefreshInterval(interval: RefreshInterval): void {
    setCurrentRefreshInterval(interval);
    this.refreshIntervalLabel = refreshIntervalDescription(interval);
  }

  // MARK: - Build
  //
  // Styling measured off the iOS reference capture of SettingsViewController
  // (390x844pt): the sheet sits on systemGroupedBackground; each section is ONE white card
  // inset 16pt a side ([16,…][374,…]) with ~10pt corners; rows are 51pt with a 0.5 hairline
  // between them, inset 16pt inside the card; section headers are a 38pt band of bare
  // background with 18pt of air above. Tokens come from the style baseline.

  /** The hairline between two rows of one card (capture: inset 16pt each side). */
  @Builder
  rowSeparator() {
    Divider()
      .strokeWidth(0.5)
      .color($r('sys.color.ohos_id_color_list_separator'))
      .margin({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
  }

  @Builder
  notificationsSection() {
    Column() {
      VibrantSectionHeader({ title: 'Notifications, Badge, Data, & More' })
      Column() {
        VibrantBasicTableViewCell({
          label: 'Open System Settings',
          showsDisclosure: true,
          rowId: 'settings_open_system_settings',
          onTap: (): void => {
            this.openSystemSettings();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  accountsSection() {
    Column() {
      VibrantSectionHeader({ title: 'Accounts' })
      Column() {
        ForEach(this.accounts, (account: AccountService) => {
          SettingsComboTableViewCell({
            comboImage: accountImageResource(account.type),
            comboNameLabel: account.nameForDisplay,
            rowId: 'settings_account_itemroot',
            onTap: (): void => {
              this.openAccountInspector(account);
            }
          })
          // Every account row is followed by one — the last one divides it from Add Account.
          this.rowSeparator()
        }, (account: AccountService) => account.accountID)
        VibrantBasicTableViewCell({
          label: 'Add Account',
          showsDisclosure: true,
          rowId: 'settings_add_account',
          onTap: (): void => {
            this.goToAddAccountViewController();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  feedsSection() {
    Column() {
      VibrantSectionHeader({ title: 'Feeds' })
      Column() {
        VibrantBasicTableViewCell({
          label: 'Import Subscriptions',
          rowId: 'settings_import_subscriptions',
          onTap: (): void => {
            this.importOPML();
          }
        })
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Export Subscriptions',
          rowId: 'settings_export_subscriptions',
          onTap: (): void => {
            this.exportOPML();
          }
        })
        if (this.showsAddNewsFeedRow) {
          this.rowSeparator()
          VibrantBasicTableViewCell({
            label: 'Add NetNewsWire News Feed',
            rowId: 'settings_add_news_feed',
            onTap: (): void => {
              this.addNetNewsWireNewsFeed();
            }
          })
        }
        // No source UI counterpart (it was a Mac-only preference), but the timer in
        // common/timer/RefreshTimers.ts reads it, so it needs somewhere to live now that
        // the invented "Advanced" section that held it is gone.
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Refresh Interval',
          detail: this.refreshIntervalLabel,
          showsDisclosure: true,
          rowId: 'settings_refresh_interval',
          onTap: (): void => {
            this.pickRefreshInterval();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  timelineSection() {
    Column() {
      VibrantSectionHeader({ title: 'Timeline' })
      Column() {
        VibrantSwitchTableViewCell({
          label: 'Sort Oldest to Newest',
          isOn: this.sortOldestToNewest,
          switchId: 'settings_sort_oldest_to_newest',
          onSwitchChange: (value: boolean): void => {
            this.switchTimelineOrder(value);
          }
        })
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Group by Feed',
          isOn: this.groupByFeed,
          switchId: 'settings_group_by_feed',
          onSwitchChange: (value: boolean): void => {
            this.switchGroupByFeed(value);
          }
        })
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Refresh to Clear Read Articles',
          isOn: this.refreshClearsReadArticles,
          switchId: 'settings_refresh_clears_read_articles',
          onSwitchChange: (value: boolean): void => {
            this.switchClearsReadArticles(value);
          }
        })
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Confirm Mark All as Read',
          isOn: this.confirmMarkAllAsRead,
          switchId: 'settings_confirm_mark_all_as_read',
          onSwitchChange: (value: boolean): void => {
            this.switchConfirmMarkAllAsRead(value);
          }
        })
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Timeline Layout',
          showsDisclosure: true,
          rowId: 'settings_timeline_layout',
          onTap: (): void => {
            this.goToTimelineCustomizerCollectionViewController();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  /**
   * The explanatory caption a Settings switch cell carries under its label — a
   * `UICTFontTextStyleFootnote` label INSIDE the same cell as the switch
   * (Settings.storyboard: FkT-O9-gpj under Enable JavaScript, a30-nc-ZS4 under Enable Full
   * Screen Articles), pinned to the cell's leading margin, not a section footer.
   */
  @Builder
  rowCaption(text: string) {
    Text(text)
      .width('100%')
      .fontSize($r('sys.float.ohos_id_text_size_body3'))
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
      })
  }

  @Builder
  articlesSection() {
    Column() {
      VibrantSectionHeader({ title: 'Articles' })
      Column() {
        VibrantBasicTableViewCell({
          label: $r('app.string.theme'),
          detail: this.currentThemeName,
          showsDisclosure: true,
          rowId: 'settings_theme',
          onTap: (): void => {
            this.goToArticleThemesTableViewController();
          }
        })
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Open Links in NetNewsWire',
          isOn: this.openLinksInApp,
          switchId: 'settings_open_links_in_app',
          onSwitchChange: (value: boolean): void => {
            this.switchBrowserPreference(value);
          }
        })
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Enable JavaScript',
          isOn: this.enableJavaScript,
          switchId: 'settings_enable_javascript',
          onSwitchChange: (value: boolean): void => {
            this.switchJavaScriptPreference(value);
          }
        })
        this.rowCaption('Some content, such as videos and embedded social media posts, ' +
          'may require JavaScript to work correctly.')
        if (this.isPhoneIdiom()) {
          this.rowSeparator()
          VibrantSwitchTableViewCell({
            label: 'Enable Full Screen Articles',
            isOn: this.fullscreenArticles,
            switchId: 'settings_fullscreen_articles',
            onSwitchChange: (value: boolean): void => {
              this.switchFullscreenArticles(value);
            }
          })
          this.rowCaption('Tap the article top bar to enter Full Screen. ' +
            'Tap the top or bottom to exit.')
        }
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  appearanceSection() {
    Column() {
      VibrantSectionHeader({ title: 'Appearance' })
      Column() {
        VibrantBasicTableViewCell({
          label: $r('app.string.color_palette'),
          detail: this.colorPalette,
          showsDisclosure: true,
          rowId: 'settings_color_palette',
          onTap: (): void => {
            this.goToColorPaletteTableViewController();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  troubleshootingSection() {
    Column() {
      VibrantSectionHeader({ title: 'Troubleshooting' })
      Column() {
        VibrantBasicTableViewCell({
          label: 'Error Log',
          showsDisclosure: true,
          rowId: 'settings_error_log',
          onTap: (): void => {
            this.goToErrorLogView();
          }
        })
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Activity Log',
          showsDisclosure: true,
          rowId: 'settings_activity_log',
          onTap: (): void => {
            this.goToActivityLogView();
          }
        })
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Account Stats',
          showsDisclosure: true,
          rowId: 'settings_account_stats',
          onTap: (): void => {
            this.goToAccountStatsView();
          }
        })
        this.rowSeparator()
        VibrantBasicTableViewCell({
          label: 'Dinosaurs',
          showsDisclosure: true,
          rowId: 'settings_dinosaurs',
          onTap: (): void => {
            this.goToDinosaursView();
          }
        })
        if (this.hasiCloudAccount) {
          this.rowSeparator()
          VibrantBasicTableViewCell({
            label: 'iCloud Storage Stats',
            showsDisclosure: true,
            rowId: 'settings_icloud_stats',
            onTap: (): void => {
              this.goToCloudKitStatsView();
            }
          })
        }
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  helpSection() {
    Column() {
      VibrantSectionHeader({ title: 'Help' })
      Column() {
        ForEach(helpRows, (row: HelpRowItem) => {
          VibrantBasicTableViewCell({
            label: row.title,
            rowId: 'settings_help_itemroot',
            onTap: (): void => {
              this.openHelpURL(row.url);
            }
          })
          // The last help row's hairline divides it from About NetNewsWire.
          this.rowSeparator()
        }, (row: HelpRowItem) => row.url)
        VibrantBasicTableViewCell({
          label: 'About NetNewsWire',
          showsDisclosure: true,
          rowId: 'settings_about',
          onTap: (): void => {
            this.goToAboutView();
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  @Builder
  overlayBody() {
    Column() {
      // Nav bar (capture: the 54pt band y63..117, "Settings" centred and semibold, the Done
      // bar button a 36pt glass chip at [334,67][370,103], a pushed
      // /presented screen's title is CENTRED and inline).
      Stack({ alignContent: Alignment.Center }) {
        Text('Settings')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Row() {
          Blank()
          VibrantButton({
            title: 'Done',
            compact: true,
            buttonId: 'settings_done',
            onTap: (): void => {
              this.done();
            }
          })
            .width(76)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        // The overlay Row must not swallow taps aimed at what sits under it.
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(54)
      .padding({ left: 20, right: 20 })

      Scroll() {
        Column() {
          this.notificationsSection()
          this.accountsSection()
          this.feedsSection()
          this.timelineSection()
          this.articlesSection()
          this.appearanceSection()
          this.troubleshootingSection()
          this.helpSection()
          // tableFooterView (capture: "NetNewsWire 7.1.3 (Build 7205)" at x32, footnote grey)
          Text(this.buildLabel)
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding({ left: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
            .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
        }
        .width('100%')
        // The grouped-list side inset — the cards are x16..374 in the 390pt capture.
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: 32
        })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    // systemGroupedBackground — #F1F3F5 light / #000000 dark.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  build() {
    Stack() {
    }
    .id('SettingsViewController')
    .width('100%')
    .height('100%')
    // systemGroupedBackground — the same token the sheet body and the feed list underneath
    // paint. Leaving this root unpainted showed the window's default WHITE for the length of
    // the sheet's close animation and the pop transition, which is the white page the tester
    // sees between Settings and Feeds. The other empty-root pages already carry it.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // The back gesture (and a drag-down) closes the sheet without taking the page off the
        // foreground, so onPageShow never fires and the restore above cannot run: the gesture
        // would strand the empty root on screen and a SECOND gesture would be needed to leave.
        // Settings is presented FROM the feed list, so leaving it means exactly what Done
        // means — take the dismissal over and route it there.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.done();
        } })
  }
}
