/**
 * InAppBrowserPage — the host for the safari view component.
 * Source: every `SFSafariViewController` the app presents (feed home page, help links,
 * account sign-up, an article opened in the app).
 *
 * SFSafariViewController is presented BY UIKit itself, so in the source every call site got
 * a browser for free. The migrated `BrowserService.openInAppBrowser()` only records the URL
 * and notifies listeners — the SCREEN has to host the browser — and no screen registered one,
 * so every in-app link tap did nothing at all. This page is that host, reached by route, so
 * the one call in BrowserService serves every call site instead of each screen carrying its
 * own sheet.
 */

import { router } from '@kit.ArkUI';
import { SafariView } from '../components/InAppBrowserSheet';
import { BrowserService } from '../common/system/BrowserService';

@Entry
@Component
struct InAppBrowserPage {
  /** BrowserService.pendingInAppURL — set by openInAppBrowser() before it routes here. */
  @State url: string = '';

  aboutToAppear(): void {
    this.url = BrowserService.shared.pendingInAppURL ?? '';
  }

  build() {
    Column() {
      SafariView({
        url: this.url,
        onDismissed: (): void => {
          router.back();
        }
      })
    }
    .id('InAppBrowserPage')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}
