/**
 * MainFeedCollectionViewControllerPage (the cold-start root).
 * Source: iOS/MainFeed/MainFeedCollectionViewController.swift (+Drag/+Drop),
 *         iOS/MainFeed/Collection View Cells/*.swift, iOS/Base.lproj/Main.storyboard.
 *
 * "Feeds" over one inset-grouped list of the sidebar tree: a Smart Feeds section header, then
 * one collapsible section per account, each row a feed or a folder. The diffable data source's
 * (section, row) IndexPath is a FLAT index into SceneCoordinator.sidebarRows here (see
 * common/tree/TreeController.ts `visibleRows`), so `selectSidebarItem(indexPath:)` takes a row
 * index. Nav bar: the title plus the filter-read-feeds button; bottom bar: Settings, the
 * refresh progress view, Current Activity and Add.
 *
 * This page also HOSTS the two overlays the source presents from here: Add Folder (.formSheet)
 * and Current Activity (a .medium/.large-detent sheet).
 */

import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import {
  MainFeedCollectionViewCell, SidebarRowDataSource, SidebarRowInfo, sidebarRowInfo
} from '../components/MainFeedCell';
import { MainFeedCollectionViewFolderCell } from '../components/MainFeedFolderCell';
import { MainFeedCollectionHeaderReusableView } from '../components/MainFeedSectionHeader';
import { IconView, labelTint, primaryAccentTint, startColorModeWatch } from '../components/IconView';
import {
  IconImageCache, FeedIconDownloader, FeedIconAvailableListener,
  FaviconDownloader, FaviconAvailableListener
} from '../common/images/IconImageCache';
import { RefreshProgressView } from '../components/RefreshProgressView';
import {
  MarkAsReadAlertController, confirmMarkAllAsReadIsRequired
} from '../components/MarkAsReadAlert';
import { RootSplitViewController, SplitColumn, showColumn } from '../components/RootSplitHost';
import { AddFolderViewController } from './AddFolderViewControllerPage';
import { CurrentActivityView } from './CurrentActivityViewPage';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { AccountService, ContainerRef } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { AccountRefreshTimer } from '../common/timer/RefreshTimers';
import { BrowserService } from '../common/system/BrowserService';
import { localized } from '../common/system/Localized';
import { ShareService } from '../common/system/ShareService';
import { DeleteCommand, UndoableCommandRunner } from '../common/command/UndoableCommandRunner';
import { SidebarRow } from '../common/tree/TreeController';
import { AccountBehaviorKind, behaviorsContain } from '../model/AccountBehavior';
import { Article } from '../model/Article';
import { Feed } from '../model/Feed';
import { FetchType } from '../model/FetchType';
import { Folder } from '../model/Folder';
import { Node } from '../model/Node';

const DOMAIN: number = 0x0001;
const TAG: string = 'MainFeedCollectionViewControllerPage';

/** Which overlay the page's single sheet slot is showing. */
enum FeedSheet {
  none = 'none',
  addFolder = 'addFolder',
  currentActivity = 'currentActivity'
}

/** The route params showFeedInspector(for:) carries — `resolveFeed()` reads `feedID` first. */
interface FeedInspectorRouteParams {
  feedID: string;
}

/**
 * rename(indexPath:) raises a UIAlertController with a TEXT FIELD prefilled with the current
 * name (`alert.addTextField { $0.text = name }`) and renames to whatever the user typed.
 * ArkUI's AlertDialog has no text field, so the migrated prompt could only ever hand the old
 * name straight back to `renameRow` — a rename that renamed nothing. A CustomDialog is the
 * only ArkUI dialog form that takes input, so the field lives here.
 */
@CustomDialog
struct RenameAlertController {
  controller?: CustomDialogController;
  /** The row's current title, which is what the field opens on. */
  @Prop currentName: string = '';
  @State private draft: string = '';
  onRenamed: (newName: string) => void = (): void => {
    hilog.warn(DOMAIN, TAG, 'renamed with no completion attached');
  };

  aboutToAppear(): void {
    this.draft = this.currentName;
  }

  private dismiss(): void {
    const controller: CustomDialogController | undefined = this.controller;
    if (controller !== undefined) {
      controller.close();
    }
  }

  build() {
    // The same dialog surface MarkAsReadAlertController uses — bold title, then the field
    // and the two actions, Cancel emphasised as iOS emphasises its cancel action.
    Column({ space: 8 }) {
      Text($r('app.string.rename'))
        .width('100%')
        .textAlign(TextAlign.Center)
        .fontSize($r('sys.float.ohos_id_text_size_sub_title2'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      TextInput({ text: this.draft })
        .id('feed_rename_field')
        .width('100%')
        .height(44)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .onChange((value: string) => {
          this.draft = value;
        })
      Button($r('app.string.rename'))
        .id('feed_rename_confirm')
        .type(ButtonType.Capsule)
        .width('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        // The source disables its Rename action for an empty field.
        .enabled(this.draft.length > 0)
        .opacity(this.draft.length > 0 ? 1 : 0.4)
        .onClick(() => {
          this.dismiss();
          this.onRenamed(this.draft);
        })
      Button($r('app.string.cancel'))
        .id('feed_rename_cancel')
        .type(ButtonType.Capsule)
        .width('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontWeight(FontWeight.Bold)
        .onClick(() => {
          this.dismiss();
          hilog.debug(DOMAIN, TAG, 'rename cancelled');
        })
    }
    .width('100%')
    .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
    .backgroundColor($r('sys.color.ohos_id_color_dialog_bg'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_dialog'))
  }
}

/**
 * `delete(indexPath:)` (MainFeedCollectionViewController.swift:1341) NEVER deletes straight
 * away: it raises a UIAlertController(.alert) titled "Delete Feed" / "Delete Folder" with the
 * message 'Are you sure you want to delete the “%@” feed?', a .cancel Cancel and a
 * .destructive Delete which is also the alert's `preferredAction`. `performDelete(indexPath:)`
 * — the DeleteCommand — only runs from that Delete action. The port wired the menu and
 * the swipe straight to the command, so a feed was gone the moment the row was tapped, with
 * nothing between the user and the loss.
 *
 * ArkUI's built-in AlertDialog cannot carry a stable `.id()` on its buttons, and the test
 * driver finds a control by id or by visible text, so this follows the same @CustomDialog
 * form RenameAlertController and MarkAsReadAlertController already use on this screen.
 */
@CustomDialog
struct DeleteAlertController {
  controller?: CustomDialogController;
  /** "Delete Feed" or "Delete Folder". */
  @Prop alertTitle: string = '';
  /** 'Are you sure you want to delete the “%@” feed?', already formatted with the name. */
  @Prop alertMessage: string = '';
  onDeleteConfirmed: () => void = (): void => {
    hilog.warn(DOMAIN, TAG, 'delete confirmed with no completion attached');
  };

  private dismiss(): void {
    const controller: CustomDialogController | undefined = this.controller;
    if (controller !== undefined) {
      controller.close();
    }
  }

  build() {
    Column({ space: 8 }) {
      Text(this.alertTitle)
        .width('100%')
        .textAlign(TextAlign.Center)
        .fontSize($r('sys.float.ohos_id_text_size_sub_title2'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text(this.alertMessage)
        .width('100%')
        .textAlign(TextAlign.Center)
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      // A two-action iOS .alert lays its buttons out side by side, cancel leading. The
      // destructive action is red; the cancel action is the tinted, emphasised one.
      Row({ space: 8 }) {
        Button($r('app.string.cancel'))
          .id('feed_delete_cancel')
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(FontWeight.Bold)
          .onClick(() => {
            this.dismiss();
            hilog.debug(DOMAIN, TAG, 'delete cancelled');
          })
        Button($r('app.string.delete'))
          .id('feed_delete_confirm')
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .onClick(() => {
            this.dismiss();
            this.onDeleteConfirmed();
          })
      }
      .width('100%')
    }
    .width('100%')
    .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
    .backgroundColor($r('sys.color.ohos_id_color_dialog_bg'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_dialog'))
  }
}

@Entry
@Component
struct MainFeedCollectionViewControllerPage {
  /** the feed tree rootNode flattened to visible rows, wrapped for LazyForEach. */
  @State sidebarNodes: SidebarRowDataSource = new SidebarRowDataSource();
  /** Bumped on every expand/collapse so the list re-reads the coordinator's rows. */
  @StorageLink('nnwExpandedContainers') expandedContainers: number = 0;
  /** AppDefaults.hideReadFeeds, published by the coordinator. */
  @StorageLink('nnwIsReadFeedsFiltered') isReadFiltered: boolean = false;
  /** CombinedRefreshProgress, published by RefreshProgressView. */
  @StorageLink('nnwRefreshProgress') refreshProgress: number = 0;
  /** AccountManager.lastRefreshCompletedDate — rendered by RefreshProgressView. */
  @State lastRefreshLabel: string = '';
  /** The coordinator's selection; the timeline page reads the same key. */
  @StorageLink('nnwSelectedSidebarItemID') selectedSidebarItemId: string = '';
  /** Bumped by the coordinator whenever the sidebar rows change. */
  @StorageLink('nnwSidebarVersion') private sidebarVersion: number = 0;
  /**
   * True while the app draws in the dark palette. The toolbar/nav glyphs are template PNGs,
   * and a PNG can only be recoloured through a ColorFilter built from plain numbers, which
   * ArkUI cannot re-resolve on a palette switch the way it re-resolves a Resource — so the
   * light/dark choice is made HERE, in ArkTS, not by the resource qualifier (the
   * full reasoning is on `templateTintDynamic` in components/IconView.ets).
   *
   * This replaces `@StorageProp('currentColorMode')`, which earlier revisions used. That key is
   * not something this app ever writes and it is not in the SDK's typings either, so its
   * value was the declared default forever — it made build() depend on nothing. The value
   * behind `nnwDarkMode` is written by `startColorModeWatch` from the ability's own
   * Configuration, which is exactly what Color Palette > Dark updates.
   */
  @StorageProp('nnwDarkMode') private isDarkMode: boolean = false;

  /**
   * `addNewItemButton.isEnabled = !AccountManager.shared.activeAccounts.isEmpty`, held as
   * STATE. AccountManager.start() is async here (databases + OPML), so the first build()
   * runs with zero accounts; read straight from the manager, `.enabled()` computed a plain
   * method with no observable dependency, never re-evaluated, and Add stayed dead for the
   * whole session even once the sidebar had the account's feeds.
   */
  @State private hasActiveAccounts: boolean = false;
  /** Bumped when a feed icon/favicon download lands, so the rows re-read the cache. */
  @State private iconVersion: number = 0;
  @State private isRefreshing: boolean = false;
  @State private sheetKind: FeedSheet = FeedSheet.none;
  @State private sheetShown: boolean = false;
  @State private markAllAsReadTitle: string = '';
  /** "Delete Feed" / "Delete Folder" — the delete alert's title. */
  @State private deleteAlertTitle: string = '';
  /** The delete alert's message, already formatted with the row's name. */
  @State private deleteAlertMessage: string = '';
  /** The title the rename dialog's field opens on. */
  @State private renameName: string = '';
  /** The row a long press / drag is acting on — the source's `indexPath` parameter. */
  @State private contextRow: SidebarRow | undefined = undefined;
  @State private draggedFeed: Feed | undefined = undefined;

  private coordinatorListener: () => void = (): void => {
    this.reloadRows();
  };

  /** .feedIconDidBecomeAvailable — a feed icon finished downloading; redraw the rows. */
  private feedIconListener: FeedIconAvailableListener = (feed: Feed): void => {
    this.iconVersion = this.iconVersion + 1;
  };

  /** .faviconDidBecomeAvailable — same, for the favicon fallback. */
  private faviconListener: FaviconAvailableListener = (faviconURL: string): void => {
    this.iconVersion = this.iconVersion + 1;
  };

  private markAllAsReadDialog: CustomDialogController = new CustomDialogController({
    builder: MarkAsReadAlertController({
      confirmTitle: this.markAllAsReadTitle,
      onConfirmed: (): void => {
        this.markContextItemAsRead();
      }
    }),
    autoCancel: true
  });

  private deleteDialog: CustomDialogController = new CustomDialogController({
    builder: DeleteAlertController({
      alertTitle: this.deleteAlertTitle,
      alertMessage: this.deleteAlertMessage,
      onDeleteConfirmed: (): void => {
        this.performDelete(this.contextRow);
      }
    }),
    autoCancel: true
  });

  private renameDialog: CustomDialogController = new CustomDialogController({
    builder: RenameAlertController({
      currentName: this.renameName,
      onRenamed: (newName: string): void => {
        this.renameRow(this.contextRow, newName);
      }
    }),
    autoCancel: true
  });

  aboutToAppear(): void {
    startColorModeWatch(this.getUIContext());
    SceneCoordinator.shared.addListener(this.coordinatorListener);
    FeedIconDownloader.shared.addListener(this.feedIconListener);
    FaviconDownloader.shared.addListener(this.faviconListener);
    this.reloadRows();
  }

  aboutToDisappear(): void {
    SceneCoordinator.shared.removeListener(this.coordinatorListener);
    FeedIconDownloader.shared.removeListener(this.feedIconListener);
    FaviconDownloader.shared.removeListener(this.faviconListener);
  }

  onPageShow(): void {
    // Color Palette pops back with router.back(), which re-runs onPageShow but NOT
    // aboutToAppear — so the palette has to be re-read here or the glyphs keep the old tint.
    startColorModeWatch(this.getUIContext());
    // viewWillAppear -> updateUI(); willEnterForeground fires the overdue refresh timer.
    AccountRefreshTimer.shared.fireOldTimer();
    AccountRefreshTimer.shared.update();
    this.reloadRows();
  }

  onPageHide(): void {
    // didEnterBackground — persist the expansion set, selection and read filters.
    SceneCoordinator.shared.didEnterBackground();
  }

  private reloadRows(): void {
    const rows: SidebarRow[] = SceneCoordinator.shared.sidebarRows;
    this.sidebarNodes.reload(rows);
    this.isReadFiltered = SceneCoordinator.shared.isReadFeedsFiltered;
    const date: Date | undefined = AccountManager.shared.lastRefreshCompletedDate;
    this.lastRefreshLabel = date === undefined ? '' : date.toISOString();
    // updateUI() — the source recomputes the Add button's enablement on every reload.
    this.hasActiveAccounts = AccountManager.shared.activeAccounts.length > 0;
    this.prefetchRowIcons(rows);
  }

  /**
   * applySnapshot(_:) starts with `IconImageCache.shared.prefetchImagesForFeeds(feeds)`.
   * Without it nothing ever calls the downloaders — `imageForFeed` only consults the
   * CACHES — so every feed row drew the empty placeholder forever.
   */
  private prefetchRowIcons(rows: SidebarRow[]): void {
    const feeds: Feed[] = [];
    for (const row of rows) {
      const obj: Object = row.node.representedObject;
      if (obj instanceof Feed) {
        feeds.push(obj);
      }
    }
    if (feeds.length > 0) {
      IconImageCache.shared.prefetchImagesForFeeds(feeds);
    }
  }

  // MARK: - Toolbar actions

  /** toggleFilter(_:) -> coordinator.toggleReadFeedsFilter() */
  private toggleFilter(): void {
    SceneCoordinator.shared.toggleReadFeedsFilter();
    this.reloadRows();
  }

  /** settings(_:) -> coordinator.showSettings() */
  private showSettings(): void {
    router.pushUrl({ url: 'pages/SettingsViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Settings failed: %{public}s', err.message);
      });
  }

  private showAddFeed(): void {
    router.pushUrl({ url: 'pages/AddFeedViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Add Feed failed: %{public}s', err.message);
      });
  }

  private presentSheet(kind: FeedSheet): void {
    this.sheetKind = kind;
    this.sheetShown = true;
  }

  /** `anyActiveAccountSupportsFolders` — Add Folder only appears when one does. */
  private anyActiveAccountSupportsFolders(): boolean {
    for (const account of AccountManager.shared.activeAccounts) {
      if (!behaviorsContain(account.behaviors, AccountBehaviorKind.disallowFolderManagement)) {
        return true;
      }
    }
    return false;
  }

  /**
   * add(_:) presents an .actionSheet: Add Feed, and Add Folder when it is allowed.
   *
   * `hasAccounts` is the @State the caller reads, so the menu is REBUILT when the accounts
   * finish loading — without it the menu was frozen at its first (account-less) evaluation
   * and could never grow the Add Folder entry.
   */
  private addMenuElements(hasAccounts: boolean): MenuElement[] {
    const addFeed: MenuElement = {
      value: $r('app.string.add_feed'),
      action: (): void => {
        this.showAddFeed();
      }
    };
    const elements: MenuElement[] = [addFeed];
    if (hasAccounts && this.anyActiveAccountSupportsFolders()) {
      const addFolder: MenuElement = {
        value: $r('app.string.add_folder'),
        action: (): void => {
          this.presentSheet(FeedSheet.addFolder);
        }
      };
      elements.push(addFolder);
    }
    // The source's .actionSheet ends in a Cancel action. ArkUI's bindMenu is dismissed by a
    // tap outside and offers no such row, so the sheet read as having no way to back out.
    // Selecting it closes the menu and does nothing else, which is the source's behaviour.
    const cancel: MenuElement = {
      value: $r('app.string.cancel'),
      action: (): void => {
        hilog.debug(DOMAIN, TAG, 'add action sheet cancelled');
      }
    };
    elements.push(cancel);
    return elements;
  }

  /** refreshAccounts(_:) -> appDelegate.manualRefresh(errorHandler:) */
  private async pullToRefresh(): Promise<void> {
    this.isRefreshing = true;
    try {
      // manualRefresh runs cleanUp(conditional: true) on every scene BEFORE
      // refreshAllWithoutWaiting — the Feeds screen's refresh control goes through the same
      // AppDelegate entry point as the timeline's, so it clears the same two filtered sets.
      await SceneCoordinator.shared.cleanUp(true);
      await AccountManager.shared.refreshAll((error: Error): void => {
        hilog.error(DOMAIN, TAG, 'refreshAll: %{public}s', error.message);
      });
      await SceneCoordinator.shared.unreadCountDidChange();
    } finally {
      this.isRefreshing = false;
      this.reloadRows();
    }
  }

  // MARK: - Row actions

  /** didSelectItemAt -> coordinator.selectSidebarItem(indexPath:), then show the timeline. */
  private async selectRow(index: number): Promise<void> {
    await SceneCoordinator.shared.selectSidebarItem(index, true);
    showColumn(SplitColumn.supplementary);
  }

  /** containerHeaderTapped / setDisclosure(isExpanded:) -> expand(node) / collapse(node). */
  private toggleExpansion(row: SidebarRow): void {
    SceneCoordinator.shared.toggleExpandedNode(row.node);
    this.expandedContainers = this.expandedContainers + 1;
    this.reloadRows();
  }

  private feedForRow(row: SidebarRow | undefined): Feed | undefined {
    if (row === undefined) {
      return undefined;
    }
    const obj: Object = row.node.representedObject;
    return obj instanceof Feed ? obj : undefined;
  }

  private accountForRow(row: SidebarRow | undefined): AccountService | undefined {
    if (row === undefined) {
      return undefined;
    }
    const obj: Object = row.node.representedObject;
    return obj instanceof AccountService ? obj : undefined;
  }

  /**
   * delete(indexPath:) — the CONFIRMATION, not the delete. Both entry points the source has
   * (the context menu's Delete and the trailing-swipe Delete) call this same function there,
   * so the guard lives here once instead of at each call site.
   */
  private confirmDelete(row: SidebarRow | undefined): void {
    if (row === undefined) {
      return;
    }
    // The dialog's completion reads contextRow, so pin it to the row actually acted on —
    // the swipe path does not go through the context menu's touch-down capture.
    this.contextRow = row;
    const info: SidebarRowInfo = sidebarRowInfo(row);
    if (info.isFolder) {
      this.deleteAlertTitle = localized('delete_folder', 'Delete Folder');
      this.deleteAlertMessage = localized('are_you_sure_you_want_to_delete_the_folder',
        'Are you sure you want to delete the “%s” folder?').replace('%s', info.title);
    } else {
      this.deleteAlertTitle = localized('delete_feed', 'Delete Feed');
      this.deleteAlertMessage = localized('are_you_sure_you_want_to_delete_the_feed_3',
        'Are you sure you want to delete the “%s” feed?').replace('%s', info.title);
    }
    this.deleteDialog.open();
  }

  /** performDelete(indexPath:) -> DeleteCommand + the undo stack. Only the alert calls it. */
  private async performDelete(row: SidebarRow | undefined): Promise<void> {
    if (row === undefined) {
      return;
    }
    const command: DeleteCommand | undefined = DeleteCommand.create([row.node],
      (error: Error): void => {
        hilog.error(DOMAIN, TAG, 'delete failed: %{public}s', error.message);
      },
      // didChange runs after perform AND after undo, so a restored feed reappears too.
      (): void => {
        SceneCoordinator.shared.rebuildBackingStores();
        this.reloadRows();
      });
    if (command === undefined) {
      return;
    }
    await UndoableCommandRunner.shared.runCommand(command);
  }

  /** rename(indexPath:) -> feed.rename(to:) / folder.rename(to:) */
  private async renameRow(row: SidebarRow | undefined, newName: string): Promise<void> {
    if (row === undefined || newName.length === 0) {
      return;
    }
    const obj: Object = row.node.representedObject;
    if (obj instanceof Feed) {
      const account: AccountService | undefined = AccountManager.shared.accountForFeed(obj);
      if (account !== undefined) {
        await account.renameFeed(obj, newName);
      }
    } else if (obj instanceof Folder) {
      const account: AccountService | undefined = AccountManager.shared.accountForFolder(obj);
      if (account !== undefined) {
        await account.renameFolder(obj, newName);
      }
    }
    SceneCoordinator.shared.rebuildBackingStores();
    this.reloadRows();
  }

  /** The source's rename alert, prefilled with the current name. */
  private showRenamePrompt(row: SidebarRow | undefined): void {
    if (row === undefined) {
      return;
    }
    // The swipe action and the context menu both land here; the dialog's completion reads
    // contextRow, so pin it to the row that was actually acted on.
    this.contextRow = row;
    this.renameName = sidebarRowInfo(row).title;
    this.renameDialog.open();
  }

  /**
   * getInfoAction -> coordinator.showFeedInspector(for:), which CARRIES the feed. This pushed
   * with no params at all, and the inspector's `resolveFeed()` falls back to the first feed of
   * the first account when it is told nothing — so Get Info on any row but the first opened
   * the wrong feed. Name the row's feed the way the inspector already looks for it.
   */
  private showFeedInspector(): void {
    const feed: Feed | undefined = this.feedForRow(this.contextRow);
    const params: FeedInspectorRouteParams = { feedID: feed === undefined ? '' : feed.feedID };
    router.pushUrl({ url: 'pages/FeedInspectorViewControllerPage', params: params })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Feed Inspector failed: %{public}s', err.message);
      });
  }

  /** Same for the account header's two inspectors — SettingsViewControllerPage sets this key. */
  private publishInspectedAccount(): void {
    const account: AccountService | undefined = this.accountForRow(this.contextRow);
    if (account !== undefined) {
      AppStorage.setOrCreate<string>('nnwInspectedAccountID', account.accountID);
    }
  }

  private showAccountInspector(): void {
    this.publishInspectedAccount();
    router.pushUrl({ url: 'pages/AccountInspectorViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Account Inspector failed: %{public}s', err.message);
      });
  }

  private showNotificationInspector(): void {
    this.publishInspectedAccount();
    router.pushUrl({ url: 'pages/AccountNotificationInspectorViewPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Notification Inspector failed: %{public}s', err.message);
      });
  }

  /** homePageAction -> UIApplication.shared.open(feed.homePageURL) */
  private openHomePage(): void {
    const feed: Feed | undefined = this.feedForRow(this.contextRow);
    if (feed === undefined) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openFeedHomePage(context, feed);
  }

  private copyFeedURL(): void {
    const feed: Feed | undefined = this.feedForRow(this.contextRow);
    if (feed !== undefined) {
      BrowserService.shared.copyLink(feed.url);
    }
  }

  private copyHomePageURL(): void {
    const feed: Feed | undefined = this.feedForRow(this.contextRow);
    const homePageURL: string | undefined = feed === undefined ? undefined : feed.homePageURL;
    if (homePageURL !== undefined) {
      BrowserService.shared.copyLink(homePageURL);
    }
  }

  /** The More action sheet's share entry — the real system share panel, not a clipboard write. */
  private shareFeedURL(): void {
    const feed: Feed | undefined = this.feedForRow(this.contextRow);
    if (feed === undefined) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    ShareService.shared.shareURL(context, feed.url, feed.nameForDisplay);
  }

  /**
   * `markAllAsReadAction(indexPath:)` builds its title as
   * `NSString.localizedStringWithFormat("Mark All as Read in “%@”", sidebarItem.nameForDisplay)`
   * and hands the SAME string to `MarkAsReadAlertController.confirm(confirmTitle:)`. The
   * port hard-coded the bare "Mark All as Read" in both places, so the menu entry never
   * named the feed it was about to touch.
   */
  private markAllAsReadCommandTitle(): string {
    const row: SidebarRow | undefined = this.contextRow;
    if (row === undefined) {
      return localized('mark_all_as_read', 'Mark All as Read');
    }
    return localized('mark_all_as_read_in', 'Mark All as Read in “%s”')
      .replace('%s', sidebarRowInfo(row).title);
  }

  /** `sidebarItem.unreadCount > 0` — the source drops the action entirely when it is 0. */
  private contextUnreadCount(): number {
    const row: SidebarRow | undefined = this.contextRow;
    return row === undefined ? 0 : sidebarRowInfo(row).unreadCount;
  }

  /**
   * Get Info / Open Home Page / Copy … / Share all `guard let feed = … as? Feed` in the
   * source, and `makeFolderContextMenu` offers none of them. Without this the folder rows
   * showed a Get Info that opened the inspector on a feed that was not the row.
   */
  private contextIsFeed(): boolean {
    return this.feedForRow(this.contextRow) !== undefined;
  }

  /** markAllAsReadAction -> MarkAsReadAlertController.confirm then markAllAsRead(fetched). */
  private requestMarkAllAsRead(title: string): void {
    this.markAllAsReadTitle = title;
    if (confirmMarkAllAsReadIsRequired()) {
      this.markAllAsReadDialog.open();
    } else {
      this.markContextItemAsRead();
    }
  }

  private async markContextItemAsRead(): Promise<void> {
    const row: SidebarRow | undefined = this.contextRow;
    if (row === undefined) {
      return;
    }
    const obj: Object = row.node.representedObject;
    let articles: Article[] = [];
    if (obj instanceof Feed) {
      const account: AccountService | undefined = AccountManager.shared.accountForFeed(obj);
      if (account !== undefined) {
        articles = await account.fetchArticles(FetchType.forFeed(obj));
      }
    } else if (obj instanceof Folder) {
      const account: AccountService | undefined = AccountManager.shared.accountForFolder(obj);
      if (account !== undefined) {
        articles = await account.fetchArticles(FetchType.forFolder(obj, true));
      }
    } else if (obj instanceof AccountService) {
      articles = await obj.fetchArticles(FetchType.unread());
    }
    await SceneCoordinator.shared.markAllAsRead(articles);
    this.reloadRows();
  }

  /** Deactivate (account header context menu) -> account.isActive = false */
  private deactivateAccount(): void {
    const account: AccountService | undefined = this.accountForRow(this.contextRow);
    if (account === undefined) {
      return;
    }
    account.isActive = false;
    SceneCoordinator.shared.rebuildBackingStores();
    this.reloadRows();
  }

  // MARK: - Drag and drop (MainFeedCollectionViewController+Drag/+Drop)

  /** Same account -> account.moveFeed(from:to:); cross-account -> addFeed(existingFeed). */
  private async dropFeed(feed: Feed, targetRow: SidebarRow): Promise<void> {
    const sourceAccount: AccountService | undefined = AccountManager.shared.accountForFeed(feed);
    if (sourceAccount === undefined) {
      return;
    }
    const target: Object = targetRow.node.representedObject;
    let destinationAccount: AccountService | undefined = undefined;
    let destination: ContainerRef | undefined = undefined;
    if (target instanceof Folder) {
      destinationAccount = AccountManager.shared.accountForFolder(target);
      if (destinationAccount !== undefined) {
        destination = ContainerRef.forFolder(destinationAccount, target);
      }
    } else if (target instanceof AccountService) {
      destinationAccount = target;
      destination = target.containerRef;
    }
    if (destinationAccount === undefined || destination === undefined) {
      return;
    }
    // .disallowFeedInMultipleFolders forbids a duplicate URL under the same account.
    if (behaviorsContain(destinationAccount.behaviors,
      AccountBehaviorKind.disallowFeedInMultipleFolders)
      && destinationAccount.hasFeedWithURL(feed.url)
      && destinationAccount !== sourceAccount) {
      hilog.info(DOMAIN, TAG, 'drop rejected: this account already has that feed');
      return;
    }
    if (destinationAccount === sourceAccount) {
      const containers: ContainerRef[] = AccountManager.shared.containersForFeed(feed);
      const source: ContainerRef =
        containers.length > 0 ? containers[0] : sourceAccount.containerRef;
      await sourceAccount.moveFeed(feed, source, destination);
    } else {
      await destinationAccount.addFeed(feed, destination);
    }
    SceneCoordinator.shared.rebuildBackingStores();
    this.reloadRows();
  }

  // MARK: - Builders

  /**
   * Refresh's DEFAULT indicator keeps a LoadingProgress node in the tree permanently — visible
   * even at rest, with nothing in flight — so the screen reads "still loading" forever. Render
   * the spinner only while a refresh is actually running.
   */
  @Builder
  refreshIndicator() {
    Row() {
      if (this.isRefreshing) {
        LoadingProgress().width(32).height(32)
      }
    }
    .width('100%')
    .height(this.isRefreshing ? 32 : 0)
    .justifyContent(FlexAlign.Center)
  }

  /**
   * The feed context menu: Get Info / Open Home Page / Copy … / Share / Mark All as Read.
   * `makeFeedContextMenu` / `makeFolderContextMenu` both build their entries from optional
   * actions, so an entry that does not apply to the long-pressed row is absent rather than
   * dead — the feed-only actions on a folder, and Mark All as Read on a row with 0 unread.
   */
  @Builder
  feedContextMenu() {
    Menu() {
      if (this.contextIsFeed()) {
        MenuItem({ content: $r('app.string.get_info') })
          .onClick(() => {
            this.showFeedInspector();
          })
        MenuItem({ content: $r('app.string.open_home_page') })
          .onClick(() => {
            this.openHomePage();
          })
        MenuItem({ content: $r('app.string.copy_feed_url') })
          .onClick(() => {
            this.copyFeedURL();
          })
        MenuItem({ content: $r('app.string.copy_home_page_url') })
          .onClick(() => {
            this.copyHomePageURL();
          })
        MenuItem({ content: $r('app.string.share') })
          .onClick(() => {
            this.shareFeedURL();
          })
      }
      if (this.contextUnreadCount() > 0) {
        MenuItem({ content: this.markAllAsReadCommandTitle() })
          .onClick(() => {
            this.requestMarkAllAsRead(this.markAllAsReadCommandTitle());
          })
      }
      MenuItem({ content: $r('app.string.rename') })
        .onClick(() => {
          this.showRenamePrompt(this.contextRow);
        })
      // `deleteAction` is the ONLY UIAction in makeFeedContextMenu / makeFolderContextMenu
      // built with `attributes: .destructive` — every other entry (Rename, Get Info, the
      // Copy pair, Share, Mark All as Read, and the account menu's Deactivate) is a plain
      // UIAction. So exactly one item reddens, and it uses the same warning token the
      // swipe Delete and the confirmation dialog already use.
      MenuItem({ content: $r('app.string.delete') })
        .contentFontColor($r('sys.color.ohos_id_color_warning'))
        .onClick(() => {
          this.confirmDelete(this.contextRow);
        })
    }
  }

  /** The account-header context menu: Get Info / Notifications / Mark All as Read / Deactivate. */
  @Builder
  accountContextMenu() {
    Menu() {
      MenuItem({ content: $r('app.string.get_info') })
        .onClick(() => {
          this.showAccountInspector();
        })
      MenuItem({ content: $r('app.string.notifications') })
        .onClick(() => {
          this.showNotificationInspector();
        })
      if (this.contextUnreadCount() > 0) {
        MenuItem({ content: this.markAllAsReadCommandTitle() })
          .onClick(() => {
            this.requestMarkAllAsRead(this.markAllAsReadCommandTitle());
          })
      }
      MenuItem({ content: $r('app.string.deactivate') })
        .onClick(() => {
          this.deactivateAccount();
        })
    }
  }

  /** Trailing swipe: Delete, Rename and (feeds only) More. */
  @Builder
  swipeActions(row: SidebarRow) {
    // iOS trailing-swipe styling: a destructive red Delete, then neutral grey actions.
    Row() {
      Button($r('app.string.delete'))
        .id('feed_swipe_delete')
        .type(ButtonType.Normal)
        .height('100%')
        .backgroundColor($r('sys.color.ohos_id_color_warning'))
        .fontColor($r('sys.color.ohos_id_color_foreground_contrary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .onClick(() => {
          // The source's swipe action calls the SAME `delete(indexPath:)` the menu does, so
          // it raises the confirmation too — it is not a shortcut past it.
          this.confirmDelete(row);
        })
      Button($r('app.string.rename'))
        .id('feed_swipe_rename')
        .type(ButtonType.Normal)
        .height('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .onClick(() => {
          this.contextRow = row;
          this.showRenamePrompt(row);
        })
      if (this.feedForRow(row) !== undefined) {
        Button($r('app.string.more'))
          .id('feed_swipe_more')
          .type(ButtonType.Normal)
          .height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .fontSize($r('sys.float.ohos_id_text_size_body2'))
          .onClick(() => {
            this.contextRow = row;
            this.requestMarkAllAsRead(this.markAllAsReadCommandTitle());
          })
      }
    }
    .height('100%')
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /**
   * The grouped-list card. Section headers sit on the bare grouped background; every other
   * row is a slice of the section's white card (capture: card x16..374, rows 50pt tall).
   */
  private rowBackground(info: SidebarRowInfo): ResourceColor {
    return info.isGroupItem
      ? Color.Transparent : $r('sys.color.ohos_id_color_background');
  }

  /** Only a section's first/last row rounds — the middle rows must stay square. */
  private rowCorners(index: number, info: SidebarRowInfo): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const top: boolean = !info.isGroupItem && this.sidebarNodes.isFirstInSection(index);
    const bottom: boolean = !info.isGroupItem && this.sidebarNodes.isLastInSection(index);
    const corners: BorderRadiuses = {
      topLeft: top ? radius : 0,
      topRight: top ? radius : 0,
      bottomLeft: bottom ? radius : 0,
      bottomRight: bottom ? radius : 0
    };
    return corners;
  }

  /** 18pt of grouped-background air above every section header but the first. */
  private rowTopGap(index: number, info: SidebarRowInfo): Length {
    return info.isGroupItem && index > 0
      ? $r('sys.float.ohos_id_elements_margin_horizontal_l') : 0;
  }

  @Builder
  rowBody(row: SidebarRow, index: number, info: SidebarRowInfo) {
    Column() {
      Row({ space: 8 }) {
        if (!info.isGroupItem) {
          IconView({
            iconURL: info.iconURL,
            symbolName: info.symbolName,
            dimension: 24,
            // IconImage.preferredColor — the smart feeds' orange sun / blue ring / yellow
            // star (Assets.swift). A SymbolGlyph's colour only takes on the glyph itself.
            tintColor: info.tintColor
          })
        }
        if (info.isGroupItem) {
          MainFeedCollectionHeaderReusableView({
            headerTitle: info.title,
            unreadCount: info.unreadCount,
            disclosureExpanded: SceneCoordinator.shared.isExpandedNode(row.node),
            onHeaderTapped: (): void => {
              this.toggleExpansion(row);
            }
          })
        } else if (info.isFolder) {
          MainFeedCollectionViewFolderCell({
            folderTitle: info.title,
            unreadCount: info.unreadCount,
            disclosureExpanded: SceneCoordinator.shared.isExpandedNode(row.node),
            onToggleDisclosure: (): void => {
              this.toggleExpansion(row);
            }
          })
        } else {
          MainFeedCollectionViewCell({
            feedTitle: info.title,
            unreadCount: info.unreadCount
          })
        }
      }
      .width('100%')
      // A feed inside a folder is indented one level (favicon leading 32 vs 16).
      .padding({
        left: info.indentationLevel === 1 ? 32 : 16,
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      // Capture: a header band is 36pt, a feed/folder row 50pt (24pt icon + 13pt insets).
      // iOS sizes these from content, so there is no HarmonyOS token for the value.
      .constraintSize({ minHeight: info.isGroupItem ? 36 : 49 })
      .alignItems(VerticalAlign.Center)

      // The grouped-list hairline, inset past the favicon and dropped on the card's last row.
      if (!info.isGroupItem && !this.sidebarNodes.isLastInSection(index)) {
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({ left: info.indentationLevel === 1 ? 64 : 48 })
      }
    }
    .width('100%')
    .backgroundColor(this.rowBackground(info))
    .borderRadius(this.rowCorners(index, info))
    .margin({ top: this.rowTopGap(index, info) })
    .id(info.isGroupItem ? 'feed_section_header_itemroot'
      : (info.isFolder ? 'feed_folder_itemroot' : 'feed_itemroot'))
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.contextRow = row;
      }
    })
    .onClick(() => {
      if (info.isGroupItem) {
        this.toggleExpansion(row);
      } else {
        this.selectRow(index);
      }
    })
    // NO `.draggable()` / `.onDragStart()` here, on purpose. ArkUI starts a drag with a
    // LongPress(500ms)+Pan sequence bound to the dragged node, and the GestureReferee orders
    // the hit-test chain inside-out — so this Column's drag long press beat the ListItem's
    // `.bindContextMenu(…, ResponseType.LongPress)` and a long press only lifted the row
    // instead of opening the menu. The timeline binds the same context menu
    // WITHOUT draggable and its menu works, which is what isolates this to the drag.
    // UIKit resolves the pair (press -> menu, press+move -> drag); ArkUI cannot, so the menu
    // wins and the source's feed-into-folder drag is off. Restoring it means re-adding the
    // two modifiers, and the menu goes dead again.
    .onDrop((event: DragEvent, extraParams?: string) => {
      const feed: Feed | undefined = this.draggedFeed;
      if (feed !== undefined) {
        this.dropFeed(feed, row);
      }
      this.draggedFeed = undefined;
    })
  }

  @Builder
  sidebarRow(row: SidebarRow, index: number, info: SidebarRowInfo) {
    // `UIContextMenuConfiguration` lifts the long-pressed cell out of the list and blurs
    // everything else behind it; with no `preview` ArkUI just drops a plain menu on the
    // untouched screen, which is what the bug report showed. MenuPreviewMode.IMAGE takes
    // the snapshot of the bound node — the row — and dims the rest, matching the source.
    // Section 0 (Smart Feeds) and the section headers have no swipe actions.
    if (info.isGroupItem || row.sectionIndex === 0) {
      ListItem() {
        this.rowBody(row, index, info)
      }
      .bindContextMenu(this.accountContextMenu, ResponseType.LongPress,
        { preview: MenuPreviewMode.IMAGE })
    } else {
      ListItem() {
        this.rowBody(row, index, info)
      }
      .swipeAction({ end: this.swipeActions(row) })
      .bindContextMenu(this.feedContextMenu, ResponseType.LongPress,
        { preview: MenuPreviewMode.IMAGE })
    }
  }

  @Builder
  sidebarList() {
    Column() {
      // Nav bar, iOS large-title form (capture: the bar-button row at y51-87, the 34pt bold
      // title below at y104-145, both on the grouped background with no separator).
      Column() {
        Row() {
          // Main.storyboard:387 — the rightBarButtonItem's image is the PLAIN
          // `line.3.horizontal.decrease`, in BOTH states; setFilterButtonToActive/Inactive
          // only swap the TINT (primaryAccent vs .label). The circle / circle.fill pair this
          // used before is a different glyph the source never puts on this screen.
          // 36vp box: ArkUI width is border-box, so the 6vp padding leaves a 24vp glyph and
          // the capture's 36pt round bar button (x334..370) is reproduced exactly.
          Image($r('app.media.ic_sf_line_3_horizontal_decrease'))
            .width(36)
            .height(36)
            .objectFit(ImageFit.Contain)
            .padding(6)
            // setFilterButtonToActive/Inactive (MainFeedCollectionViewController.swift:745,
            // :750) tint with `Assets.Colors.primaryAccent` / `.label` — both DYNAMIC
            // colours. The port had baked their light values in as literals, so in dark mode
            // the inactive glyph stayed near-black on a black bar.
            //
            // Note: earlier revisions both left the light/dark choice to the resource
            // qualifier and both measured RGB(0,0,0) on device. The choice is now made in
            // ArkTS from `isDarkMode`, over two base-only tokens, so no qualifier resolution
            // sits between the palette and the glyph. See `templateTintDynamic` in
            // components/IconView.ets for why the gear "passing" never proved otherwise.
            .colorFilter(this.isReadFiltered
              ? primaryAccentTint(this.isDarkMode)
              : labelTint(this.isDarkMode))
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
            .id('feed_filter')
            .onClick(() => {
              this.toggleFilter();
            })
        }
        .width('100%')
        .height(44)
        .justifyContent(FlexAlign.End)
        .alignItems(VerticalAlign.Center)

        Text($r('app.string.feeds'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_headline6'))
          .fontWeight(FontWeight.Bold)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
      }
      .width('100%')
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
      })

      Refresh({ refreshing: $$this.isRefreshing, builder: this.refreshIndicator() }) {
        List() {
          LazyForEach(this.sidebarNodes, (row: SidebarRow, index: number) => {
            this.sidebarRow(row, index, sidebarRowInfo(row))
          }, (row: SidebarRow) => row.node.uniqueID.toString() + '-' + this.sidebarVersion
            + '-' + this.iconVersion)
        }
        .width('100%')
        .height('100%')
        .cachedCount(8)
        .scrollBar(BarState.Off)
        // The 16pt grouped-list side inset — the cards are x16..374 in a 390pt capture.
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
      }
      .id('feed_pull_refresh')
      .layoutWeight(1)
      .onRefreshing(() => {
        this.pullToRefresh();
      })

      // Bottom bar: Settings / Current Activity / progress / Add — the capture's order, with
      // the leading pair in one glass capsule and Add in its own round glass button.
      Row() {
        Row({ space: 14 }) {
          // Main.storyboard:378 gives the Settings item no tint of its own, so it inherits
          // the window's: SceneDelegate.swift:22 `window!.tintColor =
          // Assets.Colors.primaryAccent`. The port drew the template PNG untinted, i.e.
          // black — wrong in light mode too, and invisible on the dark bar.
          Image($r('app.media.ic_sf_gear'))
            .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .objectFit(ImageFit.Contain)
            .colorFilter(primaryAccentTint(this.isDarkMode))
            .id('feed_settings')
            .onClick(() => {
              this.showSettings();
            })
          // Assets.Images.currentActivity = RSImage(symbol: "text.pad.header") — the lined
          // rounded rectangle, not the bubbles-and-sparkles glyph this used before.
          // updateCurrentActivityButtonState() (:113) tints it
          // `hasCurrentActivity ? primaryAccent : .label`. The idle half is what this port
          // has — and `.label` is a dynamic colour, so it must be the text token, not the
          // untinted black PNG this drew. The lit-while-refreshing half needs
          // the ActivityLog running/pending counts, which this page does not observe yet.
          Image($r('app.media.ic_sf_text_pad_header'))
            .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .objectFit(ImageFit.Contain)
            // Note: the `.label` half is now picked in ArkTS from `isDarkMode` instead of
            // by the resource qualifier — earlier revisions both trusted the qualifier here and
            // both measured RGB(0,0,0) on the RGB(25,25,25) pill.
            .colorFilter(labelTint(this.isDarkMode))
            .id('feed_current_activity')
            .onClick(() => {
              this.presentSheet(FeedSheet.currentActivity);
            })
        }
        .padding({ left: 14, right: 14, top: 8, bottom: 8 })
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .borderRadius($r('sys.float.ohos_id_corner_radius_button'))

        Column() {
          RefreshProgressView()
        }
        .layoutWeight(1)
        .padding({ left: 8, right: 8 })

        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          .padding(8)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .id('feed_add')
          .enabled(this.hasActiveAccounts)
          // the source disables Add with no active account — show that, don't just eat taps.
          .opacity(this.hasActiveAccounts ? 1 : 0.4)
          .bindMenu(this.addMenuElements(this.hasActiveAccounts))
      }
      .width('100%')
      .height($r('sys.float.titlebar_default_height'))
      .alignItems(VerticalAlign.Center)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  /** The two overlays this screen hosts, through the one sheet slot. */
  @Builder
  hostedSheet() {
    Column() {
      if (this.sheetKind === FeedSheet.addFolder) {
        AddFolderViewController({
          onDismissed: (): void => {
            this.sheetShown = false;
            SceneCoordinator.shared.rebuildBackingStores();
            this.reloadRows();
          }
        })
      } else if (this.sheetKind === FeedSheet.currentActivity) {
        CurrentActivityView({
          onDismissed: (): void => {
            this.sheetShown = false;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  build() {
    Column() {
      RootSplitViewController({ column: SplitColumn.primary }) {
        this.sidebarList()
      }
    }
    .width('100%')
    .height('100%')
    // systemGroupedBackground — #F1F3F5 light / #000000 dark, the palette's iOS pair.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.sheetShown, this.hostedSheet(),
      { height: SheetSize.MEDIUM, dragBar: true, showClose: false })
  }
}
