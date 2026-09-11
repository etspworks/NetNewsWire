/**
 * AddFolderViewControllerPage.
 * Source: iOS/Add/AddFolderViewController.swift, iOS/Add/Add.storyboard.
 *
 * Two sections: the Name field, and the Account row (value label + picker). The eligible
 * accounts are AccountManager.sortedActiveAccounts MINUS those declaring
 * .disallowFolderManagement; with one or fewer of them the picker row disappears entirely
 * (`shouldDisplayPicker` / `numberOfRowsInSection` returns one fewer row). The initial
 * selection is the account matching AppDefaults.addFolderAccountID, else the first. Add is
 * enabled only for a non-empty name and calls `selectedAccount.addFolder(name)`.
 *
 * `AddFolderViewController` is the mountable overlay body — the main feed screen hosts it — and
 * the @Entry page keeps the captured states replayable by route.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { AccountBehaviorKind, behaviorsContain } from '../model/AccountBehavior';
import { dismissTo } from '../common/util/Navigation';

const DOMAIN: number = 0x0001;
const TAG: string = 'AddFolderViewControllerPage';

/** AccountManager.sortedActiveAccounts.filter { !$0.behaviors.contains(.disallowFolderManagement) } */
export function folderCapableAccounts(): AccountService[] {
  const accounts: AccountService[] = [];
  for (const account of AccountManager.shared.sortedActiveAccounts) {
    if (!behaviorsContain(account.behaviors, AccountBehaviorKind.disallowFolderManagement)) {
      accounts.push(account);
    }
  }
  return accounts;
}

@Component
export struct AddFolderViewController {
  /** Local — a non-empty name enables Add. */
  @State folderName: string = '';
  /** Active accounts that do NOT declare disallowFolderManagement. */
  @State eligibleAccounts: AccountService[] = [];
  /** AppDefaults.addFolderAccountID, else the first eligible account. */
  @State selectedAccount: AccountService | undefined = undefined;
  @State private selectedIndex: number = 0;
  @State private errorMessage: string = '';

  onDismissed: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'Add Folder dismissed with no host handler');
  };

  aboutToAppear(): void {
    this.resolveAccounts();
    if (this.eligibleAccounts.length === 0) {
      // folderCapableAccounts() reads AccountManager, and EntryAbility does not await
      // AppBootstrap, so a deep-linked open resolves an empty list and the sheet offers no
      // account to create the folder in. start() returns the load already in flight.
      AccountManager.shared.start()
        .then(() => {
          this.resolveAccounts();
        })
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'accounts did not load: %{public}s', err.message);
        });
    }
  }

  private resolveAccounts(): void {
    const accounts: AccountService[] = folderCapableAccounts();
    this.eligibleAccounts = accounts;
    const predefined: string | undefined = AppDefaults.addFolderAccountID;
    let index: number = 0;
    if (predefined !== undefined) {
      for (let i: number = 0; i < accounts.length; i++) {
        if (accounts[i].accountID === predefined) {
          index = i;
          break;
        }
      }
    }
    this.selectedIndex = index;
    this.selectedAccount = accounts.length > index ? accounts[index] : undefined;
  }

  /** `shouldDisplayPicker` — accounts.count > 1. */
  private shouldDisplayPicker(): boolean {
    return this.eligibleAccounts.length > 1;
  }

  private accountNames(): string[] {
    const names: string[] = [];
    for (const account of this.eligibleAccounts) {
      names.push(account.nameForDisplay);
    }
    return names;
  }

  /** didSelect(_ account:) — persists the choice and updates the value label. */
  private didSelectAccount(index: number): void {
    if (index < 0 || index >= this.eligibleAccounts.length) {
      return;
    }
    const account: AccountService = this.eligibleAccounts[index];
    AppDefaults.addFolderAccountID = account.accountID;
    this.selectedIndex = index;
    this.selectedAccount = account;
  }

  /** add(_:) — `try await selectedAccount.addFolder(folderName)`, then dismiss either way. */
  private async addFolder(): Promise<void> {
    const account: AccountService | undefined = this.selectedAccount;
    if (account === undefined || this.folderName.length === 0) {
      return;
    }
    try {
      await account.addFolder(this.folderName);
    } catch (e) {
      this.errorMessage = (e as Error).message;
      hilog.error(DOMAIN, TAG, 'addFolder failed: %{public}s', this.errorMessage);
    } finally {
      this.onDismissed();
    }
  }

  /** `addButton.isEnabled` — the source's own enable rule, rendered as a visual state. */
  private addIsEnabled(): boolean {
    return this.folderName.length > 0 && this.selectedAccount !== undefined;
  }

  build() {
    // A formSheet on the grouped background: a centred inline title between the two bar
    // buttons, then two inset cards (capture: Name card y152..196, Account+picker card
    // y232..416, both x16..374).
    Column() {
      Stack() {
        Text($r('app.string.add_folder'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          Button($r('app.string.cancel'))
            .id('addfolder_cancel')
            .type(ButtonType.Capsule)
            .height(36)
            .backgroundColor($r('sys.color.ohos_id_color_background'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .onClick(() => {
              this.onDismissed();
            })
          Blank()
          Button('Add')
            .id('addfolder_add')
            .type(ButtonType.Capsule)
            .height(36)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .enabled(this.addIsEnabled())
            // The source keeps Add disabled until the name is non-empty — show it.
            .opacity(this.addIsEnabled() ? 1 : 0.4)
            .onClick(() => {
              this.addFolder();
            })
        }
        .width('100%')
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(54)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // Section 1 — the Name field, its own card.
      TextInput({ placeholder: $r('app.string.name'), text: this.folderName })
        .id('addfolder_name')
        // width('100%') is the PARENT's width and the margin is added outside it, so this
        // node rendered a left-plus-right margin wider than the screen and its right edge
        // was clipped. alignSelf(Stretch) fills the cross axis MINUS the margins.
        .alignSelf(ItemAlign.Stretch)
        .height(44)
        .backgroundColor($r('sys.color.ohos_id_color_background'))
        .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
        .placeholderFont({ size: $r('sys.float.ohos_id_text_size_body1') })
        .margin({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          top: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .onChange((value: string) => {
          // textDidChange: addButton.isEnabled = !text.isEmpty
          this.folderName = value;
        })

      // Section 2 — the Account value row and, under it in the SAME card, the picker.
      Column() {
        Row({ space: 8 }) {
          Text($r('app.string.account'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
          Blank()
          Text(this.selectedAccount === undefined ? '' : this.selectedAccount.nameForDisplay)
            .id('addfolder_account_value')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .constraintSize({ minHeight: 44 })
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })

        // accountPickerView.isHidden = !shouldDisplayPicker
        if (this.shouldDisplayPicker()) {
          Divider()
            .strokeWidth(0.5)
            .color($r('sys.color.ohos_id_color_list_separator'))
            .margin({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
            })
          TextPicker({ range: this.accountNames(), selected: this.selectedIndex })
            .id('addfolder_account_picker')
            .width('100%')
            .height(140)
            .backgroundColor(Color.Transparent)
            .onChange((value: string | string[], index: number | number[]) => {
              this.didSelectAccount(typeof index === 'number' ? index : index[0]);
            })
        }
      }
      // width('100%') is the PARENT's width and the margin is added outside it, so this
      // node rendered a left-plus-right margin wider than the screen and its right edge
      // was clipped. alignSelf(Stretch) fills the cross axis MINUS the margins.
      .alignSelf(ItemAlign.Stretch)
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .margin({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // addFolder()'s failure path — the source presents the account error here.
      if (this.errorMessage.length > 0) {
        Text(this.errorMessage)
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body2'))
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .padding({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            top: $r('sys.float.ohos_id_elements_margin_horizontal_m')
          })
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }
}

@Entry
@Component
struct AddFolderViewControllerPage {
  @State overlayShown: boolean = true;

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown
    // to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
  }

  /** Cancel and the sheet's own back gesture both mean the same thing: uncover the presenter. */
  private dismissSelf(): void {
    this.overlayShown = false;
    // The source presents this sheet FROM the feed list, so dismissing uncovers the
    // feed list — not the empty backdrop this replay-only @Entry page would show.
    dismissTo('pages/MainFeedCollectionViewControllerPage');
  }

  @Builder
  overlayBody() {
    AddFolderViewController({
      onDismissed: (): void => {
        this.dismissSelf();
      }
    })
  }

  build() {
    Stack() {
    }
    .id('AddFolderViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // A back gesture or drag-down closes the sheet without hiding the page, so onPageShow
        // does not fire and the restore above cannot run: it would leave the empty root on
        // screen and take a second gesture to leave. Same as Cancel.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.dismissSelf();
        } })
  }
}
