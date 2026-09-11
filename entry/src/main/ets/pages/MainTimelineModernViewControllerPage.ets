/**
 * MainTimelineModernViewControllerPage.
 * Source: iOS/MainTimeline/MainTimelineModernViewController.swift, MainTimelineDataSource.swift,
 *         iOS/MainTimeline/Cell/*.swift, iOS/Base.lproj/Main.storyboard.
 *
 * The article list for the selected sidebar item. Nav bar: back to Feeds, a tappable title
 * (the feed inspector, disabled for a pseudo-feed) and the filter-read-articles button, which
 * only appears when `coordinator.shouldShowFilterButton()`. Bottom bar: mark-all-as-read and
 * next-unread, both disabled when nothing unread is available, with the refresh progress view
 * between them. Body: a LazyForEach over `coordinator.articles`, a search field with Here /
 * All Articles scopes, pull-to-refresh, leading (read) and trailing (star / more) swipe
 * actions and the row context menu.
 */

import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import {
  ArticleDataSource, MainTimelineCell, MainTimelineCellData
} from '../components/MainTimelineCell';
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
import { SceneCoordinator, SearchScope, ShowFeedName } from '../common/SceneCoordinator';
import { AccountManager } from '../common/account/AccountManager';
import { AccountService } from '../common/account/Account';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';
import { articleExternalLink, articleFeed, preferredLink } from '../common/article/ArticleText';
import { Article } from '../model/Article';
import { Author } from '../model/Author';
import { Feed } from '../model/Feed';
import { FetchType } from '../model/FetchType';
import { IconSize } from '../model/IconSize';

const DOMAIN: number = 0x0001;
const TAG: string = 'MainTimelineModernViewControllerPage';

/** The route params showFeedInspector(for:) carries — `resolveFeed()` reads `feedID` first. */
interface FeedInspectorRouteParams {
  feedID: string;
}

@Entry
@Component
struct MainTimelineModernViewControllerPage {
  /** coordinator.articles — Account.fetchArticles(FetchType) for the selected sidebar item. */
  @State articles: ArticleDataSource = new ArticleDataSource();
  /** The sidebar's selection, written by the main feed screen. */
  @StorageLink('nnwSelectedSidebarItemID') selectedSidebarItemId: string = '';
  /** The selected article, read by the article page. */
  @StorageLink('nnwSelectedArticleID') selectedArticleId: string = '';
  /** HidingReadArticlesState for this sidebar item. */
  @State isReadFiltered: boolean = false;
  /** Under 3 characters the source clears the timeline instead of searching. */
  @State searchText: string = '';
  /** Here (SearchTimelineFeedDelegate) vs All Articles (SearchFeedDelegate). */
  @State searchScope: SearchScope = SearchScope.timeline;
  /** CombinedRefreshProgress, published by RefreshProgressView. */
  @StorageLink('nnwRefreshProgress') refreshProgress: number = 0;
  @StorageLink('nnwTimelineName') private timelineName: string = '';
  @StorageLink('nnwArticlesVersion') private articlesVersion: number = 0;
  /**
   * True while the app draws in the dark palette. The filter glyph is a template PNG, and a
   * PNG can only be recoloured through a ColorFilter built from plain numbers, which ArkUI
   * cannot re-resolve on a palette switch the way it re-resolves a Resource — so the
   * light/dark choice is made HERE, in ArkTS, not by the resource qualifier (the
   * full reasoning is on `templateTintDynamic` in components/IconView.ets).
   *
   * This replaces `@StorageProp('currentColorMode')`, which earlier revisions used. That key is
   * not something this app ever writes and it is not in the SDK's typings either, so its
   * value was the declared default forever — it made build() depend on nothing.
   */
  @StorageProp('nnwDarkMode') private isDarkMode: boolean = false;

  @State private isRefreshing: boolean = false;
  @State private isSearching: boolean = false;
  @State private showFeedNames: ShowFeedName = ShowFeedName.none;
  @State private showIcons: boolean = false;
  @State private numberOfLines: number = 0;
  @State private iconSize: IconSize = IconSize.medium;
  @State private isTimelineUnreadAvailable: boolean = false;
  @State private isNextUnreadAvailable: boolean = false;
  @State private shouldShowFilterButton: boolean = false;
  @State private markAllAsReadTitle: string = '';
  /** Bumped when a feed icon / favicon download lands, so the rows re-read the cache. */
  @State private iconVersion: number = 0;
  /** The row a swipe / long press is acting on. */
  @State private contextArticle: Article | undefined = undefined;

  private coordinatorListener: () => void = (): void => {
    this.reloadArticles();
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
        this.markAsReadAndShowSidebar();
      }
    }),
    autoCancel: true
  });

  aboutToAppear(): void {
    startColorModeWatch(this.getUIContext());
    // viewDidLoad(): subscribe, then load the article set. The cell-layout preferences are
    // read by reloadArticles(), which this funnels through as well.
    SceneCoordinator.shared.addListener(this.coordinatorListener);
    FeedIconDownloader.shared.addListener(this.feedIconListener);
    FaviconDownloader.shared.addListener(this.faviconListener);
    this.reloadArticles();
  }

  aboutToDisappear(): void {
    SceneCoordinator.shared.removeListener(this.coordinatorListener);
    FeedIconDownloader.shared.removeListener(this.feedIconListener);
    FaviconDownloader.shared.removeListener(this.faviconListener);
  }

  onPageShow(): void {
    // A palette change reaches this page as a router.back(), which fires onPageShow but not
    // aboutToAppear — so the palette is re-read here too.
    startColorModeWatch(this.getUIContext());
    this.reloadArticles();
  }

  private reloadArticles(): void {
    const coordinator: SceneCoordinator = SceneCoordinator.shared;
    // viewWillAppear, not viewDidLoad: the Timeline Layout screen writes these two through
    // AppDefaults, and router.back() re-runs onPageShow but NOT aboutToAppear — so reading
    // them once at load left the list on the old layout until the app was force-quit.
    this.numberOfLines = AppDefaults.timelineNumberOfLines;
    this.iconSize = AppDefaults.timelineIconSize;
    this.articles.reload(coordinator.articles);
    this.prefetchArticleIcons(coordinator.articles);
    this.showFeedNames = coordinator.currentShowFeedNames;
    this.showIcons = coordinator.currentShowIcons;
    this.isReadFiltered = coordinator.isReadArticlesFiltered;
    this.isTimelineUnreadAvailable = coordinator.isTimelineUnreadAvailable;
    this.isNextUnreadAvailable = coordinator.isNextUnreadAvailable;
    this.shouldShowFilterButton = coordinator.shouldShowFilterButton();
    this.isSearching = coordinator.isSearching;
  }

  /**
   * IconImageCache.prefetchImagesForArticles(_:) — the source runs this over the article set
   * before applying the snapshot. `imageForArticle` only ever consults the CACHES, so with no
   * prefetch nothing started a download, every row's iconImage stayed nil, and
   * `showIcon = showIcons && iconImage != nil` collapsed the icon slot on every row.
   */
  private prefetchArticleIcons(articles: Article[]): void {
    const feeds: Feed[] = [];
    const seenFeeds: Set<string> = new Set<string>();
    const seenAuthors: Set<string> = new Set<string>();
    for (const article of articles) {
      const authors: Author[] | undefined = article.authors;
      if (authors !== undefined) {
        for (const author of authors) {
          const avatarURL: string | undefined = author.avatarURL;
          if (avatarURL !== undefined && !seenAuthors.has(avatarURL)) {
            seenAuthors.add(avatarURL);
            IconImageCache.shared.imageForAuthor(author);
          }
        }
      }
      const feed: Feed | undefined = articleFeed(article);
      if (feed !== undefined && !seenFeeds.has(feed.feedID)) {
        seenFeeds.add(feed.feedID);
        feeds.push(feed);
      }
    }
    if (feeds.length > 0) {
      IconImageCache.shared.prefetchImagesForFeeds(feeds);
    }
  }

  private cellData(article: Article): MainTimelineCellData {
    return new MainTimelineCellData(article, this.showFeedNames, this.showIcons,
      this.numberOfLines, this.iconSize);
  }

  // MARK: - Toolbar actions

  /** toggleFilter(_:) -> coordinator.toggleReadArticlesFilter() */
  private async toggleFilter(): Promise<void> {
    await SceneCoordinator.shared.toggleReadArticlesFilter();
    this.reloadArticles();
  }

  /** markAllAsRead(_:) — confirm (unless the preference is off), then mark and show the sidebar. */
  private requestMarkAllAsRead(): void {
    this.markAllAsReadTitle = 'Mark All as Read';
    if (confirmMarkAllAsReadIsRequired()) {
      this.markAllAsReadDialog.open();
    } else {
      this.markAsReadAndShowSidebar();
    }
  }

  /** coordinator.markAsReadAndShowSidebar(articles) */
  private async markAsReadAndShowSidebar(): Promise<void> {
    await SceneCoordinator.shared.markAllAsRead(SceneCoordinator.shared.articles);
    this.reloadArticles();
    showColumn(SplitColumn.primary);
  }

  /** nextUnread(_:) -> coordinator.selectNextUnread() */
  private async nextUnread(): Promise<void> {
    const before: Article | undefined = SceneCoordinator.shared.currentArticle;
    await SceneCoordinator.shared.selectNextUnread();
    this.reloadArticles();
    const after: Article | undefined = SceneCoordinator.shared.currentArticle;
    if (after !== undefined && after !== before) {
      // The source selects with animations [.scroll, .NAVIGATION] — it reveals the article,
      // exactly as a row tap does. Without this the button selected an article and stayed
      // on the timeline, so it read as doing nothing at all.
      showColumn(SplitColumn.secondary);
    }
  }

  /**
   * `SceneCoordinator.showFeedInspector()`:
   * `guard let feed = timelineFeed as? Feed ?? currentArticle?.feed`. A PseudoFeed timeline
   * (Today, All Unread, Starred) is not a Feed, so it falls back to the selected article's
   * feed rather than doing nothing.
   */
  private inspectedFeed(): Feed | undefined {
    const item: Object | undefined = SceneCoordinator.shared.timelineFeed;
    if (item instanceof Feed) {
      return item;
    }
    const article: Article | undefined = SceneCoordinator.shared.currentArticle;
    return article === undefined ? undefined : articleFeed(article);
  }

  private showFeedInspector(): void {
    const feed: Feed | undefined = this.inspectedFeed();
    if (feed === undefined) {
      return;
    }
    // `feedInspectorController.feed = feed` — the sheet is handed the feed. Without the
    // route param the inspector had nothing to resolve and fell back to the FIRST feed of
    // the first account, so every timeline title opened the same inspector.
    const params: FeedInspectorRouteParams = { feedID: feed.feedID };
    router.pushUrl({ url: 'pages/FeedInspectorViewControllerPage', params: params })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push Feed Inspector failed: %{public}s', err.message);
      });
  }

  /** refreshAccounts(_:) -> appDelegate.manualRefresh(errorHandler:) */
  private async pullToRefresh(): Promise<void> {
    this.isRefreshing = true;
    try {
      // manualRefresh runs cleanUp(conditional: true) on every scene BEFORE
      // refreshAllWithoutWaiting. The order matters: cleanUp drops the read articles from
      // the timeline set, and fetchAndMergeArticles below merges the network's result INTO
      // that set — so clearing afterwards would be undone by the merge.
      await SceneCoordinator.shared.cleanUp(true);
      await AccountManager.shared.refreshAll((error: Error): void => {
        hilog.error(DOMAIN, TAG, 'refreshAll: %{public}s', error.message);
      });
      await SceneCoordinator.shared.fetchAndMergeArticles();
    } finally {
      this.isRefreshing = false;
      this.reloadArticles();
    }
  }

  // MARK: - Search

  /** updateSearchResults: under 3 characters the coordinator clears the timeline. */
  private async runSearch(text: string): Promise<void> {
    this.searchText = text;
    if (text.length === 0) {
      // willDismissSearchController -> coordinator.endSearching()
      this.endSearch();
      return;
    }
    if (!this.isSearching) {
      SceneCoordinator.shared.beginSearching();
      this.isSearching = true;
    }
    await SceneCoordinator.shared.searchArticles(text, this.searchScope);
    this.reloadArticles();
  }

  private async changeSearchScope(scope: SearchScope): Promise<void> {
    this.searchScope = scope;
    if (this.searchText.length > 0) {
      await SceneCoordinator.shared.searchArticles(this.searchText, scope);
      this.reloadArticles();
    }
  }

  private endSearch(): void {
    if (this.isSearching) {
      SceneCoordinator.shared.endSearching();
      this.isSearching = false;
      this.reloadArticles();
    }
  }

  // MARK: - Row actions

  /** didSelectItemAt -> coordinator.selectArticle(article) (which marks it read). */
  private async selectArticle(article: Article): Promise<void> {
    await SceneCoordinator.shared.selectArticle(article);
    this.reloadArticles();
    showColumn(SplitColumn.secondary);
  }

  private async toggleRead(article: Article): Promise<void> {
    await SceneCoordinator.shared.toggleRead(article);
    this.reloadArticles();
  }

  private async toggleStar(article: Article): Promise<void> {
    await SceneCoordinator.shared.toggleStar(article);
    this.reloadArticles();
  }

  private async markAboveAsRead(): Promise<void> {
    const article: Article | undefined = this.contextArticle;
    if (article !== undefined) {
      await SceneCoordinator.shared.markAboveAsRead(article);
      this.reloadArticles();
    }
  }

  private async markBelowAsRead(): Promise<void> {
    const article: Article | undefined = this.contextArticle;
    if (article !== undefined) {
      await SceneCoordinator.shared.markBelowAsRead(article);
      this.reloadArticles();
    }
  }

  /** Go to Feed -> coordinator.discloseFeed(feed) and reveal the sidebar. */
  private async goToFeed(): Promise<void> {
    const article: Article | undefined = this.contextArticle;
    const feed: Feed | undefined = article === undefined ? undefined : articleFeed(article);
    if (feed === undefined) {
      return;
    }
    await SceneCoordinator.shared.discloseFeed(feed);
    this.reloadArticles();
    showColumn(SplitColumn.primary);
  }

  private openInBrowser(): void {
    const article: Article | undefined = this.contextArticle;
    if (article === undefined) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openArticle(context, article);
  }

  /** Share -> UIActivityViewController(url:title:) — the real system share panel. */
  private shareArticle(): void {
    const article: Article | undefined = this.contextArticle;
    if (article === undefined) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    ShareService.shared.shareArticle(context, article);
  }

  private copyArticleURL(): void {
    const article: Article | undefined = this.contextArticle;
    const link: string | undefined = article === undefined ? undefined : preferredLink(article);
    if (link !== undefined) {
      BrowserService.shared.copyLink(link);
    }
  }

  private copyExternalURL(): void {
    const article: Article | undefined = this.contextArticle;
    const link: string | undefined =
      article === undefined ? undefined : articleExternalLink(article);
    if (link !== undefined) {
      BrowserService.shared.copyLink(link);
    }
  }

  /** Mark All as Read in "<feed>" — the per-feed entry of the More sheet. */
  private async markFeedAsRead(): Promise<void> {
    const article: Article | undefined = this.contextArticle;
    const feed: Feed | undefined = article === undefined ? undefined : articleFeed(article);
    if (feed === undefined) {
      return;
    }
    const account: AccountService | undefined = AccountManager.shared.accountForFeed(feed);
    if (account === undefined) {
      return;
    }
    const articles: Article[] = await account.fetchArticles(FetchType.forFeed(feed));
    await SceneCoordinator.shared.markAllAsRead(articles);
    this.reloadArticles();
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

  @Builder
  articleContextMenu() {
    Menu() {
      MenuItem({ content: $r('app.string.mark_above_as_read') })
        .onClick(() => {
          this.markAboveAsRead();
        })
      MenuItem({ content: $r('app.string.mark_below_as_read') })
        .onClick(() => {
          this.markBelowAsRead();
        })
      MenuItem({ content: $r('app.string.go_to_feed') })
        .onClick(() => {
          this.goToFeed();
        })
      MenuItem({ content: $r('app.string.mark_all_as_read') })
        .onClick(() => {
          this.markFeedAsRead();
        })
      MenuItem({ content: $r('app.string.open_in_browser_2') })
        .onClick(() => {
          this.openInBrowser();
        })
      MenuItem({ content: $r('app.string.share') })
        .onClick(() => {
          this.shareArticle();
        })
      MenuItem({ content: $r('app.string.copy_article_url') })
        .onClick(() => {
          this.copyArticleURL();
        })
      MenuItem({ content: $r('app.string.copy_external_url') })
        .onClick(() => {
          this.copyExternalURL();
        })
      MenuItem({ content: $r('app.string.mark_as_read_2') })
        .onClick(() => {
          const article: Article | undefined = this.contextArticle;
          if (article !== undefined) {
            this.toggleRead(article);
          }
        })
      MenuItem({ content: $r('app.string.star') })
        .onClick(() => {
          const article: Article | undefined = this.contextArticle;
          if (article !== undefined) {
            this.toggleStar(article);
          }
        })
    }
  }

  /** Leading swipe: Mark as Read / Mark as Unread. */
  @Builder
  readSwipeAction(article: Article) {
    // iOS leading swipe: one neutral action on the system fill, .callout label.
    Row() {
      Button(article.status.read ? $r('app.string.mark_as_unread') : $r('app.string.mark_as_read_2'))
        .id('timeline_swipe_read')
        .type(ButtonType.Normal)
        .height('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .onClick(() => {
          this.toggleRead(article);
        })
    }
    .height('100%')
  }

  /** Trailing swipe: Star / Unstar, then More. */
  @Builder
  starSwipeActions(article: Article) {
    Row() {
      Button(article.status.starred ? $r('app.string.unstar') : $r('app.string.star'))
        .id('timeline_swipe_star')
        .type(ButtonType.Normal)
        .height('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .onClick(() => {
          this.toggleStar(article);
        })
      Button($r('app.string.more'))
        .id('timeline_swipe_more')
        .type(ButtonType.Normal)
        .height('100%')
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .onClick(() => {
          this.contextArticle = article;
          this.shareArticle();
        })
    }
    .height('100%')
  }

  @Builder
  timelineRow(article: Article, data: MainTimelineCellData) {
    ListItem() {
      // Capture geometry: indicator x8 (12pt), icon x28 (36pt), text block x72..370,
      // row 86pt tall from content — a PLAIN full-width list, no inset card.
      Row({ space: 8 }) {
        // indicatorView: starred -> star.fill, else unread -> circle.fill, else hidden.
        if (data.indicatorSymbol.length > 0) {
          IconView({
            symbolName: data.indicatorSymbol,
            dimension: 12,
            tintName: data.indicatorSymbol === 'star.fill' ? 'star' : 'accent'
          })
            .margin({ top: 5 })
        }
        // iconView: present only when showIcons && iconImage != nil.
        if (data.showIcon) {
          IconView({
            iconURL: data.iconURL,
            symbolName: data.iconSymbolName,
            dimension: data.iconDimension
          })
            .margin({ top: 4 })
        }
        MainTimelineCell({
          title: data.title,
          summary: data.summary,
          dateString: data.dateString,
          feedName: data.feedName,
          byline: data.byline,
          showFeedName: data.showFeedName,
          numberOfLines: data.numberOfLines
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
        right: 20,
        top: 12,
        bottom: 12
      })
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .id('timeline_itemroot')
      .onTouch((event: TouchEvent) => {
        if (event.type === TouchType.Down) {
          this.contextArticle = article;
        }
      })
      .onClick(() => {
        this.selectArticle(article);
      })
    }
    .swipeAction({
      start: this.readSwipeAction(article),
      end: this.starSwipeActions(article)
    })
    .bindContextMenu(this.articleContextMenu, ResponseType.LongPress)
  }

  /** The scope bar only exists while the search controller is active (iOS shows it then). */
  private scopeColor(scope: SearchScope): ResourceColor {
    return this.searchScope === scope
      ? $r('sys.color.ohos_id_color_text_primary_activated')
      : $r('sys.color.ohos_id_color_text_secondary');
  }

  @Builder
  timelineBody() {
    Column() {
      // Nav bar, iOS inline form: the title is CENTERED across the
      // full bar, with the round glass back button leading. Capture: bar y47..101, back
      // button x16..60, title centred on x195.
      Stack() {
        Text(this.timelineName)
          .width('100%')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ left: 56, right: 56 })
          .id('timeline_title')
          .onClick(() => {
            this.showFeedInspector();
          })

        Row() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .fontColor([$r('sys.color.ohos_id_color_text_primary')])
            .padding(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
            .id('timeline_back_to_feeds')
            .onClick(() => {
              showColumn(SplitColumn.primary);
            })
          Blank()
          // The filter button is present only when the coordinator says so.
          if (this.shouldShowFilterButton) {
            // `UIBarButtonItem(image: Assets.Images.filter …)` — Assets.Images.filter is the
            // PLAIN `line.3.horizontal.decrease`; the active state only changes the tint.
            // Width is border-box in ArkUI, so 36 - 2*6 padding leaves a 24vp glyph.
            Image($r('app.media.ic_sf_line_3_horizontal_decrease'))
              .width(36)
              .height(36)
              .objectFit(ImageFit.Contain)
              .padding(6)
              // MainTimelineModernViewController.swift:938/:941 tint the button with
              // `Assets.Colors.primaryAccent` / `.label` — both DYNAMIC colours. The port had
              // baked their light values in as literals, so in dark mode the inactive glyph
              // stayed near-black on a black bar.
              //
              // Note: identical to the Feeds screen's filter button — the light/dark
              // choice is made in ArkTS from `isDarkMode` over two base-only tokens, because
              // earlier revisions both left it to the resource qualifier and both measured
              // RGB(0,0,0). See `templateTintDynamic` in components/IconView.ets.
              .colorFilter(this.isReadFiltered
                ? primaryAccentTint(this.isDarkMode)
                : labelTint(this.isDarkMode))
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
              .id('timeline_filter')
              .onClick(() => {
                this.toggleFilter();
              })
          }
        }
        .width('100%')
        // The bar-button layer sits ON TOP of the centred title, so it must not swallow
        // the title's tap (ArkUI hit-tests the topmost layer).
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(44)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // scopeButtonTitles: Here / All Articles — the scope bar appears with the search
      // controller, which is why the base capture (not searching) does not show it.
      if (this.isSearching) {
        Row({ space: 8 }) {
          Button($r('app.string.here'))
            .id('timeline_search_scope')
            .type(ButtonType.Normal)
            .layoutWeight(1)
            .height(32)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
            .fontSize($r('sys.float.ohos_id_text_size_body2'))
            .fontColor(this.scopeColor(SearchScope.timeline))
            .onClick(() => {
              this.changeSearchScope(SearchScope.timeline);
            })
          Button($r('app.string.all_articles'))
            .id('timeline_search_scope_all')
            .type(ButtonType.Normal)
            .layoutWeight(1)
            .height(32)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
            .fontSize($r('sys.float.ohos_id_text_size_body2'))
            .fontColor(this.scopeColor(SearchScope.global))
            .onClick(() => {
              this.changeSearchScope(SearchScope.global);
            })
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
        })
      }

      Refresh({ refreshing: $$this.isRefreshing, builder: this.refreshIndicator() }) {
        List() {
          // The key has to carry EVERY mutable input a row renders: LazyForEach reuses a row
          // whose key is unchanged, and `timelineRow` is a @Builder taking its parameters by
          // value, so neither `onDataReloaded()` nor a plain @State write re-runs it.
          //   - read / starred: toggling them mutates the shared ArticleStatus in place (every
          //     fetch is handed the same instance out of ArticlesDatabase's statusCache), so
          //     the array and the row identities never change. `indicatorView` renders exactly
          //     these two flags.
          //   - numberOfLines / iconSize: the Timeline Layout screen writes them, and they
          //     drive the cell's line budget and the icon slot's dimension.
          // Without them the row only redrew when `articlesVersion` moved — which only
          // `replaceArticles` does, i.e. only a refresh.
          LazyForEach(this.articles, (article: Article) => {
            this.timelineRow(article, this.cellData(article))
          }, (article: Article) => article.articleID + '-' + this.articlesVersion
            + '-' + this.iconVersion + '-' + (article.status.read ? 'r' : 'u')
            + (article.status.starred ? 's' : 'n')
            + '-' + this.numberOfLines + '-' + (this.iconSize as number))
        }
        .width('100%')
        .height('100%')
        .cachedCount(8)
        .scrollBar(BarState.Off)
        .backgroundColor($r('sys.color.ohos_id_color_background'))
        // The plain-table hairline: inset past the indicator + icon columns (capture
        // x72..370), NOT the inset-card separator the grouped sidebar uses.
        .divider({
          strokeWidth: 0.5,
          color: $r('sys.color.ohos_id_color_list_separator'),
          startMargin: 72,
          endMargin: 20
        })
      }
      .id('timeline_pull_refresh')
      .layoutWeight(1)
      .onRefreshing(() => {
        this.pullToRefresh();
      })

      // Bottom bar: mark-all-as-read, the search field, next-unread — the capture's iOS 26
      // toolbar, each glyph in its own round glass button and the search field a capsule
      // between them. The refresh progress rides in the same centre slot (it renders
      // nothing at all when no refresh has run, which is the source's behaviour).
      Row({ space: 8 }) {
        // ArkUI width is BORDER-box: sizing this to the icon size and then adding 8vp of
        // padding shrank the glyph to 8vp inside its circle, so it read ~35% smaller than
        // the SymbolGlyph next-unread button beside it (the source draws both the same).
        // 40 = 24vp glyph + 2*8vp padding, which matches the SymbolGlyph's own box.
        Image($r('app.media.ic_mark_all_as_read'))
          .width(40)
          .height(40)
          .objectFit(ImageFit.Contain)
          .padding(8)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .id('timeline_mark_all_read')
          .enabled(this.isTimelineUnreadAvailable)
          .opacity(this.isTimelineUnreadAvailable ? 1 : 0.4)
          .onClick(() => {
            this.requestMarkAllAsRead();
          })
        Column() {
          Search({ value: this.searchText, placeholder: $r('app.string.search_articles') })
            .id('timeline_search_field')
            .width('100%')
            .height(40)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
            .placeholderColor($r('sys.color.ohos_id_color_text_secondary'))
            .placeholderFont({ size: $r('sys.float.ohos_id_text_size_body1') })
            .textFont({ size: $r('sys.float.ohos_id_text_size_body1') })
            .onChange((value: string) => {
              this.runSearch(value);
            })
            .onSubmit((value: string) => {
              this.runSearch(value);
            })
          RefreshProgressView()
        }
        .layoutWeight(1)

        SymbolGlyph($r('sys.symbol.chevron_down_circle'))
          .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          .padding(8)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .id('timeline_next_unread')
          .enabled(this.isNextUnreadAvailable)
          .opacity(this.isNextUnreadAvailable ? 1 : 0.4)
          .onClick(() => {
            this.nextUnread();
          })
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
    // The timeline is a PLAIN table on the page background, not a grouped one.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  build() {
    Column() {
      RootSplitViewController({ column: SplitColumn.supplementary }) {
        this.timelineBody()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}
