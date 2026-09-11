/**
 * RootSplitViewController.
 * Source: iOS/RootSplitViewController.swift, iOS/SceneCoordinator.swift, iOS/KeyboardManager.swift.
 *
 * The three-column UISplitViewController. On the phone the capture was taken on it is always
 * COLLAPSED, so the three columns are three routed pages (Feeds -> Timeline -> Article) and
 * this component is what remains of the split controller itself:
 *   - `showColumn()` — the source's `show(.supplementary)` / `show(.secondary)` semantics,
 *     which on a collapsed split view push the next column;
 *   - the hardware-keyboard commands KeyboardManager installs on each column
 *     (Shared/Resources/{Global,Sidebar,Timeline}KeyboardShortcuts.plist).
 *
 * It wraps whichever column's content it is given, so each column page keeps its own body.
 *
 * It also carries the column's READABLE WIDTH CAP (see `readableColumnWidth`), which is the
 * one place all three columns pass through.
 */

import { router } from '@kit.ArkUI';
import { KeyCode } from '@kit.InputKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { BrowserService } from '../common/system/BrowserService';
import { Article } from '../model/Article';

const DOMAIN: number = 0x0001;
const TAG: string = 'RootSplitHost';

/** UISplitViewController.Column. */
export enum SplitColumn {
  primary = 'primary',
  supplementary = 'supplementary',
  secondary = 'secondary'
}

/**
 * The widest a column's content is allowed to get.
 *
 * The reference capture is a 390x844pt iPhone (the iOS reference capture). Landscape there is
 * 844x390pt, a COMPACT horizontal size class, so the source's UISplitViewController stays
 * COLLAPSED — one full-width column, which is what this port already does. The source only
 * splits on iPad or a large (Max/Plus) iPhone; see the comment at
 * iOS/MainTimeline/Cell/MainTimelineCell.swift:82 and the phone bail-out at
 * iOS/RootSplitViewController.swift:37. So a split view here would be MORE than the source
 * does, and what is actually missing is the bound the source puts on wide content.
 *
 * The number is the source's own, not an invented one: `preferredContentSizeForFormSheetDisplay`
 * is CGSize(width: 460.0, ...) in every place it is declared —
 * iOS/Add/AddFeedViewController.swift:21, iOS/Add/AddFolderViewController.swift:20,
 * iOS/Inspector/AccountInspectorViewController.swift:15,
 * iOS/Inspector/FeedInspectorViewController.swift:18,
 * Modules/RSCore/Sources/RSCore/UIKit/UIStoryboard+RSCore.swift:14.
 *
 * A cap, not a width: the device's portrait window is 376vp (1316px / 3.5), well under 460,
 * so this resolves to the full width and portrait is byte-for-byte the layout that was accepted.
 * Landscape is 809vp (2832px / 3.5), so there it clamps to 460 and centres.
 */
export const readableColumnWidth: number = 460;

const columnRoutes: Map<SplitColumn, string> = new Map<SplitColumn, string>([
  [SplitColumn.primary, 'pages/MainFeedCollectionViewControllerPage'],
  [SplitColumn.supplementary, 'pages/MainTimelineModernViewControllerPage'],
  [SplitColumn.secondary, 'pages/ArticleViewControllerPage']
]);

/**
 * `splitViewController.show(column)` on a collapsed split view. The primary column is the
 * navigation root, so revealing it pops back instead of pushing a second copy.
 */
export function showColumn(column: SplitColumn): void {
  if (column === SplitColumn.primary) {
    router.back({ url: 'pages/MainFeedCollectionViewControllerPage' });
    return;
  }
  const url: string | undefined = columnRoutes.get(column);
  if (url === undefined) {
    return;
  }
  router.pushUrl({ url: url }).catch((err: BusinessError) => {
    hilog.warn(DOMAIN, TAG, 'showColumn %{public}s failed: %{public}s', column, err.message);
  });
}

@Component
export struct RootSplitViewController {
  /** Which column this instance is hosting — it selects the key-command set. */
  @Prop column: SplitColumn = SplitColumn.primary;
  @BuilderParam columnContent: () => void = this.emptyColumn;

  @Builder
  emptyColumn() {
    Column() {
    }
    .width('100%')
    .height('100%')
  }

  /**
   * KeyboardManager's commands. GlobalKeyboardShortcuts apply to every column; the sidebar
   * and timeline plists add their own navigation keys.
   */
  private handleKey(event: KeyEvent): void {
    if (event.type !== KeyType.Down) {
      return;
    }
    const coordinator: SceneCoordinator = SceneCoordinator.shared;
    const code: number = event.keyCode;

    // --- GlobalKeyboardShortcuts.plist ---
    if (code === KeyCode.KEYCODE_N) {
      coordinator.selectNextUnread();
      return;
    }
    if (code === KeyCode.KEYCODE_R || code === KeyCode.KEYCODE_U) {
      coordinator.toggleReadForCurrentArticle();
      return;
    }
    if (code === KeyCode.KEYCODE_S) {
      coordinator.toggleStarredForCurrentArticle();
      return;
    }
    if (code === KeyCode.KEYCODE_K) {
      coordinator.markAllAsRead(coordinator.articles);
      return;
    }
    if (code === KeyCode.KEYCODE_B) {
      this.openCurrentArticleInBrowser();
      return;
    }
    if (code === KeyCode.KEYCODE_A) {
      coordinator.selectPrevFeed();
      return;
    }
    if (code === KeyCode.KEYCODE_Z) {
      coordinator.selectNextFeed();
      return;
    }

    // --- Sidebar / Timeline plists ---
    if (code === KeyCode.KEYCODE_DPAD_UP) {
      coordinator.selectPrevArticle();
      return;
    }
    if (code === KeyCode.KEYCODE_DPAD_DOWN) {
      coordinator.selectNextArticle();
      return;
    }
    if (code === KeyCode.KEYCODE_DPAD_RIGHT) {
      // sidebar: navigateToTimeline; timeline: navigateToDetail
      showColumn(this.column === SplitColumn.primary
        ? SplitColumn.supplementary : SplitColumn.secondary);
      return;
    }
    if (code === KeyCode.KEYCODE_DPAD_LEFT) {
      // timeline: navigateToSidebar; detail: navigateToTimeline
      showColumn(this.column === SplitColumn.secondary
        ? SplitColumn.supplementary : SplitColumn.primary);
    }
  }

  private openCurrentArticleInBrowser(): void {
    const article: Article | undefined = SceneCoordinator.shared.currentArticle;
    if (article === undefined) {
      hilog.debug(DOMAIN, TAG, 'openInBrowser with no selected article');
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openArticle(context, article);
  }

  build() {
    Column() {
      // The column body, capped at the readable width and centred in whatever is left.
      // At portrait width the cap is inactive, so this Column measures exactly as the
      // body did before and nothing below it sees a different size.
      Column() {
        this.columnContent()
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: readableColumnWidth })
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Center)
    .onKeyEvent((event: KeyEvent) => {
      this.handleKey(event);
    })
  }
}
