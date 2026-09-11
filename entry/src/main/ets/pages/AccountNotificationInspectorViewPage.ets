/**
 * AccountNotificationInspectorViewPage
 * (source: iOS/Account/AccountNotificationInspectorView.swift).
 *
 * Sheet with a close button that renders TWO entirely different layouts keyed on the
 * notification authorization status:
 *   notDetermined / denied -> the "Notifications Disabled" unavailable view (bell.slash)
 *                             plus an Open Settings button;
 *   authorized             -> the per-feed toggle list of account.flattenedFeeds(),
 *                             sorted case-insensitively by display name.
 * Only one branch was captured; the other comes from the source, so both
 * are built here rather than flattened into the captured one.
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
import { IconView } from '../components/IconView';
import { VibrantButton, vibrantRowMinHeight } from '../components/VibrantCell';

const DOMAIN: number = 0x0001;
const TAG: string = 'AccountNotificationInspectorViewPage';

/** AppStorage key the sidebar account-header context menu writes before raising this sheet. */
const inspectedAccountIDKey: string = 'nnwInspectedAccountID';
const didRequestNotificationAuthorizationKey: string = 'nnwDidRequestNotificationAuthorization';

/** UNAuthorizationStatus — see FeedInspectorViewControllerPage for why it is three-state. */
enum NotificationAuthorization {
  notDetermined = 0,
  denied = 1,
  authorized = 2
}

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

/** LazyForEach backing store for account.flattenedFeeds(). */
class FeedDataSource implements IDataSource {
  private feeds: Feed[] = [];
  private listeners: DataChangeListener[] = [];

  setFeeds(feeds: Feed[]): void {
    this.feeds = feeds;
    for (const listener of this.listeners) {
      listener.onDataReloaded();
    }
  }

  totalCount(): number {
    return this.feeds.length;
  }

  getData(index: number): Feed {
    return this.feeds[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    this.listeners = this.listeners.filter((l: DataChangeListener) => l !== listener);
  }

  reload(): void {
    for (const listener of this.listeners) {
      listener.onDataReloaded();
    }
  }
}

/**
 * One row of the toggle list: the cached favicon, the feed name and the switch that
 * writes feed.newArticleNotificationsEnabled straight through (the source does NOT
 * re-check permission here).
 *
 * This row's switch is the per-feed notification toggle; the id it is driven by is
 * `feed_notifications_itemroot`.
 */
@Component
struct FeedNotificationRow {
  /**
   * IconImageCache -> the feed's icon. The row is re-keyed on every
   * feedIconDidBecomeAvailable, so a plain member is enough to pick up a late icon.
   */
  iconImage?: IconImage;
  @Prop feedName: string = '';
  @Prop isOn: boolean = false;
  onToggle?: (value: boolean) => void;

  build() {
    Row({ space: 8 }) {
      if (this.iconImage !== undefined) {
        IconView({
          iconURL: this.iconImage?.sourceURL ?? '',
          symbolName: this.iconImage?.resourceName ?? '',
          dimension: 24
        })
      }
      Text(this.feedName)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Toggle({ type: ToggleType.Switch, isOn: this.isOn })
        .width(51)
        .height(31)
        .selectedColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .onChange((value: boolean) => {
          const handler: ((v: boolean) => void) | undefined = this.onToggle;
          if (handler !== undefined) {
            handler(value);
          }
        })
    }
    .width('100%')
    .constraintSize({ minHeight: vibrantRowMinHeight })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .alignItems(VerticalAlign.Center)
    .id('feed_notifications_itemroot')
  }
}

@Entry
@Component
struct AccountNotificationInspectorViewPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State overlayShown: boolean = true;

  /** SceneCoordinator inspectedAccountID. */
  @StorageLink(inspectedAccountIDKey) inspectedAccountID: string = '';

  /** navigationSubtitle = account.nameForDisplay. */
  @State accountName: string = '';
  /** UserNotificationManager authorization status — it flips the whole layout. */
  @State authStatus: number = NotificationAuthorization.notDetermined as number;
  /** Bumped whenever an icon arrives, so the rows re-read the cache (the source's `uuid`). */
  @State iconGeneration: number = 0;
  /** Drives the empty state when the account has no feeds. */
  @State feedCount: number = 0;

  private account?: AccountService;
  private feedSource: FeedDataSource = new FeedDataSource();
  private iconListener: FeedIconAvailableListener = (feed: Feed): void => {
    this.iconGeneration = this.iconGeneration + 1;
    this.feedSource.reload();
  };

  aboutToAppear(): void {
    this.loadAccount();
    this.refreshAuthorization();
    FeedIconDownloader.shared.addListener(this.iconListener);
  }

  /** .task + didBecomeActive — returning from the Settings app flips the layout. */
  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. Anything
    // that leaves this page closes that sheet and the `$$` two-way binding latches
    // overlayShown to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
    this.refreshAuthorization();
  }

  aboutToDisappear(): void {
    FeedIconDownloader.shared.removeListener(this.iconListener);
  }

  // MARK: - Data

  private resolveAccount(): AccountService | undefined {
    const params: Record<string, string> | undefined =
      router.getParams() as Record<string, string>;
    if (params !== undefined && params !== null) {
      const routedID: string | undefined = params.accountID;
      if (routedID !== undefined && routedID.length > 0) {
        const routed: AccountService | undefined =
          AccountManager.shared.existingAccount(routedID);
        if (routed !== undefined) {
          return routed;
        }
      }
    }
    if (this.inspectedAccountID.length > 0) {
      const stored: AccountService | undefined =
        AccountManager.shared.existingAccount(this.inspectedAccountID);
      if (stored !== undefined) {
        return stored;
      }
    }
    // No account named: the first account, which is what the capture inspected.
    const accounts: AccountService[] = AccountManager.shared.sortedAccounts;
    return accounts.length > 0 ? accounts[0] : undefined;
  }

  private loadAccount(): void {
    const account: AccountService | undefined = this.resolveAccount();
    this.account = account;
    if (account === undefined) {
      this.feedSource.setFeeds([]);
      this.feedCount = 0;
      return;
    }
    this.accountName = account.nameForDisplay;
    // `account.flattenedFeeds().sorted(by: localizedCaseInsensitiveCompare)`
    const feeds: Feed[] = account.flattenedFeeds().slice();
    feeds.sort((a: Feed, b: Feed): number => {
      const left: string = a.nameForDisplay.toLowerCase();
      const right: string = b.nameForDisplay.toLowerCase();
      return left < right ? -1 : (left > right ? 1 : 0);
    });
    this.feedSource.setFeeds(feeds);
    this.feedCount = feeds.length;
  }

  /** IconImageCache -> nothing (the source's third fallback, feed.smallIcon, has no
   * counterpart on the ported Feed model). */
  private iconImageFor(feed: Feed): IconImage | undefined {
    return IconImageCache.shared.imageForFeed(feed);
  }

  // MARK: - Actions

  private uiAbilityContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private refreshAuthorization(): void {
    this.authStatus = currentNotificationAuthorization() as number;
  }

  /** Open Settings — shown only in the denied/undetermined layout. */
  private openSettings(): void {
    if (this.authStatus === (NotificationAuthorization.notDetermined as number)) {
      // Never asked yet: the system prompt is the right surface, exactly once.
      AppDefaults.setBool(didRequestNotificationAuthorizationKey, true);
      notificationManager.requestEnableNotification(this.uiAbilityContext())
        .then(() => {
          this.refreshAuthorization();
        })
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'requestEnableNotification refused: %{public}s', err.message);
          this.refreshAuthorization();
        });
      return;
    }
    notificationManager.openNotificationSettings(this.uiAbilityContext())
      .then(() => {
        this.refreshAuthorization();
      })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'openNotificationSettings failed: %{public}s', err.message);
      });
  }

  /** The row toggle — written through with no permission re-check, as the source does. */
  private setFeedNotifications(feed: Feed, value: boolean): void {
    feed.newArticleNotificationsEnabled = value;
    const account: AccountService | undefined = AccountManager.shared.accountForFeed(feed);
    if (account === undefined) {
      return;
    }
    account.persistFeedSettings(feed).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'persistFeedSettings failed: %{public}s', err.message);
    });
  }

  private close(): void {
    this.overlayShown = false;
    router.back();
  }

  // MARK: - Build
  //
  // Styling measured off the iOS reference capture of AccountNotificationInspectorView
  // /base (390x844pt). This is the app's one SwiftUI screen, so it sits on systemBackground
  // (WHITE), not the grouped grey of the UIKit inspectors: nav band y63..117 with the title
  // [106,69][284,87] over the account subtitle [156,87][233,101] and a glass Close chip at
  // [334,67][370,103]; bell.slash 53pt grey at y374..427; the unavailable title bold beneath
  // it; the accent-filled Open Settings capsule [128,775][261,810]. The authorized branch is
  // a SwiftUI inset-grouped List, so ITS rows are the grouped-table card on grey.

  /** Only the list's first and last row round — the middle rows stay square. */
  private rowCorners(index: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const first: boolean = index === 0;
    const last: boolean = index === this.feedCount - 1;
    const corners: BorderRadiuses = {
      topLeft: first ? radius : 0,
      topRight: first ? radius : 0,
      bottomLeft: last ? radius : 0,
      bottomRight: last ? radius : 0
    };
    return corners;
  }

  @Builder
  navigationBar() {
    Row() {
      Column() {
        Text('New Article Notifications')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Text(this.accountName)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body2'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Center)
      .justifyContent(FlexAlign.Center)
      VibrantButton({
        title: 'Close',
        compact: true,
        buttonId: 'feed_notifications_close',
        onTap: (): void => {
          this.close();
        }
      })
        .width(76)
    }
    .width('100%')
    .height(54)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 20, right: 20 })
  }

  /** ContentUnavailableView("Notifications Disabled", systemImage: "bell.slash"). */
  @Builder
  notificationsDisabledView() {
    Column() {
      Column() {
        SymbolGlyph($r('sys.symbol.bell_slash'))
          .fontSize(53)
          .fontColor([$r('sys.color.ohos_id_color_text_secondary')])
        Text('Notifications Disabled')
          .fontSize($r('sys.float.ohos_id_text_size_headline7'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
        Text('Enable Notifications in Settings')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_s') })
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)

      Row() {
        VibrantButton({
          title: 'Open Settings',
          prominent: true,
          buttonId: 'feed_notifications_open_settings',
          onTap: (): void => {
            this.openSettings();
          }
        })
          .width(150)
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .margin({ bottom: 34 })
    }
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  feedToggleList() {
    Column() {
      // Empty state: the account has no feeds. The source renders an empty List, so this
      // stays the same quiet centred line the unavailable view uses — no invented artwork.
      if (this.feedCount === 0) {
        Text('No Feeds')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .layoutWeight(1)
      } else {
        List() {
          LazyForEach(this.feedSource, (feed: Feed, index: number) => {
            ListItem() {
              FeedNotificationRow({
                iconImage: this.iconImageFor(feed),
                feedName: feed.nameForDisplay,
                isOn: feed.newArticleNotificationsEnabled,
                onToggle: (value: boolean): void => {
                  this.setFeedNotifications(feed, value);
                }
              })
            }
            .backgroundColor($r('sys.color.ohos_id_color_background'))
            .borderRadius(this.rowCorners(index))
          }, (feed: Feed) => feed.feedID + ':' + this.iconGeneration)
        }
        .width('100%')
        .layoutWeight(1)
        .cachedCount(8)
        .scrollBar(BarState.Off)
        // Measured from the item's own edge, which the List padding has already inset to
        // the card edge — so 16 here is the same hairline inset the UIKit cards use.
        .divider({
          strokeWidth: 0.5,
          color: $r('sys.color.ohos_id_color_list_separator'),
          startMargin: 16,
          endMargin: 16
        })
        // The inset-grouped side margin — the same 16pt the UIKit inspectors' cards use.
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: 32
        })
      }
    }
    .width('100%')
    .layoutWeight(1)
    // A SwiftUI inset-grouped List paints systemGroupedBackground behind its cards.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  @Builder
  overlayBody() {
    Column() {
      this.navigationBar()
      if (this.authStatus === (NotificationAuthorization.authorized as number)) {
        this.feedToggleList()
      } else {
        this.notificationsDisabledView()
      }
    }
    .width('100%')
    .height('100%')
    // systemBackground — this SwiftUI sheet is white, unlike the grouped UIKit inspectors.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  build() {
    Stack() {
    }
    .id('AccountNotificationInspectorView')
    .width('100%')
    .height('100%')
    // The root is empty for the whole sheet-close + router.back() transition, and an
    // unpainted root draws the window's default WHITE there. Paint the grouped background
    // the other sheet pages use — the overlay body's own white is the SHEET's, not the
    // backdrop's.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // A back gesture or drag-down closes the sheet without hiding the page, so onPageShow
        // does not fire and the restore above cannot run: it would leave the empty root on
        // screen and take a second gesture to leave. Every row writes through as it is
        // toggled, so an interactive dismissal is the Close chip — route it there.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.close();
        } })
  }
}
