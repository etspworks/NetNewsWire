/**
 * SafariView.
 * Source: Modules/RSCore/Sources/RSCore/SwiftUI/SafariView.swift (an SFSafariViewController
 * wrapper presented as a sheet for every in-app help link).
 *
 * SFSafariViewController has no HarmonyOS counterpart, so the in-app browser is an ArkWeb
 * `Web` component. BrowserService is the migrated presentation path: it holds the pending URL
 * and honours the "Open Links in NetNewsWire" preference, falling back to the system browser
 * when the in-app page cannot serve the link.
 */

import common from '@ohos.app.ability.common';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';

const DOMAIN: number = 0x0001;
const TAG: string = 'InAppBrowserSheet';

@Component
export struct SafariView {
  @Prop url: string = '';
  onDismissed: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'in-app browser dismissed with no host handler');
  };

  private controller: webview.WebviewController = new webview.WebviewController();

  aboutToDisappear(): void {
    BrowserService.shared.endedBrowsing();
  }

  private goBack(): void {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'back failed: %{public}s', (e as Error).message);
    }
  }

  private reload(): void {
    try {
      this.controller.refresh();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'reload failed: %{public}s', (e as Error).message);
    }
  }

  private share(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    ShareService.shared.shareURL(context, this.url).catch((e: Object): void => {
      hilog.warn(DOMAIN, TAG, 'share failed: %{public}s', String(e));
    });
  }

  private openInSystemBrowser(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openInSystemBrowser(context, this.url).catch((e: Object): void => {
      hilog.warn(DOMAIN, TAG, 'open in system browser failed: %{public}s', String(e));
    });
  }

  build() {
    // SFSafariViewController's bar is the URL host on the chrome fill with the trailing
    // dismiss action — styled with the app-wide sheet tokens, no capture of its own exists.
    Column() {
      Row({ space: 8 }) {
        Text(this.url)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .fontSize($r('sys.float.ohos_id_text_size_body2'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Button($r('app.string.done'))
          .id('safari_view_done')
          .type(ButtonType.Capsule)
          .height(36)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .onClick(() => {
            BrowserService.shared.endedBrowsing();
            this.onDismissed();
          })
      }
      .width('100%')
      .height(52)
      .alignItems(VerticalAlign.Center)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      if (this.url.length > 0) {
        Web({ src: this.url, controller: this.controller })
          .layoutWeight(1)
          .width('100%')
      }

      // SFSafariViewController's bottom bar: back, share, reload, open in the system
      // browser. It was missing entirely, so the in-app browser was a dead end.
      Row() {
        Button({ type: ButtonType.Circle }) {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        }
        .id('safari_view_back')
        .width(44)
        .height(44)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.goBack();
        })
        Blank()
        Button({ type: ButtonType.Circle }) {
          SymbolGlyph($r('sys.symbol.share'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        }
        .id('safari_view_share')
        .width(44)
        .height(44)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.share();
        })
        Blank()
        Button({ type: ButtonType.Circle }) {
          SymbolGlyph($r('sys.symbol.arrow_clockwise'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        }
        .id('safari_view_reload')
        .width(44)
        .height(44)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.reload();
        })
        Blank()
        Button({ type: ButtonType.Circle }) {
          // No system compass glyph exists; the source's is "open this page out there".
          SymbolGlyph($r('sys.symbol.chevron_up'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
        }
        .id('safari_view_open_in_browser')
        .width(44)
        .height(44)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.openInSystemBrowser();
        })
      }
      .width('100%')
      .height(52)
      .alignItems(VerticalAlign.Center)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}
