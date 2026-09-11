/**
 * SceneCoordinator — port of iOS/SceneCoordinator.swift.
 *
 * The single routing + selection hub: the sidebar tree and which containers are expanded,
 * the selected sidebar item, the timeline's article set and the selected article, the two
 * read filters, and prev/next/next-unread navigation.
 *
 * What did NOT come across, because it is UIKit and has no counterpart:
 *  - UISplitViewController column plumbing (showColumn / preferredDisplayMode / collapse).
 *    The pages own their own navigation; the coordinator publishes selection instead.
 *  - The diffable data source. The sidebar's (section, row) IndexPath becomes a FLAT index
 *    into `sidebarRows` (see tree/TreeController.ts `visibleRows`), so every "indexPath"
 *    parameter in the source is a row index here.
 *  - NotificationCenter. The screens subscribe with `addListener`, and the AppStorage keys
 *    below let an .ets page bind with @StorageLink without a listener at all.
 *
 * Everything reactive is mirrored into AppStorage under the `nnw*` keys: the pages read
 * them, and every write goes through `publish()` so there is exactly one place that does it.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article, unreadArticles } from '../model/Article';
import { ArticleStatusKey } from '../model/ArticleStatus';
import { Author } from '../model/Author';
import { ContainerIdentifier } from '../model/ContainerIdentifier';
import { FetchType } from '../model/FetchType';
import { Feed } from '../model/Feed';
import { Folder } from '../model/Folder';
import { IconImage } from '../model/IconImage';
import { Node } from '../model/Node';
import { ReadFilterType, SidebarItemIdentifier } from '../model/SidebarItemIdentifier';
import { SmartFeed } from '../model/SmartFeed';
import { SortDirection, AppDefaults, AppDefaultsKey } from './prefs/AppDefaults';
import { AccountChange, AccountService } from './account/Account';
import { AccountManager } from './account/AccountManager';
import { SmartFeedsController } from './account/SmartFeedsController';
import { CoalescingQueue } from './util/CoalescingQueue';
import { IconImageCache } from './images/IconImageCache';
import { MarkStatusCommand, UndoableCommandRunner } from './command/UndoableCommandRunner';
import {
  SidebarRow, SidebarTreeControllerDelegate, TreeController, containerIDOf, containerKey,
  defaultReadFilterTypeOf, descendantNodeForSidebarItemID, isSidebarItem, nameForDisplayOf,
  sidebarItemIDOf, unreadCountOf, visibleRows
} from './tree/TreeController';
import {
  articlesAbove, articlesBelow, canMarkAllAsRead, indexOfArticle, isAvailableToMarkUnread,
  sortedByDate
} from './article/ArticleText';
import {
  ArticleSpecifier, HidingReadArticlesState, StateRestoration, StateRestorationInfo
} from './state/StateRestoration';

const DOMAIN: number = 0x0001;
const TAG: string = 'SceneCoordinator';

/**
 * CoalescingQueue keys — the ArkTS stand-in for the (target, selector) pair the source's
 * queueRebuildBackingStores() / queueFetchAndMergeArticles() unique on.
 */
const rebuildCallKey: string = 'SceneCoordinator.rebuildBackingStores';
const mergeArticlesCallKey: string = 'SceneCoordinator.fetchAndMergeArticles';
const timelineUnreadCallKey: string = 'SceneCoordinator.updateTimelineUnreadCount';

/** AppStorage keys the reader pages bind to. */
export class SelectionKeys {
  /** Bumped whenever the sidebar rows change, so the sidebar can re-read them. */
  static readonly sidebarVersion: string = 'nnwSidebarVersion';
  /** Bumped whenever the timeline article list changes. */
  static readonly articlesVersion: string = 'nnwArticlesVersion';
  static readonly selectedSidebarItemID: string = 'nnwSelectedSidebarItemID';
  static readonly timelineName: string = 'nnwTimelineName';
  static readonly timelineUnreadCount: string = 'nnwTimelineUnreadCount';
  static readonly selectedArticleID: string = 'nnwSelectedArticleID';
  static readonly isReadFeedsFiltered: string = 'nnwIsReadFeedsFiltered';
  static readonly isReadArticlesFiltered: string = 'nnwIsReadArticlesFiltered';
  static readonly isSearching: string = 'nnwIsSearching';
}

export enum SearchScope {
  timeline = 'timeline',
  global = 'global'
}

/** ShowFeedName — how much of the feed name a timeline row shows. */
export enum ShowFeedName {
  none = 'none',
  feed = 'feed',
  byline = 'byline'
}

export type CoordinatorChangeListener = () => void;

export class SceneCoordinator {
  static readonly shared: SceneCoordinator = new SceneCoordinator();

  private readonly treeControllerDelegate: SidebarTreeControllerDelegate =
    new SidebarTreeControllerDelegate();
  private readonly treeController: TreeController;
  private readonly hidingReadArticlesState: HidingReadArticlesState =
    new HidingReadArticlesState();

  /** Which containers are expanded, keyed by containerKey(). */
  private expandedContainers: Set<string> = new Set<string>();

  private rows: SidebarRow[] = [];
  private currentFeedIndex?: number;

  /** Feed | Folder | SmartFeed — the source's `SidebarItem`. */
  private timelineItem?: Object;
  private timelineArticles: Article[] = [];
  private selectedArticle?: Article;
  private idToArticle: Map<string, Article> = new Map<string, Article>();

  private searching: boolean = false;
  private preSearchTimelineItem?: Object;
  private lastSearchString: string = '';
  private lastSearchScope?: SearchScope;
  private savedSearchArticles?: Article[];
  private savedSearchArticleIDs?: string[];
  private isRestoringState: boolean = false;

  private fetchSerialNumber: number = 0;
  private sortDirection: SortDirection = SortDirection.orderedDescending;
  private groupByFeed: boolean = false;
  private showFeedNames: ShowFeedName = ShowFeedName.none;
  private showIcons: boolean = false;
  private timelineUnread: number = 0;

  private listeners: CoordinatorChangeListener[] = [];

  private constructor() {
    this.treeController = new TreeController(this.treeControllerDelegate);
  }

  // MARK: - Listeners and published state

  addListener(listener: CoordinatorChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: CoordinatorChangeListener): void {
    this.listeners = this.listeners.filter((l: CoordinatorChangeListener) => l !== listener);
  }

  private publish(): void {
    AppStorage.setOrCreate<string>(SelectionKeys.selectedSidebarItemID,
      this.selectedSidebarItemID === undefined ? '' : this.selectedSidebarItemID.description());
    AppStorage.setOrCreate<string>(SelectionKeys.timelineName, this.timelineName);
    AppStorage.setOrCreate<number>(SelectionKeys.timelineUnreadCount, this.timelineUnread);
    AppStorage.setOrCreate<string>(SelectionKeys.selectedArticleID,
      this.selectedArticle === undefined ? '' : this.selectedArticle.articleID);
    AppStorage.setOrCreate<boolean>(SelectionKeys.isReadFeedsFiltered, this.isReadFeedsFiltered);
    AppStorage.setOrCreate<boolean>(SelectionKeys.isReadArticlesFiltered,
      this.isReadArticlesFiltered);
    AppStorage.setOrCreate<boolean>(SelectionKeys.isSearching, this.searching);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private publishSidebar(): void {
    const version: number = AppStorage.get<number>(SelectionKeys.sidebarVersion) ?? 0;
    AppStorage.setOrCreate<number>(SelectionKeys.sidebarVersion, version + 1);
    this.publish();
  }

  private publishArticles(): void {
    const version: number = AppStorage.get<number>(SelectionKeys.articlesVersion) ?? 0;
    AppStorage.setOrCreate<number>(SelectionKeys.articlesVersion, version + 1);
    this.publish();
  }

  // MARK: - Read-only state the pages render

  get rootNode(): Node {
    return this.treeController.rootNode;
  }

  get sidebarRows(): SidebarRow[] {
    return this.rows;
  }

  get articles(): Article[] {
    return this.timelineArticles;
  }

  get currentArticle(): Article | undefined {
    return this.selectedArticle;
  }

  get timelineFeed(): Object | undefined {
    return this.timelineItem;
  }

  get timelineName(): string {
    return this.timelineItem === undefined ? '' : nameForDisplayOf(this.timelineItem);
  }

  get timelineIconImage(): IconImage | undefined {
    const item: Object | undefined = this.timelineItem;
    if (item === undefined) {
      return undefined;
    }
    if (item instanceof Feed) {
      return IconImageCache.shared.imageForFeed(item);
    }
    if (item instanceof SmartFeed) {
      return IconImageCache.shared.imageForSmartFeed(item.sidebarItemID, item.smallIcon);
    }
    return undefined;
  }

  get timelineUnreadCount(): number {
    return this.timelineUnread;
  }

  get selectedSidebarItemID(): SidebarItemIdentifier | undefined {
    return this.timelineItem === undefined ? undefined : sidebarItemIDOf(this.timelineItem);
  }

  get isSearching(): boolean {
    return this.searching;
  }

  get currentShowFeedNames(): ShowFeedName {
    return this.showFeedNames;
  }

  get currentShowIcons(): boolean {
    return this.showIcons;
  }

  get isReadFeedsFiltered(): boolean {
    return this.treeControllerDelegate.isReadFiltered;
  }

  get isReadArticlesFiltered(): boolean {
    const sidebarItemID: SidebarItemIdentifier | undefined = this.selectedSidebarItemID;
    if (sidebarItemID === undefined) {
      return false;
    }
    return this.hidingReadArticlesState.isHidingReadArticles(sidebarItemID);
  }

  get timelineDefaultReadFilterType(): ReadFilterType {
    return this.timelineItem === undefined
      ? ReadFilterType.none : defaultReadFilterTypeOf(this.timelineItem);
  }

  articleFor(articleID: string): Article | undefined {
    const current: Article | undefined = this.selectedArticle;
    if (current !== undefined && current.articleID === articleID) {
      return current;
    }
    return this.idToArticle.get(articleID);
  }

  unreadCountFor(node: Node): number {
    // The coordinator supplies the count for the currently selected feed.
    if (this.timelineItem !== undefined && node.representedObject === this.timelineItem) {
      return this.timelineUnread;
    }
    return unreadCountOf(node.representedObject);
  }

  // MARK: - Launch and state restoration

  /** Called once from the app bootstrap, after AccountManager has started. */
  async restoreWindowState(restoreSelection: boolean): Promise<void> {
    this.isRestoringState = true;

    const info: StateRestorationInfo = StateRestorationInfo.restored();
    this.sortDirection = AppDefaults.timelineSortDirection;
    this.groupByFeed = AppDefaults.timelineGroupByFeed;

    if (AppDefaults.isFirstRun) {
      // Expand the top-level items on first run.
      for (const sectionNode of this.treeController.rootNode.childNodes) {
        this.markExpandedNode(sectionNode);
      }
      this.saveExpandedContainers();
    } else {
      this.expandedContainers = new Set<string>();
      for (const containerID of info.expandedContainers) {
        this.expandedContainers.add(containerKey(containerID));
      }
    }

    this.hidingReadArticlesState.copyFrom(info);
    this.rebuildBackingStores();

    // The feeds read filter can only be applied once the backing stores exist, or state
    // restoration has nothing to work with while unread counts are still initializing.
    this.treeControllerDelegate.isReadFiltered = info.hideReadFeeds;
    this.rebuildBackingStores();

    if (!restoreSelection) {
      this.isRestoringState = false;
      this.publishSidebar();
      return;
    }

    await this.restoreSelectedSidebarItemAndArticle(info);
    this.isRestoringState = false;
    this.publishSidebar();
  }

  private async restoreSelectedSidebarItemAndArticle(info: StateRestorationInfo): Promise<void> {
    const selected: SidebarItemIdentifier | undefined = info.selectedSidebarItem;
    if (selected === undefined) {
      return;
    }
    const node: Node | undefined = this.nodeForSidebarItemID(selected);
    if (node === undefined) {
      return;
    }
    const index: number | undefined = this.indexForNode(node);
    if (index === undefined) {
      return;
    }
    await this.selectSidebarItem(index, true);
    await this.restoreSelectedArticle(info);
  }

  private async restoreSelectedArticle(info: StateRestorationInfo): Promise<void> {
    const specifier: ArticleSpecifier | undefined = info.selectedArticle;
    if (specifier === undefined) {
      return;
    }
    let article: Article | undefined = undefined;
    for (const candidate of this.timelineArticles) {
      if (candidate.accountID === specifier.accountID
        && candidate.articleID === specifier.articleID) {
        article = candidate;
        break;
      }
    }
    if (article === undefined) {
      article = await AccountManager.shared.fetchArticle(specifier.accountID,
        specifier.articleID);
    }
    if (article !== undefined) {
      await this.selectArticle(article, info.isShowingExtractedArticle,
        info.articleWindowScrollY);
    }
  }

  /** OPEN_ARTICLE from a notification, and the `netnewswire:` deep link. */
  async selectSidebarItemAndArticle(accountID: string, articleID: string): Promise<boolean> {
    const article: Article | undefined =
      await AccountManager.shared.fetchArticle(accountID, articleID);
    if (article === undefined) {
      return false;
    }
    const feed: Feed | undefined = AccountManager.shared.feedForArticle(article);
    if (feed !== undefined) {
      await this.discloseFeed(feed);
    }
    await this.selectArticle(article);
    return true;
  }

  // MARK: - Sidebar rebuild

  rebuildBackingStores(): void {
    if (this.searching) {
      return;
    }
    this.treeController.rebuild();
    this.applyPendingFirstRunExpansion();
    this.rows = visibleRows(this.treeController.rootNode, (node: Node): boolean => {
      return this.isExpandedNode(node);
    });
    this.clearTimelineIfNoLongerAvailable();
    this.publishSidebar();
  }

  /**
   * Finish the first-run "expand the top-level sections" pass.
   *
   * The source runs that pass with AccountManager already loaded AND the tree already
   * built, so every section is there to expand. Here the tree is only built by the FIRST
   * rebuildBackingStores(), which happens after the pass, and on a fresh install the
   * account does not exist yet at all — so the pass expanded nothing, persisted an empty
   * set, and the Feeds screen shipped with both sections collapsed and no feed rows.
   * `didExpandTopLevelSections` is persisted, not per-process, so this survives the
   * relaunch that finally has the account.
   */
  private applyPendingFirstRunExpansion(): void {
    if (!AppDefaults.isLoaded() ||
      AppDefaults.boolValue(AppDefaultsKey.didExpandTopLevelSections)) {
      return;
    }
    const sections: Node[] = this.treeController.rootNode.childNodes;
    if (sections.length === 0) {
      return;
    }
    for (const sectionNode of sections) {
      this.markExpandedNode(sectionNode);
    }
    // Only call it done once an ACCOUNT section is there — Smart Feeds alone means the
    // bootstrap has not finished and the account still has to be expanded on a later pass.
    if (sections.length > 1) {
      AppDefaults.setBool(AppDefaultsKey.didExpandTopLevelSections, true);
    }
    this.saveExpandedContainers();
  }

  private clearTimelineIfNoLongerAvailable(): void {
    const item: Object | undefined = this.timelineItem;
    if (item === undefined || this.sidebarContains(item)) {
      return;
    }
    this.timelineItem = undefined;
    this.replaceArticles([]);
  }

  private sidebarContains(item: Object): boolean {
    for (const row of this.rows) {
      if (row.node.representedObject === item) {
        return true;
      }
    }
    return false;
  }

  /** Unread counts changed somewhere — refresh the sidebar and, if filtered, its rows. */
  async unreadCountDidChange(): Promise<void> {
    await SmartFeedsController.shared.refreshUnreadCounts();
    this.rebuildBackingStores();
  }

  // MARK: - Account observation

  /**
   * The app's ONE AccountChange subscriber — iOS/SceneCoordinator.swift:361-370, where the
   * coordinator is the only object watching the account layer and every screen reads what it
   * publishes. AppBootstrap hands it the AccountManager listener it already owns.
   *
   * Before this, nothing connected AccountChange to the coordinator: the account layer posted
   * every change faithfully and the pages were subscribed to publish(), but the middle of the
   * chain was missing, so the sidebar only ever rebuilt when a page asked it to by hand. A
   * feed added from the timeline, an account added or removed in Settings, a background
   * refresh that brought in new feeds — none of those reached a screen until the next launch.
   * That is the root cause behind the "new feed shows nothing until relaunch" report.
   *
   * Coalesced through CoalescingQueue.standard (the port of RSCore's CoalescingQueue, which is
   * exactly what the source's queue* helpers use): one refresh posts a change per feed, and
   * each would otherwise rebuild the whole tree and re-query the unread counts.
   */
  accountDidChange(change: AccountChange): void {
    // restoreWindowState is mid-flight and finishes with its own rebuild + unreadCountDidChange
    // (AppBootstrap.restoreState); rebuilding under it would race the selection restore.
    if (this.isRestoringState) {
      return;
    }
    switch (change) {
      case AccountChange.children:
      case AccountChange.displayName:
      case AccountChange.state:
      case AccountChange.unreadCount:
      case AccountChange.unreadCountDidInitialize:
        this.queueRebuildBackingStores();
        break;
      case AccountChange.articlesDownloaded:
        this.queueFetchAndMergeArticles();
        break;
      case AccountChange.statuses:
        // statusesDidChange -> updateUnreadCount() and NOTHING else (SceneCoordinator.swift:539).
        // A refetch here would move the timeline under the reader's finger; the sidebar rebuild
        // arrives separately on the .unreadCount that noteStatusesDidChange posts alongside.
        this.queueUpdateTimelineUnreadCount();
        break;
      default:
        // progress / refreshDidBegin / refreshDidFinish already reach the toolbar through
        // CombinedRefreshProgress, and queuedArticleStatuses through ArticleStatusSyncTimer.
        break;
    }
  }

  private queueRebuildBackingStores(): void {
    CoalescingQueue.standard.add(rebuildCallKey, (): void => {
      this.unreadCountDidChange().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'rebuild after account change failed: %{public}s', String(e));
      });
    });
  }

  private queueFetchAndMergeArticles(): void {
    CoalescingQueue.standard.add(mergeArticlesCallKey, (): void => {
      // A no-op when no feed is selected, so the source's timelineFetcherContainsAnyFeed()
      // gate is unnecessary here.
      this.fetchAndMergeArticles().catch((e: Object): void => {
        hilog.error(DOMAIN, TAG, 'merge after download failed: %{public}s', String(e));
      });
    });
  }

  private queueUpdateTimelineUnreadCount(): void {
    CoalescingQueue.standard.add(timelineUnreadCallKey, (): void => {
      this.updateUnreadCount();
      this.publish();
    });
  }

  // MARK: - Expansion

  isExpanded(containerID: ContainerIdentifier): boolean {
    return this.expandedContainers.has(containerKey(containerID));
  }

  isExpandedNode(node: Node): boolean {
    const containerID: ContainerIdentifier | undefined = containerIDOf(node.representedObject);
    return containerID !== undefined && this.isExpanded(containerID);
  }

  private markExpandedNode(node: Node): void {
    const containerID: ContainerIdentifier | undefined = containerIDOf(node.representedObject);
    if (containerID !== undefined) {
      this.expandedContainers.add(containerKey(containerID));
    }
  }

  private unmarkExpandedNode(node: Node): void {
    const containerID: ContainerIdentifier | undefined = containerIDOf(node.representedObject);
    if (containerID !== undefined) {
      this.expandedContainers.delete(containerKey(containerID));
    }
  }

  expandNode(node: Node): void {
    this.markExpandedNode(node);
    this.rebuildBackingStores();
    this.saveExpandedContainers();
  }

  collapseNode(node: Node): void {
    this.unmarkExpandedNode(node);
    this.rebuildBackingStores();
    this.saveExpandedContainers();
  }

  toggleExpandedNode(node: Node): void {
    if (this.isExpandedNode(node)) {
      this.collapseNode(node);
    } else {
      this.expandNode(node);
    }
  }

  expandAllSectionsAndFolders(): void {
    for (const sectionNode of this.treeController.rootNode.childNodes) {
      this.markExpandedNode(sectionNode);
      for (const topLevelNode of sectionNode.childNodes) {
        if (topLevelNode.representedObject instanceof Folder) {
          this.markExpandedNode(topLevelNode);
        }
      }
    }
    this.rebuildBackingStores();
    this.saveExpandedContainers();
  }

  collapseAllFolders(): void {
    for (const sectionNode of this.treeController.rootNode.childNodes) {
      for (const topLevelNode of sectionNode.childNodes) {
        if (topLevelNode.representedObject instanceof Folder) {
          this.unmarkExpandedNode(topLevelNode);
        }
      }
    }
    this.rebuildBackingStores();
    this.saveExpandedContainers();
  }

  saveExpandedContainers(): void {
    const containers: ContainerIdentifier[] = [];
    this.treeController.visitNodes((node: Node) => {
      const containerID: ContainerIdentifier | undefined = containerIDOf(node.representedObject);
      if (containerID !== undefined && this.isExpanded(containerID)) {
        containers.push(containerID);
      }
    });
    StateRestoration.saveExpandedContainers(containers);
  }

  // MARK: - Filters

  toggleReadFeedsFilter(): void {
    const newValue: boolean = !this.isReadFeedsFiltered;
    this.treeControllerDelegate.isReadFiltered = newValue;
    StateRestoration.saveHideReadFeeds(newValue);
    this.rebuildBackingStores();
  }

  shouldShowFilterButton(): boolean {
    const sidebarItemID: SidebarItemIdentifier | undefined = this.selectedSidebarItemID;
    if (sidebarItemID === undefined) {
      return false;
    }
    return this.hidingReadArticlesState.canToggleHidingReadArticles(sidebarItemID);
  }

  async toggleReadArticlesFilter(): Promise<void> {
    const sidebarItemID: SidebarItemIdentifier | undefined = this.selectedSidebarItemID;
    if (sidebarItemID === undefined) {
      return;
    }
    this.hidingReadArticlesState.toggleHidingReadArticles(sidebarItemID);
    await this.refreshTimeline();
  }

  // MARK: - Node lookup

  nodeForSidebarItemID(sidebarItemID: SidebarItemIdentifier): Node | undefined {
    return descendantNodeForSidebarItemID(this.treeController.rootNode, sidebarItemID);
  }

  nodeForIndex(index: number): Node | undefined {
    if (index < 0 || index >= this.rows.length) {
      return undefined;
    }
    return this.rows[index].node;
  }

  indexForNode(node: Node): number | undefined {
    for (let i: number = 0; i < this.rows.length; i++) {
      if (this.rows[i].node === node) {
        return i;
      }
    }
    return undefined;
  }

  private indexForObject(item: Object): number | undefined {
    for (let i: number = 0; i < this.rows.length; i++) {
      if (this.rows[i].node.representedObject === item) {
        return i;
      }
    }
    return undefined;
  }

  // MARK: - Selection

  get prevFeedIndex(): number | undefined {
    const index: number | undefined = this.currentFeedIndex;
    if (index === undefined || index - 1 < 0) {
      return undefined;
    }
    return index - 1;
  }

  get nextFeedIndex(): number | undefined {
    const index: number | undefined = this.currentFeedIndex;
    if (index === undefined || index + 1 >= this.rows.length) {
      return undefined;
    }
    return index + 1;
  }

  async selectPrevFeed(): Promise<void> {
    const index: number | undefined = this.prevFeedIndex;
    if (index !== undefined) {
      await this.selectSidebarItem(index, true);
    }
  }

  async selectNextFeed(): Promise<void> {
    const index: number | undefined = this.nextFeedIndex;
    if (index !== undefined) {
      await this.selectSidebarItem(index, true);
    }
  }

  /** The source's selectFeed(_:) — select by the represented object. */
  async selectFeed(item?: Object, deselectArticle: boolean = true): Promise<void> {
    const index: number | undefined = item === undefined ? undefined : this.indexForObject(item);
    await this.selectSidebarItem(index, deselectArticle);
  }

  /** The source's selectSidebarItem(indexPath:) — `index` is a row of `sidebarRows`. */
  async selectSidebarItem(index?: number, deselectArticle: boolean = true): Promise<void> {
    let tappedItem: Object | undefined = undefined;
    if (index !== undefined) {
      const node: Node | undefined = this.nodeForIndex(index);
      if (node !== undefined && isSidebarItem(node.representedObject)) {
        tappedItem = node.representedObject;
      }
    }

    if (tappedItem === this.timelineItem) {
      return; // Same feed — nothing to do.
    }

    this.currentFeedIndex = index;

    if (deselectArticle) {
      await this.selectArticle(undefined);
    }

    if (tappedItem === undefined) {
      this.timelineItem = undefined;
      StateRestoration.saveSelectedSidebarItem(undefined);
      this.replaceArticles([]);
      if (this.isReadFeedsFiltered) {
        this.rebuildBackingStores();
      }
      this.publish();
      return;
    }

    this.timelineItem = tappedItem;
    const sidebarItemID: SidebarItemIdentifier | undefined = sidebarItemIDOf(tappedItem);
    StateRestoration.saveSelectedSidebarItem(sidebarItemID);
    await this.fetchAndReplaceArticles();
    if (this.isReadFeedsFiltered) {
      this.rebuildBackingStores();
    }
    this.publish();
  }

  async selectTodayFeed(): Promise<void> {
    await this.selectSmartFeed(SmartFeedsController.shared.todayFeed);
  }

  async selectAllUnreadFeed(): Promise<void> {
    await this.selectSmartFeed(SmartFeedsController.shared.unreadFeed);
  }

  async selectStarredFeed(): Promise<void> {
    await this.selectSmartFeed(SmartFeedsController.shared.starredFeed);
  }

  private async selectSmartFeed(smartFeed: SmartFeed): Promise<void> {
    this.ensureFeedIsAvailableToSelect(smartFeed);
    await this.selectFeed(smartFeed);
  }

  async selectFirstUnreadInAllUnread(): Promise<void> {
    await this.selectAllUnreadFeed();
    await this.selectNextArticleInTimeline(0);
  }

  /** A filtered-out item must be reachable: add it (and its folder) to the exceptions. */
  private ensureFeedIsAvailableToSelect(item: Object): void {
    const sidebarItemID: SidebarItemIdentifier | undefined = sidebarItemIDOf(item);
    if (sidebarItemID === undefined) {
      return;
    }
    const smartFeedsNode: Node | undefined =
      this.treeController.rootNode.childNodeRepresentingObject(SmartFeedsController.shared);
    if (smartFeedsNode !== undefined) {
      this.markExpandedNode(smartFeedsNode);
    }
    this.treeControllerDelegate.addFilterException(sidebarItemID);
    this.rebuildBackingStores();
  }

  async selectArticle(article?: Article, isShowingExtractedArticle?: boolean,
    articleWindowScrollY?: number): Promise<void> {
    const current: Article | undefined = this.selectedArticle;
    if (article === undefined && current === undefined) {
      return;
    }
    if (article !== undefined && current !== undefined
      && article.articleID === current.articleID && article.accountID === current.accountID) {
      return;
    }

    this.selectedArticle = article;

    if (article === undefined) {
      StateRestoration.saveSelectedArticle(undefined, undefined);
      this.publish();
      return;
    }

    StateRestoration.saveSelectedArticle(article.accountID, article.articleID);
    if (isShowingExtractedArticle !== undefined && articleWindowScrollY !== undefined) {
      StateRestoration.saveArticleScrollPosition(articleWindowScrollY,
        isShowingExtractedArticle);
    }
    this.publish();

    // Mark read BEFORE the article view appears, so the row does not flash unread->read.
    // State restoration must not mark the restored article read again.
    if (!this.isRestoringState) {
      await this.markArticlesWithUndo([article], ArticleStatusKey.read, true);
    }
  }

  // MARK: - Article navigation

  get isPrevArticleAvailable(): boolean {
    return this.prevArticle !== undefined;
  }

  get isNextArticleAvailable(): boolean {
    return this.nextArticle !== undefined;
  }

  get prevArticle(): Article | undefined {
    const article: Article | undefined = this.selectedArticle;
    if (article === undefined) {
      return undefined;
    }
    const index: number = indexOfArticle(this.timelineArticles, article);
    return index <= 0 ? undefined : this.timelineArticles[index - 1];
  }

  get nextArticle(): Article | undefined {
    const article: Article | undefined = this.selectedArticle;
    if (article === undefined) {
      return undefined;
    }
    const index: number = indexOfArticle(this.timelineArticles, article);
    if (index < 0 || index + 1 >= this.timelineArticles.length) {
      return undefined;
    }
    return this.timelineArticles[index + 1];
  }

  async selectPrevArticle(): Promise<void> {
    const article: Article | undefined = this.prevArticle;
    if (article !== undefined) {
      await this.selectArticle(article);
    }
  }

  async selectNextArticle(): Promise<void> {
    const article: Article | undefined = this.nextArticle;
    if (article !== undefined) {
      await this.selectArticle(article);
    }
  }

  get isTimelineUnreadAvailable(): boolean {
    return this.timelineUnread > 0;
  }

  get isNextUnreadAvailable(): boolean {
    return AccountManager.shared.unreadCount > 0;
  }

  /**
   * Next unread: try the timeline first, then walk the sidebar forward (wrapping) to the
   * next collapsed row with unread articles, exactly as the source does.
   */
  async selectNextUnread(): Promise<void> {
    if (AccountManager.shared.unreadCount < 1) {
      return; // Never loop looking for an unread that is not there.
    }
    if (await this.selectNextUnreadArticleInTimeline()) {
      return;
    }
    if (this.searching) {
      this.endSearching();
    }
    if (await this.selectNextUnreadFeed()) {
      await this.selectNextUnreadArticleInTimeline();
    }
  }

  async selectPrevUnread(): Promise<void> {
    if (AccountManager.shared.unreadCount < 1) {
      return;
    }
    if (await this.selectPrevUnreadArticleInTimeline()) {
      return;
    }
    if (await this.selectPrevUnreadFeed()) {
      await this.selectPrevUnreadArticleInTimeline();
    }
  }

  private async selectNextUnreadArticleInTimeline(): Promise<boolean> {
    const article: Article | undefined = this.selectedArticle;
    const currentRow: number = article === undefined
      ? -1 : indexOfArticle(this.timelineArticles, article);
    return await this.selectNextArticleInTimeline(currentRow + 1);
  }

  private async selectNextArticleInTimeline(startingRow: number): Promise<boolean> {
    if (startingRow >= this.timelineArticles.length) {
      return false;
    }
    for (let i: number = Math.max(0, startingRow); i < this.timelineArticles.length; i++) {
      if (!this.timelineArticles[i].status.read) {
        await this.selectArticle(this.timelineArticles[i]);
        return true;
      }
    }
    return false;
  }

  private async selectPrevUnreadArticleInTimeline(): Promise<boolean> {
    const article: Article | undefined = this.selectedArticle;
    const startingRow: number = article === undefined
      ? this.timelineArticles.length - 1 : indexOfArticle(this.timelineArticles, article);
    if (startingRow < 0) {
      return false;
    }
    for (let i: number = startingRow; i >= 0; i--) {
      if (!this.timelineArticles[i].status.read) {
        await this.selectArticle(this.timelineArticles[i]);
        return true;
      }
    }
    return false;
  }

  /** Forward from the row after the current one, wrapping once. */
  private async selectNextUnreadFeed(): Promise<boolean> {
    const start: number = this.currentFeedIndex === undefined ? 0 : this.currentFeedIndex + 1;
    if (await this.selectUnreadFeedStartingAt(start, 1)) {
      return true;
    }
    return await this.selectUnreadFeedStartingAt(0, 1);
  }

  /** Backward from the row before the current one, wrapping once. */
  private async selectPrevUnreadFeed(): Promise<boolean> {
    const start: number = this.currentFeedIndex === undefined
      ? this.rows.length - 1 : this.currentFeedIndex - 1;
    if (await this.selectUnreadFeedStartingAt(start, -1)) {
      return true;
    }
    return await this.selectUnreadFeedStartingAt(this.rows.length - 1, -1);
  }

  private async selectUnreadFeedStartingAt(start: number, step: number): Promise<boolean> {
    for (let i: number = start; i >= 0 && i < this.rows.length; i += step) {
      const node: Node = this.rows[i].node;
      // An expanded container's unread count belongs to its visible children.
      if (this.isExpandedNode(node)) {
        continue;
      }
      if (unreadCountOf(node.representedObject) > 0 && isSidebarItem(node.representedObject)) {
        await this.selectSidebarItem(i, false);
        this.selectedArticle = undefined;
        return true;
      }
    }
    return false;
  }

  // MARK: - Marking

  async markAllAsRead(articles: Article[]): Promise<void> {
    await this.markArticlesWithUndo(articles, ArticleStatusKey.read, true);
  }

  canMarkAboveAsRead(article: Article): boolean {
    return canMarkAllAsRead(articlesAbove(this.timelineArticles, article));
  }

  async markAboveAsRead(article: Article): Promise<void> {
    await this.markAllAsRead(articlesAbove(this.timelineArticles, article));
  }

  canMarkBelowAsRead(article: Article): boolean {
    return canMarkAllAsRead(articlesBelow(this.timelineArticles, article));
  }

  async markBelowAsRead(article: Article): Promise<void> {
    await this.markAllAsRead(articlesBelow(this.timelineArticles, article));
  }

  async markAsReadForCurrentArticle(): Promise<void> {
    const article: Article | undefined = this.selectedArticle;
    if (article !== undefined) {
      await this.markArticlesWithUndo([article], ArticleStatusKey.read, true);
    }
  }

  async markAsUnreadForCurrentArticle(): Promise<void> {
    const article: Article | undefined = this.selectedArticle;
    if (article !== undefined) {
      await this.markArticlesWithUndo([article], ArticleStatusKey.read, false);
    }
  }

  async toggleRead(article: Article): Promise<void> {
    if (article.status.read && !isAvailableToMarkUnread(article)) {
      return;
    }
    await this.markArticlesWithUndo([article], ArticleStatusKey.read, !article.status.read);
  }

  async toggleReadForCurrentArticle(): Promise<void> {
    const article: Article | undefined = this.selectedArticle;
    if (article !== undefined) {
      await this.toggleRead(article);
    }
  }

  async toggleStar(article: Article): Promise<void> {
    await this.markArticlesWithUndo([article], ArticleStatusKey.starred, !article.status.starred);
  }

  async toggleStarredForCurrentArticle(): Promise<void> {
    const article: Article | undefined = this.selectedArticle;
    if (article !== undefined) {
      await this.toggleStar(article);
    }
  }

  private async markArticlesWithUndo(articles: Article[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    const command: MarkStatusCommand | undefined =
      MarkStatusCommand.create(articles, statusKey, flag);
    if (command === undefined) {
      return;
    }
    await UndoableCommandRunner.shared.runCommand(command);
    this.updateUnreadCount();
    await this.unreadCountDidChange();
  }

  // MARK: - Search

  beginSearching(): void {
    this.searching = true;
    this.preSearchTimelineItem = this.timelineItem;
    this.savedSearchArticles = this.timelineArticles.slice();
    const ids: string[] = [];
    for (const article of this.timelineArticles) {
      ids.push(article.articleID);
    }
    this.savedSearchArticleIDs = ids;
    this.timelineItem = undefined;
    this.selectedArticle = undefined;
    this.replaceArticles([]);
    this.publish();
  }

  endSearching(): void {
    const saved: Object | undefined = this.preSearchTimelineItem;
    if (saved !== undefined) {
      this.timelineItem = saved;
      this.replaceArticles(this.savedSearchArticles === undefined ? [] : this.savedSearchArticles);
    } else {
      this.timelineItem = undefined;
      this.replaceArticles([]);
    }

    this.lastSearchString = '';
    this.lastSearchScope = undefined;
    this.preSearchTimelineItem = undefined;
    this.savedSearchArticleIDs = undefined;
    this.savedSearchArticles = undefined;
    this.searching = false;
    this.selectedArticle = undefined;
    this.publish();
  }

  /** Fewer than 3 characters empties the timeline, exactly as the source does. */
  async searchArticles(searchString: string, searchScope: SearchScope): Promise<void> {
    if (!this.searching) {
      return;
    }

    if (searchString.length < 3) {
      this.timelineItem = undefined;
      this.replaceArticles([]);
      return;
    }

    if (searchString === this.lastSearchString && searchScope === this.lastSearchScope) {
      return;
    }

    if (searchScope === SearchScope.global) {
      this.timelineItem = SmartFeedsController.searchFeed(searchString);
    } else {
      const ids: string[] =
        this.savedSearchArticleIDs === undefined ? [] : this.savedSearchArticleIDs;
      this.timelineItem = SmartFeedsController.searchTimelineFeed(searchString, ids);
    }
    this.lastSearchString = searchString;
    this.lastSearchScope = searchScope;
    await this.fetchAndReplaceArticles();
  }

  // MARK: - Fetching

  /** The timeline's fetch, honouring the per-item hide-read-articles setting. */
  private async fetchArticlesForTimeline(): Promise<Article[]> {
    const item: Object | undefined = this.timelineItem;
    if (item === undefined) {
      return [];
    }

    const sidebarItemID: SidebarItemIdentifier | undefined = sidebarItemIDOf(item);
    const hidesRead: boolean = sidebarItemID !== undefined
      && this.hidingReadArticlesState.isHidingReadArticles(sidebarItemID);

    if (item instanceof SmartFeed) {
      const articles: Article[] = await AccountManager.shared.fetchArticles(item.fetchType);
      return hidesRead ? unreadArticles(articles) : articles;
    }

    if (item instanceof Feed) {
      const account: AccountService | undefined =
        AccountManager.shared.existingAccount(item.accountID);
      if (account === undefined) {
        return [];
      }
      const articles: Article[] = await account.fetchArticles(FetchType.forFeed(item));
      return hidesRead ? unreadArticles(articles) : articles;
    }

    if (item instanceof Folder) {
      const account: AccountService | undefined =
        AccountManager.shared.existingAccount(item.accountID);
      if (account === undefined) {
        return [];
      }
      // The folder fetch takes the unread-only flag directly.
      return await account.fetchArticles(FetchType.forFolder(item, hidesRead));
    }

    return [];
  }

  /** A full fetch that replaces the timeline. */
  async fetchAndReplaceArticles(emptyFirst: boolean = true): Promise<void> {
    this.fetchSerialNumber += 1;
    const serialNumber: number = this.fetchSerialNumber;
    if (emptyFirst) {
      this.replaceArticles([]);
    }
    if (this.timelineItem === undefined) {
      return;
    }

    let fetched: Article[] = [];
    try {
      fetched = await this.fetchArticlesForTimeline();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'timeline fetch failed: %{public}s', (e as Error).message);
      return;
    }
    // A newer fetch superseded this one.
    if (serialNumber !== this.fetchSerialNumber) {
      return;
    }
    this.replaceArticles(fetched);
  }

  /** Refetch without blanking the timeline first — used after a status change. */
  async refreshTimeline(): Promise<void> {
    await this.fetchAndReplaceArticles(false);
  }

  /**
   * A refresh brought in new articles: merge them into the current set rather than
   * replacing it, so the user's scroll position and the open article survive.
   */
  async fetchAndMergeArticles(): Promise<void> {
    if (this.timelineItem === undefined) {
      return;
    }
    const fetched: Article[] = await this.fetchArticlesForTimeline();
    const fetchedIDs: Set<string> = new Set<string>();
    for (const article of fetched) {
      fetchedIDs.add(article.articleID);
    }
    const merged: Article[] = fetched.slice();
    for (const article of this.timelineArticles) {
      if (fetchedIDs.has(article.articleID)) {
        continue;
      }
      // Drop articles whose feed is gone.
      if (AccountManager.shared.feedForArticle(article) === undefined) {
        continue;
      }
      merged.push(article);
    }
    this.replaceArticles(merged);
  }

  sortParametersDidChange(): void {
    this.sortDirection = AppDefaults.timelineSortDirection;
    this.groupByFeed = AppDefaults.timelineGroupByFeed;
    this.replaceArticles(this.timelineArticles.slice());
  }

  private replaceArticles(unsorted: Article[]): void {
    const sorted: Article[] = sortedByDate(unsorted, this.sortDirection, this.groupByFeed);
    this.timelineArticles = sorted;

    this.idToArticle = new Map<string, Article>();
    for (const article of sorted) {
      this.idToArticle.set(article.articleID, article);
    }

    // Re-point currentArticle at the new instance if it is still in the timeline. If it
    // is not, keep showing it anyway — never blank the screen because of a filter.
    const current: Article | undefined = this.selectedArticle;
    if (!this.isRestoringState && current !== undefined) {
      const replacement: Article | undefined = this.idToArticle.get(current.articleID);
      if (replacement !== undefined && replacement.accountID === current.accountID) {
        this.selectedArticle = replacement;
      }
    }

    this.updateShowNamesAndIcons();
    this.updateUnreadCount();
    this.publishArticles();
  }

  private updateUnreadCount(): void {
    let count: number = 0;
    for (const article of this.timelineArticles) {
      if (!article.status.read) {
        count += 1;
      }
    }
    this.timelineUnread = count;
  }

  /** A pseudo-feed or a folder shows feed names and icons; a single feed does not. */
  private updateShowNamesAndIcons(): void {
    const item: Object | undefined = this.timelineItem;
    if (item instanceof SmartFeed || item instanceof Folder) {
      this.showFeedNames = ShowFeedName.feed;
      this.showIcons = true;
      return;
    }
    this.showFeedNames = ShowFeedName.none;
    let showIcons: boolean = false;
    for (const article of this.timelineArticles) {
      const authors: Author[] | undefined = article.authors;
      if (authors !== undefined && authors.length === 1 && authors[0].avatarURL !== undefined) {
        showIcons = true;
        break;
      }
    }
    this.showIcons = showIcons;
  }

  // MARK: - Disclose a feed (from Add Feed, a notification, or a deep link)

  /** Expands the feed's account and folder so the feed is visible, then selects it. */
  async discloseFeed(feed: Feed): Promise<void> {
    if (this.searching) {
      this.endSearching();
    }
    const account: AccountService | undefined =
      AccountManager.shared.existingAccount(feed.accountID);
    if (account === undefined) {
      return;
    }

    const accountNode: Node | undefined =
      this.treeController.rootNode.childNodeRepresentingObject(account);
    if (accountNode !== undefined) {
      this.markExpandedNode(accountNode);
      for (const childNode of accountNode.childNodes) {
        const obj: Object = childNode.representedObject;
        if (obj instanceof Folder && obj.containsFeed(feed)) {
          this.markExpandedNode(childNode);
        }
      }
    }

    this.ensureFeedIsAvailableToSelect(feed);
    this.saveExpandedContainers();
    await this.selectFeed(feed);
  }

  // MARK: - Lifecycle

  /**
   * cleanUp(conditional:) — a manual refresh drops what the read filters are already
   * hiding. `conditional` means "only if the user asked for it in Settings > Timeline",
   * which is how manualRefresh(errorHandler:) calls it. The source's only unconditional
   * caller is the explicit "Clean Up" keyboard command
   * (RootSplitViewController.cleanUp(_:)), which has no counterpart here — the port has no
   * key-command responder chain — so `conditional` is always true at the two call sites.
   *
   * Note the gate the source puts on the article half: read articles are cleared ONLY
   * when the timeline is filtering them out (`isReadArticlesFiltered`). Marking an
   * article read leaves it on screen so the reader keeps their place; this is the refetch
   * that finally removes it. With the filter off there is nothing to clear.
   */
  async cleanUp(conditional: boolean): Promise<void> {
    if (this.isReadFeedsFiltered) {
      this.rebuildBackingStores();
    }
    if (this.isReadArticlesFiltered
      && (AppDefaults.refreshClearsReadArticles || !conditional)) {
      // refreshTimeline() is fetchAndReplaceArticles(false) — the port of
      // refreshTimeline(resetScroll: false), so the list is refetched, not blanked.
      await this.refreshTimeline();
    }
  }

  /** willEnterForeground: fire the timers' overdue ticks and refresh what changed. */
  async willEnterForeground(): Promise<void> {
    await SmartFeedsController.shared.refreshIfDayChanged();
    this.rebuildBackingStores();
    await this.refreshTimeline();
  }

  /** didEnterBackground: persist everything state restoration needs. */
  didEnterBackground(): void {
    this.saveExpandedContainers();
    this.hidingReadArticlesState.save();
    StateRestoration.saveSelectedSidebarItem(this.selectedSidebarItemID);
    const article: Article | undefined = this.selectedArticle;
    StateRestoration.saveSelectedArticle(
      article === undefined ? undefined : article.accountID,
      article === undefined ? undefined : article.articleID);
  }

  /** The timeline reloaded with a different article set — clear the undo stack. */
  cleanUpUndoableCommands(): void {
    UndoableCommandRunner.shared.clearUndoableCommands();
  }

  /** True when "Mark All as Read" should be enabled for the current timeline. */
  get canMarkAllAsReadInTimeline(): boolean {
    return canMarkAllAsRead(this.timelineArticles);
  }
}
