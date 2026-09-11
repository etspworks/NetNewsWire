/**
 * MainFeedCollectionHeaderReusableView.
 * Source: iOS/MainFeed/Collection View Cells/MainFeedCollectionHeaderReusableView.swift.
 *
 * The Smart Feeds header and one header per account: up-to-3-line title, a rotating
 * chevron.down disclosure indicator, and an unread count capped at 80 wide that is visible
 * only while the section is collapsed (`updateUnreadCount`). The whole header is tappable
 * (`containerHeaderTapped` -> coordinator.expand/collapse); an account header additionally
 * carries the account context menu, which the page supplies.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0001;
const TAG: string = 'MainFeedSectionHeader';

@Component
export struct MainFeedCollectionHeaderReusableView {
  @Prop headerTitle: string = '';
  @Prop unreadCount: number = 0;
  @Prop disclosureExpanded: boolean = true;
  onHeaderTapped: () => void = (): void => {
    hilog.warn(DOMAIN, TAG, 'header tapped with no delegate attached');
  };

  build() {
    // the sidebar section header is an iOS `.title3`-weight bold header sitting on the
    // grouped background (capture: text x32 y153-189, 36pt band, chevron right-aligned at 358).
    Row({ space: 8 }) {
      Text(this.headerTitle)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      if (!this.disclosureExpanded && this.unreadCount > 0) {
        Text(this.unreadCount.toString())
          .constraintSize({ maxWidth: 80 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(16)
        .fontColor([$r('sys.color.ohos_id_color_text_secondary')])
        .rotate({ angle: this.disclosureExpanded ? 0 : -90 })
    }
    .width('100%')
    .height(36)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onHeaderTapped();
    })
  }
}
