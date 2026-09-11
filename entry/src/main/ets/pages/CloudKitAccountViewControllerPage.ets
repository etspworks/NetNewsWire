/**
 * CloudKitAccountViewControllerPage
 * (source: iOS/Account/CloudKitAccountViewController.swift).
 *
 *
 * 🟥 CloudKit is the one sanctioned platform-capability substitution: HarmonyOS exposes no
 * CKContainer. The screen still SHIPS and still renders exactly as captured. 'Use iCloud'
 * takes the source's own guard branch — the availability probe fails, so it reports the
 * failure through the source's error path (postSyncError -> the Error Log) and the alert,
 * and does NOT create a half-working account. Nothing is faked and nothing crashes.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { postSyncError } from '../common/account/AccountDelegate';
import { CloudKitUnavailableError, cloudKitCannotAddAccountMessage }
  from '../common/account/CloudKitAccountDelegate';
import { BrowserService } from '../common/system/BrowserService';
import { dismissTo, isBrowsingInApp } from '../common/util/Navigation';
import { AccountType, accountTypeDisplayName } from '../model/AccountType';
import { ImageHeaderView } from '../components/ImageHeaderView';

const DOMAIN: number = 0x0001;
const TAG: string = 'CloudKitAccountViewController';
/** CloudKitWebDocumentation.limitationsAndSolutionsURL */
const limitationsAndSolutionsURL: string = 'https://netnewswire.com/help/optimize-icloud.html';

@Component
export struct CloudKitAccountViewController {
  /** The presenting sheet's visibility — the source's `dismiss(animated:)`. */
  @Link presented: boolean;
  /**
   * AddAccountDismissDelegate.dismiss(). Unlike the other account sheets, CloudKit's
   * Cancel calls this too — it dismisses AND pops Add Account.
   */
  dismissHost: () => void = (): void => {
    router.back();
  };

  /**
   * AddCloudKitAccountUtilities.isiCloudDriveEnabled. The substitution's probe is always
   * false: there is no iCloud Drive on HarmonyOS (CloudKitAccountDelegate's
   * `iCloudAccountIsUnavailable` is unconditionally true).
   */
  @State iCloudAvailable: boolean = false;
  @State errorMessage: ResourceStr = '';

  /** cancel(_:) — dismiss AND pop the host. */
  private cancel(): void {
    this.presented = false;
    this.dismissHost();
  }

  /** add(_:) — the source's guard, then createAccount(type:.cloudKit). */
  private async useICloud(): Promise<void> {
    if (!this.iCloudAvailable) {
      const error: CloudKitUnavailableError = new CloudKitUnavailableError();
      // The source's own error path: the Error Log gets the failure, the user gets the alert.
      postSyncError(accountTypeDisplayName(AccountType.cloudKit), AccountType.cloudKit, error,
        'Adding iCloud account');
      // The alert body is the ADD path's message: no account was created, so the sync
      // wording ("this account's feeds … stay on this device") would describe one that
      // does not exist.
      this.showError(cloudKitCannotAddAccountMessage);
      return;
    }

    const account: AccountService =
      await AccountManager.shared.createAccount(AccountType.cloudKit);
    hilog.info(DOMAIN, TAG, 'created iCloud account %{public}s', account.accountID);
    this.presented = false;
    this.dismissHost();
  }

  /** openLimitationsAndSolutions(_:) */
  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, limitationsAndSolutionsURL)
      .catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'help link failed: %{public}s', String(e));
      });
  }

  private showError(message: ResourceStr): void {
    this.errorMessage = message;
    AlertDialog.show({
      title: $r('app.string.can_t_add_icloud_account'),
      message: message,
      confirm: {
        value: 'OK',
        action: (): void => {
          this.errorMessage = '';
        }
      }
    });
  }

  // MARK: - Styling (visual only — no structural decision lives here)

  /**
   * The sheet's inline nav bar: an absolutely CENTERED 17pt title
   * between two 80pt slots, the close affordance rendered as the iOS 26 round glass button
   * the capture shows (a11y label 'Cancel', glyph xmark). This sheet has no
   * activity-indicator bar item, so its trailing slot is empty — as captured.
   */
  @Builder
  navigationBar() {
    Row() {
      Row() {
        Button() {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary')])
        }
        .type(ButtonType.Circle)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .width(36)
        .height(36)
        .id('cloudkit_account_cancel')
        .onClick((): void => {
          this.cancel();
        })
      }
      .width(80)
      .justifyContent(FlexAlign.Start)

      Text(accountTypeDisplayName(AccountType.cloudKit))
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))

      Blank().width(80)
    }
    .width('100%')
    .height(54)
    .alignItems(VerticalAlign.Center)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
  }

  build() {
    Column() {
      this.navigationBar()

      Scroll() {
        Column() {
          // section 0 header — ImageHeaderView with Assets.accountImage(.cloudKit)
          ImageHeaderView({ accountType: AccountType.cloudKit as number })

          // The action section — a one-row inset-grouped card (capture: x16..374,
          // y205..256, the tinted 17pt label centred in a 44pt button).
          Column() {
            Button('Use iCloud')
              .id('cloudkit_account_submit')
              .type(ButtonType.Normal)
              .backgroundColor(Color.Transparent)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .width('100%')
              .height(44)
              .onClick((): void => {
                this.useICloud().catch((e: Object): void => {
                  this.showError(String(e));
                });
              })
          }
          .width('100%')
          .padding({ top: 4, bottom: 4 })
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          // Unlike the other account sheets this footer is LEFT-aligned and .body-sized
          // (capture: x20..369, y282..346, three lines at ~21pt leading).
          Text($r('app.string.netnewswire_will_use_your_icloud_account_to'))
            .width('100%')
            .margin({ top: 26 })
            .padding({ left: 4, right: 4 })
            .textAlign(TextAlign.Start)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))

          Button($r('app.string.how_to_optimize_icloud_syncing'))
            .id('cloudkit_account_help')
            .type(ButtonType.Normal)
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick((): void => {
              this.openHelp();
            })
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    // systemGroupedBackground — the grouped page the sheet's table sits on.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }
}

@Entry
@Component
struct CloudKitAccountViewControllerPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State @Watch('onOverlayShownChange') overlayShown: boolean = true;
  /** The sheet closed because the in-app browser was pushed on top, not by the user. */
  private browsingAway: boolean = false;

  onOverlayShownChange(): void {
    if (this.overlayShown) {
      return;
    }
    if (isBrowsingInApp()) {
      // Backing out here would pop the browser that just opened, so the link would flash
      // and vanish and this page would be left showing its empty backdrop.
      this.browsingAway = true;
      return;
    }
    dismissTo('pages/AddAccountViewControllerPage');
  }

  onPageShow(): void {
    if (this.browsingAway) {
      // Back from the in-app browser — the account sheet was never dismissed.
      this.browsingAway = false;
      this.overlayShown = true;
    }
  }

  @Builder
  overlayBody() {
    CloudKitAccountViewController({
      presented: $overlayShown,
      dismissHost: (): void => {
        this.overlayShown = false;
      }
    })
  }

  build() {
    Stack() {
    }
    .id('CloudKitAccountViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}
