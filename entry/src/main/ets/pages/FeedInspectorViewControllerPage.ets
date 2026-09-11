/**
 * FeedInspectorViewControllerPage
 * (source: iOS/Inspector/FeedInspectorViewController.swift + Inspector.storyboard).
 *
 * Per-feed settings sheet presented over the reader (presentation: modal, hostScreen
 * the root split component).
 *
 * Two source-driven conditionals live here, not in the styling passes:
 *  - the WHOLE Home Page section disappears when feed.homePageURL is nil (`shift(_:)`
 *    renumbers the later sections);
 *  - the notification switch forks on the notification authorization status — denied
 *    reverts the switch and offers Open Settings, undetermined asks for authorization
 *    first and reverts on refusal.
 */

import common from '@ohos.app.ability.common';
import notificationManager from '@ohos.notificationManager';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Feed } from '../model/Feed';
import { IconImage } from '../model/IconImage';
import { AccountManager } from '../common/account/AccountManager';
import { AccountService } from '../common/account/Account';
import {
  IconImageCache,
  FeedIconDownloader,
  FeedIconAvailableListener
} from '../common/images/IconImageCache';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { BrowserService } from '../common/system/BrowserService';
import { InspectorIconHeaderView } from '../components/InspectorIconHeader';
import {
  VibrantBasicTableViewCell,
  VibrantButton,
  VibrantSectionHeader,
  VibrantSwitchTableViewCell,
  vibrantRowMinHeight
} from '../components/VibrantCell';

const DOMAIN: number = 0x0001;
const TAG: string = 'FeedInspectorViewControllerPage';

/** AppStorage key the sidebar / timeline / article link writes before raising this sheet. */
const inspectedFeedIDKey: string = 'nnwInspectedFeedID';

/**
 * UNAuthorizationStatus. HarmonyOS reports only "notifications enabled" or not, so the
 * third state is recovered the way the OS models it: `requestEnableNotification` may be
 * shown once, and a later refusal is permanent — so "we already asked and they are still
 * off" is `denied`.
 */
enum NotificationAuthorization {
  notDetermined = 0,
  denied = 1,
  authorized = 2
}

const didRequestNotificationAuthorizationKey: string = 'nnwDidRequestNotificationAuthorization';

/** The current authorization status, in the source's three-state shape. */
function currentNotificationAuthorization(): NotificationAuthorization {
  let enabled: boolean = false;
  try {
    enabled = notificationManager.isNotificationEnabledSync();
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'isNotificationEnabledSync failed: %{public}s', String(e));
  }
  if (enabled) {
    return NotificationAuthorization.authorized;
  }
  return AppDefaults.boolValue(didRequestNotificationAuthorizationKey)
    ? NotificationAuthorization.denied
    : NotificationAuthorization.notDetermined;
}

@Entry
@Component
struct FeedInspectorViewControllerPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State overlayShown: boolean = true;

  /** SceneCoordinator inspectedFeedID, resolved through AccountService. */
  @StorageLink(inspectedFeedIDKey) inspectedFeedID: string = '';

  /** navigationItem.title = feed.nameForDisplay. */
  @State title: string = '';
  /** nameTextField — committed on disappear via account.renameFeed. */
  @State nameDraft: string = '';
  /** feed.newArticleNotificationsEnabled, forked on the authorization status. */
  @State notificationsEnabled: boolean = false;
  /** feed.readerViewAlwaysEnabled. */
  @State readerViewAlways: boolean = false;
  /** The section-0 row-1 label — feed.notificationDisplayName.capitalized, two lines. */
  @State notificationLabel: string = 'Notify About New Articles';
  /** feed.homePageURL — nil removes the whole Home Page section. */
  @State homePageURL: string = '';
  /** feed.url. */
  @State feedURL: string = '';
  /** IconImageCache -> the feed icon, which arrives asynchronously. */
  @State iconURL: string = '';
  @State iconResourceName: string = '';
  /** UserNotificationManager authorization status, refreshed on appear and on foreground. */
  @State authStatus: number = NotificationAuthorization.notDetermined as number;

  private feed?: Feed;
  private account?: AccountService;
  private iconListener: FeedIconAvailableListener = (feed: Feed): void => {
    this.refreshIcon();
  };

  aboutToAppear(): void {
    this.loadFeed();
    this.updateNotificationSettings();
    // .feedIconDidBecomeAvailable — the icon resolves lazily out of the cache.
    FeedIconDownloader.shared.addListener(this.iconListener);
  }

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown
    // to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
    // viewDidAppear + willEnterForeground both re-read the authorization status.
    this.updateNotificationSettings();
  }

  /** viewDidDisappear — the source commits the rename on the way out. */
  aboutToDisappear(): void {
    FeedIconDownloader.shared.removeListener(this.iconListener);
    this.commitRename();
  }

  onPageHide(): void {
    this.commitRename();
  }

  // MARK: - Data

  private resolveFeed(): Feed | undefined {
    const params: Record<string, string> | undefined =
      router.getParams() as Record<string, string>;
    if (params !== undefined && params !== null) {
      const routedID: string | undefined = params.feedID;
      if (routedID !== undefined && routedID.length > 0) {
        const routed: Feed | undefined = this.feedWithID(routedID);
        if (routed !== undefined) {
          return routed;
        }
      }
    }
    if (this.inspectedFeedID.length > 0) {
      const stored: Feed | undefined = this.feedWithID(this.inspectedFeedID);
      if (stored !== undefined) {
        return stored;
      }
    }
    // No feed named: the first feed, which is what the capture inspected.
    for (const account of AccountManager.shared.sortedAccounts) {
      const feeds: Feed[] = account.flattenedFeeds();
      if (feeds.length > 0) {
        return feeds[0];
      }
    }
    return undefined;
  }

  private feedWithID(feedID: string): Feed | undefined {
    for (const account of AccountManager.shared.accounts) {
      const feed: Feed | undefined = account.existingFeedWithFeedID(feedID);
      if (feed !== undefined) {
        return feed;
      }
    }
    return undefined;
  }

  private loadFeed(): void {
    const feed: Feed | undefined = this.resolveFeed();
    this.feed = feed;
    if (feed === undefined) {
      return;
    }
    this.account = AccountManager.shared.accountForFeed(feed);
    this.title = feed.nameForDisplay;
    this.nameDraft = feed.nameForDisplay;
    this.notificationsEnabled = feed.newArticleNotificationsEnabled;
    this.readerViewAlways = feed.readerViewAlwaysEnabled;
    this.notificationLabel = capitalized(feed.notificationDisplayName);
    this.homePageURL = feed.homePageURL ?? '';
    this.feedURL = feed.url;
    this.refreshIcon();
  }

  private refreshIcon(): void {
    const feed: Feed | undefined = this.feed;
    if (feed === undefined) {
      return;
    }
    const icon: IconImage | undefined = IconImageCache.shared.imageForFeed(feed);
    this.iconURL = icon === undefined ? '' : (icon.sourceURL ?? '');
    this.iconResourceName = icon === undefined ? '' : (icon.resourceName ?? '');
  }

  /** viewDidDisappear — rename when the text actually changed. */
  private commitRename(): void {
    const feed: Feed | undefined = this.feed;
    const account: AccountService | undefined = this.account;
    if (feed === undefined || account === undefined) {
      return;
    }
    if (this.nameDraft === feed.nameForDisplay) {
      return;
    }
    const newName: string = this.nameDraft.length > 0
      ? this.nameDraft
      : (feed.name ?? 'Untitled');
    account.renameFeed(feed, newName)
      .then(() => {
        this.title = feed.nameForDisplay;
      })
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'renameFeed failed: %{public}s', err.message);
      });
  }

  private persistFeedSettings(): void {
    const feed: Feed | undefined = this.feed;
    const account: AccountService | undefined = this.account;
    if (feed === undefined || account === undefined) {
      return;
    }
    account.persistFeedSettings(feed).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'persistFeedSettings failed: %{public}s', err.message);
    });
  }

  // MARK: - Notifications

  private uiAbilityContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  /** updateNotificationSettings() — getNotificationSettings + the status it publishes. */
  private updateNotificationSettings(): void {
    this.authStatus = currentNotificationAuthorization() as number;
  }

  /** newArticleNotificationsEnabledChanged(_:). */
  private notificationsSwitchChanged(value: boolean): void {
    const feed: Feed | undefined = this.feed;
    if (feed === undefined) {
      this.notificationsEnabled = !value;
      return;
    }
    if (this.authStatus === (NotificationAuthorization.denied as number)) {
      // Revert the switch and offer the Settings app, as the source alert does.
      this.notificationsEnabled = !value;
      this.presentNotificationUpdateErrorAlert();
      return;
    }
    if (this.authStatus === (NotificationAuthorization.authorized as number)) {
      this.notificationsEnabled = value;
      feed.newArticleNotificationsEnabled = value;
      this.persistFeedSettings();
      return;
    }
    // notDetermined — ask first, then apply or revert on refusal.
    AppDefaults.setBool(didRequestNotificationAuthorizationKey, true);
    notificationManager.requestEnableNotification(this.uiAbilityContext())
      .then(() => {
        this.updateNotificationSettings();
        if (this.authStatus === (NotificationAuthorization.authorized as number)) {
          this.notificationsEnabled = value;
          feed.newArticleNotificationsEnabled = value;
          this.persistFeedSettings();
        } else {
          this.notificationsEnabled = !value;
        }
      })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'requestEnableNotification refused: %{public}s', err.message);
        this.updateNotificationSettings();
        this.notificationsEnabled = !value;
      });
  }

  /** notificationUpdateErrorAlert() — "Notifications need to be enabled in the Settings app." */
  private presentNotificationUpdateErrorAlert(): void {
    AlertDialog.show({
      title: 'Enable Notifications',
      message: 'Notifications need to be enabled in the Settings app.',
      primaryButton: {
        value: 'Dismiss',
        action: () => {
          hilog.info(DOMAIN, TAG, 'notification alert dismissed');
        }
      },
      secondaryButton: {
        value: 'Open Settings',
        action: () => {
          this.openNotificationSettings();
        }
      }
    });
  }

  private openNotificationSettings(): void {
    notificationManager.openNotificationSettings(this.uiAbilityContext())
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'openNotificationSettings failed: %{public}s', err.message);
      });
  }

  // MARK: - Actions

  /** readerViewAlwaysEnabledChanged(_:). */
  private readerViewSwitchChanged(value: boolean): void {
    const feed: Feed | undefined = this.feed;
    if (feed === undefined) {
      return;
    }
    this.readerViewAlways = value;
    feed.readerViewAlwaysEnabled = value;
    this.persistFeedSettings();
  }

  /** didSelectRowAt homePageIndexPath — SFSafariViewController .pageSheet in the source. */
  private openHomePage(): void {
    if (this.homePageURL.length === 0) {
      return;
    }
    BrowserService.shared.openLink(this.uiAbilityContext(), this.homePageURL)
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'open home page failed: %{public}s', err.message);
      });
  }

  /** The rows' context menus — UIPasteboard.general.string = urlString. */
  private copyHomePageURL(): void {
    BrowserService.shared.copyLink(this.homePageURL);
  }

  private copyFeedURL(): void {
    BrowserService.shared.copyLink(this.feedURL);
  }

  private done(): void {
    this.commitRename();
    this.overlayShown = false;
    router.back();
  }

  // MARK: - Build

  @Builder
  copyHomePageMenu() {
    Menu() {
      MenuItem({
        startIcon: $r('app.media.ic_sf_document_on_document'),
        content: 'Copy Home Page URL'
      })
        .onClick(() => {
          this.copyHomePageURL();
        })
    }
  }

  @Builder
  copyFeedURLMenu() {
    Menu() {
      MenuItem({
        startIcon: $r('app.media.ic_sf_document_on_document'),
        content: 'Copy Feed URL'
      })
        .onClick(() => {
          this.copyFeedURL();
        })
    }
  }

  // Styling measured off the iOS reference capture of FeedInspectorViewController
  // (390x844pt): the sheet sits on systemGroupedBackground; the nav band is y63..117 with the
  // feed name centred and a PROMINENT (accent-filled) Done at [20,67][56,103]; the icon header
  // fills y117..205 (88pt, a 48pt icon); each section is ONE white card inset 16pt a side with
  // 51pt rows and a 0.5 hairline between them. Tokens: the style baseline.

  /** The hairline between two rows of one card. */
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
  overlayBody() {
    Column() {
      // Nav bar: title = feed.nameForDisplay (centred, inline),
      // leading Done.
      Stack({ alignContent: Alignment.Center }) {
        Text(this.title)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ left: 76, right: 76 })
        Row() {
          VibrantButton({
            title: 'Done',
            compact: true,
            prominent: true,
            buttonId: 'feed_inspector_done',
            onTap: (): void => {
              this.done();
            }
          })
            .width(76)
          Blank()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(54)
      .padding({ left: 20, right: 20 })

      Scroll() {
        Column() {
          // Section 0 — the icon header the source swaps in, then name + the two switches.
          InspectorIconHeaderView({
            iconURL: this.iconURL,
            iconResourceName: this.iconResourceName
          })

          Column() {
            TextInput({ text: this.nameDraft, placeholder: 'Name' })
              .id('feed_inspector_name')
              .width('100%')
              .height(vibrantRowMinHeight)
              .backgroundColor(Color.Transparent)
              .borderRadius(0)
              .padding({
                left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
                right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
              })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
              .caretColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .onChange((value: string) => {
                this.nameDraft = value;
              })
              .onSubmit(() => {
                this.commitRename();
              })

            this.rowSeparator()

            VibrantSwitchTableViewCell({
              label: this.notificationLabel,
              labelMaxLines: 2,
              isOn: this.notificationsEnabled,
              switchId: 'feed_inspector_notifications',
              onSwitchChange: (value: boolean): void => {
                this.notificationsSwitchChanged(value);
              }
            })

            this.rowSeparator()

            VibrantSwitchTableViewCell({
              label: 'Always Use Reader View',
              isOn: this.readerViewAlways,
              switchId: 'feed_inspector_reader_view',
              onSwitchChange: (value: boolean): void => {
                this.readerViewSwitchChanged(value);
              }
            })
          }
          .width('100%')
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          // Section 1 — removed entirely when the feed has no home page URL.
          if (this.homePageURL.length > 0) {
            VibrantSectionHeader({ title: $r('app.string.home_page') })
            Column() {
              // The capture's row carries the tinted `safari` accessory at its trailing edge.
              VibrantBasicTableViewCell({
                label: this.homePageURL,
                trailingIcon: $r('app.media.ic_sf_safari'),
                rowId: 'feed_inspector_home_page',
                onTap: (): void => {
                  this.openHomePage();
                }
              })
                .bindContextMenu(this.copyHomePageMenu, ResponseType.LongPress)
            }
            .width('100%')
            .backgroundColor($r('sys.color.ohos_id_color_background'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
            .clip(true)
          }

          // Section 2 — display-only; its context menu copies the URL.
          VibrantSectionHeader({ title: $r('app.string.feed_url') })
          Column() {
            VibrantBasicTableViewCell({
              label: this.feedURL,
              rowId: 'feed_inspector_feed_url'
            })
              .bindContextMenu(this.copyFeedURLMenu, ResponseType.LongPress)
          }
          .width('100%')
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)
        }
        .width('100%')
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
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  build() {
    Stack() {
    }
    .id('FeedInspectorViewController')
    .width('100%')
    .height('100%')
    // The root is empty, so it paints nothing while the sheet animates out and the following
    // router.back() runs — and an unpainted root shows the window's default WHITE. The other
    // sheet-hosting pages (AddFeedViewControllerPage, AddFolderViewControllerPage) already
    // carry this line and show no white flash; give the backdrop the same grouped grey the
    // sheet body uses.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // A back gesture or drag-down closes the sheet without hiding the page, so onPageShow
        // does not fire and the restore above cannot run: it would leave the empty root on
        // screen and take a second gesture to leave. The source commits the pending rename on
        // an interactive dismissal too, so this is Done — route it there.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.done();
        } })
  }
}

/**
 * `String.capitalized` for the notification row label — Swift title-cases EVERY word, so
 * `label.text = feed.notificationDisplayName.capitalized` (FeedInspectorViewController.swift:156)
 * turns "Notify about new articles" into "Notify About New Articles", which is what the capture
 * and the replay drivers match on. Capitalising only the first character rendered the sentence
 * case instead.
 */
function capitalized(text: string): string {
  return text.split(' ')
    .map((word: string): string => word.length === 0
      ? word
      : word.substring(0, 1).toUpperCase() + word.substring(1).toLowerCase())
    .join(' ');
}
