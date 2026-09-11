/**
 * CurrentActivityViewPage.
 * Source: iOS/CurrentActivity/CurrentActivityView.swift,
 *         Shared/CurrentActivity/CurrentActivityViewModel.swift.
 *
 * A medium/large-detent sheet presented over the Feeds sidebar, so the page renders that
 * sidebar as its backdrop (the capture shows it dimmed behind the sheet) and
 * the sheet on top. The sheet is one section of activity rows — running, then pending, then
 * the completed ones still inside the model's 2-second linger window — or, when there are
 * none, the single secondary "No current activity." row. A "Current Activity Help" link
 * below opens netnewswire.com/help/current-activity.html in the in-app browser (SafariView).
 *
 * CurrentActivityViewModel's 0.5s poll is reproduced verbatim, including its stop-when-empty
 * behaviour.
 */

import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { IconView } from '../components/IconView';
import {
  MainFeedCollectionViewCell, SidebarRowDataSource, SidebarRowInfo, sidebarRowInfo
} from '../components/MainFeedCell';
import { MainFeedCollectionViewFolderCell } from '../components/MainFeedFolderCell';
import { MainFeedCollectionHeaderReusableView } from '../components/MainFeedSectionHeader';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { ActivityLog } from '../common/log/ActivityLog';
import { BrowserService } from '../common/system/BrowserService';
import { SidebarRow } from '../common/tree/TreeController';
import { dismissTo } from '../common/util/Navigation';
import { Activity, ActivityKindType, ActivityState } from '../model/Activity';

const DOMAIN: number = 0x0001;
const TAG: string = 'CurrentActivityViewPage';

const helpURL: string = 'https://netnewswire.com/help/current-activity.html';
/** CurrentActivityViewModel.updateInterval / .lingerDuration */
const updateIntervalMillis: number = 500;
const lingerMillis: number = 2000;

/** ActivityDisplayText — the title/detail pair one row renders. */
export class ActivityDisplayText {
  readonly title: string;
  readonly detail?: string;

  constructor(title: string, detail?: string) {
    this.title = title;
    this.detail = detail;
  }
}

/** CurrentActivityViewModel.displayText(for:) */
export function activityDisplayText(activity: Activity): ActivityDisplayText {
  const kind: ActivityKindType = activity.kind.type;
  const url: string = activity.kind.urlString === undefined ? '' : activity.kind.urlString;
  if (kind === ActivityKindType.refreshFeedContent) {
    const feedName: string | undefined = activity.detail;
    return feedName !== undefined
      ? new ActivityDisplayText(feedName, url) : new ActivityDisplayText(url);
  }
  if (kind === ActivityKindType.findFeed) {
    return new ActivityDisplayText('Finding feed', url);
  }
  if (kind === ActivityKindType.fetchFeedCandidate) {
    return new ActivityDisplayText('Fetching', url);
  }
  if (kind === ActivityKindType.downloadFeedImage) {
    return new ActivityDisplayText('Downloading image', url);
  }
  if (kind === ActivityKindType.downloadFavicon) {
    return new ActivityDisplayText('Downloading favicon', url);
  }
  if (kind === ActivityKindType.downloadAvatar) {
    return new ActivityDisplayText('Downloading avatar', url);
  }
  if (kind === ActivityKindType.downloadHTMLMetadata) {
    return new ActivityDisplayText('Downloading metadata', url);
  }
  const simple: string | undefined = activity.kind.simpleDisplayName;
  return new ActivityDisplayText(simple === undefined ? '' : simple, activity.detail);
}

/** The detail line, empty when the activity supplies none. */
export function activityDetail(activity: Activity): string {
  const detail: string | undefined = activityDisplayText(activity).detail;
  return detail === undefined ? '' : detail;
}

/** CurrentActivityViewModel.symbolName(for:) */
export function activityStateSymbol(state: ActivityState): string {
  if (state === ActivityState.pending) {
    return 'circle';
  }
  if (state === ActivityState.running) {
    return 'circle.fill';
  }
  if (state === ActivityState.completed) {
    return 'checkmark.circle.fill';
  }
  return 'xmark.circle.fill';
}

/** CurrentActivityViewModel.currentActivities() */
export function currentActivities(): Activity[] {
  const log: ActivityLog = ActivityLog.shared;
  const activities: Activity[] = [];
  for (const activity of log.runningActivities) {
    activities.push(activity);
  }
  for (const activity of log.pendingActivities) {
    activities.push(activity);
  }
  const now: number = Date.now();
  for (const activity of log.completedActivities) {
    const endDate: Date | undefined = activity.endDate;
    if (endDate !== undefined && now - endDate.getTime() < lingerMillis) {
      activities.push(activity);
    }
  }
  return activities;
}

@Component
export struct CurrentActivityView {
  /** ActivityLog's live list, re-read on the model's 0.5s tick. */
  @State activities: Activity[] = [];
  private updateTimerID: number = -1;
  private activityListener: () => void = (): void => {
    this.scheduleUpdate();
  };

  onDismissed: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'Current Activity dismissed with no host handler');
  };

  aboutToAppear(): void {
    // model.start(): observe .activityDidChange and poll.
    ActivityLog.shared.addListener(this.activityListener);
    this.scheduleUpdate();
  }

  aboutToDisappear(): void {
    // model.stop()
    try {
      ActivityLog.shared.removeListener(this.activityListener);
    } finally {
      this.invalidateUpdateTimer();
    }
  }

  private scheduleUpdate(): void {
    if (this.updateTimerID >= 0) {
      return;
    }
    this.updateTimerID = setInterval(() => {
      this.update();
    }, updateIntervalMillis);
    this.update();
  }

  private update(): void {
    const activities: Activity[] = currentActivities();
    this.activities = activities;
    // "if activities.isEmpty { invalidateUpdateTimer() }"
    if (activities.length === 0) {
      this.invalidateUpdateTimer();
    }
  }

  private invalidateUpdateTimer(): void {
    if (this.updateTimerID >= 0) {
      clearInterval(this.updateTimerID);
      this.updateTimerID = -1;
    }
  }

  /**
   * The source presents SafariView(url:) here. openInAppBrowser() only recorded the URL for
   * a screen that would host the browser, and none did, so the link was dead; it now routes
   * to pages/InAppBrowserPage, which is also closer to the capture's full-screen browser.
   */
  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, helpURL).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'help link failed: %{public}s', String(e));
    });
  }

  /**
   * Styling helper — the sheet's list is ONE inset card, so only its first row rounds
   * its top corners and only its last row rounds its bottom corners.
   */
  private rowCorners(index: number, count: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const corners: BorderRadiuses = {
      topLeft: index === 0 ? radius : 0,
      topRight: index === 0 ? radius : 0,
      bottomLeft: index === count - 1 ? radius : 0,
      bottomRight: index === count - 1 ? radius : 0
    };
    return corners;
  }

  @Builder
  activityRow(activity: Activity) {
    Row({ space: 8 }) {
      IconView({ symbolName: activityStateSymbol(activity.state), dimension: 16 })
      Column() {
        Text(activity.owner.displayName)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(activityDisplayText(activity).title)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        // The detail line renders only when the activity supplies one.
        if (activityDetail(activity).length > 0) {
          Text(activityDetail(activity))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .fontSize($r('sys.float.ohos_id_text_size_body2'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      top: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
      bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
    })
    .constraintSize({ minHeight: 49 })
    .id('current_activity_itemroot')
  }

  build() {
    Column() {
      // Sheet nav bar: the title is CENTERED inline and the dismiss control is a round
      // glass button at .topBarTrailing (capture: title centred on x195, Close at x328..362).
      Stack() {
        Text($r('app.string.current_activity'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          Blank()
          // iOS 26 renders this as Button(role: .close): a round xmark glyph, not a text
          // pill (capture: a 34pt circle at x328..362). Its accessibility label — the one
          // the capture and the replay both address — is "Close", so the glyph carries it
          // as .accessibilityText, exactly as ImageViewControllerPage's .close item does.
          Button() {
            SymbolGlyph($r('sys.symbol.xmark'))
              .fontSize(20)
              .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          }
          .id('current_activity_close')
          .accessibilityText('Close')
          .type(ButtonType.Circle)
          .width(36)
          .height(36)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .onClick(() => {
            this.onDismissed();
          })
        }
        .width('100%')
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(52)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      List() {
        if (this.activities.length === 0) {
          // The empty state is a single secondary row, not a full-screen panel.
          ListItem() {
            Text($r('app.string.no_current_activity'))
              .width('100%')
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .padding({
                left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
                right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
              })
              .constraintSize({ minHeight: 49 })
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          }
        }
        ForEach(this.activities, (activity: Activity, index: number) => {
          ListItem() {
            this.activityRow(activity)
          }
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius(this.rowCorners(index, this.activities.length))
        }, (activity: Activity) => activity.id.toString())

        // The help link sits directly UNDER the card in the capture, not pinned to the
        // bottom of the sheet — as the last row it does, and it also leaves the system's
        // bottom gesture strip, which was swallowing the tap.
        ListItem() {
          // A plain tinted link, not a filled button (capture: blue, centred).
          Button($r('app.string.current_activity_help'))
            .id('current_activity_help')
            .type(ButtonType.Normal)
            .width('100%')
            .height(44)
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .onClick(() => {
              this.openHelp();
            })
        }
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}

@Entry
@Component
struct CurrentActivityViewPage {
  /** The sheet is presented on the Feeds backdrop as soon as the page shows. */
  @State sheetOpen: boolean = true;
  /** The backdrop sidebar — the presenting MainFeedCollectionViewController stays visible. */
  @State private backdropRows: SidebarRowDataSource = new SidebarRowDataSource();
  @StorageLink('nnwSidebarVersion') private sidebarVersion: number = 0;

  private coordinatorListener: () => void = (): void => {
    this.reloadBackdrop();
  };

  aboutToAppear(): void {
    SceneCoordinator.shared.addListener(this.coordinatorListener);
    this.reloadBackdrop();
  }

  aboutToDisappear(): void {
    SceneCoordinator.shared.removeListener(this.coordinatorListener);
  }

  private reloadBackdrop(): void {
    this.backdropRows.reload(SceneCoordinator.shared.sidebarRows);
  }

  /** Section headers sit on the bare grouped background; rows are the white card. */
  private backdropRowBackground(info: SidebarRowInfo): ResourceColor {
    return info.isGroupItem
      ? Color.Transparent : $r('sys.color.ohos_id_color_background');
  }

  @Builder
  backdropRow(info: SidebarRowInfo, row: SidebarRow) {
    Row({ space: 8 }) {
      if (!info.isGroupItem) {
        IconView({ iconURL: info.iconURL, symbolName: info.symbolName, dimension: 24 })
      }
      if (info.isGroupItem) {
        MainFeedCollectionHeaderReusableView({
          headerTitle: info.title,
          unreadCount: info.unreadCount,
          disclosureExpanded: SceneCoordinator.shared.isExpandedNode(row.node)
        })
      } else if (info.isFolder) {
        MainFeedCollectionViewFolderCell({
          folderTitle: info.title,
          unreadCount: info.unreadCount,
          disclosureExpanded: SceneCoordinator.shared.isExpandedNode(row.node)
        })
      } else {
        MainFeedCollectionViewCell({
          feedTitle: info.title,
          unreadCount: info.unreadCount
        })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({
      left: info.indentationLevel === 1 ? 32 : 16,
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .constraintSize({ minHeight: info.isGroupItem ? 36 : 49 })
    .backgroundColor(this.backdropRowBackground(info))
  }

  @Builder
  sheetBody() {
    CurrentActivityView({
      onDismissed: (): void => {
        this.sheetOpen = false;
        // Close uncovers the FULL Feeds screen in the source — large title, expanded
        // account section and bottom toolbar — not this page's plain sidebar backdrop.
        dismissTo('pages/MainFeedCollectionViewControllerPage');
      }
    })
  }

  build() {
    Column() {
      List() {
        LazyForEach(this.backdropRows, (row: SidebarRow) => {
          ListItem() {
            this.backdropRow(sidebarRowInfo(row), row)
          }
        }, (row: SidebarRow) => row.node.uniqueID.toString() + '-' + this.sidebarVersion)
      }
      .width('100%')
      .height('100%')
      .cachedCount(8)
      .scrollBar(BarState.Off)
      // The presenting Feeds sidebar keeps its own 16pt grouped-list inset.
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .id('CurrentActivityView')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.sheetOpen, this.sheetBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}
