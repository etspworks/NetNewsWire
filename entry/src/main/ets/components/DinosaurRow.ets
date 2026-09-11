/**
 * DinosaurRowView — port of iOS/Settings/DinosaurRowView.swift
 *
 * One stale-feed row: the feed icon, the feed name, the monospaced feed URL, the account,
 * and — only when the data exists — the Last Article and Last Response lines.
 *
 * `dinosaur` is a plain member on purpose: rows are produced by the page's LazyForEach and
 * replaced wholesale when the model reloads, and the row hands the REAL `Feed` instance to
 * IconImageCache (a @Prop deep copy would strip its prototype).
 *
 * the source's own text roles — feed name `.headline`, everything else `.caption`, the URL
 * monospaced. Tokens from the style baseline. The captured state has no rows
 * (the test account has no stale feed), so the row is styled from the source, not the capture.
 */

import { DinosaurRow } from '../common/account/DinosaursModel';
import { IconImage } from '../model/IconImage';
import { IconImageCache } from '../common/images/IconImageCache';
import { IconView } from './IconView';

@Component
export struct DinosaurRowView {
  dinosaur: DinosaurRow | undefined = undefined;

  @State private feedName: string = '';
  @State private feedURL: string = '';
  @State private accountName: string = '';
  /** Hidden when the feed has no dated article / no recorded status code. */
  @State private hasLastArticle: boolean = false;
  @State private lastArticleText: string = '';
  @State private hasLastResponse: boolean = false;
  @State private lastResponseText: string = '';
  @State private hasIcon: boolean = false;
  /** IconImage.sourceURL / .resourceName, as IconView takes them. */
  @State private iconURL: string = '';
  @State private symbolName: string = '';

  aboutToAppear(): void {
    const dinosaur: DinosaurRow | undefined = this.dinosaur;
    if (dinosaur === undefined) {
      return;
    }
    this.feedName = dinosaur.feedName;
    this.feedURL = dinosaur.feedURL;
    this.accountName = dinosaur.accountName;

    const lastArticleDate: Date | undefined = dinosaur.lastArticleDate;
    this.hasLastArticle = lastArticleDate !== undefined;
    this.lastArticleText =
      lastArticleDate === undefined ? '' : lastArticleDate.toLocaleDateString();

    const lastResponseCode: number | undefined = dinosaur.lastResponseCode;
    this.hasLastResponse = lastResponseCode !== undefined;
    this.lastResponseText = lastResponseCode === undefined ? '' : lastResponseCode.toString();

    // IconImageCache -> nothing (the source's `feed.smallIcon` fallback has no port).
    const icon: IconImage | undefined = IconImageCache.shared.imageForFeed(dinosaur.feed);
    if (icon !== undefined) {
      this.iconURL = icon.sourceURL === undefined ? '' : icon.sourceURL;
      this.symbolName = icon.resourceName === undefined ? '' : icon.resourceName;
      this.hasIcon = true;
    }
  }

  build() {
    // HStack(alignment: .top) { icon, VStack(alignment: .leading) { … } }
    Row({ space: 8 }) {
      if (this.hasIcon) {
        IconView({ iconURL: this.iconURL, symbolName: this.symbolName })
      }

      Column({ space: 2 }) {
        // .font(.headline)
        Text(this.feedName)
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        // .font(.caption).monospaced()
        Text(this.feedURL)
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_caption'))
          .fontFamily('monospace')
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))

        // LabeledContent — the label leads, the value trails, both .caption.
        Row() {
          Text($r('app.string.account'))
            .fontSize($r('sys.float.ohos_id_text_size_caption'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
          Blank()
          Text(this.accountName)
            .fontSize($r('sys.float.ohos_id_text_size_caption'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width('100%')

        if (this.hasLastArticle) {
          Row() {
            Text($r('app.string.last_article'))
              .fontSize($r('sys.float.ohos_id_text_size_caption'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
            Blank()
            Text(this.lastArticleText)
              .fontSize($r('sys.float.ohos_id_text_size_caption'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          }
          .width('100%')
        }

        if (this.hasLastResponse) {
          Row() {
            Text($r('app.string.last_response'))
              .fontSize($r('sys.float.ohos_id_text_size_caption'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
            Blank()
            Text(this.lastResponseText)
              .fontSize($r('sys.float.ohos_id_text_size_caption'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          }
          .width('100%')
        }
      }
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      top: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
      bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
    })
  }
}
