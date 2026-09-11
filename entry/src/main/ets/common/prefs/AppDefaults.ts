/**
 * AppDefaults — port of iOS/AppDefaults.swift over @ohos.data.preferences.
 *
 * Every user default the app has, with the source's registered default values, plus the
 * per-account `<accountID>-<key>` settings the AccountSettings model builds keys for.
 *
 * UserDefaults reads are synchronous, so this keeps a preferences handle opened once at
 * startup (`load`) and uses the *Sync accessors; writes are flushed asynchronously the
 * way UserDefaults coalesces its own writes.
 */

import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppContext } from '../util/AppContext';
import { ContainerIdentifier } from '../../model/ContainerIdentifier';
import { SidebarItemIdentifier } from '../../model/SidebarItemIdentifier';
import { IconSize } from '../../model/IconSize';

/** The source's UserInterfaceColorPalette. */
export enum UserInterfaceColorPalette {
  automatic = 0,
  light = 1,
  dark = 2
}

/** Foundation's ComparisonResult, used for the timeline sort direction. */
export enum SortDirection {
  orderedAscending = -1,
  orderedDescending = 1
}

export class AppDefaultsKey {
  static readonly userInterfaceColorPalette: string = 'userInterfaceColorPalette';
  static readonly lastImageCacheFlushDate: string = 'lastImageCacheFlushDate';
  static readonly firstRunDate: string = 'firstRunDate';
  /**
   * Whether the first-run "expand the top-level sections" pass has actually run against a
   * built tree. Not in the source: there AccountManager is loaded before the coordinator
   * restores, so the pass always had its sections. Here the bootstrap is async.
   */
  static readonly didExpandTopLevelSections: string = 'didExpandTopLevelSections';
  static readonly timelineGroupByFeed: string = 'timelineGroupByFeed';
  static readonly refreshClearsReadArticles: string = 'refreshClearsReadArticles';
  static readonly timelineNumberOfLines: string = 'timelineNumberOfLines';
  static readonly timelineIconDimension: string = 'timelineIconSize';
  static readonly timelineSortDirection: string = 'timelineSortDirection';
  static readonly articleFullscreenAvailable: string = 'articleFullscreenAvailable';
  static readonly articleFullscreenEnabled: string = 'articleFullscreenEnabled';
  static readonly confirmMarkAllAsRead: string = 'confirmMarkAllAsRead';
  static readonly lastRefresh: string = 'lastRefresh';
  static readonly addFeedAccountID: string = 'addFeedAccountID';
  static readonly addFeedFolderName: string = 'addFeedFolderName';
  static readonly addFolderAccountID: string = 'addFolderAccountID';
  static readonly useSystemBrowser: string = 'useSystemBrowser';
  static readonly currentThemeName: string = 'currentThemeName';
  static readonly articleContentJavascriptEnabled: string = 'articleContentJavascriptEnabled';
  static readonly hideReadFeeds: string = 'hideReadFeeds';
  static readonly isShowingExtractedArticle: string = 'isShowingExtractedArticle';
  static readonly articleWindowScrollY: string = 'articleWindowScrollY';
  static readonly expandedContainers: string = 'expandedContainers';
  static readonly smartFeedsHidingReadArticles: string = 'smartFeedsHidingReadArticles';
  static readonly feedsHidingReadArticles: string = 'feedsHidingReadArticles';
  static readonly foldersShowingReadArticles: string = 'foldersShowingReadArticles';
  static readonly selectedSidebarItem: string = 'selectedSidebarItem';
  static readonly selectedArticle: string = 'selectedArticle';
  static readonly didMigrateLegacyStateRestorationInfo: string =
    'didMigrateLegacyStateRestorationInfo';
  static readonly splitViewPreferredDisplayMode: string = 'splitViewPreferredDisplayMode';
  static readonly timelineWidth: string = 'timelineWidth';
  /** DownloadSession's openrss.org one-per-session throttle. */
  static readonly lastOpenRSSOrgFeedRefresh: string = 'lastOpenRSSOrgFeedRefresh';
  /** AccountManager's list of accounts (an accountID array). */
  static readonly accountIDs: string = 'accountIDs';
}

/**
 * The default article theme name.
 *
 * Module-level, NOT read off `AppDefaults`: `registeredDefaults()` below runs from
 * `AppDefaults`'s own static field initializer, so reaching back into the class there is a
 * temporal-dead-zone read that throws `ReferenceError: AppDefaults is not initialized` and
 * kills the app before its first frame. `AppDefaults.defaultThemeName` stays as the public
 * name every other module already uses.
 */
const DEFAULT_THEME_NAME: string = 'Default';

/** The source's `registerDefaults()`. */
function registeredDefaults(): Map<string, preferences.ValueType> {
  const d: Map<string, preferences.ValueType> = new Map<string, preferences.ValueType>();
  d.set(AppDefaultsKey.userInterfaceColorPalette, UserInterfaceColorPalette.automatic as number);
  d.set(AppDefaultsKey.timelineGroupByFeed, false);
  d.set(AppDefaultsKey.refreshClearsReadArticles, false);
  d.set(AppDefaultsKey.timelineNumberOfLines, 2);
  d.set(AppDefaultsKey.timelineIconDimension, IconSize.medium as number);
  d.set(AppDefaultsKey.timelineSortDirection, SortDirection.orderedDescending as number);
  d.set(AppDefaultsKey.articleFullscreenAvailable, false);
  d.set(AppDefaultsKey.articleFullscreenEnabled, false);
  d.set(AppDefaultsKey.confirmMarkAllAsRead, true);
  d.set(AppDefaultsKey.articleContentJavascriptEnabled, true);
  d.set(AppDefaultsKey.currentThemeName, DEFAULT_THEME_NAME);
  d.set(AppDefaultsKey.splitViewPreferredDisplayMode, 0);
  return d;
}

export class AppDefaults {
  static readonly defaultThemeName: string = DEFAULT_THEME_NAME;
  private static readonly storeName: string = 'NetNewsWireDefaults';

  private static store?: preferences.Preferences;
  private static defaults: Map<string, preferences.ValueType> = registeredDefaults();
  private static firstRun: boolean = false;

  /** Opens the store and applies registerDefaults(). Call once at startup. */
  static load(): void {
    if (AppDefaults.store !== undefined) {
      return;
    }
    const options: preferences.Options = { name: AppDefaults.storeName };
    AppDefaults.store = preferences.getPreferencesSync(AppContext.get(), options);
    // `isFirstRun` is decided by the presence of firstRunDate, exactly as in the source.
    if (AppDefaults.dateValue(AppDefaultsKey.firstRunDate) === undefined) {
      AppDefaults.firstRun = true;
      AppDefaults.setDate(AppDefaultsKey.firstRunDate, new Date());
    }
  }

  static isLoaded(): boolean {
    return AppDefaults.store !== undefined;
  }

  static get isFirstRun(): boolean {
    return AppDefaults.firstRun;
  }

  private static requireStore(): preferences.Preferences {
    const store: preferences.Preferences | undefined = AppDefaults.store;
    if (store === undefined) {
      throw new Error('AppDefaults.load() has not been called yet');
    }
    return store;
  }

  // MARK: - Primitive accessors

  static stringValue(key: string): string | undefined {
    const store: preferences.Preferences = AppDefaults.requireStore();
    if (!store.hasSync(key)) {
      const fallback: preferences.ValueType | undefined = AppDefaults.defaults.get(key);
      return typeof fallback === 'string' ? fallback as string : undefined;
    }
    const value: preferences.ValueType = store.getSync(key, '');
    return typeof value === 'string' ? value as string : undefined;
  }

  static setString(key: string, value?: string): void {
    const store: preferences.Preferences = AppDefaults.requireStore();
    if (value === undefined) {
      store.deleteSync(key);
    } else {
      store.putSync(key, value);
    }
    AppDefaults.flush();
  }

  static boolValue(key: string): boolean {
    const fallback: preferences.ValueType | undefined = AppDefaults.defaults.get(key);
    const value: preferences.ValueType =
      AppDefaults.requireStore().getSync(key, fallback === undefined ? false : fallback);
    return typeof value === 'boolean' ? value as boolean : false;
  }

  static setBool(key: string, value: boolean): void {
    AppDefaults.requireStore().putSync(key, value);
    AppDefaults.flush();
  }

  static intValue(key: string): number {
    const fallback: preferences.ValueType | undefined = AppDefaults.defaults.get(key);
    const value: preferences.ValueType =
      AppDefaults.requireStore().getSync(key, fallback === undefined ? 0 : fallback);
    return typeof value === 'number' ? value as number : 0;
  }

  static setInt(key: string, value: number): void {
    AppDefaults.requireStore().putSync(key, value);
    AppDefaults.flush();
  }

  /** Dates are stored as epoch milliseconds; an absent key reads as undefined. */
  static dateValue(key: string): Date | undefined {
    const store: preferences.Preferences = AppDefaults.requireStore();
    if (!store.hasSync(key)) {
      return undefined;
    }
    const value: preferences.ValueType = store.getSync(key, -1);
    if (typeof value !== 'number') {
      return undefined;
    }
    const millis: number = value as number;
    return millis < 0 ? undefined : new Date(millis);
  }

  static setDate(key: string, value?: Date): void {
    const store: preferences.Preferences = AppDefaults.requireStore();
    if (value === undefined) {
      store.deleteSync(key);
    } else {
      store.putSync(key, value.getTime());
    }
    AppDefaults.flush();
  }

  static stringArrayValue(key: string): string[] {
    const value: preferences.ValueType = AppDefaults.requireStore().getSync(key, '[]');
    if (typeof value !== 'string') {
      return [];
    }
    try {
      const parsed: Object = JSON.parse(value as string) as Object;
      return Array.isArray(parsed) ? parsed as string[] : [];
    } catch (e) {
      return [];
    }
  }

  static setStringArray(key: string, value: string[]): void {
    AppDefaults.requireStore().putSync(key, JSON.stringify(value));
    AppDefaults.flush();
  }

  /** `[String: Set<String>]` defaults (feedsHidingReadArticles, foldersShowingReadArticles). */
  static stringSetMapValue(key: string): Map<string, string[]> {
    const result: Map<string, string[]> = new Map<string, string[]>();
    const value: preferences.ValueType = AppDefaults.requireStore().getSync(key, '{}');
    if (typeof value !== 'string') {
      return result;
    }
    try {
      const parsed: Record<string, Object> = JSON.parse(value as string) as Record<string, Object>;
      for (const mapKey of Object.keys(parsed)) {
        const entry: Object | undefined = parsed[mapKey];
        if (Array.isArray(entry)) {
          result.set(mapKey, entry as string[]);
        }
      }
    } catch (e) {
      return result;
    }
    return result;
  }

  static setStringSetMap(key: string, value: Map<string, string[]>): void {
    const plain: Record<string, string[]> = {};
    value.forEach((entry: string[], mapKey: string) => {
      plain[mapKey] = entry;
    });
    AppDefaults.requireStore().putSync(key, JSON.stringify(plain));
    AppDefaults.flush();
  }

  /** A `[String: String]` userInfo dictionary (selected sidebar item / article). */
  static stringMapValue(key: string): Map<string, string> | undefined {
    const result: Map<string, string> = new Map<string, string>();
    const value: preferences.ValueType = AppDefaults.requireStore().getSync(key, '');
    if (typeof value !== 'string' || (value as string).length === 0) {
      return undefined;
    }
    try {
      const parsed: Record<string, Object> = JSON.parse(value as string) as Record<string, Object>;
      for (const mapKey of Object.keys(parsed)) {
        const entry: Object | undefined = parsed[mapKey];
        if (typeof entry === 'string') {
          result.set(mapKey, entry as string);
        }
      }
    } catch (e) {
      return undefined;
    }
    return result.size === 0 ? undefined : result;
  }

  static setStringMap(key: string, value?: Map<string, string>): void {
    const store: preferences.Preferences = AppDefaults.requireStore();
    if (value === undefined) {
      store.deleteSync(key);
      AppDefaults.flush();
      return;
    }
    const plain: Record<string, string> = {};
    value.forEach((entry: string, mapKey: string) => {
      plain[mapKey] = entry;
    });
    store.putSync(key, JSON.stringify(plain));
    AppDefaults.flush();
  }

  /** An array of `[String: String]` dictionaries (expandedContainers). */
  static stringMapArrayValue(key: string): Map<string, string>[] {
    const out: Map<string, string>[] = [];
    const value: preferences.ValueType = AppDefaults.requireStore().getSync(key, '[]');
    if (typeof value !== 'string') {
      return out;
    }
    try {
      const parsed: Object = JSON.parse(value as string) as Object;
      if (!Array.isArray(parsed)) {
        return out;
      }
      for (const element of parsed as Object[]) {
        const record: Record<string, Object> = element as Record<string, Object>;
        const map: Map<string, string> = new Map<string, string>();
        for (const mapKey of Object.keys(record)) {
          const entry: Object | undefined = record[mapKey];
          if (typeof entry === 'string') {
            map.set(mapKey, entry as string);
          }
        }
        if (map.size > 0) {
          out.push(map);
        }
      }
    } catch (e) {
      return out;
    }
    return out;
  }

  static setStringMapArray(key: string, value: Map<string, string>[]): void {
    const plain: Record<string, string>[] = [];
    for (const map of value) {
      const record: Record<string, string> = {};
      map.forEach((entry: string, mapKey: string) => {
        record[mapKey] = entry;
      });
      plain.push(record);
    }
    AppDefaults.requireStore().putSync(key, JSON.stringify(plain));
    AppDefaults.flush();
  }

  static removeValue(key: string): void {
    AppDefaults.requireStore().deleteSync(key);
    AppDefaults.flush();
  }

  private static flush(): void {
    const store: preferences.Preferences | undefined = AppDefaults.store;
    if (store === undefined) {
      return;
    }
    // Best-effort, exactly like UserDefaults' own deferred write.
    store.flush().catch((err: Error) => {
      hilog.warn(0x0000, 'AppDefaults', 'flush failed: %{public}s', String(err));
    });
  }

  // MARK: - Typed properties (the source's computed vars)

  static get userInterfaceColorPalette(): UserInterfaceColorPalette {
    const raw: number = AppDefaults.intValue(AppDefaultsKey.userInterfaceColorPalette);
    if (raw === UserInterfaceColorPalette.light as number) {
      return UserInterfaceColorPalette.light;
    }
    if (raw === UserInterfaceColorPalette.dark as number) {
      return UserInterfaceColorPalette.dark;
    }
    return UserInterfaceColorPalette.automatic;
  }

  static set userInterfaceColorPalette(value: UserInterfaceColorPalette) {
    AppDefaults.setInt(AppDefaultsKey.userInterfaceColorPalette, value as number);
  }

  static get addFeedAccountID(): string | undefined {
    return AppDefaults.stringValue(AppDefaultsKey.addFeedAccountID);
  }

  static set addFeedAccountID(value: string | undefined) {
    AppDefaults.setString(AppDefaultsKey.addFeedAccountID, value);
  }

  static get addFeedFolderName(): string | undefined {
    return AppDefaults.stringValue(AppDefaultsKey.addFeedFolderName);
  }

  static set addFeedFolderName(value: string | undefined) {
    AppDefaults.setString(AppDefaultsKey.addFeedFolderName, value);
  }

  static get addFolderAccountID(): string | undefined {
    return AppDefaults.stringValue(AppDefaultsKey.addFolderAccountID);
  }

  static set addFolderAccountID(value: string | undefined) {
    AppDefaults.setString(AppDefaultsKey.addFolderAccountID, value);
  }

  static get useSystemBrowser(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.useSystemBrowser);
  }

  static set useSystemBrowser(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.useSystemBrowser, value);
  }

  static get lastImageCacheFlushDate(): Date | undefined {
    return AppDefaults.dateValue(AppDefaultsKey.lastImageCacheFlushDate);
  }

  static set lastImageCacheFlushDate(value: Date | undefined) {
    AppDefaults.setDate(AppDefaultsKey.lastImageCacheFlushDate, value);
  }

  static get timelineGroupByFeed(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.timelineGroupByFeed);
  }

  static set timelineGroupByFeed(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.timelineGroupByFeed, value);
  }

  static get refreshClearsReadArticles(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.refreshClearsReadArticles);
  }

  static set refreshClearsReadArticles(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.refreshClearsReadArticles, value);
  }

  static get timelineSortDirection(): SortDirection {
    const raw: number = AppDefaults.intValue(AppDefaultsKey.timelineSortDirection);
    return raw === SortDirection.orderedAscending as number
      ? SortDirection.orderedAscending
      : SortDirection.orderedDescending;
  }

  static set timelineSortDirection(value: SortDirection) {
    AppDefaults.setInt(AppDefaultsKey.timelineSortDirection, value as number);
  }

  static get articleFullscreenAvailable(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.articleFullscreenAvailable);
  }

  static set articleFullscreenAvailable(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.articleFullscreenAvailable, value);
  }

  /** The source gates the enabled flag on availability in the getter too. */
  static get articleFullscreenEnabled(): boolean {
    return AppDefaults.articleFullscreenAvailable
      && AppDefaults.boolValue(AppDefaultsKey.articleFullscreenEnabled);
  }

  static set articleFullscreenEnabled(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.articleFullscreenEnabled, value);
  }

  static get confirmMarkAllAsRead(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.confirmMarkAllAsRead);
  }

  static set confirmMarkAllAsRead(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.confirmMarkAllAsRead, value);
  }

  static get isArticleContentJavascriptEnabled(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.articleContentJavascriptEnabled);
  }

  static set isArticleContentJavascriptEnabled(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.articleContentJavascriptEnabled, value);
  }

  static get splitViewPreferredDisplayMode(): number {
    return AppDefaults.intValue(AppDefaultsKey.splitViewPreferredDisplayMode);
  }

  static set splitViewPreferredDisplayMode(value: number) {
    AppDefaults.setInt(AppDefaultsKey.splitViewPreferredDisplayMode, value);
  }

  /** nil until the user has resized the timeline column. */
  static get timelineWidth(): number | undefined {
    const value: number = AppDefaults.intValue(AppDefaultsKey.timelineWidth);
    return value === 0 ? undefined : value;
  }

  static set timelineWidth(value: number | undefined) {
    if (value === undefined) {
      AppDefaults.removeValue(AppDefaultsKey.timelineWidth);
    } else {
      AppDefaults.setInt(AppDefaultsKey.timelineWidth, value);
    }
  }

  static get lastRefresh(): Date | undefined {
    return AppDefaults.dateValue(AppDefaultsKey.lastRefresh);
  }

  static set lastRefresh(value: Date | undefined) {
    AppDefaults.setDate(AppDefaultsKey.lastRefresh, value);
  }

  static get timelineNumberOfLines(): number {
    return AppDefaults.intValue(AppDefaultsKey.timelineNumberOfLines);
  }

  static set timelineNumberOfLines(value: number) {
    AppDefaults.setInt(AppDefaultsKey.timelineNumberOfLines, value);
  }

  static get timelineIconSize(): IconSize {
    const raw: number = AppDefaults.intValue(AppDefaultsKey.timelineIconDimension);
    if (raw === IconSize.small as number) {
      return IconSize.small;
    }
    if (raw === IconSize.large as number) {
      return IconSize.large;
    }
    return IconSize.medium;
  }

  static set timelineIconSize(value: IconSize) {
    AppDefaults.setInt(AppDefaultsKey.timelineIconDimension, value as number);
  }

  static get currentThemeName(): string | undefined {
    return AppDefaults.stringValue(AppDefaultsKey.currentThemeName);
  }

  static set currentThemeName(value: string | undefined) {
    AppDefaults.setString(AppDefaultsKey.currentThemeName, value);
  }

  static get hideReadFeeds(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.hideReadFeeds);
  }

  static set hideReadFeeds(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.hideReadFeeds, value);
  }

  static get isShowingExtractedArticle(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.isShowingExtractedArticle);
  }

  static set isShowingExtractedArticle(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.isShowingExtractedArticle, value);
  }

  static get articleWindowScrollY(): number {
    return AppDefaults.intValue(AppDefaultsKey.articleWindowScrollY);
  }

  static set articleWindowScrollY(value: number) {
    AppDefaults.setInt(AppDefaultsKey.articleWindowScrollY, value);
  }

  static get expandedContainers(): ContainerIdentifier[] {
    const out: ContainerIdentifier[] = [];
    for (const userInfo of AppDefaults.stringMapArrayValue(AppDefaultsKey.expandedContainers)) {
      const identifier: ContainerIdentifier | undefined =
        ContainerIdentifier.fromUserInfo(userInfo);
      if (identifier !== undefined) {
        out.push(identifier);
      }
    }
    return out;
  }

  static set expandedContainers(value: ContainerIdentifier[]) {
    const userInfos: Map<string, string>[] = [];
    for (const identifier of value) {
      userInfos.push(identifier.userInfo());
    }
    AppDefaults.setStringMapArray(AppDefaultsKey.expandedContainers, userInfos);
  }

  static get smartFeedsHidingReadArticles(): string[] {
    return AppDefaults.stringArrayValue(AppDefaultsKey.smartFeedsHidingReadArticles);
  }

  static set smartFeedsHidingReadArticles(value: string[]) {
    AppDefaults.setStringArray(AppDefaultsKey.smartFeedsHidingReadArticles, value);
  }

  /** accountID -> feedIDs. */
  static get feedsHidingReadArticles(): Map<string, string[]> {
    return AppDefaults.stringSetMapValue(AppDefaultsKey.feedsHidingReadArticles);
  }

  static set feedsHidingReadArticles(value: Map<string, string[]>) {
    AppDefaults.setStringSetMap(AppDefaultsKey.feedsHidingReadArticles, value);
  }

  /** accountID -> folder display names. */
  static get foldersShowingReadArticles(): Map<string, string[]> {
    return AppDefaults.stringSetMapValue(AppDefaultsKey.foldersShowingReadArticles);
  }

  static set foldersShowingReadArticles(value: Map<string, string[]>) {
    AppDefaults.setStringSetMap(AppDefaultsKey.foldersShowingReadArticles, value);
  }

  static get selectedSidebarItem(): SidebarItemIdentifier | undefined {
    const userInfo: Map<string, string> | undefined =
      AppDefaults.stringMapValue(AppDefaultsKey.selectedSidebarItem);
    return userInfo === undefined ? undefined : SidebarItemIdentifier.fromUserInfo(userInfo);
  }

  static set selectedSidebarItem(value: SidebarItemIdentifier | undefined) {
    AppDefaults.setStringMap(AppDefaultsKey.selectedSidebarItem,
      value === undefined ? undefined : value.userInfo());
  }

  /** ArticleSpecifier's `[String: String]` dictionary form. */
  static get selectedArticle(): Map<string, string> | undefined {
    return AppDefaults.stringMapValue(AppDefaultsKey.selectedArticle);
  }

  static set selectedArticle(value: Map<string, string> | undefined) {
    AppDefaults.setStringMap(AppDefaultsKey.selectedArticle, value);
  }

  static get didMigrateLegacyStateRestorationInfo(): boolean {
    return AppDefaults.boolValue(AppDefaultsKey.didMigrateLegacyStateRestorationInfo);
  }

  static set didMigrateLegacyStateRestorationInfo(value: boolean) {
    AppDefaults.setBool(AppDefaultsKey.didMigrateLegacyStateRestorationInfo, value);
  }

  static get accountIDs(): string[] {
    return AppDefaults.stringArrayValue(AppDefaultsKey.accountIDs);
  }

  static set accountIDs(value: string[]) {
    AppDefaults.setStringArray(AppDefaultsKey.accountIDs, value);
  }
}
