/**
 * AddFeedViewControllerPage.
 * Source: iOS/Add/AddFeedViewController.swift, iOS/Add/Add.storyboard,
 *         Shared/Extensions/AddFeedDefaultContainer.swift.
 *
 * One grouped section of three rows — URL, Title (Optional) and the Folder row showing the
 * chosen container — under a Cancel / "Add Feed" / Add bar. Behaviour, verbatim from the
 * source:
 *   - with no initial feed, the pasteboard is used when it `mayBeURL`;
 *   - every URL change re-evaluates `addButton.isEnabled = text.mayBeURL`, and Add starts
 *     disabled outright when there is no default container;
 *   - the Folder row presents AddFeedFolderViewController (.currentContext); the delegate
 *     stores the container, updates the detail label and saves it as the default;
 *   - Add normalizes the URL, resolves the owning Account, rejects an already-subscribed URL,
 *     swaps itself for a spinner and calls
 *     `account.createFeed(url:name:container:validateFeed:true)`; on success it dismisses and
 *     discloses the new feed in the sidebar (the source's .UserDidAddFeed notification).
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { router } from '@kit.ArkUI';
import { pasteboard, BusinessError } from '@kit.BasicServicesKit';
import { AddFeedSelectFolderTableViewCell } from '../components/AddComboCell';
import { AddFeedFolderViewController } from './AddFeedFolderViewControllerPage';
import { AccountService, ContainerRef } from '../common/account/Account';
import { AccountError, AccountErrorKind } from '../common/account/AccountDelegate';
import { AccountManager } from '../common/account/AccountManager';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { normalizedURL } from '../common/util/Urls';
import { trimmingWhitespace } from '../common/util/Strings';
import { AccountBehaviorKind, behaviorsContain } from '../model/AccountBehavior';
import { Feed } from '../model/Feed';
import { Folder, sortedFolders } from '../model/Folder';
import { containerKey } from '../common/tree/TreeController';
import { dismissTo } from '../common/util/Navigation';

const DOMAIN: number = 0x0001;
const TAG: string = 'AddFeedViewControllerPage';

/** String.mayBeURL (Modules/RSCore/Sources/RSCore/String+RSCore.swift). */
export function mayBeURL(text: string): boolean {
  const s: string = trimmingWhitespace(text);
  if (s.length === 0) {
    return false;
  }
  if (s.indexOf('.') < 0 && s.indexOf('[') < 0 && s.indexOf('localhost') < 0) {
    return false;
  }
  // banned: whitespace, newlines and control characters anywhere in the string
  for (let i: number = 0; i < s.length; i++) {
    const code: number = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** AddFeedDefaultContainer.substituteContainerIfNeeded(account:) */
function substituteContainerIfNeeded(account: AccountService): ContainerRef | undefined {
  if (!behaviorsContain(account.behaviors, AccountBehaviorKind.disallowFeedInRootFolder)) {
    return ContainerRef.forAccount(account);
  }
  const folders: Folder[] = sortedFolders(account.folders());
  return folders.length > 0 ? ContainerRef.forFolder(account, folders[0]) : undefined;
}

/** AddFeedDefaultContainer.defaultContainer */
export function defaultAddFeedContainer(): ContainerRef | undefined {
  const accountID: string | undefined = AppDefaults.addFeedAccountID;
  if (accountID !== undefined) {
    for (const account of AccountManager.shared.activeAccounts) {
      if (account.accountID !== accountID) {
        continue;
      }
      const folderName: string | undefined = AppDefaults.addFeedFolderName;
      if (folderName !== undefined) {
        const folder: Folder | undefined = account.existingFolderWithDisplayName(folderName);
        if (folder !== undefined) {
          return ContainerRef.forFolder(account, folder);
        }
      }
      return substituteContainerIfNeeded(account);
    }
  }
  const accounts: AccountService[] = AccountManager.shared.sortedActiveAccounts;
  return accounts.length > 0 ? substituteContainerIfNeeded(accounts[0]) : undefined;
}

/** AddFeedDefaultContainer.saveDefaultContainer(_:) */
export function saveDefaultAddFeedContainer(container: ContainerRef): void {
  AppDefaults.addFeedAccountID = container.account.accountID;
  AppDefaults.addFeedFolderName =
    container.isAccount ? undefined : container.nameForDisplay;
}

/** updateFolderLabel(): "<Account> / <Folder>" for a folder, the bare account name otherwise. */
export function folderLabelFor(container: ContainerRef | undefined): string {
  if (container === undefined) {
    return '';
  }
  if (container.isAccount) {
    return container.nameForDisplay;
  }
  return container.account.nameForDisplay + ' / ' + container.nameForDisplay;
}

@Component
export struct AddFeedViewController {
  /** Prefilled from the deep link / Settings, or from the pasteboard when it mayBeURL. */
  @State urlText: string = '';
  /** Optional display name passed to createFeed. */
  @State nameText: string = '';
  /** The chosen account/folder, defaulted from AddFeedDefaultContainer. */
  @State container: ContainerRef | undefined = undefined;
  /** True while createFeed(validateFeed: true) runs — Add becomes a spinner. */
  @State isValidating: boolean = false;
  @State private errorMessage: string = '';
  @State private folderPickerShown: boolean = false;
  /** True when the screen was opened with a prefilled feed (Add starts enabled). */
  @Prop initialFeed: string = '';
  @Prop initialFeedName: string = '';

  onDismissed: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'Add Feed dismissed with no host handler');
  };
  /**
   * The success path, separate from a Cancel: the source dismisses AND discloses the new
   * feed, so the host has to show it rather than just uncover the presenter.
   */
  onFeedAdded: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'feed added with no host handler');
  };

  aboutToAppear(): void {
    this.urlText = this.initialFeed.length > 0 ? normalizedURL(this.initialFeed) : '';
    this.nameText = this.initialFeedName;
    this.container = defaultAddFeedContainer();
    if (this.container === undefined) {
      hilog.info(DOMAIN, TAG, 'no default container — Add stays disabled');
      // defaultAddFeedContainer() reads AccountManager.activeAccounts, and EntryAbility does
      // not await AppBootstrap, so a cold start that opens this sheet directly resolves no
      // container: the Folder row renders with no value and Add stays disabled forever.
      // start() hands back the load already in flight, so re-resolve once it lands.
      AccountManager.shared.start()
        .then(() => {
          this.container = defaultAddFeedContainer();
        })
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'accounts did not load: %{public}s', err.message);
        });
    }
    if (this.initialFeed.length === 0) {
      this.prefillFromPasteboard();
    }
  }

  /** `if initialFeed == nil, let urlString = UIPasteboard.general.string, urlString.mayBeURL`. */
  private prefillFromPasteboard(): void {
    try {
      const data: pasteboard.PasteData = pasteboard.getSystemPasteboard().getDataSync();
      const text: string = data.getPrimaryText();
      if (text !== undefined && mayBeURL(text)) {
        this.urlText = normalizedURL(text);
      }
    } catch (e) {
      hilog.debug(DOMAIN, TAG, 'pasteboard unavailable: %{public}s', (e as Error).message);
    }
  }

  /** updateUI(): addButton.isEnabled = urlText.mayBeURL, and never without a container. */
  private addIsEnabled(): boolean {
    return !this.isValidating && this.container !== undefined && mayBeURL(this.urlText);
  }

  /** AddFeedFolderViewControllerDelegate.didSelect(container:) */
  private didSelectContainer(container: ContainerRef): void {
    this.container = container;
    saveDefaultAddFeedContainer(container);
    this.folderPickerShown = false;
  }

  /** add(_:) */
  private async addFeed(): Promise<void> {
    const container: ContainerRef | undefined = this.container;
    const normalized: string = normalizedURL(this.urlText);
    if (container === undefined || normalized.length === 0) {
      return;
    }
    const account: AccountService = container.account;
    if (account.hasFeedWithURL(normalized)) {
      this.errorMessage = AccountError.of(AccountErrorKind.createErrorAlreadySubscribed).message;
      return;
    }

    this.errorMessage = '';
    this.isValidating = true;
    const feedName: string | undefined =
      this.nameText.length === 0 ? undefined : this.nameText;
    try {
      const feed: Feed = await account.createFeed(normalized, feedName, container, true);
      // .UserDidAddFeed — the sidebar reveals and selects the new feed. discloseFeed only
      // moves the coordinator's selection; showing that selection is the host's job.
      await SceneCoordinator.shared.discloseFeed(feed);
      this.onFeedAdded();
    } catch (e) {
      this.errorMessage = (e as Error).message;
      hilog.error(DOMAIN, TAG, 'createFeed failed: %{public}s', this.errorMessage);
    } finally {
      this.isValidating = false;
    }
  }

  @Builder
  folderPicker() {
    AddFeedFolderViewController({
      initialContainerKey: this.container === undefined
        ? '' : containerKey(this.container.containerID),
      onContainerSelected: (container: ContainerRef): void => {
        this.didSelectContainer(container);
      },
      onCancelled: (): void => {
        this.folderPickerShown = false;
      }
    })
  }

  build() {
    // A formSheet on the grouped background: centred inline title between the two bar
    // buttons, then ONE inset card of three rows — URL, Title (Optional), Folder — with the
    // hairline inset 16pt inside the card (capture: card x16..374, rows 44pt, sep x32..358).
    Column() {
      Stack() {
        Text($r('app.string.add_feed'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          Button($r('app.string.cancel'))
            .id('addfeed_cancel')
            .type(ButtonType.Capsule)
            .height(36)
            .backgroundColor($r('sys.color.ohos_id_color_background'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .onClick(() => {
              // userCancelled = true; dismiss(animated:)
              this.onDismissed();
            })
          Blank()
          // add(_:) swaps the button for a spinner while the feed is validated.
          if (this.isValidating) {
            LoadingProgress()
              .width(24)
              .height(24)
              .color($r('sys.color.ohos_id_color_text_primary_activated'))
          } else {
            Button('Add')
              .id('addfeed_add')
              .type(ButtonType.Capsule)
              .height(36)
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .enabled(this.addIsEnabled())
              .opacity(this.addIsEnabled() ? 1 : 0.4)
              .onClick(() => {
                this.addFeed();
              })
          }
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

      Column() {
        TextInput({ placeholder: $r('app.string.url'), text: this.urlText })
          .id('addfeed_url')
          .type(InputType.URL)
          .width('100%')
          .height(44)
          .backgroundColor(Color.Transparent)
          .borderRadius(0)
          .padding({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
          .placeholderFont({ size: $r('sys.float.ohos_id_text_size_body1') })
          .onChange((value: string) => {
            this.urlText = value;
          })

        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })

        TextInput({ placeholder: 'Title (Optional)', text: this.nameText })
          .id('addfeed_name')
          .width('100%')
          .height(44)
          .backgroundColor(Color.Transparent)
          .borderRadius(0)
          .padding({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .placeholderColor($r('sys.color.ohos_id_color_text_tertiary'))
          .placeholderFont({ size: $r('sys.float.ohos_id_text_size_body1') })
          .onChange((value: string) => {
            this.nameText = value;
          })

        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })

        // Row 2 — the AddFeedSelectFolderTableViewCell, whose detail label is the container.
        Row() {
          AddFeedSelectFolderTableViewCell({
            folderLabel: 'Folder',
            detailLabel: folderLabelFor(this.container)
          })
        }
        .width('100%')
        .id('addfeed_folder')
        .onClick(() => {
          // didSelectRowAt row 2 -> present AddFeedFolderNavViewController (.currentContext)
          this.folderPickerShown = true;
        })
      }
      // `width('100%')` means the PARENT's full width and a margin is added outside it, so
      // this card was rendering one left-plus-right margin wider than the screen and its right
      // edge — rounded corner, separator ends, the Folder row's value — was clipped away.
      // alignSelf(Stretch) fills the cross axis MINUS the margins, which is what an inset card
      // wants. (Settings' cards avoid it the other way, with no margin and the inset on the
      // parent.)
      .alignSelf(ItemAlign.Stretch)
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
      .clip(true)
      .margin({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // createFeed()'s failure path — "already subscribed", download errors, …
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
    .bindSheet($$this.folderPickerShown, this.folderPicker(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
  }
}

@Entry
@Component
struct AddFeedViewControllerPage {
  @State overlayShown: boolean = true;
  /**
   * `showAddFeed(initialFeed:initialFeedName:)` — the presenter's arguments. They arrive as
   * route params because the callers are abilities and other pages, not a coordinator:
   * EntryAbility for a `feed:`/`feeds:` link, and Settings for the NetNewsWire News feed.
   * Without this the sheet always opened empty and both prefills were dropped on the floor.
   */
  @State private initialFeed: string = '';
  @State private initialFeedName: string = '';

  aboutToAppear(): void {
    const params: Record<string, string> | undefined =
      router.getParams() as Record<string, string>;
    if (params === undefined || params === null) {
      return;
    }
    const feed: string | undefined = params.initialFeed;
    const name: string | undefined = params.initialFeedName;
    if (feed !== undefined) {
      this.initialFeed = feed;
    }
    if (name !== undefined) {
      this.initialFeedName = name;
    }
  }

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown
    // to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
  }

  /** Cancel and the sheet's own drag-down both mean the same thing: uncover the presenter. */
  private dismissSelf(): void {
    this.overlayShown = false;
    // The source presents this sheet FROM the feed list, so dismissing uncovers the
    // feed list — not the empty backdrop this replay-only @Entry page would show.
    dismissTo('pages/MainFeedCollectionViewControllerPage');
  }

  @Builder
  overlayBody() {
    AddFeedViewController({
      initialFeed: this.initialFeed,
      initialFeedName: this.initialFeedName,
      onDismissed: (): void => {
        this.dismissSelf();
      },
      onFeedAdded: (): void => {
        // discloseFeed() already selected the new feed, so the source's next screen is its
        // timeline — the same place tapping the feed in the sidebar lands
        // (MainFeedCollectionViewControllerPage: selectSidebarItem + showColumn). replaceUrl,
        // not pushUrl: Add Feed is done, and Back from the timeline belongs to the feed list.
        this.overlayShown = false;
        router.replaceUrl({ url: 'pages/MainTimelineModernViewControllerPage' })
          .catch((err: BusinessError) => {
            hilog.warn(DOMAIN, TAG, 'show added feed failed: %{public}s', err.message);
          });
      }
    })
  }

  build() {
    Stack() {
    }
    .id('AddFeedViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // Dragging the sheet down never hides the page, so onPageShow does not fire and the
        // restore above cannot run: the drag would leave the empty root on screen. Take the
        // dismissal over and treat it as Cancel.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.dismissSelf();
        } })
  }
}
