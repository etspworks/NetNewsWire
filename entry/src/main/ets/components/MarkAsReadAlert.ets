/**
 * MarkAsReadAlertController.
 * Source: iOS/MainTimeline/MarkAsReadAlertController.swift.
 *
 * The confirm-before-mark-all-as-read action sheet. Three actions, in the source's order:
 * the confirm action (its title varies per call site), "Open Settings" (which shows Settings
 * scrolled to the Articles section) and Cancel. The whole sheet is skipped when
 * AppDefaults.confirmMarkAllAsRead is off — see `confirmMarkAllAsReadIsRequired()`, which the
 * calling screens check before raising the dialog, exactly as `MarkAsReadAlertController.confirm`
 * does.
 */

import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppDefaults } from '../common/prefs/AppDefaults';

const DOMAIN: number = 0x0001;
const TAG: string = 'MarkAsReadAlert';

/** `if AppDefaults.shared.confirmMarkAllAsRead` — the source's whole gate on this dialog. */
export function confirmMarkAllAsReadIsRequired(): boolean {
  return AppDefaults.confirmMarkAllAsRead;
}

/** The route params showSettings(scrollToArticlesSection:) carries to the Settings screen. */
export interface SettingsRouteParams {
  scrollToArticlesSection: boolean;
}

/** coordinator.showSettings(scrollToArticlesSection: true) */
export function showSettingsScrolledToArticles(): void {
  const params: SettingsRouteParams = { scrollToArticlesSection: true };
  router.pushUrl({
    url: 'pages/SettingsViewControllerPage',
    params: params
  }).catch((err: BusinessError) => {
    hilog.warn(DOMAIN, TAG, 'push Settings failed: %{public}s', err.message);
  });
}

@CustomDialog
export struct MarkAsReadAlertController {
  controller?: CustomDialogController;
  /** The per-call-site confirm title ("Mark All as Read", 'Mark All as Read in "%@"'). */
  @Prop confirmTitle: string = '';
  onConfirmed: () => void = (): void => {
    hilog.warn(DOMAIN, TAG, 'confirmed with no completion attached');
  };
  onCancelled: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'mark-all-as-read cancelled');
  };

  private dismiss(): void {
    const controller: CustomDialogController | undefined = this.controller;
    if (controller !== undefined) {
      controller.close();
    }
  }

  build() {
    // an iOS .actionSheet — bold title, grey body message, then full-width tinted
    // actions with Cancel emphasised, on the system dialog surface.
    Column({ space: 8 }) {
      Text($r('app.string.mark_as_read'))
        .fontSize($r('sys.float.ohos_id_text_size_sub_title2'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .textAlign(TextAlign.Center)
        .width('100%')
      Text($r('app.string.you_can_turn_this_confirmation_off_in_settin'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
        .width('100%')
      Button(this.confirmTitle)
        .id('mark_all_read_confirm')
        .type(ButtonType.Capsule)
        .width('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .onClick(() => {
          this.dismiss();
          this.onConfirmed();
        })
      Button($r('app.string.open_settings'))
        .id('mark_all_read_open_settings')
        .type(ButtonType.Capsule)
        .width('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .onClick(() => {
          this.dismiss();
          showSettingsScrolledToArticles();
        })
      Button($r('app.string.cancel'))
        .id('mark_all_read_cancel')
        .type(ButtonType.Capsule)
        .width('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontWeight(FontWeight.Bold)
        .onClick(() => {
          this.dismiss();
          this.onCancelled();
        })
    }
    .width('100%')
    .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
    .backgroundColor($r('sys.color.ohos_id_color_dialog_bg'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_dialog'))
  }
}
