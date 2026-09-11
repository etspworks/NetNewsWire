/**
 * ContextMenuPreviewViewController.
 * Source: iOS/Article/ContextMenuPreviewViewController.swift.
 *
 * The preview card shown above the article long-press menu: feed name, byline, article
 * title, the published date and the feed icon.
 *
 * The source assigns `previewProvider.article` and the controller reads the four labels off
 * it. The migrated Article is an interface holding a class (ArticleStatus) and Dates, which
 * an ArkUI @Prop would have to deep-copy, so the owning page reads the labels and hands them
 * down — the same convention IconView already uses for IconImage.
 */

import { IconView } from './IconView';

@Component
export struct ContextMenuPreviewViewController {
  /** article.feed?.nameForDisplay */
  @Prop feedName: string = '';
  /** article.byline() */
  @Prop byline: string = '';
  /** article.title */
  @Prop articleTitle: string = '';
  /** article.logicalDatePublished, dateStyle .long + timeStyle .medium */
  @Prop dateTime: string = '';
  /** IconImage.sourceURL for the article's feed. */
  @Prop iconURL: string = '';
  /** IconImage.resourceName for the article's feed. */
  @Prop iconSymbol: string = '';

  /**
   * the long-press preview has no captured state, so the styling comes from the
   * storyboard scene verbatim — blog name .headline on primaryAccentColor, author .body,
   * a 1pt separator inset 20 on both sides, the title .title1, the date .headline, and the
   * 48pt icon pinned top-trailing at 20. Every label's leading inset is 20, gaps are 8.
   */
  build() {
    Row({ space: 8 }) {
      Column({ space: 8 }) {
        Text(this.feedName)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        Text(this.byline)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Divider()
          .strokeWidth(1)
          .color($r('sys.color.ohos_id_color_list_separator'))

        Text(this.articleTitle)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_headline6'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Text(this.dateTime)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      IconView({ iconURL: this.iconURL, symbolName: this.iconSymbol, dimension: 48 })
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding(20)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}
