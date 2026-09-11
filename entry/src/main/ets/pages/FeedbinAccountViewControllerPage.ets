/**
 * FeedbinAccountViewControllerPage
 * (source: iOS/Account/FeedbinAccountViewController.swift).
 *
 *
 * The sheet BODY is exported as `FeedbinAccountViewController` so its host
 * (AddAccountViewControllerPage) mounts the real component — the source presents this
 * controller modally from Add Account and from the Account Inspector. The @Entry page is
 * the deep-link/replay route.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { validateCredentialsForAccountType } from '../common/account/AccountDelegate';
import { CredentialsError } from '../common/security/CredentialsManager';
import { BrowserService } from '../common/system/BrowserService';
import { dismissTo, isBrowsingInApp } from '../common/util/Navigation';
import { AccountType } from '../model/AccountType';
import { Credentials, CredentialsType } from '../model/Credentials';
import { ImageHeaderView } from '../components/ImageHeaderView';

const DOMAIN: number = 0x0001;
const TAG: string = 'FeedbinAccountViewController';
const signUpURL: string = 'https://feedbin.com/signup';

@Component
export struct FeedbinAccountViewController {
  /** The presenting sheet's visibility — the source's `dismiss(animated:)`. */
  @Link presented: boolean;
  /** The account being edited, when opened from the Account Inspector. */
  @Prop accountID: string = '';
  /** AddAccountDismissDelegate.dismiss() — pops Add Account after a successful add. */
  dismissHost: () => void = (): void => {
    router.back();
  };

  @State email: string = '';
  @State password: string = '';
  @State showPassword: boolean = false;
  @State isSubmitting: boolean = false;
  /** Existing retrievable basic credentials -> 'Update Credentials', prefilled and enabled. */
  @State hasExistingCredentials: boolean = false;
  @State errorMessage: ResourceStr = '';

  private account?: AccountService;

  aboutToAppear(): void {
    this.loadExistingCredentials().catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'prefill failed: %{public}s', String(e));
    });
  }

  /** viewDidLoad: `try? account.retrieveCredentials(type: .basic)` */
  private async loadExistingCredentials(): Promise<void> {
    if (this.accountID.length === 0) {
      return;
    }
    const account: AccountService | undefined =
      AccountManager.shared.existingAccount(this.accountID);
    if (account === undefined) {
      return;
    }
    this.account = account;
    const credentials: Credentials | undefined =
      await account.retrieveCredentials(CredentialsType.basic);
    if (credentials !== undefined) {
      this.email = credentials.username;
      this.password = credentials.secret;
      this.hasExistingCredentials = true;
    }
  }

  /** textDidChange: enabled only when BOTH fields are non-empty. */
  private submitEnabled(): boolean {
    return !this.isSubmitting && this.email.length > 0 && this.password.length > 0;
  }

  private cancel(): void {
    this.presented = false;
  }

  private toggleShowPassword(): void {
    this.showPassword = !this.showPassword;
  }

  private openSignUp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, signUpURL).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sign-up link failed: %{public}s', String(e));
    });
  }

  /** The source's `action(_:)`. */
  private async submit(): Promise<void> {
    const trimmedEmail: string = this.email.trim();
    if (trimmedEmail.length === 0 || this.password.length === 0) {
      this.showError($r('app.string.username_password_required'));
      return;
    }
    if (this.account === undefined
      && AccountManager.shared.duplicateServiceAccount(AccountType.feedbin, trimmedEmail)) {
      this.showError($r('app.string.there_is_already_a_feedbin_account_with_that'));
      return;
    }

    const credentials: Credentials = {
      type: CredentialsType.basic,
      username: trimmedEmail,
      secret: this.password
    };

    this.isSubmitting = true;
    try {
      const validated: Credentials | undefined =
        await validateCredentialsForAccountType(AccountType.feedbin, credentials);
      if (validated === undefined) {
        this.showError($r('app.string.invalid_email_password_combination'));
        return;
      }

      let account: AccountService | undefined = this.account;
      if (account === undefined) {
        account = await AccountManager.shared.createAccount(AccountType.feedbin);
        this.account = account;
      }
      try {
        await account.storeCredentials(validated);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'storeCredentials failed: %{public}s', String(e));
        this.showError($r('app.string.keychain_error_while_storing_credentials'));
        return;
      }

      account.refreshAll().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'refresh after add failed: %{public}s', String(e));
      });
      this.presented = false;
      this.dismissHost();
    } catch (e) {
      if (e instanceof CredentialsError) {
        this.showError($r('app.string.keychain_error_while_storing_credentials'));
      } else {
        this.showError($r('app.string.network_error_try_again_later'));
      }
    } finally {
      this.isSubmitting = false;
    }
  }

  private showError(message: ResourceStr): void {
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

  // MARK: - Styling helpers (visual only — no structural decision lives here)
  /**
   * The sheet's inline nav bar: an absolutely CENTERED 17pt title
   * between two 80pt slots, the close affordance rendered as the iOS 26 round glass button
   * the capture shows (a11y label 'Cancel', glyph xmark), and the activity-indicator bar
   * item as a matching empty glass circle on the trailing side.
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
        .id('feedbin_account_cancel')
        .enabled(!this.isSubmitting)
        .onClick((): void => {
          this.cancel();
        })
      }
      .width(80)
      .justifyContent(FlexAlign.Start)

      Text('Feedbin')
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))

      Row() {
        // The activity-indicator bar item: its glass circle is present in every captured
        // state; only the spinner inside it is conditional.
        Row() {
          if (this.isSubmitting) {
            LoadingProgress()
              .width(20)
              .height(20)
              .color($r('sys.color.ohos_id_color_text_primary_activated'))
          }
        }
        .width(36)
        .height(36)
        .justifyContent(FlexAlign.Center)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
      }
      .width(80)
      .justifyContent(FlexAlign.End)
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
          // section 0 header — ImageHeaderView with Assets.accountImage(.feedbin)
          ImageHeaderView({ accountType: AccountType.feedbin as number })

          // The credentials section: ONE inset-grouped card, rows separated by a hairline
          // inset 16 inside the card (capture: card x16..374, rows 51pt, hairline x32..358).
          Column() {
            Row() {
              TextInput({ placeholder: 'Email', text: this.email })
                .id('feedbin_account_email')
                .type(InputType.Email)
                .enterKeyType(EnterKeyType.Next)
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
                  this.email = value;
                })
            }
            .width('100%')
            .constraintSize({ minHeight: 49 })
            .alignItems(VerticalAlign.Center)
            .padding({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
            })

            Divider()
              .strokeWidth(0.5)
              .color($r('sys.color.ohos_id_color_list_separator'))
              .margin({
                left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
                right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
              })

            Row() {
              TextInput({ placeholder: 'Password', text: this.password })
                .id('feedbin_account_password')
                .type(this.showPassword ? InputType.Normal : InputType.Password)
                .showPasswordIcon(false)
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
                .enterKeyType(EnterKeyType.Done)
                .onChange((value: string): void => {
                  this.password = value;
                })
                .onSubmit((): void => {
                  this.submit().catch((e: Object): void => {
                    hilog.error(DOMAIN, TAG, 'submit failed: %{public}s', String(e));
                  });
                })
              Button(this.showPassword ? 'Hide' : 'Show')
                .id('feedbin_account_show_password')
                .type(ButtonType.Normal)
                .backgroundColor(Color.Transparent)
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .padding({
                  left: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
                  right: 0
                })
                .onClick((): void => {
                  this.toggleShowPassword();
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
          // the fields card ends at y307, this one starts at y343).
          Column() {
            Button(this.hasExistingCredentials
              ? $r('app.string.update_credentials') : $r('app.string.add_account'))
              .id('feedbin_account_submit')
              .type(ButtonType.Normal)
              .backgroundColor(Color.Transparent)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .width('100%')
              .height(44)
              .enabled(this.submitEnabled())
              .onClick((): void => {
                this.submit().catch((e: Object): void => {
                  hilog.error(DOMAIN, TAG, 'submit failed: %{public}s', String(e));
                });
              })
          }
          .width('100%')
          .margin({ top: 36 })
          .padding({ top: 4, bottom: 4 })
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          Text($r('app.string.sign_in_to_your_feedbin_account_and_sync_you'))
            .width('100%')
            .margin({ top: 26 })
            .padding({ left: 4, right: 4 })
            .textAlign(TextAlign.Center)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))

          Button($r('app.string.sign_up_here'))
            .id('feedbin_account_sign_up')
            .type(ButtonType.Normal)
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick((): void => {
              this.openSignUp();
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
struct FeedbinAccountViewControllerPage {
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

  private routeAccountID(): string {
    const params: Record<string, Object> = router.getParams() as Record<string, Object>;
    if (params === undefined || params === null) {
      return '';
    }
    const value: Object | undefined = params['accountID'];
    return value === undefined ? '' : String(value);
  }

  @Builder
  overlayBody() {
    FeedbinAccountViewController({
      presented: $overlayShown,
      accountID: this.routeAccountID(),
      dismissHost: (): void => {
        this.overlayShown = false;
      }
    })
  }

  build() {
    Stack() {
    }
    .id('FeedbinAccountViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}
