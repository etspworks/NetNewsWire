/**
 * InspectorIconHeader — port of iOS/Inspector/InspectorIconHeaderView.swift.
 *
 * The feed inspector's section-0 header: the feed's icon, centred at 48x48. The icon
 * resolves lazily out of IconImageCache, so the URL arrives after first layout — hence
 * @Prop, which re-renders when feedIconDidBecomeAvailable pushes a new value down.
 *
 * Owned by the feed inspector screen.
 */

/** InspectorIconHeaderView lays its icon out at 48x48. */
export const inspectorIconSize: number = 48;
export const inspectorIconHeaderHeight: number = 88;

@Component
export struct InspectorIconHeaderView {
  /** IconImage.sourceURL — the downloaded feed icon / favicon. */
  @Prop iconURL: string = '';
  /** IconImage.resourceName — set instead of iconURL for the app's own branded feeds. */
  @Prop iconResourceName: string = '';

  build() {
    Column() {
      if (this.iconURL.length > 0) {
        Image(this.iconURL)
          .width(inspectorIconSize)
          .height(inspectorIconSize)
          .objectFit(ImageFit.Contain)
          .alt($r('app.media.ic_favicon_template_image'))
      } else if (this.iconResourceName.length > 0) {
        Image($r('app.media.ic_nnw_feed_icon'))
          .width(inspectorIconSize)
          .height(inspectorIconSize)
          .objectFit(ImageFit.Contain)
      } else {
        Image($r('app.media.ic_favicon_template_image'))
          .width(inspectorIconSize)
          .height(inspectorIconSize)
          .objectFit(ImageFit.Contain)
      }
    }
    .width('100%')
    .height(inspectorIconHeaderHeight)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}
