/**
 * StateRestoration — port of the `StateRestorationInfo` struct in iOS/AppDefaults.swift
 * and iOS/HidingReadArticlesState.swift.
 *
 * Everything the app restores on launch: the sidebar's hide-read state and expanded
 * containers, the selected sidebar item and article, the article scroll position and
 * whether the reader view was showing. All of it is already stored in preferences by the
 * ported AppDefaults, so this is a snapshot/restore facade over those keys.
 *
 * The source's `init(legacyState:)` migration reads an NSUserActivity written by
 * NetNewsWire 7.0 and earlier. There is no such activity on HarmonyOS — nothing to
 * migrate from — so the migration flag is simply marked done.
 */

import { ContainerIdentifier } from '../../model/ContainerIdentifier';
import { SidebarItemIdentifier, SidebarItemIdentifierType }
  from '../../model/SidebarItemIdentifier';
import { AppDefaults } from '../prefs/AppDefaults';
import { AccountManager } from '../account/AccountManager';
import { AccountService } from '../account/Account';
import { SmartFeedsController } from '../account/SmartFeedsController';

/** ArticleSpecifier.swift — how a selected article is referred to on disk. */
export class ArticleSpecifier {
  readonly accountID: string;
  readonly articleID: string;

  constructor(accountID: string, articleID: string) {
    this.accountID = accountID;
    this.articleID = articleID;
  }

  dictionary(): Map<string, string> {
    const d: Map<string, string> = new Map<string, string>();
    d.set('accountID', this.accountID);
    d.set('articleID', this.articleID);
    return d;
  }

  static fromDictionary(d: Map<string, string>): ArticleSpecifier | undefined {
    const accountID: string | undefined = d.get('accountID');
    const articleID: string | undefined = d.get('articleID');
    if (accountID === undefined || articleID === undefined) {
      return undefined;
    }
    return new ArticleSpecifier(accountID, articleID);
  }
}

export class StateRestorationInfo {
  readonly hideReadFeeds: boolean;
  readonly expandedContainers: ContainerIdentifier[];
  readonly selectedSidebarItem?: SidebarItemIdentifier;
  readonly smartFeedsHidingReadArticles: string[];
  readonly feedsHidingReadArticles: Map<string, string[]>;
  readonly foldersShowingReadArticles: Map<string, string[]>;
  readonly selectedArticle?: ArticleSpecifier;
  readonly articleWindowScrollY: number;
  readonly isShowingExtractedArticle: boolean;

  constructor(hideReadFeeds: boolean, expandedContainers: ContainerIdentifier[],
    selectedSidebarItem: SidebarItemIdentifier | undefined,
    smartFeedsHidingReadArticles: string[], feedsHidingReadArticles: Map<string, string[]>,
    foldersShowingReadArticles: Map<string, string[]>,
    selectedArticle: ArticleSpecifier | undefined, articleWindowScrollY: number,
    isShowingExtractedArticle: boolean) {
    this.hideReadFeeds = hideReadFeeds;
    this.expandedContainers = expandedContainers;
    this.selectedSidebarItem = selectedSidebarItem;
    this.smartFeedsHidingReadArticles = smartFeedsHidingReadArticles;
    this.feedsHidingReadArticles = feedsHidingReadArticles;
    this.foldersShowingReadArticles = foldersShowingReadArticles;
    this.selectedArticle = selectedArticle;
    this.articleWindowScrollY = articleWindowScrollY;
    this.isShowingExtractedArticle = isShowingExtractedArticle;
  }

  /** Reads the current snapshot out of preferences. */
  static current(): StateRestorationInfo {
    const selectedArticleDictionary: Map<string, string> | undefined = AppDefaults.selectedArticle;
    const selectedArticle: ArticleSpecifier | undefined =
      selectedArticleDictionary === undefined
        ? undefined : ArticleSpecifier.fromDictionary(selectedArticleDictionary);

    return new StateRestorationInfo(
      AppDefaults.hideReadFeeds,
      AppDefaults.expandedContainers,
      AppDefaults.selectedSidebarItem,
      AppDefaults.smartFeedsHidingReadArticles,
      AppDefaults.feedsHidingReadArticles,
      AppDefaults.foldersShowingReadArticles,
      selectedArticle,
      AppDefaults.articleWindowScrollY,
      AppDefaults.isShowingExtractedArticle
    );
  }

  /**
   * The source migrates a legacy NSUserActivity here. HarmonyOS has none, so the flag is
   * marked migrated and the current preferences are the whole story.
   */
  static restored(): StateRestorationInfo {
    if (!AppDefaults.didMigrateLegacyStateRestorationInfo) {
      AppDefaults.didMigrateLegacyStateRestorationInfo = true;
    }
    return StateRestorationInfo.current();
  }
}

/** Snapshot writers — called when the app backgrounds or the selection changes. */
export class StateRestoration {
  static saveSelectedSidebarItem(sidebarItemID?: SidebarItemIdentifier): void {
    AppDefaults.selectedSidebarItem = sidebarItemID;
  }

  static saveSelectedArticle(accountID?: string, articleID?: string): void {
    if (accountID === undefined || articleID === undefined) {
      AppDefaults.selectedArticle = undefined;
      return;
    }
    AppDefaults.selectedArticle = new ArticleSpecifier(accountID, articleID).dictionary();
  }

  static saveArticleScrollPosition(scrollY: number, isShowingExtractedArticle: boolean): void {
    AppDefaults.articleWindowScrollY = scrollY;
    AppDefaults.isShowingExtractedArticle = isShowingExtractedArticle;
  }

  static saveExpandedContainers(containers: ContainerIdentifier[]): void {
    AppDefaults.expandedContainers = containers;
  }

  static saveHideReadFeeds(hideReadFeeds: boolean): void {
    AppDefaults.hideReadFeeds = hideReadFeeds;
  }

  /** The split view's preferred display mode — the source restores it on launch too. */
  static saveDisplayMode(displayMode: number): void {
    AppDefaults.splitViewPreferredDisplayMode = displayMode;
  }

  static restoredDisplayMode(): number {
    return AppDefaults.splitViewPreferredDisplayMode;
  }
}

/**
 * HidingReadArticlesState.swift — per-sidebar-item "hide read articles". Folders hide
 * read articles by DEFAULT, so a folder is stored only when it is SHOWING them; feeds and
 * smart feeds are stored when they are HIDING them. Accounts, feeds and folders that no
 * longer exist are filtered out on every save, exactly as the source does.
 */
export class HidingReadArticlesState {
  private smartFeedsHidingReadArticles: Set<string> = new Set<string>();
  private feedsHidingReadArticles: Map<string, Set<string>> = new Map<string, Set<string>>();
  private foldersShowingReadArticles: Map<string, Set<string>> = new Map<string, Set<string>>();

  copyFrom(info: StateRestorationInfo): void {
    this.smartFeedsHidingReadArticles = new Set<string>(info.smartFeedsHidingReadArticles);
    this.feedsHidingReadArticles = toSetMap(info.feedsHidingReadArticles);
    this.foldersShowingReadArticles = toSetMap(info.foldersShowingReadArticles);
  }

  save(): void {
    this.saveSmartFeedsHidingReadArticles();
    this.saveFeedsHidingReadArticles();
    this.saveFoldersShowingReadArticles();
  }

  isHidingReadArticles(sidebarItemID: SidebarItemIdentifier): boolean {
    if (sidebarItemID.type === SidebarItemIdentifierType.smartFeed) {
      if (isUnreadSmartFeed(sidebarItemID)) {
        return true;
      }
      const id: string | undefined = sidebarItemID.id;
      return id !== undefined && this.smartFeedsHidingReadArticles.has(id);
    }

    const accountID: string | undefined = sidebarItemID.accountID;
    if (accountID === undefined) {
      return false;
    }

    if (sidebarItemID.type === SidebarItemIdentifierType.feed) {
      const feedID: string | undefined = sidebarItemID.feedID;
      const feedIDs: Set<string> | undefined = this.feedsHidingReadArticles.get(accountID);
      return feedID !== undefined && feedIDs !== undefined && feedIDs.has(feedID);
    }

    // Folders hide read articles by default, so check whether they are SHOWING them.
    const folderName: string | undefined = sidebarItemID.folderName;
    const folderNames: Set<string> | undefined = this.foldersShowingReadArticles.get(accountID);
    if (folderName === undefined || folderNames === undefined) {
      return true;
    }
    return !folderNames.has(folderName);
  }

  canToggleHidingReadArticles(sidebarItemID: SidebarItemIdentifier): boolean {
    // The only item that cannot be toggled is the unread smart feed.
    return !isUnreadSmartFeed(sidebarItemID);
  }

  toggleHidingReadArticles(sidebarItemID: SidebarItemIdentifier): void {
    if (!this.canToggleHidingReadArticles(sidebarItemID)) {
      return;
    }
    this.setHidingReadArticles(sidebarItemID, !this.isHidingReadArticles(sidebarItemID));
  }

  private setHidingReadArticles(sidebarItemID: SidebarItemIdentifier, hiding: boolean): void {
    if (sidebarItemID.type === SidebarItemIdentifierType.smartFeed) {
      if (isUnreadSmartFeed(sidebarItemID)) {
        return;
      }
      const id: string | undefined = sidebarItemID.id;
      if (id === undefined) {
        return;
      }
      if (hiding) {
        this.smartFeedsHidingReadArticles.add(id);
      } else {
        this.smartFeedsHidingReadArticles.delete(id);
      }
      this.saveSmartFeedsHidingReadArticles();
      return;
    }

    const accountID: string | undefined = sidebarItemID.accountID;
    if (accountID === undefined) {
      return;
    }

    if (sidebarItemID.type === SidebarItemIdentifierType.feed) {
      const feedID: string | undefined = sidebarItemID.feedID;
      if (feedID === undefined) {
        return;
      }
      let feedIDs: Set<string> | undefined = this.feedsHidingReadArticles.get(accountID);
      if (feedIDs === undefined) {
        feedIDs = new Set<string>();
        this.feedsHidingReadArticles.set(accountID, feedIDs);
      }
      if (hiding) {
        feedIDs.add(feedID);
      } else {
        feedIDs.delete(feedID);
      }
      this.saveFeedsHidingReadArticles();
      return;
    }

    const folderName: string | undefined = sidebarItemID.folderName;
    if (folderName === undefined) {
      return;
    }
    let folderNames: Set<string> | undefined = this.foldersShowingReadArticles.get(accountID);
    if (folderNames === undefined) {
      folderNames = new Set<string>();
      this.foldersShowingReadArticles.set(accountID, folderNames);
    }
    // The opposite of feeds: a folder is stored only when it SHOWS read articles.
    if (hiding) {
      folderNames.delete(folderName);
    } else {
      folderNames.add(folderName);
    }
    this.saveFoldersShowingReadArticles();
  }

  private saveSmartFeedsHidingReadArticles(): void {
    AppDefaults.smartFeedsHidingReadArticles = Array.from(this.smartFeedsHidingReadArticles);
  }

  private saveFeedsHidingReadArticles(): void {
    const d: Map<string, string[]> = new Map<string, string[]>();
    for (const accountID of Array.from(this.feedsHidingReadArticles.keys())) {
      const account: AccountService | undefined = AccountManager.shared.existingAccount(accountID);
      if (account === undefined) {
        this.feedsHidingReadArticles.delete(accountID);
        continue;
      }
      const feedIDs: Set<string> = this.feedsHidingReadArticles.get(accountID) as Set<string>;
      const kept: string[] = [];
      for (const feedID of Array.from(feedIDs)) {
        if (account.existingFeedWithFeedID(feedID) !== undefined) {
          kept.push(feedID);
        }
      }
      d.set(accountID, kept);
    }
    AppDefaults.feedsHidingReadArticles = d;
  }

  private saveFoldersShowingReadArticles(): void {
    const d: Map<string, string[]> = new Map<string, string[]>();
    for (const accountID of Array.from(this.foldersShowingReadArticles.keys())) {
      const account: AccountService | undefined = AccountManager.shared.existingAccount(accountID);
      if (account === undefined) {
        this.foldersShowingReadArticles.delete(accountID);
        continue;
      }
      const folderNames: Set<string> =
        this.foldersShowingReadArticles.get(accountID) as Set<string>;
      const kept: string[] = [];
      for (const folderName of Array.from(folderNames)) {
        if (account.existingFolderWithDisplayName(folderName) !== undefined) {
          kept.push(folderName);
        }
      }
      d.set(accountID, kept);
    }
    AppDefaults.foldersShowingReadArticles = d;
  }
}

function isUnreadSmartFeed(sidebarItemID: SidebarItemIdentifier): boolean {
  return sidebarItemID.equals(SmartFeedsController.shared.unreadFeed.sidebarItemID);
}

function toSetMap(source: Map<string, string[]>): Map<string, Set<string>> {
  const out: Map<string, Set<string>> = new Map<string, Set<string>>();
  source.forEach((value: string[], key: string) => {
    out.set(key, new Set<string>(value));
  });
  return out;
}
