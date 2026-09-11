/**
 * MainFeedCollectionViewFolderCell.
 * Source: iOS/MainFeed/Collection View Cells/MainFeedCollectionViewFolderCell.swift.
 *
 * Folder sidebar row body: title, the rotating disclosure button (`feed_folder_disclosure`,
 * 0 <-> -90 degrees) and the unread count, which the source shows ONLY when the folder is
 * collapsed AND the count is > 0 (`updateUnreadCountVisibility`). The folder icon is supplied
 * by the owning page, as in the source's `configureIcon(cell:)`.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0001;
const TAG: string = 'MainFeedFolderCell';

@Component
export struct MainFeedCollectionViewFolderCell {
  @Prop folderTitle: string = '';
  @Prop unreadCount: number = 0;
  /** Parent-owned: a plain member would never re-render when the folder expands. */
  @Prop disclosureExpanded: boolean = true;
  /** toggleDisclosure() -> delegate.mainFeedCollectionFolderViewCellDisclosureDidToggle */
  onToggleDisclosure: () => void = (): void => {
    hilog.warn(DOMAIN, TAG, 'disclosure toggled with no delegate attached');
  };

  build() {
    Row({ space: 8 }) {
      Text(this.folderTitle)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      // Visible only when collapsed AND unreadCount > 0.
      if (!this.disclosureExpanded && this.unreadCount > 0) {
        Text(this.unreadCount.toString())
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(16)
        .fontColor([$r('sys.color.ohos_id_color_text_secondary')])
        .rotate({ angle: this.disclosureExpanded ? 0 : -90 })
        .id('feed_folder_disclosure')
        .onClick(() => {
          this.onToggleDisclosure();
        })
    }
    // Sibling of the folder icon in the page's row Row — '100%' would overflow by icon+gap
    // and clip the trailing count (see MainFeedCollectionViewCell).
    .layoutWeight(1)
    .alignItems(VerticalAlign.Center)
  }
}
