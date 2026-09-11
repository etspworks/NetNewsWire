/**
 * ReaderAPIAccountViewControllerPage
 * (source: iOS/Account/ReaderAPIAccountViewController.swift).
 *
 *
 * 🟥 ONE screen serving FOUR providers — FreshRSS, Inoreader, BazQux, The Old Reader.
 * Every branch keys off `accountType`: the title, the header image, the footer copy, the
 * sign-up label and destination, the section-0 row count (FreshRSS shows the API URL row)
 * and the validation messages. These are SOURCE-defined conditional branches, not styling.
 */

import common from '@ohos.app.ability.common';
import url from '@ohos.url';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { readerAPIEndpointFor, validateCredentialsForAccountType }
  from '../common/account/AccountDelegate';
import { CredentialsError } from '../common/security/CredentialsManager';
import { BrowserService } from '../common/system/BrowserService';
import { dismissTo, isBrowsingInApp } from '../common/util/Navigation';
import { AccountType } from '../model/AccountType';
import { Credentials, CredentialsType } from '../model/Credentials';
import { ImageHeaderView } from '../components/ImageHeaderView';

const DOMAIN: number = 0x0001;
const TAG: string = 'ReaderAPIAccountViewController';

@Component
export struct ReaderAPIAccountViewController {
  /** The presenting sheet's visibility — the source's `dismiss(animated:)`. */
  @Link presented: boolean;
  /**
   * The ReaderAPI variant the caller chose. @Prop, not a plain member: Add Account sets it
   * per row and the same component instance is re-presented for a different provider.
   */
  @Prop accountType: AccountType = AccountType.freshRSS;
  /** The account being edited, when opened from the Account Inspector. */
  @Prop accountID: string = '';
  /** AddAccountDismissDelegate.dismiss() — pops Add Account after a successful add. */
  dismissHost: () => void = (): void => {
    router.back();
  };

  @State username: string = '';
  /**
   * Whether ANY credential field has been edited — see submitEnabled().
   *
   * The source sets the button enabled once in viewDidLoad and then re-evaluates it in
   * updateUI(), which every field's editingChanged calls — so typing in the PASSWORD box
   * with an empty username disables it. Tracking only the username edit left the button
   * enabled in exactly that state.
   */
  @State anyFieldEdited: boolean = false;
  @State password: string = '';
  /** The self-hosted endpoint — FreshRSS only. */
  @State apiUrl: string = '';
  @State showPassword: boolean = false;
  @State isSubmitting: boolean = false;
  @State hasExistingCredentials: boolean = false;
  @State errorMessage: ResourceStr = '';

  private account?: AccountService;

  aboutToAppear(): void {
    this.loadExistingCredentials().catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'prefill failed: %{public}s', String(e));
    });
  }

  /** viewDidLoad: `try? retrieveCredentialsForAccount(for:)` — .readerBasic for all four. */
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
    const endpoint: string | undefined = account.endpointURL;
    if (endpoint !== undefined) {
      this.apiUrl = endpoint;
    }
    const credentials: Credentials | undefined =
      await account.retrieveCredentials(CredentialsType.readerBasic);
    if (credentials !== undefined) {
      this.username = credentials.username;
      this.password = credentials.secret;
      this.hasExistingCredentials = true;
    }
  }

  // MARK: - Per-variant values (all four providers)

  private isFreshRSS(): boolean {
    return this.accountType === AccountType.freshRSS;
  }

  /** The navigation title set in viewDidLoad. */
  private title(): string {
    if (this.accountType === AccountType.freshRSS) {
      return 'FreshRSS';
    }
    if (this.accountType === AccountType.inoreader) {
      return 'Inoreader';
    }
    if (this.accountType === AccountType.bazQux) {
      return 'BazQux';
    }
    return 'The Old Reader';
  }

  // headerViewImage() lives in ImageHeaderView (accountImageResource): it resolves the
  // provider artwork from the account type this screen passes it.

  /** setupFooter() — the per-provider footer copy. */
  private footerText(): Resource {
    if (this.accountType === AccountType.freshRSS) {
      return $r('app.string.sign_in_to_your_freshrss_instance_and_sync_y');
    }
    if (this.accountType === AccountType.inoreader) {
      return $r('app.string.sign_in_to_your_inoreader_account_and_sync_y');
    }
    if (this.accountType === AccountType.bazQux) {
      return $r('app.string.sign_in_to_your_bazqux_account_and_sync_your');
    }
    return $r('app.string.sign_in_to_your_the_old_reader_account_and_s');
  }

  /** setupFooter() — 'Find Out More' for FreshRSS, 'Sign Up Here' otherwise. */
  private signUpTitle(): Resource {
    return this.isFreshRSS() ? $r('app.string.find_out_more') : $r('app.string.sign_up_here');
  }

  /** signUpWithProvider(_:) — the per-provider destination. */
  private signUpURL(): string {
    if (this.accountType === AccountType.freshRSS) {
      return 'https://freshrss.org';
    }
    if (this.accountType === AccountType.inoreader) {
      return 'https://www.inoreader.com';
    }
    if (this.accountType === AccountType.bazQux) {
      return 'https://bazqux.com';
    }
    return 'https://theoldreader.com';
  }

  /** apiURL() — the typed URL for the self-hosted FreshRSS, the variant host otherwise. */
  private apiURL(): string | undefined {
    return readerAPIEndpointFor(this.accountType, this.apiUrl.trim());
  }

  // MARK: - Actions

  /**
   * `textDidChange` sets `actionButton.isEnabled = !(usernameTextField.text?.isEmpty ?? false)`,
   * and — unlike Feedbin/NewsBlur — this controller's storyboard button ships ENABLED
   * (Account.storyboard has `enabled="NO"` on the Feedbin and NewsBlur buttons only). So an
   * untouched field leaves the button live and `validateDataEntry()` raises the "Username,
   * password, and API URL are required." alert the capture records; only
   * typing and then clearing the username disables it.
   */
  private submitEnabled(): boolean {
    return !this.isSubmitting && (!this.anyFieldEdited || this.username.length > 0);
  }

  private cancel(): void {
    this.presented = false;
  }

  private toggleShowPassword(): void {
    this.showPassword = !this.showPassword;
  }

  private openSignUp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    // The source's SFSafariViewController presentation had no counterpart and this tap did
    // nothing at all: BrowserService's in-app branch only recorded the URL and notified
    // listeners, and no screen hosted the browser. openInAppBrowser now routes to
    // pages/InAppBrowserPage in that case, so the ordinary openLink() — which still lets
    // the "Open Links in NetNewsWire" preference decide — is the whole handler.
    BrowserService.shared.openLink(context, this.signUpURL()).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'sign-up link failed: %{public}s', String(e));
    });
  }

  /** validateDataEntry() — FreshRSS additionally needs a parseable API URL. */
  private validateDataEntry(): boolean {
    if (this.isFreshRSS()) {
      if (this.username.length === 0 || this.password.length === 0
        || this.apiUrl.trim().length === 0) {
        this.showError($r('app.string.username_password_and_api_url_are_required'));
        return false;
      }
      try {
        url.URL.parseURL(this.apiUrl.trim());
      } catch (e) {
        this.showError($r('app.string.invalid_api_url'));
        return false;
      }
      return true;
    }
    if (this.username.length === 0 || this.password.length === 0) {
      this.showError($r('app.string.username_and_password_are_required'));
      return false;
    }
    return true;
  }

  /** The source's `action(_:)`. */
  private async submit(): Promise<void> {
    if (!this.validateDataEntry()) {
      return;
    }
    const endpoint: string | undefined = this.apiURL();
    if (endpoint === undefined) {
      this.showError($r('app.string.invalid_api_url'));
      return;
    }
    const trimmedUsername: string = this.username.trim();
    if (this.account === undefined
      && AccountManager.shared.duplicateServiceAccount(this.accountType, trimmedUsername,
        endpoint)) {
      this.showError($r('app.string.there_is_already_an_account_of_that_type_wit'));
      return;
    }

    const credentials: Credentials = {
      type: CredentialsType.readerBasic,
      username: trimmedUsername,
      secret: this.password
    };

    this.isSubmitting = true;
    try {
      const validated: Credentials | undefined =
        await validateCredentialsForAccountType(this.accountType, credentials, endpoint);
      if (validated === undefined) {
        this.showError($r('app.string.invalid_username_password_combination'));
        return;
      }

      let account: AccountService | undefined = this.account;
      if (account === undefined) {
        account = await AccountManager.shared.createAccount(this.accountType);
        this.account = account;
      }
      try {
        account.endpointURL = endpoint;
        // BOTH are stored, as in the source: the entered pair AND the returned token.
        await account.storeCredentials(credentials);
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
        // Inoreader's AppId/AppKey were Xcode build-time secrets with no self-signed
        // equivalent: the delegate's "not configured" message is surfaced verbatim.
        this.showError((e as Error).message);
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
   * between two 80pt slots. Unlike the other account sheets this one's Cancel is a TEXT bar
   * button in a glass capsule (capture: 'Cancel' at x20..98), not the round xmark glyph, and
   * the activity-indicator bar item is a matching glass circle on the trailing side.
   */
  @Builder
  navigationBar() {
    // A Stack, not a three-slot Row: the leading slot was a fixed Row().width(80), and 80vp
    // could not hold "Cancel" plus the button's own horizontal padding, so the label rendered
    // as "Can…". Centering the title absolutely and overlaying the bar buttons lets each
    // button size to its own content — the same shape AddFolderViewControllerPage uses.
    Stack() {
      Text(this.title())
        .width('100%')
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))

      Row() {
        Button($r('app.string.cancel'))
          .id('readerapi_account_cancel')
          .type(ButtonType.Capsule)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .height(36)
          .padding({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
          .enabled(!this.isSubmitting)
          .onClick((): void => {
            this.cancel();
          })
        Blank()

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
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .hitTestBehavior(HitTestMode.Transparent)
    }
    .width('100%')
    .height(54)
    .alignContent(Alignment.Center)
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
          // section 0 header — the provider's own image
          ImageHeaderView({ accountType: this.accountType as number })

          // The credentials section: ONE inset-grouped card. FreshRSS's third row makes it
          // 153pt tall (capture y205..358); the other three providers' card is 102pt.
          Column() {
            Row() {
              TextInput({ placeholder: 'Username or Email', text: this.username })
                .id('readerapi_account_username')
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
                  this.username = value;
                  this.anyFieldEdited = true;
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
                .id('readerapi_account_password')
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
                  this.anyFieldEdited = true;
                })
              Button(this.showPassword ? 'Hide' : 'Show')
                .id('readerapi_account_show_password')
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

            // section 0 has 3 rows for FreshRSS (self-hosted), 2 for the other three
            if (this.isFreshRSS()) {
              Divider()
                .strokeWidth(0.5)
                .color($r('sys.color.ohos_id_color_list_separator'))
                .margin({
                  left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
                  right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
                })

              Row() {
                TextInput({
                  placeholder: $r('app.string.api_url_https_fresh_rss_net_api_greader_php'),
                  text: this.apiUrl
                })
                  .id('readerapi_account_api_url')
                  .type(InputType.URL)
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
                    this.apiUrl = value;
                    this.anyFieldEdited = true;
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
          }
          .width('100%')
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
          .clip(true)

          // The action section — its own card, 36pt of grouped air above it (capture:
          // the fields card ends at y358, this one starts at y394).
          Column() {
            Button(this.hasExistingCredentials
              ? $r('app.string.update_credentials') : $r('app.string.add_account'))
              .id('readerapi_account_submit')
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

          Text(this.footerText())
            .width('100%')
            .margin({ top: 26 })
            .padding({ left: 4, right: 4 })
            .textAlign(TextAlign.Center)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))

          Button(this.signUpTitle())
            .id('readerapi_account_sign_up')
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
struct ReaderAPIAccountViewControllerPage {
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

  private routeParam(key: string): Object | undefined {
    const params: Record<string, Object> = router.getParams() as Record<string, Object>;
    if (params === undefined || params === null) {
      return undefined;
    }
    return params[key];
  }

  /** The variant the caller chose; FreshRSS is the default for a bare deep link. */
  private routeAccountType(): AccountType {
    const value: Object | undefined = this.routeParam('accountType');
    if (value === undefined) {
      return AccountType.freshRSS;
    }
    const raw: string = String(value);
    if (raw === String(AccountType.inoreader as number) || raw === 'inoreader') {
      return AccountType.inoreader;
    }
    if (raw === String(AccountType.bazQux as number) || raw === 'bazQux') {
      return AccountType.bazQux;
    }
    if (raw === String(AccountType.theOldReader as number) || raw === 'theOldReader') {
      return AccountType.theOldReader;
    }
    return AccountType.freshRSS;
  }

  private routeAccountID(): string {
    const value: Object | undefined = this.routeParam('accountID');
    return value === undefined ? '' : String(value);
  }

  @Builder
  overlayBody() {
    ReaderAPIAccountViewController({
      presented: $overlayShown,
      accountType: this.routeAccountType(),
      accountID: this.routeAccountID(),
      dismissHost: (): void => {
        this.overlayShown = false;
      }
    })
  }

  build() {
    Stack() {
    }
    .id('ReaderAPIAccountViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}
