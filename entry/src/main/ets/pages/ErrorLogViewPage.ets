/**
 * ErrorLogViewPage (source: iOS/Settings/ErrorLogView.swift).
 *
 * The newest 200 error rows read from ErrorLogDatabase
 * (ErrorLogDatabase) and rendered as monospaced per-segment text — timestamp, source
 * (+ optional " — <operation>"), message, optional location — under the privacy warning;
 * no rows renders the "No Errors Logged" state and disables Copy Contents.
 *
 * Segment colours and weights are carried on each segment.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ErrorLogEntry } from '../model/ErrorLogEntry';
import { AccountType } from '../model/AccountType';
import { ErrorLogDatabase } from '../common/db/ErrorLogDatabase';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'ErrorLogViewPage';

const helpURL: string = 'https://netnewswire.com/help/error-log.html';
const maxEntries: number = 200;
/** The source pads the whole log block once; each row here carries the same 16pt inset. */
const logPadding: number = 16;
/** One blank monospaced body line — the "\n\n" that separates two entries in the source. */
const logEntryGap: number = 20;

/**
 * `AccountType(rawValue: entry.sourceID)?.logColor ?? .secondary`
 * (Shared/AccountType+Helpers.swift, the iOS arm). SwiftUI system colours the source names
 * literally, so the values are copied verbatim. `.onMyMac` is `.secondary`.
 */
function accountLogColor(sourceID: number | undefined): ResourceColor {
  if (sourceID === AccountType.cloudKit) {
    return '#AF52DE';
  }
  if (sourceID === AccountType.feedly) {
    return '#34C759';
  }
  if (sourceID === AccountType.feedbin) {
    return '#0088FF';
  }
  if (sourceID === AccountType.newsBlur) {
    return '#FF8D28';
  }
  if (sourceID === AccountType.freshRSS) {
    return '#30B0C7';
  }
  if (sourceID === AccountType.inoreader) {
    return '#A2845E';
  }
  if (sourceID === AccountType.bazQux) {
    return '#5856D6';
  }
  if (sourceID === AccountType.theOldReader) {
    return '#FF2D55';
  }
  return $r('sys.color.ohos_id_color_text_secondary');
}

/** Segment roles: timestamp secondary, source per account type, message primary, location tertiary. */
export enum ErrorLogColor {
  primary = 'primary',
  secondary = 'secondary',
  tertiary = 'tertiary',
  source = 'source'
}

class ErrorSegment {
  readonly text: string;
  readonly color: ErrorLogColor;
  /** AccountType raw value for the source segment — the colour comes from it in . */
  readonly sourceID?: number;

  constructor(text: string, color: ErrorLogColor, sourceID?: number) {
    this.text = text;
    this.color = color;
    this.sourceID = sourceID;
  }
}

class ErrorLine {
  readonly id: string;
  readonly segments: ErrorSegment[];

  constructor(id: string, segments: ErrorSegment[]) {
    this.id = id;
    this.segments = segments;
  }
}

class ErrorLineDataSource implements IDataSource {
  private lines: ErrorLine[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.lines.length;
  }

  getData(index: number): ErrorLine {
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

  reload(lines: ErrorLine[]): void {
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
struct ErrorLogViewPage {
  @State isEmpty: boolean = true;
  @State plainText: string = '';

  private readonly lines: ErrorLineDataSource = new ErrorLineDataSource();

  aboutToAppear(): void {
    this.reload();
  }

  /**
   * The source appends live on the `.appDidEncounterError` notification. The ported
   * ErrorLogDatabase exposes no listener, so the newest rows are re-read whenever the page
   * becomes visible; every error that was written is present.
   */
  onPageShow(): void {
    this.reload();
  }

  private reload(): void {
    ErrorLogDatabase.shared.allEntries().then((allEntries: ErrorLogEntry[]): void => {
      const entries: ErrorLogEntry[] = allEntries.length > maxEntries
        ? allEntries.slice(allEntries.length - maxEntries) : allEntries;
      const lines: ErrorLine[] = [];
      let plain: string = '';
      for (const entry of entries) {
        const segments: ErrorSegment[] = ErrorLogViewPage.segmentsFor(entry);
        for (const segment of segments) {
          plain += segment.text;
        }
        plain += '\n\n';
        lines.push(new ErrorLine(entry.id.toString(), segments));
      }
      this.lines.reload(lines);
      this.isEmpty = entries.length === 0;
      this.plainText = plain;
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'could not read the error log: %{public}s', String(e));
    });
  }

  /** `[<timestamp>] <sourceName>[ — <operation>]: <message> (<file>:<function>:<line>)`. */
  private static segmentsFor(entry: ErrorLogEntry): ErrorSegment[] {
    const result: ErrorSegment[] = [];
    result.push(new ErrorSegment('[' + logTimestamp(entry.date) + '] ',
      ErrorLogColor.secondary));

    const source: string = entry.operation.length === 0
      ? entry.sourceName + ': ' : entry.sourceName + ' — ' + entry.operation + ': ';
    result.push(new ErrorSegment(source, ErrorLogColor.source, entry.sourceID));

    result.push(new ErrorSegment(entry.errorMessage, ErrorLogColor.primary));

    if (entry.functionName.length > 0) {
      result.push(new ErrorSegment(' (' + entry.fileName + ':' + entry.functionName + ':'
        + entry.lineNumber + ')', ErrorLogColor.tertiary));
    }
    return result;
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

  /** Timestamp secondary, source per AccountType.logColor, message primary, location tertiary. */
  private segmentColor(segment: ErrorSegment): ResourceColor {
    if (segment.color === ErrorLogColor.primary) {
      return $r('sys.color.ohos_id_color_text_primary');
    }
    if (segment.color === ErrorLogColor.tertiary) {
      return $r('sys.color.ohos_id_color_text_tertiary');
    }
    if (segment.color === ErrorLogColor.source) {
      return accountLogColor(segment.sourceID);
    }
    return $r('sys.color.ohos_id_color_text_secondary');
  }

  /** `source.font = .system(.body, design: .monospaced).weight(.medium)` — only that segment. */
  private segmentWeight(segment: ErrorSegment): FontWeight {
    return segment.color === ErrorLogColor.source ? FontWeight.Medium : FontWeight.Regular;
  }

  @Builder
  errorLine(line: ErrorLine) {
    Text() {
      ForEach(line.segments, (segment: ErrorSegment) => {
        Span(segment.text)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontFamily('monospace')
          .fontColor(this.segmentColor(segment))
          .fontWeight(this.segmentWeight(segment))
      }, (segment: ErrorSegment, index: number) => line.id + '-' + index)
    }
    .width('100%')
    .textAlign(TextAlign.Start)
    .copyOption(CopyOptions.LocalDevice)
    .padding({ left: logPadding, right: logPadding })
    // The blank line the source's "\n\n" puts between two entries.
    .margin({ bottom: logEntryGap })
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_background') }) {
    Column() {
      // Nav bar: the title sits leading, next to the back affordance, because the wide
      // "Copy Contents" bar button leaves no room to centre it (capture: title x74-145).
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
        Text($r('app.string.error_log'))
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Blank()
        Button($r('app.string.copy_contents'))
          .id('error_log_copy')
          .type(ButtonType.Capsule)
          .height(36)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .enabled(!this.isEmpty)
          // the capture shows Copy Contents greyed out on an empty log.
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
        // Empty state — the capture's grey checkmark.circle over the bold title.
        Column({ space: 16 }) {
          SymbolGlyph($r('sys.symbol.checkmark_circle'))
            .fontSize(50)
            .fontColor([$r('sys.color.ohos_id_color_text_secondary')])
          Text($r('app.string.no_errors_logged'))
            .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Text($r('app.string.errors_may_contain_feed_urls_and_other_infor'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
        List() {
          LazyForEach(this.lines, (line: ErrorLine) => {
            ListItem() {
              this.errorLine(line)
            }
          }, (line: ErrorLine) => line.id)
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
      Button($r('app.string.error_log_help'))
        .id('error_log_help')
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
    .id('ErrorLogView')
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
