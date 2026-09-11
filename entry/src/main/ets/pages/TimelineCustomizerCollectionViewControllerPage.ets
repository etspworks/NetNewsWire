/**
 * TimelineCustomizerCollectionViewControllerPage
 * (source: iOS/Settings/TimelineCustomizerCollectionViewController.swift +
 * TimelineCustomizerCell.swift + TimelineHeaderView.swift).
 *
 * Four sections: an Icon Size slider (3 ticks), a Number of Lines slider (6 ticks), and two
 * live, non-selectable MainTimelineCell previews over the source's fixed sample article —
 * the first with showIcon false, the second with showIcon true. The sample article's TEXT is
 * static chrome (the source hardcodes it); the LAYOUT it renders with is bound to the two
 * preferences, so moving either slider re-renders both previews and persists the value.
 */

import intl from '@ohos.intl';
import { router } from '@kit.ArkUI';
import { ShowFeedName } from '../common/SceneCoordinator';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { IconSize, iconSizeDimension } from '../model/IconSize';
import { IconView } from '../components/IconView';
import { MainTimelineCell, timelineDateString } from '../components/MainTimelineCell';
import { TickMarkSlider } from '../components/TickMarkSlider';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';
import { readableColumnWidth } from '../components/RootSplitHost';

/** The source's `previewArticle` — a fixed sample, not a fetched one. */
const previewTitle: string = 'At The Sign Of The Prancing Pony';
const previewSummary: string = 'Bree was the chief village of Bree-land, a small country a '
  + 'few miles broad whose chief claim to fame was its aluminum siding industry. The Men of '
  + 'Bree were cheerful and independent: they belonged to nobody but themselves. In the lands '
  + 'beyond Bree there were mysterious wanderers.';
const previewFeedName: string = 'The Fellowship of the Ring';
const previewByline: string = 'J. R. R. Tolkien';
/** 1954-07-29, from the source's DateComponents. */
const previewDate: Date = new Date(1954, 6, 29);

@Entry
@Component
struct TimelineCustomizerCollectionViewControllerPage {
  /** AppDefaults.timelineIconSize — 3 ticks (small / medium / large). */
  @StorageLink('timelineIconSize') timelineIconSize: number = IconSize.medium as number;
  /** AppDefaults.timelineNumberOfLines — 6 ticks. */
  @StorageLink('timelineNumberOfLines') timelineNumberOfLines: number = 2;

  aboutToAppear(): void {
    this.timelineIconSize = AppDefaults.timelineIconSize as number;
    this.timelineNumberOfLines = AppDefaults.timelineNumberOfLines;
  }

  /** The source writes AppDefaults from the slider and both previews reload. */
  private onIconSizeChanged(): void {
    const size: IconSize = this.timelineIconSize === (IconSize.small as number)
      ? IconSize.small
      : (this.timelineIconSize === (IconSize.large as number) ? IconSize.large : IconSize.medium);
    if (AppDefaults.timelineIconSize !== size) {
      AppDefaults.timelineIconSize = size;
    }
  }

  private onNumberOfLinesChanged(): void {
    if (AppDefaults.timelineNumberOfLines !== this.timelineNumberOfLines) {
      AppDefaults.timelineNumberOfLines = this.timelineNumberOfLines;
    }
  }

  private iconSize(): IconSize {
    if (this.timelineIconSize === (IconSize.small as number)) {
      return IconSize.small;
    }
    if (this.timelineIconSize === (IconSize.large as number)) {
      return IconSize.large;
    }
    return IconSize.medium;
  }

  private previewDateString(): string {
    // The preview row is a TIMELINE row, so it must read exactly as one. This formatted
    // itself with `dateStyle short` + `timeStyle short` and rendered '7/29/54, 00:00' where
    // the source shows '29 Jul 1954' — wrong date style AND a time the source never shows
    // for a non-today date. Defer to the one formatter the timeline uses.
    return timelineDateString(previewDate);
  }

  /**
   * TimelineHeaderView — label .headline on .label, inset to the card's content edge and
   * 8pt of air above and below (capture: a 36pt band at x16..374 with the text at x32).
   */
  @Builder
  sectionHeader(title: ResourceStr, isFirst: boolean) {
    Row() {
      Text(title)
        .maxLines(1)
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
    }
    .width('100%')
    .height(36)
    .alignItems(VerticalAlign.Center)
    .padding({ left: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
    .margin({ top: isFirst ? 0 : 18 })
  }

  /**
   * One preview cell — not selectable, exactly as shouldSelectItemAt returns false.
   * Capture geometry inside the card: the unread indicator at +8 (12pt), the feed icon at
   * +28, the text block from +72. cornerRadius 20 is HARDCODED by the source
   * (TimelineCustomizerCell.updateConfiguration), so it is copied verbatim rather than
   * taken from the grouped-card token.
   */
  @Builder
  previewCell(showIcon: boolean) {
    Row({ space: 8 }) {
      // The sample article is unread, so MainTimelineCellData's indicator is circle.fill on
      // the secondary accent — the blue dot the capture shows at x24.
      SymbolGlyph($r('sys.symbol.circle_fill'))
        .fontSize(12)
        .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        .margin({ top: 5 })
      if (showIcon) {
        IconView({
          symbolName: 'app_icon',
          dimension: iconSizeDimension(this.iconSize())
        })
          .margin({ top: 4 })
      }
      MainTimelineCell({
        title: previewTitle,
        summary: previewSummary,
        dateString: this.previewDateString(),
        feedName: previewFeedName,
        byline: previewByline,
        showFeedName: ShowFeedName.byline,
        numberOfLines: this.timelineNumberOfLines
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
      right: 20,
      top: 16,
      bottom: 12
    })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(20)
  }

  /** The white slider card (capture: x16..374, 54pt tall, the slider inset 16 inside it). */
  @Builder
  sliderCard(sliderId: string, minValue: number, maxValue: number) {
    Column() {
      if (sliderId === 'timeline_customizer_icon_size') {
        TickMarkSlider({
          value: $timelineIconSize,
          minValue: minValue,
          maxValue: maxValue,
          sliderId: sliderId,
          onValueChanged: (value: number) => {
            this.timelineIconSize = value;
            this.onIconSizeChanged();
          }
        })
      } else {
        TickMarkSlider({
          value: $timelineNumberOfLines,
          minValue: minValue,
          maxValue: maxValue,
          sliderId: sliderId,
          onValueChanged: (value: number) => {
            this.timelineNumberOfLines = value;
            this.onNumberOfLinesChanged();
          }
        })
      }
    }
    .width('100%')
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      top: 10,
      bottom: 10
    })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(20)
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      // Inline nav bar: the automatic back item plus a CENTERED title.
      Stack() {
        Text($r('app.string.timeline_layout'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          // The source's automatic back item is "< Settings" — the chevron plus the title of
          // the screen it returns to — and it is ONE control. Splitting it into a glyph and a
          // sibling label left the press/focus outline on the arrow alone; the
          // wrapping Row carries the padding, the id and the tap instead.
          Row({ space: 2 }) {
            SymbolGlyph($r('sys.symbol.chevron_left'))
              .fontSize(22)
              .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])

            Text('Settings')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          }
          .padding({ left: 6, right: 10, top: 6, bottom: 6 })
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .accessibilityText('Settings')
          .id('BackButton')
          .onClick(() => {
            router.back();
          })

          Blank()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(54)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      Scroll() {
        Column() {
          this.sectionHeader($r('app.string.icon_size'), true)
          this.sliderCard('timeline_customizer_icon_size',
            IconSize.small as number, IconSize.large as number)

          this.sectionHeader($r('app.string.number_of_lines'), false)
          this.sliderCard('timeline_customizer_lines', 1, 6)

          this.sectionHeader($r('app.string.no_icon_preview'), false)
          this.previewCell(false)

          this.sectionHeader($r('app.string.icon_preview'), false)
          this.previewCell(true)
        }
        .width('100%')
        // The 16pt grouped-list side inset — the cards are x16..374 in a 390pt capture.
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .id('TimelineCustomizerCollectionViewController')
    .width('100%')
    .height('100%')
    // The two previews are real MainTimelineCells, so they have to be measured at the width
    // the timeline itself now uses — same cap, same source constant (readableColumnWidth).
    // Inactive at portrait width; the card behind it keeps this exact background colour, so
    // the clamp shows no seam.
    .constraintSize({ maxWidth: readableColumnWidth })
    // systemGroupedBackground
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
