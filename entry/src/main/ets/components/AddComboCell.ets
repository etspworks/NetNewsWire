/**
 * AddComboTableViewCell / AddFeedSelectFolderTableViewCell.
 * Source: iOS/Add/AddComboTableViewCell.swift, iOS/Add/AddFeedSelectFolderTableViewCell.swift.
 *
 * Two cells the Add flow uses:
 *  - AddComboTableViewCell: the container-picker row (an account or a folder) — small icon,
 *    display name, and a checkmark accessory on the caller's current container.
 *  - AddFeedSelectFolderTableViewCell: the Add Feed "Folder" row — a static label plus the
 *    detail label carrying the chosen container's name.
 */

import { IconView } from './IconView';

@Component
export struct AddComboTableViewCell {
  @Prop label: string = '';
  /** SmallIconProvider.smallIcon — an account image name or the folder symbol. */
  @Prop symbolName: string = '';
  @Prop iconURL: string = '';
  /** accessoryType == .checkmark when this row is the caller's initial container. */
  @Prop isChecked: boolean = false;

  build() {
    // a PLAIN (non-inset) table row — capture x20 icon, x49 label, row 51pt tall.
    Row({ space: 8 }) {
      IconView({ iconURL: this.iconURL, symbolName: this.symbolName, dimension: 24 })
      Text(this.label)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      if (this.isChecked) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(16)
          .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .constraintSize({ minHeight: 49 })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}

@Component
export struct AddFeedSelectFolderTableViewCell {
  @Prop folderLabel: string = '';
  /** `cell.detailLabel.text = folderLabel` — "<Account> / <Folder>", or the account name. */
  @Prop detailLabel: string = '';

  build() {
    // a grouped-table value row — .body label left, .body secondary value right
    // (capture: "Folder" at x36, "On My iPhone" right-aligned to x354).
    Row({ space: 8 }) {
      Text(this.folderLabel)
        .maxLines(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Blank()
      Text(this.detailLabel)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .constraintSize({ minHeight: 44 })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
  }
}
