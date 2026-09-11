/**
 * ArticleSearchBar.
 * Source: iOS/Article/ArticleSearchBar.swift.
 *
 * The find-in-article bar: Done, the search field with an "n of m" / "No results" counter,
 * and previous/next result buttons. The source enables next only while
 * selectedResult < resultsCount and previous only while resultsCount > 0 && selectedResult > 1.
 */

@Component
export struct ArticleSearchBar {
  /** Two-way with the page: the page also clears it when the find session ends. */
  @Link searchText: string;
  /** FindInArticleState.count — the page reads it back off the web-view bridge. */
  @Prop resultsCount: number = 0;
  /** FindInArticleState.index + 1. */
  @Prop selectedResult: number = 1;

  onTextChanged?: (text: string) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onDone?: () => void;

  /** The source's updateUI(): "%d of %d", or "No results". */
  private resultsLabel(): string {
    if (this.resultsCount > 0) {
      return this.selectedResult.toString() + ' of ' + this.resultsCount.toString();
    }
    return 'No results';
  }

  private canGoPrevious(): boolean {
    return this.resultsCount > 0 && this.selectedResult > 1;
  }

  private canGoNext(): boolean {
    return this.selectedResult < this.resultsCount;
  }

  /**
   * no captured state exists for the find bar (it opens only from the article menu), so
   * the styling comes from the source's own explicit attributes — the stack's systemGray5
   * background, spacing 8 / 8pt side margins, Done in bold 14 .label, the results label in
   * the small system font on .secondaryLabel, and the two chevron buttons on the system tint.
   */
  build() {
    Row({ space: 8 }) {
      Button('Done')
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .padding({ left: 4, right: 4 })
        .id('article_search_done')
        .onClick(() => {
          const handler: (() => void) | undefined = this.onDone;
          if (handler !== undefined) {
            handler();
          }
        })

      // UISearchTextField: a rounded field with a leading magnifier and the "n of m" counter
      // in its rightView — which the source hides while the field is empty.
      Row({ space: 4 }) {
        SymbolGlyph($r('sys.symbol.magnifyingglass'))
          .fontSize($r('sys.float.ohos_id_text_size_body2'))
          .fontColor([$r('sys.color.ohos_id_color_text_tertiary')])
        TextInput({ text: this.searchText, placeholder: $r('app.string.find_in_article') })
          .layoutWeight(1)
          .backgroundColor(Color.Transparent)
          .padding(0)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
          .id('article_search_field')
          .enterKeyType(EnterKeyType.Search)
          .onChange((value: string) => {
            this.searchText = value;
            const handler: ((text: string) => void) | undefined = this.onTextChanged;
            if (handler !== undefined) {
              handler(value);
            }
          })
          .onSubmit(() => {
            const handler: (() => void) | undefined = this.onNext;
            if (handler !== undefined) {
              handler();
            }
          })
        if (this.searchText.length > 0) {
          Text(this.resultsLabel())
            .maxLines(1)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.End)
        }
      }
      .layoutWeight(1)
      .height(36)
      .padding({ left: 8, right: 8 })
      .alignItems(VerticalAlign.Center)
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_button'))

      Button() {
        SymbolGlyph($r('sys.symbol.chevron_up'))
          .fontSize(20)
          .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
      }
      .type(ButtonType.Normal)
      .backgroundColor(Color.Transparent)
      .width(32)
      .height(36)
      .accessibilityText('Previous Result')
      .id('article_search_previous')
      .enabled(this.canGoPrevious())
      .opacity(this.canGoPrevious() ? 1 : 0.4)
      .onClick(() => {
        const handler: (() => void) | undefined = this.onPrevious;
        if (handler !== undefined) {
          handler();
        }
      })

      Button() {
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(20)
          .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
      }
      .type(ButtonType.Normal)
      .backgroundColor(Color.Transparent)
      .width(32)
      .height(36)
      .accessibilityText('Next Result')
      .id('article_search_next')
      .enabled(this.canGoNext())
      .opacity(this.canGoNext() ? 1 : 0.4)
      .onClick(() => {
        const handler: (() => void) | undefined = this.onNext;
        if (handler !== undefined) {
          handler();
        }
      })
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
  }
}
