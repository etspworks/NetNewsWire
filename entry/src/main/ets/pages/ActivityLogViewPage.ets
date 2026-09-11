/**
 * ActivityLogViewPage (source: iOS/Settings/ActivityLogView.swift +
 * Shared/ActivityLog/ActivityLogViewModel.swift).
 *
 * The completed activities rendered as monospaced,
 * per-segment coloured and weighted text, under the privacy warning; the empty log renders
 * the "No Activity Logged" state and disables Copy Contents.
 *
 * The source builds ONE attributed string over every entry. Here each entry is one row of a
 * LazyForEach list (same text, same "\n\n" separation) so a long log does not build
 * thousands of spans at once. Segment COLOURS/WEIGHTS are carried on each segment and
 *
 *
 * `ActivityLogViewModel.segments(for:)` had no Phase-2 port (it is screen-local view-model
 * logic), so it is ported here.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';
import { Activity, ActivityKindType, ActivityOwnerKind, ActivityState } from '../model/Activity';
import { AccountType } from '../model/AccountType';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { ActivityLog } from '../common/log/ActivityLog';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';

const DOMAIN: number = 0x0001;
const TAG: string = 'ActivityLogViewPage';

const helpURL: string = 'https://netnewswire.com/help/activity-log.html';

/**
 * `AccountType.logColor` (Shared/AccountType+Helpers.swift, the iOS arm) — SwiftUI system
 * colours the source names literally, so the values are copied verbatim (palette.json where
 * it resolved them, Apple's published sRGB values otherwise). `.onMyMac` is `.secondary`.
 */
function accountLogColor(type: AccountType): ResourceColor {
  if (type === AccountType.cloudKit) {
    return '#AF52DE';
  }
  if (type === AccountType.feedly) {
    return '#34C759';
  }
  if (type === AccountType.feedbin) {
    return '#0088FF';
  }
  if (type === AccountType.newsBlur) {
    return '#FF8D28';
  }
  if (type === AccountType.freshRSS) {
    return '#30B0C7';
  }
  if (type === AccountType.inoreader) {
    return '#A2845E';
  }
  if (type === AccountType.bazQux) {
    return '#5856D6';
  }
  if (type === AccountType.theOldReader) {
    return '#FF2D55';
  }
  return $r('sys.color.ohos_id_color_text_secondary');
}

/** `.systemGreen` — the ✓ of a succeeded activity (palette.json, light). */
const systemGreen: string = '#34C759';
/** The source pads the whole log block once; each row here carries the same 16pt inset. */
const logPadding: number = 16;
/** One blank monospaced body line — the "\n\n" that separates two entries in the source. */
const logEntryGap: number = 20;

/** ActivityLogTextColor. The account case carries the accountID the colour comes from. */
export enum LogColor {
  primary = 'primary',
  secondary = 'secondary',
  success = 'success',
  failure = 'failure',
  account = 'account'
}

/** ActivityLogTextWeight. */
export enum LogWeight {
  regular = 'regular',
  medium = 'medium',
  bold = 'bold'
}

/** ActivityLogTextSegment. */
class LogSegment {
  readonly text: string;
  readonly color: LogColor;
  readonly weight: LogWeight;
  readonly accountID?: string;

  constructor(text: string, color: LogColor, weight: LogWeight, accountID?: string) {
    this.text = text;
    this.color = color;
    this.weight = weight;
    this.accountID = accountID;
  }
}

/** One completed activity, already broken into its segments. */
class LogLine {
  readonly id: string;
  readonly segments: LogSegment[];

  constructor(id: string, segments: LogSegment[]) {
    this.id = id;
    this.segments = segments;
  }
}

class LogLineDataSource implements IDataSource {
  private lines: LogLine[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.lines.length;
  }

  getData(index: number): LogLine {
    return this.lines[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    this.listeners.push(listener);
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  reload(lines: LogLine[]): void {
    this.lines = lines;
    for (const listener of this.listeners) {
      listener.onDataReloaded();
    }
  }
}

/** DateFormatter.logTimestamp — fixed format `yyyy-MM-dd HH:mm:ss`. */
function logTimestamp(date: Date): string {
  const pad: (value: number) => string = (value: number): string =>
    value < 10 ? '0' + value : value.toString();
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

@Entry
@Component
struct ActivityLogViewPage {
  @State isEmpty: boolean = true;
  /** The flattened text Copy Contents puts on the clipboard. */
  @State plainText: string = '';

  private readonly lines: LogLineDataSource = new LogLineDataSource();
  private readonly activityListener: () => void = (): void => {
    this.reload();
  };

  aboutToAppear(): void {
    ActivityLog.shared.addListener(this.activityListener);
    this.reload();
  }

  aboutToDisappear(): void {
    ActivityLog.shared.removeListener(this.activityListener);
  }

  /** Rebuilds both the rendered lines and the plain text in one pass, as the source does. */
  private reload(): void {
    const entries: Activity[] = ActivityLog.shared.completedActivities;
    const lines: LogLine[] = [];
    let plain: string = '';
    for (const entry of entries) {
      const segments: LogSegment[] = ActivityLogViewPage.segmentsFor(entry);
      for (const segment of segments) {
        plain += segment.text;
      }
      plain += '\n\n';
      lines.push(new LogLine(entry.id.toString(), segments));
    }
    this.lines.reload(lines);
    this.isEmpty = entries.length === 0;
    this.plainText = plain;
  }

  /** Port of ActivityLogViewModel.segments(for:). */
  private static segmentsFor(activity: Activity): LogSegment[] {
    const result: LogSegment[] = [];

    const date: Date = activity.endDate === undefined ? new Date() : activity.endDate;
    result.push(new LogSegment('[' + logTimestamp(date) + '] ', LogColor.secondary,
      LogWeight.regular));

    const isFailed: boolean = activity.state === ActivityState.failed;
    result.push(new LogSegment(isFailed ? '✗ ' : '✓ ',
      isFailed ? LogColor.failure : LogColor.success, LogWeight.bold));

    const isAccount: boolean = activity.owner.kind === ActivityOwnerKind.account;
    const ownerColor: LogColor = isAccount ? LogColor.account : LogColor.secondary;
    const accountID: string | undefined = isAccount ? activity.owner.accountID : undefined;
    result.push(new LogSegment(activity.owner.displayName + ': ', ownerColor,
      LogWeight.medium, accountID));
    result.push(new LogSegment(activity.kind.displayName(activity.detail), ownerColor,
      LogWeight.medium, accountID));

    const detail: string | undefined = ActivityLogViewPage.secondaryDetail(activity);
    if (detail !== undefined) {
      result.push(new LogSegment(' ' + detail, LogColor.secondary, LogWeight.regular));
    }

    const duration: string | undefined = activity.formattedDuration;
    if (duration !== undefined) {
      result.push(new LogSegment(' (' + duration + ')', LogColor.secondary, LogWeight.regular));
    }

    const message: string | undefined = activity.completionMessage;
    if (message !== undefined) {
      result.push(new LogSegment(' — ' + message, LogColor.secondary, LogWeight.regular));
    }

    if (activity.returnedFromCache) {
      result.push(new LogSegment(' — from cache', LogColor.secondary, LogWeight.regular));
    }

    const error: Error | undefined = activity.error;
    if (isFailed && error !== undefined) {
      result.push(new LogSegment(' — ' + error.message, LogColor.failure, LogWeight.regular));
    }

    return result;
  }

  /** Feed-content activities show the URL as detail when the feed name is the primary text. */
  private static secondaryDetail(activity: Activity): string | undefined {
    if (activity.kind.type === ActivityKindType.refreshFeedContent) {
      return activity.detail === undefined ? undefined : activity.kind.urlString;
    }
    if (activity.kind.type === ActivityKindType.downloadHTMLMetadata) {
      return activity.detail === undefined
        ? undefined : '(last downloaded ' + activity.detail + ')';
    }
    return activity.detail;
  }

  private copyContents(): void {
    ShareService.copyToClipboard(this.plainText);
  }

  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, helpURL)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open help: %{public}s', String(e));
      });
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /** `uiColor(for:)` — .label / .secondaryLabel / .systemGreen / .systemRed / the account colour. */
  private segmentColor(segment: LogSegment): ResourceColor {
    if (segment.color === LogColor.primary) {
      return $r('sys.color.ohos_id_color_text_primary');
    }
    if (segment.color === LogColor.success) {
      return systemGreen;
    }
    if (segment.color === LogColor.failure) {
      return $r('sys.color.ohos_id_color_warning');
    }
    if (segment.color === LogColor.account) {
      const accountID: string | undefined = segment.accountID;
      if (accountID !== undefined) {
        const account: AccountService | undefined =
          AccountManager.shared.existingAccount(accountID);
        // The source falls back to .secondaryLabel when the account is gone.
        if (account !== undefined) {
          return accountLogColor(account.type);
        }
      }
    }
    return $r('sys.color.ohos_id_color_text_secondary');
  }

  /** `font(for:)` — monospaced body at regular / medium / bold. */
  private segmentWeight(weight: LogWeight): FontWeight {
    if (weight === LogWeight.bold) {
      return FontWeight.Bold;
    }
    if (weight === LogWeight.medium) {
      return FontWeight.Medium;
    }
    return FontWeight.Regular;
  }

  @Builder
  logLine(line: LogLine) {
    Text() {
      ForEach(line.segments, (segment: LogSegment) => {
        Span(segment.text)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontFamily('monospace')
          .fontColor(this.segmentColor(segment))
          .fontWeight(this.segmentWeight(segment.weight))
      }, (segment: LogSegment, index: number) => line.id + '-' + index)
    }
    .width('100%')
    .textAlign(TextAlign.Start)
    .copyOption(CopyOptions.LocalDevice)
    .padding({ left: logPadding, right: logPadding })
    // The blank line the source's "\n\n" puts between two entries.
    .margin({ bottom: logEntryGap })
  }

  build() {
    // The source presents this screen as a SHEET: rounded top corners, inset below
    // the status bar, over the dimmed screen behind it. The scrim and the safe-area
    // expansion live on this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_background') }) {
    Column() {
      // Nav bar: the title sits leading, next to the back affordance, because the wide
      // "Copy Contents" bar button leaves no room to centre it (capture: title x74-165).
      Row({ space: 8 }) {
        // The automatic back item the capture shows left of the title.
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          .padding(10)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .accessibilityText('Settings')
          .id('BackButton')
          .onClick(() => {
            router.back();
          })
        Text($r('app.string.activity_log'))
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Blank()
        // The source's topBarTrailing Copy Contents toolbar item — a glass capsule.
        Button($r('app.string.copy_contents'))
          .id('activity_log_copy')
          .type(ButtonType.Capsule)
          .height(36)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .enabled(!this.isEmpty)
          // the source disables Copy Contents on an empty log — show it, don't eat taps.
          .opacity(this.isEmpty ? 0.4 : 1)
          .onClick(() => {
            this.copyContents();
          })
      }
      .width('100%')
      .height(44)
      .alignItems(VerticalAlign.Center)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))

      if (this.isEmpty) {
        // Empty state — ContentUnavailableView(title, systemImage: "checkmark.circle").
        Column({ space: 16 }) {
          SymbolGlyph($r('sys.symbol.checkmark_circle'))
            .fontSize(50)
            .fontColor([$r('sys.color.ohos_id_color_text_secondary')])
          Text($r('app.string.no_activity_logged'))
            .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Text($r('app.string.activity_may_contain_feed_urls_and_other_inf'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
        List() {
          LazyForEach(this.lines, (line: LogLine) => {
            ListItem() {
              this.logLine(line)
            }
          }, (line: LogLine) => line.id)
        }
        .layoutWeight(1)
        .width('100%')
        .cachedCount(5)
        .scrollBar(BarState.Off)
        .padding({ top: logPadding, bottom: logPadding })
      }

      Divider()
        .strokeWidth(0.5)
        .color($r('sys.color.ohos_id_color_list_separator'))
      Button($r('app.string.activity_log_help'))
        .id('activity_log_help')
        .type(ButtonType.Normal)
        .width('100%')
        .backgroundColor(Color.Transparent)
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .padding({ top: 12, bottom: 12 })
        .onClick(() => {
          this.openHelp();
        })
    }
    .id('ActivityLogView')
    .width('100%')
    .height('100%')
    // The log body is a plain .systemBackground page; only the bars carry the grouped grey.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
