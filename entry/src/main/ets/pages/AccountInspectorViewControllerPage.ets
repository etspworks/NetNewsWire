/**
 * AccountInspectorViewControllerPage
 * (source: iOS/Inspector/AccountInspectorViewController.swift + Inspector.storyboard).
 *
 * Presented as an overlay sheet over its host (presentation: modal, hostScreen
 * the root split component), exactly as the source presents it .formSheet / pushes it from
 * Settings > Accounts.
 *
 * The source remaps its storyboard sections at runtime by account type
 * (`displayedSections`): default -> [nameAndActive]; cloudKit -> [nameAndActive,
 * syncContent, deleteAccount]; onMyMac/cloudKit/feedly -> [nameAndActive, deleteAccount];
 * everything else -> [nameAndActive, credentials, deleteAccount]. That remap is the
 * screen's real structure and is reproduced here as ArkUI `if`.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountType } from '../model/AccountType';
import { AccountManager } from '../common/account/AccountManager';
import { AccountService } from '../common/account/Account';
import { BrowserService } from '../common/system/BrowserService';
import { ImageHeaderView } from '../components/ImageHeaderView';
import {
  VibrantBasicTableViewCell,
  VibrantButton,
  VibrantSectionHeader,
  VibrantSwitchTableViewCell,
  vibrantRowMinHeight
} from '../components/VibrantCell';

const DOMAIN: number = 0x0001;
const TAG: string = 'AccountInspectorViewControllerPage';

/** CloudKitWebDocumentation.limitationsAndSolutionsURL. */
const limitationsAndSolutionsURL: string = 'https://netnewswire.com/help/optimize-icloud.html';

/** AppStorage key the sidebar / Settings row writes before raising this inspector. */
const inspectedAccountIDKey: string = 'nnwInspectedAccountID';

@Entry
@Component
struct AccountInspectorViewControllerPage {
  /** The overlay is presented as soon as its route is opened (deep-link replay)
   * and when its host raises it. */
  @State overlayShown: boolean = true;

  /** AccountManager account for the inspected accountID. */
  @StorageLink(inspectedAccountIDKey) inspectedAccountID: string = '';

  /** navigationItem.title = account.nameForDisplay. */
  @State title: string = '';
  /** nameTextField.text = account.name (placeholder account.defaultName). */
  @State nameDraft: string = '';
  @State namePlaceholder: string = '';
  /** activeSwitch.isOn = account.isActive — committed in viewWillDisappear. */
  @State isActive: boolean = true;
  /** AccountManager.shared.syncArticleContentForUnreadArticles. */
  @State syncContentUnread: boolean = false;
  /** account.type — drives the whole section remap. */
  @State accountTypeRaw: number = AccountType.onMyMac as number;
  /** account == AccountManager.shared.defaultAccount. */
  @State isDefaultAccount: boolean = false;
  /** `guard let account = account else { return }` — viewDidLoad bails before it populates
   * a single outlet, so "no account" is the whole screen, not a row under a filled card. */
  @State hasAccount: boolean = false;

  private account?: AccountService;

  aboutToAppear(): void {
    this.loadAccount();
  }

  /** viewWillDisappear — the source commits name and isActive on the way out. */
  aboutToDisappear(): void {
    this.commitEdits();
  }

  onPageHide(): void {
    this.commitEdits();
  }

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl (Credentials) closes that sheet and the `$$` two-way binding latches
    // overlayShown to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
  }

  // MARK: - Data

  private resolveAccount(): AccountService | undefined {
    const params: Record<string, string> | undefined =
      router.getParams() as Record<string, string>;
    if (params !== undefined && params !== null) {
      const routedID: string | undefined = params.accountID;
      if (routedID !== undefined && routedID.length > 0) {
        const routed: AccountService | undefined =
          AccountManager.shared.existingAccount(routedID);
        if (routed !== undefined) {
          return routed;
        }
      }
    }
    if (this.inspectedAccountID.length > 0) {
      const stored: AccountService | undefined =
        AccountManager.shared.existingAccount(this.inspectedAccountID);
      if (stored !== undefined) {
        return stored;
      }
    }
    // No account named: the first account, which is what the capture inspected.
    const accounts: AccountService[] = AccountManager.shared.sortedAccounts;
    return accounts.length > 0 ? accounts[0] : undefined;
  }

  private loadAccount(): void {
    const account: AccountService | undefined = this.resolveAccount();
    this.account = account;
    this.hasAccount = account !== undefined;
    if (account === undefined) {
      return;
    }
    this.title = account.nameForDisplay;
    this.nameDraft = account.name ?? '';
    this.namePlaceholder = account.model.defaultName;
    this.isActive = account.isActive;
    this.accountTypeRaw = account.type as number;
    this.isDefaultAccount = this.computeIsDefaultAccount(account);
    this.syncContentUnread = AccountManager.shared.syncArticleContentForUnreadArticles;
  }

  /** `account == AccountManager.shared.defaultAccount` — the local account has no
   * credentials, sync-content or delete section. */
  private computeIsDefaultAccount(account: AccountService): boolean {
    try {
      const defaultAccount: AccountService = AccountManager.shared.defaultAccount;
      return defaultAccount.accountID === account.accountID;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'no default account yet');
      return false;
    }
  }

  private commitEdits(): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    account.name = this.nameDraft.length > 0 ? this.nameDraft : undefined;
    account.isActive = this.isActive;
    this.title = account.nameForDisplay;
  }

  // MARK: - displayedSections

  /** `hidesCredentialsSection` — onMyMac, cloudKit and feedly have no credentials row. */
  private hidesCredentialsSection(): boolean {
    const type: number = this.accountTypeRaw;
    return type === (AccountType.onMyMac as number)
      || type === (AccountType.cloudKit as number)
      || type === (AccountType.feedly as number);
  }

  private isCloudKitAccount(): boolean {
    return this.accountTypeRaw === (AccountType.cloudKit as number);
  }

  private showsSyncContentSection(): boolean {
    return !this.isDefaultAccount && this.isCloudKitAccount();
  }

  private showsCredentialsSection(): boolean {
    return !this.isDefaultAccount && !this.hidesCredentialsSection();
  }

  private showsDeleteSection(): boolean {
    return !this.isDefaultAccount;
  }

  /** Feedly's removal alert differs from every other type's. */
  private deleteAlertMessage(): string {
    if (this.accountTypeRaw === (AccountType.feedly as number)) {
      return 'Are you sure you want to remove this account? NetNewsWire will no longer be able'
        + ' to access articles and feeds unless the account is added again.';
    }
    return 'Are you sure you want to remove this account? This cannot be undone.';
  }

  /** The credential screen for this account type (present .currentContext in the source). */
  private credentialsRoute(): string | undefined {
    const type: number = this.accountTypeRaw;
    if (type === (AccountType.feedbin as number)) {
      return 'pages/FeedbinAccountViewControllerPage';
    }
    if (type === (AccountType.newsBlur as number)) {
      return 'pages/NewsBlurAccountViewControllerPage';
    }
    if (type === (AccountType.inoreader as number) || type === (AccountType.bazQux as number)
      || type === (AccountType.theOldReader as number)
      || type === (AccountType.freshRSS as number)) {
      return 'pages/ReaderAPIAccountViewControllerPage';
    }
    return undefined;
  }

  // MARK: - Actions

  private uiAbilityContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  /** done() — dismiss(animated:). */
  private done(): void {
    this.commitEdits();
    this.overlayShown = false;
    router.back();
  }

  /** credentials(_:) — present the account-type credential screen preloaded. */
  private openCredentials(): void {
    const route: string | undefined = this.credentialsRoute();
    if (route === undefined) {
      hilog.warn(DOMAIN, TAG, 'no credential screen for account type %{public}d',
        this.accountTypeRaw);
      return;
    }
    const account: AccountService | undefined = this.account;
    // The credential screen loads the account (and therefore its type) from this id.
    const params: Record<string, string> = {
      'accountID': account === undefined ? '' : account.accountID
    };
    router.pushUrl({ url: route, params: params }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'push %{public}s failed: %{public}s', route, err.message);
    });
  }

  /** openLimitationsAndSolutions(_:) — SFSafariViewController .pageSheet in the source. */
  private openLimitationsAndSolutions(): void {
    BrowserService.shared.openLink(this.uiAbilityContext(), limitationsAndSolutionsURL)
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'open limitations doc failed: %{public}s', err.message);
      });
  }

  /** syncContentSwitchDidChange(_:). */
  private setSyncContentUnread(value: boolean): void {
    this.syncContentUnread = value;
    AccountManager.shared.syncArticleContentForUnreadArticles = value;
  }

  /** deleteAccount(_:) — confirmation alert, then AccountManager.deleteAccount. */
  private confirmDeleteAccount(): void {
    AlertDialog.show({
      title: 'Remove Account',
      message: this.deleteAlertMessage(),
      primaryButton: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'account removal cancelled');
        }
      },
      secondaryButton: {
        value: 'Remove',
        action: () => {
          this.deleteAccount();
        }
      }
    });
  }

  private deleteAccount(): void {
    const account: AccountService | undefined = this.account;
    if (account === undefined) {
      return;
    }
    AccountManager.shared.deleteAccount(account)
      .then(() => {
        this.account = undefined;
        this.overlayShown = false;
        router.back();
      })
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'deleteAccount failed: %{public}s', err.message);
      });
  }

  // MARK: - Build
  //
  // Styling measured off the iOS reference capture of AccountInspectorViewController
  // /base (390x844pt): systemGroupedBackground; the nav band y63..117 with the account name
  // centred and a PROMINENT (accent-filled) Done at [20,67][56,103]; the account-image header
  // y117..205 (88pt, 48pt icon); one white card [16,205][374,307] holding the 51pt name field
  // and the Active row with a 0.5 hairline between them. Tokens: style-baseline.json.

  /** The hairline between two rows of one card. */
  @Builder
  rowSeparator() {
    Divider()
      .strokeWidth(0.5)
      .color($r('sys.color.ohos_id_color_list_separator'))
      .margin({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
  }

  /** Section 0 — the ImageHeaderView the source swaps in for the table header. */
  @Builder
  nameAndActiveSection() {
    Column() {
      ImageHeaderView({ accountType: this.accountTypeRaw })
      Column() {
        Row() {
          TextInput({ text: this.nameDraft, placeholder: this.namePlaceholder })
            .id('account_inspector_name')
            .layoutWeight(1)
            .height(vibrantRowMinHeight)
            .backgroundColor(Color.Transparent)
            .borderRadius(0)
            .padding({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
            })
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
            .caretColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onChange((value: string) => {
              this.nameDraft = value;
            })
            .onSubmit(() => {
              this.commitEdits();
            })
        }
        .width('100%')
        this.rowSeparator()
        VibrantSwitchTableViewCell({
          label: 'Active',
          isOn: this.isActive,
          switchId: 'account_inspector_active',
          onSwitchChange: (value: boolean): void => {
            this.isActive = value;
          }
        })
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
    }
    .width('100%')
  }

  /** The iCloud-only "Sync Content of Unread Articles" section. */
  @Builder
  syncContentSection() {
    Column() {
      Column() {
        VibrantSwitchTableViewCell({
          label: 'Sync Content of Unread Articles',
          isOn: this.syncContentUnread,
          switchId: 'account_inspector_sync_content',
          onSwitchChange: (value: boolean): void => {
            this.setSyncContentUnread(value);
          }
        })
        if (this.isCloudKitAccount()) {
          this.rowSeparator()
          // Capture: a centred accent label, not a filled button ([85,332][305,362]).
          VibrantButton({
            title: 'How to Optimize iCloud Syncing',
            buttonId: 'account_inspector_limitations',
            onTap: (): void => {
              this.openLimitationsAndSolutions();
            }
          })
        }
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)

      // The storyboard's section footer.
      Text('Syncing article content increases iCloud storage use, sync time, and battery'
        + ' use.\n\nArticle status and the content of starred articles are always synced.')
        .width('100%')
        .fontSize($r('sys.float.ohos_id_text_size_body3'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          top: $r('sys.float.ohos_id_elements_margin_horizontal_m')
        })
    }
    .width('100%')
  }

  @Builder
  credentialsSection() {
    Column() {
      VibrantButton({
        title: 'Credentials',
        buttonId: 'account_inspector_credentials',
        onTap: (): void => {
          this.openCredentials();
        }
      })
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
    .clip(true)
  }

  @Builder
  deleteAccountSection() {
    Column() {
      // Always "Remove Account": the storyboard button ships that title
      // (Inspector.storyboard:141) and viewDidLoad's `account.type != .onMyMac` branch only
      // re-sets the same string — no account type ever reads "Delete Account".
      VibrantButton({
        title: 'Remove Account',
        destructive: true,
        buttonId: 'account_inspector_delete_account',
        onTap: (): void => {
          this.confirmDeleteAccount();
        }
      })
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
    .clip(true)
    // Its own headerless section — the grouped-background air a header would have carried.
    .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
  }

  @Builder
  overlayBody() {
    Column() {
      // Nav bar: title = account.nameForDisplay (centred, inline),
      // Done added only when presented modally.
      Stack({ alignContent: Alignment.Center }) {
        Text(this.title)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ left: 76, right: 76 })
        Row() {
          VibrantButton({
            title: 'Done',
            compact: true,
            prominent: true,
            buttonId: 'account_inspector_done',
            onTap: (): void => {
              this.done();
            }
          })
            .width(76)
          Blank()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(54)
      .padding({ left: 20, right: 20 })

      Scroll() {
        Column() {
          // `guard let account = account else { return }`: viewDidLoad returns before it fills
          // any outlet, so the two states are mutually exclusive — the empty line REPLACES the
          // card, it does not print underneath a populated one.
          if (this.hasAccount) {
            this.nameAndActiveSection()

            if (this.showsSyncContentSection()) {
              VibrantSectionHeader({ title: 'Sync' })
              this.syncContentSection()
            }

            if (this.showsCredentialsSection()) {
              VibrantSectionHeader({ title: 'Credentials' })
              this.credentialsSection()
            }

            if (this.showsDeleteSection()) {
              this.deleteAccountSection()
            }
          } else {
            // the account could not be resolved — the source shows an empty table, so this
            // stays a quiet centred line rather than an invented illustration.
            VibrantBasicTableViewCell({ label: 'No account selected.' })
          }
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: 32
        })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  build() {
    Stack() {
    }
    .id('AccountInspectorViewController')
    .width('100%')
    .height('100%')
    // The root is empty for the whole sheet-close + router.back() transition, and an
    // unpainted root draws the window's default WHITE there. Paint the grouped background
    // the overlay body already uses, as the other sheet pages do.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // A back gesture or drag-down closes the sheet without hiding the page, so onPageShow
        // does not fire and the restore above cannot run: it would leave the empty root on
        // screen and take a second gesture to leave. The source commits the pending name edit
        // on an interactive dismissal too, so this is Done — route it there.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.done();
        } })
  }
}
