/**
 * ImageViewControllerPage
 * (source: iOS/Article/ImageViewController.swift + ImageScrollView.swift + ImageTransition.swift).
 *
 * presentation: modal, hostedBy the article screen. The viewer itself is the exported
 * `ImageViewController` component, which ArticleViewControllerPage mounts as a full-screen
 * overlay (bindContentCover) over the article — the same instance the source presents from
 * WebViewController.showFullScreenImage. The @Entry wrapper below keeps the route alive so
 * the captured action path can still be replayed.
 *
 * The image itself is DATA: the URL the article body was tapped on, handed over by the
 * web-view bridge through AppStorage (the source's coordinator.showFullScreenImage) and
 * fetched by IconImageCache's downloader.
 */

import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import { ImageDownloader } from '../common/images/IconImageCache';
import { ShareService } from '../common/system/ShareService';

const DOMAIN: number = 0x0001;
const TAG: string = 'ImageViewControllerPage';

/** AppStorage keys the article web-view bridge writes when an image is tapped. */
export const clickedImageURLKey: string = 'nnwClickedImageURL';
export const clickedImageTitleKey: string = 'nnwClickedImageTitle';

const minimumZoomScale: number = 1;
const maximumZoomScale: number = 4;

@Component
export struct ImageViewController {
  /** SceneCoordinator's clickedImage — written by the article web view's bridge. */
  @StorageLink('nnwClickedImageURL') imageUrl: string = '';
  /** The imageWasClicked payload's imageTitle. */
  @State imageTitle: string = '';
  /** Pinch / double-tap zoom over the aspect-fit minimum. */
  @State zoomScale: number = minimumZoomScale;

  /** dismiss(animated:) — the host hides the overlay and shows the clicked image again. */
  onClose?: () => void;

  aboutToAppear(): void {
    this.refreshTitle();
    this.prefetch();
  }

  /**
   * The source downloads the tapped image (Downloader.shared.download) before presenting.
   * ArkUI's Image loads the URL itself, so this only warms IconImageCache's own cache so
   * the bytes are local for the share and for a repeat open.
   */
  private prefetch(): void {
    if (this.imageUrl.length === 0) {
      return;
    }
    ImageDownloader.shared.image(this.imageUrl);
  }

  private refreshTitle(): void {
    const title: string | undefined = AppStorage.get<string>(clickedImageTitleKey);
    this.imageTitle = title === undefined ? '' : title;
  }

  private close(): void {
    const handler: (() => void) | undefined = this.onClose;
    if (handler !== undefined) {
      handler();
    }
  }

  /** The source's double-tap: zoom out when already past half of maximum, else zoom in. */
  private toggleZoom(): void {
    if (this.zoomScale > (minimumZoomScale + maximumZoomScale) / 2) {
      this.zoomScale = minimumZoomScale;
    } else {
      this.zoomScale = minimumZoomScale * 2;
    }
  }

  private share(): void {
    if (this.imageUrl.length === 0) {
      return;
    }
    const context: common.UIAbilityContext =
      this.getUIContext().getHostContext() as common.UIAbilityContext;
    ShareService.shared.shareImage(context, this.imageUrl, this.imageTitle)
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'the image could not be shared: %{public}s', err.message);
      });
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        Image(this.imageUrl)
          .objectFit(ImageFit.Contain)
          // while the bytes are in flight — or when the download failed — the source's
          // own `photo` symbol stands in, which is exactly what the capture shows.
          .alt($r('app.media.ic_sf_photo'))
          .width('100%')
          .height('100%')
          .scale({ x: this.zoomScale, y: this.zoomScale })
          .id('imageviewer_image')
          .gesture(
            GestureGroup(GestureMode.Parallel,
              PinchGesture()
                .onActionUpdate((event: GestureEvent) => {
                  const next: number = this.zoomScale * event.scale;
                  this.zoomScale =
                    Math.min(maximumZoomScale, Math.max(minimumZoomScale, next));
                }),
              TapGesture({ count: 2 })
                .onAction(() => {
                  this.toggleZoom();
                }),
              SwipeGesture({ direction: SwipeDirection.Vertical })
                .onAction(() => {
                  this.close();
                })
            )
          )
      }
      .width('100%')
      .height('100%')
      .clip(true)

      // Close / Share bar items — both UIBarButtonItem system items (.close and .action),
      // explicitly tinted Assets.Colors.primaryAccent by the source, so they are the one
      // place in this app where a bar glyph is accent-blue rather than .label.
      Row() {
        Button() {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        }
        .type(ButtonType.Circle)
        .width(36)
        .height(36)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .accessibilityText('Close')
        .id('imageviewer_close')
        .onClick(() => {
          this.close();
        })
        Blank()
        Button() {
          Image($r('app.media.ic_sf_square_and_arrow_up'))
            .width(20)
            .height(20)
            .objectFit(ImageFit.Contain)
            .renderMode(ImageRenderMode.Template)
            .fillColor($r('sys.color.ohos_id_color_text_primary_activated'))
        }
        .type(ButtonType.Circle)
        .width(36)
        .height(36)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .accessibilityText('Share')
        .id('imageviewer_share')
        .onClick(() => {
          this.share();
        })
      }
      .width('100%')
      // Capture: the two buttons sit at x20..56 and x334..370, y51..87.
      .height(44)
      .alignItems(VerticalAlign.Center)
      .padding({ left: 20, right: 20 })
      .position({ x: 0, y: 4 })

      // The blurred title chip — removed entirely when there is no title, as the source does.
      // cornerRadius 6 is HARDCODED by the source (ImageViewController.viewDidLoad), and the
      // 16pt side inset is its `width * 0.04` iPhone constant on a 390pt capture.
      if (this.imageTitle.length > 0) {
        Text(this.imageTitle)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          // width('100%') is the PARENT's width and the margin is added outside it, so this
          // node rendered a left-plus-right margin wider than the screen and its right edge
          // was clipped. alignSelf(Stretch) fills the cross axis MINUS the margins.
          .alignSelf(ItemAlign.Stretch)
          .textAlign(TextAlign.Center)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding($r('sys.float.ohos_id_elements_margin_horizontal_m'))
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius(6)
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            bottom: 26
          })
      }
    }
    .width('100%')
    .height('100%')
    // The source's plain systemBackground view — the image sits on it, not on black.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}

@Entry
@Component
struct ImageViewControllerPage {
  build() {
    Stack() {
      ImageViewController({
        onClose: () => {
          router.back();
        }
      })
    }
    .id('ImageViewController')
    .width('100%')
    .height('100%')
  }
}
