/**
 * LocalAccountViewControllerPage (source: iOS/Account/LocalAccountViewController.swift).
 *
 * The sheet BODY is exported as `LocalAccountViewController` so its host
 * (AddAccountViewControllerPage) mounts the real component, exactly as the source presents
 * this controller modally from Add Account. The @Entry page is the deep-link/replay route.
 */

import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { isBrowsingInApp } from '../common/util/Navigation';
import { AccountType, accountTypeDisplayName } from '../model/AccountType';
import { ImageHeaderView } from '../components/ImageHeaderView';

const DOMAIN: number = 0x0001;
const TAG: string = 'LocalAccountViewController';

@Component
export struct LocalAccountViewController {
  /** The presenting sheet's visibility — the source's `dismiss(animated:)`. */
  @Link presented: boolean;
  /**
   * The source's AddAccountDismissDelegate.dismiss(): after a successful add the host
   * (Add Account) is popped too. The default serves a standalone route.
   */
  dismissHost: () => void = (): void => {
    router.back();
  };

  @State accountName: string = '';
  @State errorMessage: string = '';

  private cancel(): void {
    this.presented = false;
  }

  /** AccountManager.shared.createAccount(type:.onMyMac) + account.name = nameTextField.text */
  private async add(): Promise<void> {
    const account: AccountService =
      await AccountManager.shared.createAccount(AccountType.onMyMac);
    const trimmed: string = this.accountName.trim();
    account.name = trimmed.length === 0 ? undefined : trimmed;
    hilog.info(DOMAIN, TAG, 'created local account %{public}s', account.accountID);
    this.presented = false;
    this.dismissHost();
  }

  private showError(message: string): void {
    this.errorMessage = message;
    AlertDialog.show({
      title: $r('app.string.error'),
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
        .id('local_account_cancel')
        .onClick((): void => {
          this.cancel();
        })
      }
      .width(80)
      .justifyContent(FlexAlign.Start)

      Text(accountTypeDisplayName(AccountType.onMyMac))
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
          // section 0 header — ImageHeaderView with Assets.accountImage(.onMyMac)
          ImageHeaderView({ accountType: AccountType.onMyMac as number })

          // The name section — a one-row inset-grouped card (capture: x16..374, y205..256).
          Column() {
            Row() {
              TextInput({ placeholder: $r('app.string.name'), text: this.accountName })
                .id('local_account_name')
                .enterKeyType(EnterKeyType.Done)
                .layoutWeight(1)
                .height(48)
                .padding({ left: 0, right: 0 })
                .borderRadius(0)
                .backgroundColor(Color.Transparent)
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
                .placeholderFont({ size: $r('sys.float.ohos_id_text_size_body1') })
                .caretColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .onChange((value: string): void => {
                  this.accountName = value;
                })
            }
            .width('100%')
            .constraintSize({ minHeight: 49 })
            .alignItems(VerticalAlign.Center)
            .padding({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
            })
          }
          .width('100%')
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          // The action section — its own card, 36pt of grouped air above it (capture:
          // the name card ends at y256, this one starts at y292). The source's storyboard
          // ships this button ENABLED with an empty name, so it is never greyed.
          Column() {
            Button($r('app.string.add_account'))
              .id('local_account_submit')
              .type(ButtonType.Normal)
              .backgroundColor(Color.Transparent)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .width('100%')
              .height(44)
              .onClick((): void => {
                this.add().catch((e: Object): void => {
                  this.showError(String(e));
                });
              })
          }
          .width('100%')
          .margin({ top: 36 })
          .padding({ top: 4, bottom: 4 })
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          Text($r('app.string.local_accounts_do_not_sync_your_feeds_across_2'))
            .width('100%')
            .margin({ top: 26 })
            .padding({ left: 4, right: 4 })
            .textAlign(TextAlign.Center)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
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
struct LocalAccountViewControllerPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State @Watch('onOverlayShownChange') overlayShown: boolean = true;

  onOverlayShownChange(): void {
    if (this.overlayShown) {
      return;
    }
    if (isBrowsingInApp()) {
      // Backing out here would pop the browser that just opened, so the link would flash
      // and vanish and this page would be left showing its empty backdrop.
      return;
    }
    router.back();
  }

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown
    // to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
  }

  @Builder
  overlayBody() {
    LocalAccountViewController({
      presented: $overlayShown,
      dismissHost: (): void => {
        this.overlayShown = false;
      }
    })
  }

  build() {
    Stack() {
    }
    .id('LocalAccountViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}
