/**
 * ColorPaletteTableViewControllerPage
 * (source: iOS/Settings/ColorPaletteTableViewController.swift).
 *
 * Three static rows from UserInterfaceColorPalette.allCases
 * with a checkmark on the selected one; selecting a row writes AppDefaults, applies the
 * app-wide color mode and pops back — exactly the source's didSelectRowAt.
 */

import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { AppDefaults, UserInterfaceColorPalette } from '../common/prefs/AppDefaults';
import { VibrantBasicTableViewCell } from '../components/VibrantCell';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'ColorPaletteTableViewControllerPage';

/** One row of the source's `UserInterfaceColorPalette.allCases` table. */
class PaletteRow {
  readonly palette: UserInterfaceColorPalette;
  readonly label: string;

  constructor(palette: UserInterfaceColorPalette, label: string) {
    this.palette = palette;
    this.label = label;
  }
}

/** `String(describing: rowColorPalette)` for each case, in `allCases` order. */
const paletteRows: PaletteRow[] = [
  new PaletteRow(UserInterfaceColorPalette.automatic, 'Automatic'),
  new PaletteRow(UserInterfaceColorPalette.light, 'Light'),
  new PaletteRow(UserInterfaceColorPalette.dark, 'Dark')
];

@Entry
@Component
struct ColorPaletteTableViewControllerPage {
  /** AppDefaults.userInterfaceColorPalette, mirrored into AppStorage so every screen follows. */
  @StorageLink('userInterfaceColorPalette') palette: number =
    UserInterfaceColorPalette.automatic as number;

  aboutToAppear(): void {
    this.palette = AppDefaults.userInterfaceColorPalette as number;
  }

  /** didSelectRowAt: persist, apply app-wide, pop. */
  private selectPalette(row: PaletteRow): void {
    AppDefaults.userInterfaceColorPalette = row.palette;
    this.palette = row.palette as number;
    this.applyColorMode(row.palette);
    router.back();
  }

  /** The source's overrideUserInterfaceStyle, applied through the ApplicationContext. */
  private applyColorMode(palette: UserInterfaceColorPalette): void {
    let mode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    if (palette === UserInterfaceColorPalette.light) {
      mode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
    } else if (palette === UserInterfaceColorPalette.dark) {
      mode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    }
    try {
      const context: common.UIAbilityContext =
        this.getUIContext().getHostContext() as common.UIAbilityContext;
      const applicationContext: common.ApplicationContext = context.getApplicationContext();
      applicationContext.setColorMode(mode);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'could not apply the color mode');
    }
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /** One inset-grouped card: only the first row rounds at the top, the last at the bottom. */
  private rowCorners(index: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const corners: BorderRadiuses = {
      topLeft: index === 0 ? radius : 0,
      topRight: index === 0 ? radius : 0,
      bottomLeft: index === paletteRows.length - 1 ? radius : 0,
      bottomRight: index === paletteRows.length - 1 ? radius : 0
    };
    return corners;
  }

  @Builder
  paletteRow(row: PaletteRow, index: number) {
    Column() {
      // The checkmark accessory is the only data-bound part of the row — a tint-coloured
      // `checkmark` at the trailing edge, hit-test transparent so the row keeps its tap.
      Stack({ alignContent: Alignment.End }) {
        VibrantBasicTableViewCell({
          label: row.label,
          detail: '',
          rowId: 'palette_itemroot',
          onTap: () => {
            this.selectPalette(row);
          }
        })
        if (this.palette === (row.palette as number)) {
          SymbolGlyph($r('sys.symbol.checkmark'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
            .hitTestBehavior(HitTestMode.None)
        }
      }
      .width('100%')
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      // Capture: each palette row is 52pt tall.
      .constraintSize({ minHeight: 52 })

      if (index < paletteRows.length - 1) {
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
      }
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(this.rowCorners(index))
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
        Text($r('app.string.color_palette'))
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

      List() {
        ForEach(paletteRows, (row: PaletteRow, index: number) => {
          ListItem() {
            this.paletteRow(row, index)
          }
        }, (row: PaletteRow) => (row.palette as number).toString())
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: 35
      })
    }
    .id('ColorPaletteTableViewController')
    .width('100%')
    .height('100%')
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
