/**
 * ArticleExtractorButton.
 * Source: iOS/Article/ArticleExtractorButton.swift.
 *
 * The four-state Reader View button: off / animated (processing) / on / error. The source
 * swaps the image per state and stops user interaction while processing; the accessibility
 * label changes with the state too.
 */

/** The source's ArticleExtractorButtonState. */
export enum ArticleExtractorButtonState {
  error = 'error',
  animated = 'animated',
  on = 'on',
  off = 'off'
}

@Component
export struct ArticleExtractorButton {
  /** Driven by the article page's extractor state — a @Prop so it re-renders on change. */
  @Prop buttonState: ArticleExtractorButtonState = ArticleExtractorButtonState.off;
  /** article.preferredLink != nil && !isDeveloperBuild. */
  @Prop isEnabled: boolean = false;
  onTap?: () => void;

  /** The source's accessibilityLabel switch. */
  private accessibilityLabel(): string {
    if (this.buttonState === ArticleExtractorButtonState.error) {
      return 'Error - Reader View';
    }
    if (this.buttonState === ArticleExtractorButtonState.animated) {
      return 'Processing - Reader View';
    }
    if (this.buttonState === ArticleExtractorButtonState.on) {
      return 'Selected - Reader View';
    }
    return 'Reader View';
  }

  /** The source stops interaction while processing; a dead-looking control needs the cue. */
  private isTappable(): boolean {
    return this.isEnabled && this.buttonState !== ArticleExtractorButtonState.animated;
  }

  build() {
    // a 24pt glyph in a 44pt tap box — the source's own 44x44 UIButton, sized to sit in
    // the toolbar's trailing glass lozenge beside Share.
    Stack() {
      if (this.buttonState === ArticleExtractorButtonState.animated) {
        // .animated: the source swaps the image for a medium UIActivityIndicatorView.
        LoadingProgress()
          .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .color($r('sys.color.ohos_id_color_text_primary'))
      } else if (this.buttonState === ArticleExtractorButtonState.error) {
        Image($r('app.media.ic_sf_text_page_slash'))
          .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .objectFit(ImageFit.Contain)
      } else if (this.buttonState === ArticleExtractorButtonState.on) {
        Image($r('app.media.ic_sf_text_page_fill'))
          .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .objectFit(ImageFit.Contain)
      } else {
        Image($r('app.media.ic_sf_text_page'))
          .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .objectFit(ImageFit.Contain)
      }
    }
    .width(44)
    .height(44)
    .id('article_reader_view')
    .accessibilityText(this.accessibilityLabel())
    .enabled(this.isTappable())
    .opacity(this.isTappable() ? 1 : 0.4)
    .onClick(() => {
      const handler: (() => void) | undefined = this.onTap;
      if (handler !== undefined) {
        handler();
      }
    })
  }
}
