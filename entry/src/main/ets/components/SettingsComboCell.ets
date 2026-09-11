/**
 * SettingsComboCell — port of iOS/Settings/SettingsComboTableViewCell.swift plus its
 * SettingsComboTableViewCell.xib / SettingsTableViewCell.xib layouts.
 *
 * Icon + label (+ disclosure) row. Settings uses it for each account row; Add Account
 * uses it for every row in its list.
 *
 * Owned by the settings screen; also used by the add account screen.
 */

import { vibrantRowMinHeight } from './VibrantCell';

@Component
export struct SettingsComboTableViewCell {
  /** comboImage — the account-type artwork. Changes with the row's account. */
  @Prop comboImage: Resource = $r('app.media.ic_account_local_phone');
  /** comboNameLabel — account.nameForDisplay. */
  @Prop comboNameLabel: string = '';
  @Prop showsDisclosure: boolean = true;
  rowId: string = '';
  onTap?: () => void;

  build() {
    // Capture (the Settings capture, the "On My iPhone" row): cell [16,280][374,329], the account
    // artwork 22x22 at x=28, the label at x=57, the chevron 11x14 at the trailing edge.
    Row({ space: 8 }) {
      Image(this.comboImage)
        .width(24)
        .height(24)
        .objectFit(ImageFit.Contain)
      Text(this.comboNameLabel)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      if (this.showsDisclosure) {
        // Same mis-exported filled triangle as VibrantCell — the source draws a thin chevron.
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([$r('sys.color.ohos_id_color_text_tertiary')])
      }
    }
    .width('100%')
    .constraintSize({ minHeight: vibrantRowMinHeight })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .alignItems(VerticalAlign.Center)
    .id(this.rowId)
    .onClick(() => {
      const handler: (() => void) | undefined = this.onTap;
      if (handler !== undefined) {
        handler();
      }
    })
  }
}
