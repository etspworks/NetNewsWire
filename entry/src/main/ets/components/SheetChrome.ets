/**
 * SheetChrome — the iOS sheet presentation the source uses for About, Activity Log and
 * Add Account.
 *
 * iOS draws a `.sheet` as a card inset below the status bar, with rounded TOP corners, over
 * the dimmed screen that presented it. HarmonyOS routes these screens as pages, so the page
 * fills the window and the chrome has to be drawn: the page's root Column paints the scrim
 * into the status-bar band it is laid out below, and this wrapper rounds + clips the card's
 * top corners and runs it to the bottom edge.
 *
 * STYLE ONLY — it adds no control and changes no binding. This only makes the page LOOK
 * like the sheet the source's capture shows.
 *
 * Usage — an @Entry build() root must be a CONTAINER component, so the scrim and the
 * safe-area expansion stay on the page's own root Column and this wraps the card:
 *
 *   build() {
 *     Column() {
 *       SheetChrome({ pageBackground: <the page's own background> }) {
 *         <the page's content Column>
 *       }
 *     }
 *     .width('100%').height('100%')
 *     .backgroundColor(sheetScrim)
 *     .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
 *   }
 */

/** Capture (390x844pt): the sheet's top corners read ~13pt. */
const sheetCornerRadius: number = 13;
/**
 * The presenting screen dimmed behind the sheet. No `sys.color.ohos_id_color_mask_*` token
 * fits — the lightest of them is 40% black, where iOS's sheet dim is roughly 23% (the
 * capture's band over the white settings page reads ~#C6C6C6), so the value is written out
 * the same way the style baseline writes iOS values that have no HarmonyOS token.
 */
export const sheetScrim: string = '#3C000000';

@Component
export struct SheetChrome {
  /**
   * The hosted page's own background. The card is taller than the page's content Column
   * (which sizes itself against the safe area), so without it the scrim would show through
   * the strip behind the home indicator instead of the page colour the source shows there.
   */
  @Prop pageBackground: ResourceColor = Color.White;
  @BuilderParam content: () => void;

  build() {
    Column() {
      this.content()
    }
    .width('100%')
    // layoutWeight, not height('100%'): a percentage resolves against the safe-area-sized
    // parent and leaves a scrim band under the card.
    .layoutWeight(1)
    .backgroundColor(this.pageBackground)
    .borderRadius({ topLeft: sheetCornerRadius, topRight: sheetCornerRadius })
    .clip(true)
    // The card runs to the screen's bottom edge, as the sheet does in the capture.
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }
}
