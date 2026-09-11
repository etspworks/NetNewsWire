/**
 * IconImageCache — port of the Images module plus Shared/IconImageCache.swift:
 *   ImageDownloader.swift          the memory + disk image cache and its download path
 *   ImageMetadataDatabase.swift    homePage->favicon, feed->icon and the failure ledger
 *   {DownloadFailure,HomePageFavicon,FeedIconURL}Table.swift  its three tables
 *   FaviconDownloader.swift + SingleFaviconDownloader.swift   favicon discovery
 *   FeedIconDownloader.swift       feed icon discovery
 *   ColorHash.swift                the deterministic placeholder color
 *   IconImageCache.swift           the per-sidebar-item cache the rows read
 *
 * The cache is written as a SIDE EFFECT of rendering a sidebar row: `iconForFeed` returns
 * what it has and starts a download for what it doesn't, notifying listeners when the icon
 * lands. Every retry floor from the source is kept — 30 minutes for a single favicon,
 * 5 days for a failed image URL, 33 days before a failure row is forgotten.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Feed } from '../../model/Feed';
import { Author } from '../../model/Author';
import { IconImage } from '../../model/IconImage';
import { HTMLMetadataRecord, bestWebsiteIconURL } from '../../model/HTMLMetadataRecord';
import { SidebarItemIdentifier } from '../../model/SidebarItemIdentifier';
import { DownloadResponse } from '../../model/DownloadResponse';
import { ActivityKind, ActivityKindType, ActivityOwner, ActivityOwnerKind }
  from '../../model/Activity';
import { ActivityLog } from '../log/ActivityLog';
import { AppContext } from '../util/AppContext';
import { BinaryDiskCache } from '../util/BinaryDiskCache';
import { md5String } from '../util/Hashing';
import { normalizedURL, schemeOf, hostOf, strippingQueryAndFragment, pathExtension,
  SpecialCase } from '../util/Urls';
import { Database, Row, ValuesBucket } from '../db/Database';
import { Downloader, UserAgentStyle, responseIsOK } from '../net/DownloadSession';
import { HTMLMetadataDownloader } from '../net/HTMLMetadata';

const DOMAIN: number = 0x0001;
const TAG: string = 'IconImageCache';

// MARK: - ColorHash (ColorHash.swift)

/**
 * The deterministic placeholder color for a feed with no icon. Ported bit-for-bit so a
 * feed keeps the same color it had on iOS.
 */
export class ColorHash {
  static readonly defaultSaturation: number[] = [0.35, 0.5, 0.65];
  static readonly defaultBrightness: number[] = [0.5, 0.65, 0.80];

  private static readonly seed: number = 131.0;
  private static readonly seed2: number = 137.0;
  private static readonly maxSafeInteger: number = 9007199254740991.0 / 137.0;
  private static readonly full: number = 360.0;

  readonly str: string;
  readonly saturation: number[];
  readonly brightness: number[];

  constructor(str: string, saturation: number[] = ColorHash.defaultSaturation,
    brightness: number[] = ColorHash.defaultBrightness) {
    this.str = str;
    this.saturation = saturation;
    this.brightness = brightness;
  }

  get bkdrHash(): number {
    let hash: number = 0;
    const source: string = this.str + 'x';
    for (let i: number = 0; i < source.length; i++) {
      if (hash > ColorHash.maxSafeInteger) {
        hash /= ColorHash.seed2;
      }
      hash = hash * ColorHash.seed + source.charCodeAt(i);
    }
    return hash;
  }

  /** [hue 0-1, saturation 0-1, brightness 0-1]. */
  get hsb(): number[] {
    let hash: number = this.bkdrHash;
    const h: number = (hash % (ColorHash.full - 1.0)) / ColorHash.full;
    hash /= ColorHash.full;
    const s: number =
      this.saturation[Math.floor((ColorHash.full * hash) % this.saturation.length)];
    hash /= this.saturation.length;
    const b: number =
      this.brightness[Math.floor((ColorHash.full * hash) % this.brightness.length)];
    return [h, s, b];
  }

  /** 0xRRGGBB, ready for ArkUI's Color. */
  get colorValue(): number {
    const hsb: number[] = this.hsb;
    return ColorHash.hsbToRGB(hsb[0], hsb[1], hsb[2]);
  }

  private static hsbToRGB(h: number, s: number, v: number): number {
    const i: number = Math.floor(h * 6);
    const f: number = h * 6 - i;
    const p: number = v * (1 - s);
    const q: number = v * (1 - f * s);
    const t: number = v * (1 - (1 - f) * s);
    let r: number = 0;
    let g: number = 0;
    let b: number = 0;
    const sector: number = i % 6;
    if (sector === 0) {
      r = v; g = t; b = p;
    } else if (sector === 1) {
      r = q; g = v; b = p;
    } else if (sector === 2) {
      r = p; g = v; b = t;
    } else if (sector === 3) {
      r = p; g = q; b = v;
    } else if (sector === 4) {
      r = t; g = p; b = v;
    } else {
      r = v; g = p; b = q;
    }
    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }
}

// MARK: - ImageMetadataDatabase

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE IF NOT EXISTS downloadFailure (url TEXT PRIMARY KEY NOT NULL,'
    + ' statusCode INTEGER, lastChecked REAL NOT NULL);',
  'CREATE TABLE IF NOT EXISTS homePageFavicon (homePageURL TEXT PRIMARY KEY NOT NULL,'
    + ' faviconURL TEXT, lastChecked REAL NOT NULL);',
  'CREATE TABLE IF NOT EXISTS feedIconURL (feedURL TEXT PRIMARY KEY NOT NULL,'
    + ' iconURL TEXT NOT NULL, lastChecked REAL NOT NULL);'
];

/** Per-URL image metadata: discovered URLs and failure tracking. */
export class ImageMetadataDatabase {
  static readonly shared: ImageMetadataDatabase = new ImageMetadataDatabase();

  static readonly failureRetryDays: number = 5;
  private static readonly failureRetentionDays: number = 33;

  private readonly database: Database = new Database('ImageMetadata.db');
  private homePageToFaviconURL: Map<string, string> = new Map<string, string>();
  private homePagesWithNoFavicon: Set<string> = new Set<string>();
  private feedURLToIconURL: Map<string, string> = new Map<string, string>();
  private failureDates: Map<string, Date> = new Map<string, Date>();

  async open(): Promise<void> {
    if (this.database.isOpen()) {
      return;
    }
    await this.database.open(CREATE_STATEMENTS);
    await this.loadCachesFromDatabase();
    const cutoff: number = Date.now() / 1000
      - ImageMetadataDatabase.failureRetentionDays * 24 * 60 * 60;
    await this.database.execute('DELETE FROM downloadFailure WHERE lastChecked < ?;',
      [cutoff]);
    await this.database.vacuum();
  }

  async vacuum(): Promise<void> {
    await this.database.vacuum();
  }

  // MARK: homePageFavicon

  faviconURLForHomePageURL(homePageURL: string): string | undefined {
    return this.homePageToFaviconURL.get(homePageURL);
  }

  homePageHasNoFavicon(homePageURL: string): boolean {
    return this.homePagesWithNoFavicon.has(homePageURL);
  }

  saveHomePageFavicon(homePageURL: string, faviconURL?: string): void {
    if (faviconURL !== undefined) {
      this.homePageToFaviconURL.set(homePageURL, faviconURL);
      this.homePagesWithNoFavicon.delete(homePageURL);
    } else {
      this.homePagesWithNoFavicon.add(homePageURL);
      this.homePageToFaviconURL.delete(homePageURL);
    }
    const row: ValuesBucket = {
      'homePageURL': homePageURL,
      'faviconURL': faviconURL === undefined ? null : faviconURL,
      'lastChecked': Date.now() / 1000
    };
    this.insertQuietly('homePageFavicon', row);
  }

  // MARK: feedIconURL

  iconURLForFeedURL(feedURL: string): string | undefined {
    return this.feedURLToIconURL.get(feedURL);
  }

  saveFeedIconURL(feedURL: string, iconURL: string): void {
    this.feedURLToIconURL.set(feedURL, iconURL);
    const row: ValuesBucket = {
      'feedURL': feedURL,
      'iconURL': iconURL,
      'lastChecked': Date.now() / 1000
    };
    this.insertQuietly('feedIconURL', row);
  }

  // MARK: downloadFailure

  recentlyFailed(url: string): boolean {
    const lastFailure: Date | undefined = this.failureDates.get(url);
    if (lastFailure === undefined) {
      return false;
    }
    return Date.now() - lastFailure.getTime()
      < ImageMetadataDatabase.failureRetryDays * 24 * 60 * 60 * 1000;
  }

  recordFailure(url: string, statusCode?: number): void {
    this.failureDates.set(url, new Date());
    const row: ValuesBucket = {
      'url': url,
      'lastChecked': Date.now() / 1000,
      'statusCode': statusCode === undefined ? null : statusCode
    };
    this.insertQuietly('downloadFailure', row);
  }

  clearFailure(url: string): void {
    if (!this.failureDates.has(url)) {
      return;
    }
    this.failureDates.delete(url);
    this.database.execute('DELETE FROM downloadFailure WHERE url = ?;', [url])
      .catch((e: Error) => {
        hilog.error(DOMAIN, TAG, 'clearFailure failed: %{public}s', String(e));
      });
  }

  private insertQuietly(table: string, row: ValuesBucket): void {
    this.database.insert(table, row, true).catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'insert into %{public}s failed: %{public}s', table, String(e));
    });
  }

  private async loadCachesFromDatabase(): Promise<void> {
    const faviconRows: Row[] = await this.database.query(
      'SELECT homePageURL, faviconURL, lastChecked FROM homePageFavicon;');
    for (const row of faviconRows) {
      const homePageURL: string | undefined = row.getString('homePageURL');
      if (homePageURL === undefined) {
        continue;
      }
      const faviconURL: string | undefined = row.getString('faviconURL');
      if (faviconURL !== undefined) {
        this.homePageToFaviconURL.set(homePageURL, faviconURL);
        continue;
      }
      // A no-favicon verdict expires after failureRetryDays, so the homepage is rechecked.
      const lastChecked: Date | undefined = row.getDate('lastChecked');
      if (lastChecked !== undefined && Date.now() - lastChecked.getTime()
        < ImageMetadataDatabase.failureRetryDays * 24 * 60 * 60 * 1000) {
        this.homePagesWithNoFavicon.add(homePageURL);
      }
    }

    const iconRows: Row[] = await this.database.query(
      'SELECT feedURL, iconURL FROM feedIconURL;');
    for (const row of iconRows) {
      const feedURL: string | undefined = row.getString('feedURL');
      const iconURL: string | undefined = row.getString('iconURL');
      if (feedURL !== undefined && iconURL !== undefined) {
        this.feedURLToIconURL.set(feedURL, iconURL);
      }
    }

    const failureRows: Row[] = await this.database.query(
      'SELECT url, lastChecked FROM downloadFailure;');
    for (const row of failureRows) {
      const url: string | undefined = row.getString('url');
      const lastChecked: Date | undefined = row.getDate('lastChecked');
      if (url !== undefined && lastChecked !== undefined) {
        this.failureDates.set(url, lastChecked);
      }
    }
  }
}

// MARK: - ImageDownloader

export class ImageDownloadError extends Error {
  readonly statusCode?: number;
  readonly decodingFailed: boolean;
  /** No network, DNS issue, timeout, 5xx response, etc. */
  readonly isTransient: boolean;

  constructor(statusCode: number | undefined, decodingFailed: boolean, isTransient: boolean) {
    super(ImageDownloadError.describe(statusCode, decodingFailed, isTransient));
    this.statusCode = statusCode;
    this.decodingFailed = decodingFailed;
    this.isTransient = isTransient;
  }

  private static describe(statusCode: number | undefined, decodingFailed: boolean,
    isTransient: boolean): string {
    if (decodingFailed) {
      return statusCode === undefined
        ? 'Couldn’t decode image bytes'
        : 'Couldn’t decode image bytes (HTTP ' + statusCode + ')';
    }
    if (statusCode === undefined) {
      return isTransient ? 'No response' : 'Bad URL';
    }
    return 'HTTP ' + statusCode;
  }
}

export type ImageAvailableListener = (url: string) => void;

/**
 * The memory + disk image cache. `image(for:)` returns the bytes if they are in memory,
 * otherwise starts a disk-then-network fetch and returns undefined; listeners are notified
 * when the image lands.
 */
export class ImageDownloader {
  private static instance?: ImageDownloader;

  /**
   * Lazy: the constructor resolves a cache folder through AppContext, which only exists
   * after EntryAbility.onCreate -> AppBootstrap.start(). A module-scope `new` runs while
   * EntryAbility.abc is still loading and takes the process down.
   */
  static get shared(): ImageDownloader {
    if (ImageDownloader.instance === undefined) {
      ImageDownloader.instance = new ImageDownloader();
    }
    return ImageDownloader.instance;
  }

  private readonly diskCache: BinaryDiskCache;
  private imageCache: Map<string, ArrayBuffer> = new Map<string, ArrayBuffer>();
  private urlsInProgress: Set<string> = new Set<string>();
  private listeners: ImageAvailableListener[] = [];

  constructor() {
    this.diskCache = new BinaryDiskCache(AppContext.cacheSubfolder('Images'));
  }

  addListener(listener: ImageAvailableListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: ImageAvailableListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /** Frees memory when the app is backgrounded or memory is tight. */
  emptyCache(): void {
    this.imageCache.clear();
  }

  cachedImage(url: string): ArrayBuffer | undefined {
    return this.imageCache.get(url);
  }

  /**
   * The image bytes if they are in memory, else undefined after starting a fetch.
   * The activity log fires only when the fetch reaches the network.
   */
  image(url: string, activityOwner?: ActivityOwner, activityKind?: ActivityKind,
    activityDetail?: string): ArrayBuffer | undefined {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      hilog.debug(DOMAIN, TAG, 'skipping non-http(s) URL: %{public}s', url);
      return undefined;
    }
    const cached: ArrayBuffer | undefined = this.imageCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    if (ImageMetadataDatabase.shared.recentlyFailed(url)) {
      hilog.debug(DOMAIN, TAG, 'skipping recently-failed URL: %{public}s', url);
      return undefined;
    }
    this.findImage(url, activityOwner, activityKind, activityDetail).catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'findImage failed: %{public}s', String(e));
    });
    return undefined;
  }

  private async findImage(url: string, activityOwner?: ActivityOwner,
    activityKind?: ActivityKind, activityDetail?: string): Promise<void> {
    if (this.urlsInProgress.has(url)) {
      return;
    }
    this.urlsInProgress.add(url);
    try {
      const fromDisk: ArrayBuffer | undefined = this.diskCache.data(ImageDownloader.diskKey(url));
      if (fromDisk !== undefined && fromDisk.byteLength > 0) {
        this.cacheImage(url, fromDisk);
        return;
      }

      const activityLog: ActivityLog = ActivityLog.shared;
      let activityID: number = -1;
      if (activityOwner !== undefined && activityKind !== undefined) {
        activityID = activityLog.createActivity(activityOwner, activityKind, activityDetail);
        activityLog.didStartWithID(activityID);
      }

      try {
        const response: DownloadResponse = await this.downloadImage(url);
        const data: ArrayBuffer | undefined = response.data;
        if (activityID >= 0 && data !== undefined) {
          activityLog.didCompleteWithID(activityID,
            ActivityLog.dataSizeMessage(data.byteLength), !response.returnedFromCache,
            response.returnedFromCache);
        }
        if (data !== undefined) {
          this.diskCache.setData(ImageDownloader.diskKey(url), data);
          this.cacheImage(url, data);
        }
        ImageMetadataDatabase.shared.clearFailure(url);
      } catch (e) {
        if (activityID >= 0) {
          activityLog.didFailWithID(activityID, e as Error);
        }
        const error: ImageDownloadError = e as ImageDownloadError;
        if (!error.isTransient) {
          ImageMetadataDatabase.shared.recordFailure(url, error.statusCode);
        }
      }
    } finally {
      this.urlsInProgress.delete(url);
    }
  }

  private async downloadImage(url: string): Promise<DownloadResponse> {
    let response: DownloadResponse;
    try {
      response = await Downloader.shared.download(url, UserAgentStyle.browser);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'error downloading image at %{public}s: %{public}s', url,
        String(e));
      throw new ImageDownloadError(undefined, false, true);
    }

    const data: ArrayBuffer | undefined = response.data;
    if (data !== undefined && data.byteLength > 0 && responseIsOK(response)) {
      return response;
    }

    const statusCode: number | undefined = response.statusCode;
    // 2xx with an empty body — the server said OK but gave us no image bytes.
    if (responseIsOK(response)) {
      throw new ImageDownloadError(statusCode, true, false);
    }
    const isTransient: boolean =
      statusCode === undefined ? true : (statusCode >= 500 && statusCode <= 599);
    throw new ImageDownloadError(statusCode, false, isTransient);
  }

  private cacheImage(url: string, data: ArrayBuffer): void {
    this.imageCache.set(url, data);
    for (const listener of this.listeners) {
      listener(url);
    }
  }

  private static diskKey(url: string): string {
    return md5String(url);
  }
}

// MARK: - FaviconDownloader

class SingleFaviconDownloader {
  /** If we don't have an image and the last attempt was a while ago, try again. */
  private static readonly retryIntervalMillis: number = 30 * 60 * 1000;

  readonly faviconURL: string;
  readonly homePageURL?: string;
  iconImage?: IconImage;
  error?: ImageDownloadError;

  private lastDownloadAttemptDate: Date = new Date();
  private readonly diskCache: BinaryDiskCache;
  private readonly diskKey: string;
  private readonly onLoad: (downloader: SingleFaviconDownloader) => void;

  constructor(faviconURL: string, homePageURL: string | undefined,
    diskCache: BinaryDiskCache, onLoad: (downloader: SingleFaviconDownloader) => void) {
    this.faviconURL = faviconURL;
    this.homePageURL = homePageURL;
    this.diskCache = diskCache;
    this.diskKey = md5String(faviconURL);
    this.onLoad = onLoad;
    this.findFavicon();
  }

  /** Returns true when a retry was actually started. */
  downloadFaviconIfNeeded(): boolean {
    if (this.iconImage !== undefined) {
      return false;
    }
    if (Date.now() - this.lastDownloadAttemptDate.getTime()
      < SingleFaviconDownloader.retryIntervalMillis) {
      return false;
    }
    this.lastDownloadAttemptDate = new Date();
    this.findFavicon();
    return true;
  }

  private findFavicon(): void {
    const onDisk: ArrayBuffer | undefined = this.diskCache.data(this.diskKey);
    if (onDisk !== undefined && onDisk.byteLength > 0) {
      this.iconImage = new IconImage(this.faviconURL);
      this.error = undefined;
      this.onLoad(this);
      return;
    }
    this.download().catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'favicon download failed: %{public}s', String(e));
    });
  }

  private async download(): Promise<void> {
    const activityLog: ActivityLog = ActivityLog.shared;
    const owner: ActivityOwner = new ActivityOwner(ActivityOwnerKind.faviconDownloader);
    const kind: ActivityKind =
      new ActivityKind(ActivityKindType.downloadFavicon, this.faviconURL);
    const activityID: number = activityLog.createActivity(owner, kind);
    activityLog.didStartWithID(activityID);

    try {
      const response: DownloadResponse =
        await Downloader.shared.download(this.faviconURL, UserAgentStyle.browser);
      const data: ArrayBuffer | undefined = response.data;
      if (data === undefined || data.byteLength === 0 || !responseIsOK(response)) {
        const statusCode: number | undefined = response.statusCode;
        const isTransient: boolean =
          statusCode === undefined ? true : (statusCode >= 500 && statusCode <= 599);
        const failure: ImageDownloadError =
          new ImageDownloadError(statusCode, false, isTransient);
        this.error = isTransient ? undefined : failure;
        activityLog.didFailWithID(activityID, failure);
      } else {
        this.diskCache.setData(this.diskKey, data);
        this.iconImage = new IconImage(this.faviconURL);
        this.error = undefined;
        activityLog.didCompleteWithID(activityID,
          ActivityLog.dataSizeMessage(data.byteLength), !response.returnedFromCache,
          response.returnedFromCache);
      }
    } catch (e) {
      // Transient failures are not remembered.
      this.error = undefined;
      activityLog.didFailWithID(activityID, e as Error);
    }
    this.onLoad(this);
  }
}

export type FaviconAvailableListener = (faviconURL: string) => void;

export class FaviconDownloader {
  private static instance?: FaviconDownloader;

  /** Lazy — the constructor needs AppContext's cache folder. See ImageDownloader.shared. */
  static get shared(): FaviconDownloader {
    if (FaviconDownloader.instance === undefined) {
      FaviconDownloader.instance = new FaviconDownloader();
    }
    return FaviconDownloader.instance;
  }

  private static readonly specialCasesToSkip: string[] =
    [SpecialCase.rachelByTheBayHostName, SpecialCase.openRSSOrgHostName];
  /** SVG favicons aren't decodable as bitmaps — the source ignores them. */
  private static readonly ignoredExtensions: string[] = ['svg'];

  private readonly diskCache: BinaryDiskCache;
  private singleFaviconDownloaderCache: Map<string, SingleFaviconDownloader> =
    new Map<string, SingleFaviconDownloader>();
  /** homePageURL -> favicon URLs not yet tried. */
  private remainingFaviconURLs: Map<string, string[]> = new Map<string, string[]>();
  private currentHomePageHasOnlyFaviconICO: boolean = false;
  private cache: Map<string, IconImage> = new Map<string, IconImage>();
  private listeners: FaviconAvailableListener[] = [];

  constructor() {
    this.diskCache = new BinaryDiskCache(AppContext.cacheSubfolder('Favicons'));
    HTMLMetadataDownloader.shared.addListener((record: HTMLMetadataRecord) => {
      this.faviconWithHomePageURL(record.url);
    });
  }

  addListener(listener: FaviconAvailableListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: FaviconAvailableListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  emptyCache(): void {
    this.cache.clear();
    this.singleFaviconDownloaderCache.clear();
  }

  favicon(feed: Feed): IconImage | undefined {
    if (SpecialCase.urlStringContainSpecialCase(feed.url,
      FaviconDownloader.specialCasesToSkip)) {
      return undefined;
    }

    let homePageURL: string | undefined = feed.homePageURL;
    const faviconURL: string | undefined = feed.faviconURL;
    if (faviconURL !== undefined) {
      return this.faviconWith(faviconURL, homePageURL);
    }
    if (homePageURL === undefined) {
      // Base the home page on the feed URL. Not always accurate, but good enough.
      const scheme: string | undefined = schemeOf(feed.url);
      const host: string | undefined = hostOf(feed.url);
      if (scheme !== undefined && host !== undefined) {
        homePageURL = scheme + '://' + host + '/';
      }
    }
    if (homePageURL !== undefined) {
      return this.faviconWithHomePageURL(homePageURL);
    }
    return undefined;
  }

  faviconAsIcon(feed: Feed): IconImage | undefined {
    const cached: IconImage | undefined = this.cache.get(feed.feedID);
    if (cached !== undefined) {
      return cached;
    }
    const iconImage: IconImage | undefined = this.favicon(feed);
    if (iconImage !== undefined) {
      this.cache.set(feed.feedID, iconImage);
    }
    return iconImage;
  }

  /** The in-memory favicon for `feed` without triggering a download. */
  cachedFaviconAsIcon(feed: Feed): IconImage | undefined {
    const cached: IconImage | undefined = this.cache.get(feed.feedID);
    if (cached !== undefined) {
      return cached;
    }
    const faviconURL: string | undefined = this.cachedFaviconURL(feed);
    if (faviconURL === undefined) {
      return undefined;
    }
    const downloader: SingleFaviconDownloader | undefined =
      this.singleFaviconDownloaderCache.get(faviconURL);
    const iconImage: IconImage | undefined =
      downloader === undefined ? undefined : downloader.iconImage;
    if (iconImage === undefined) {
      return undefined;
    }
    this.cache.set(feed.feedID, iconImage);
    return iconImage;
  }

  /** The known favicon URL for `feed`, from feed settings or the home-page map. */
  cachedFaviconURL(feed: Feed): string | undefined {
    const faviconURL: string | undefined = feed.faviconURL;
    if (faviconURL !== undefined) {
      return faviconURL;
    }
    const homePageURL: string | undefined = feed.homePageURL;
    if (homePageURL === undefined) {
      return undefined;
    }
    return ImageMetadataDatabase.shared.faviconURLForHomePageURL(homePageURL);
  }

  faviconWith(faviconURL: string, homePageURL?: string): IconImage | undefined {
    if (!this.canAttemptDownload(faviconURL)) {
      return undefined;
    }
    return this.faviconDownloader(faviconURL, homePageURL).iconImage;
  }

  faviconWithHomePageURL(homePageURL: string): IconImage | undefined {
    const url: string = normalizedURL(homePageURL);

    if (ImageMetadataDatabase.shared.homePageHasNoFavicon(url)) {
      return undefined;
    }
    const known: string | undefined =
      ImageMetadataDatabase.shared.faviconURLForHomePageURL(url);
    if (known !== undefined) {
      return this.faviconWith(known, url);
    }

    const faviconURLs: string[] | undefined = this.findFaviconURLs(url);
    if (faviconURLs !== undefined) {
      // If the site explicitly specifies favicon.ico, it appears twice.
      this.currentHomePageHasOnlyFaviconICO = faviconURLs.length === 1;
      this.remainingFaviconURLs.set(url, faviconURLs);
      this.downloadNextFavicon(url);
    }
    return undefined;
  }

  private findFaviconURLs(homePageURL: string): string[] | undefined {
    const metadata: HTMLMetadataRecord | undefined =
      HTMLMetadataDownloader.shared.cachedMetadata(homePageURL);
    if (metadata === undefined) {
      return undefined;
    }
    const faviconURLs: string[] = [];
    for (const favicon of metadata.favicons) {
      const urlString: string | undefined = favicon.urlString;
      if (urlString === undefined) {
        continue;
      }
      // Only http(s) — a data: URL can't be downloaded as a favicon.
      if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
        continue;
      }
      const type: string | undefined = favicon.type;
      if (type !== undefined && type.toLowerCase().indexOf('svg') >= 0) {
        continue;
      }
      if (FaviconDownloader.ignoredExtensions.indexOf(
        pathExtension(urlString).toLowerCase()) >= 0) {
        continue;
      }
      faviconURLs.push(urlString);
    }

    const scheme: string | undefined = schemeOf(homePageURL);
    const host: string | undefined = hostOf(homePageURL);
    if (scheme === undefined || host === undefined) {
      return faviconURLs.length === 0 ? undefined : faviconURLs;
    }
    faviconURLs.push((scheme + '://' + host + '/favicon.ico').toLowerCase());
    return faviconURLs;
  }

  private canAttemptDownload(faviconURL: string): boolean {
    if (!faviconURL.startsWith('http://') && !faviconURL.startsWith('https://')) {
      hilog.debug(DOMAIN, TAG, 'skipping non-http(s) URL: %{public}s', faviconURL);
      return false;
    }
    if (ImageMetadataDatabase.shared.recentlyFailed(faviconURL)) {
      hilog.debug(DOMAIN, TAG, 'skipping recently-failed URL: %{public}s', faviconURL);
      return false;
    }
    return true;
  }

  /**
   * A skipped candidate advances to the next one — otherwise the queue stalls and the
   * remaining candidates are never tried.
   * <https://github.com/Ranchero-Software/NetNewsWire/issues/4868>
   */
  private downloadNextFavicon(homePageURL: string): void {
    let remaining: string[] | undefined = this.remainingFaviconURLs.get(homePageURL);
    while (remaining !== undefined && remaining.length > 0) {
      const faviconURL: string = remaining[0];
      remaining = remaining.slice(1);
      this.remainingFaviconURLs.set(homePageURL, remaining);
      if (this.canAttemptDownload(faviconURL)) {
        this.faviconDownloader(faviconURL, homePageURL);
        return;
      }
    }
    this.remainingFaviconURLs.delete(homePageURL);
    if (this.currentHomePageHasOnlyFaviconICO) {
      ImageMetadataDatabase.shared.saveHomePageFavicon(homePageURL, undefined);
    }
  }

  private faviconDownloader(faviconURL: string,
    homePageURL?: string): SingleFaviconDownloader {
    let firstTimeSeeingHomepageURL: boolean = false;
    if (homePageURL !== undefined
      && ImageMetadataDatabase.shared.faviconURLForHomePageURL(homePageURL) === undefined) {
      ImageMetadataDatabase.shared.saveHomePageFavicon(homePageURL, faviconURL);
      firstTimeSeeingHomepageURL = true;
    }

    const existing: SingleFaviconDownloader | undefined =
      this.singleFaviconDownloaderCache.get(faviconURL);
    if (existing !== undefined) {
      // Different homepages can share one favicon (Twitter, Blogger). When the favicon is
      // already cached no retry starts, so notify here or the row never updates.
      if (firstTimeSeeingHomepageURL && !existing.downloadFaviconIfNeeded()) {
        this.postFaviconDidBecomeAvailable(faviconURL);
      }
      return existing;
    }

    const downloader: SingleFaviconDownloader = new SingleFaviconDownloader(faviconURL,
      homePageURL, this.diskCache, (finished: SingleFaviconDownloader) => {
        this.didLoadFavicon(finished);
      });
    this.singleFaviconDownloaderCache.set(faviconURL, downloader);
    return downloader;
  }

  private didLoadFavicon(downloader: SingleFaviconDownloader): void {
    // The URL-level outcome is recorded even when homePageURL is undefined.
    const error: ImageDownloadError | undefined = downloader.error;
    if (error !== undefined) {
      ImageMetadataDatabase.shared.recordFailure(downloader.faviconURL, error.statusCode);
    } else if (downloader.iconImage !== undefined) {
      ImageMetadataDatabase.shared.clearFailure(downloader.faviconURL);
    }

    const homePageURL: string | undefined = downloader.homePageURL;
    if (homePageURL === undefined) {
      return;
    }
    if (downloader.iconImage === undefined) {
      if (this.remainingFaviconURLs.has(homePageURL)) {
        this.downloadNextFavicon(homePageURL);
      }
      return;
    }
    this.remainingFaviconURLs.delete(homePageURL);
    this.postFaviconDidBecomeAvailable(downloader.faviconURL);
  }

  private postFaviconDidBecomeAvailable(faviconURL: string): void {
    for (const listener of this.listeners) {
      listener(faviconURL);
    }
  }
}

// MARK: - FeedIconDownloader

export type FeedIconAvailableListener = (feed: Feed) => void;

export class FeedIconDownloader {
  private static instance?: FeedIconDownloader;

  /**
   * Lazy — the constructor subscribes to ImageDownloader.shared, whose own construction
   * needs AppContext. See ImageDownloader.shared.
   */
  static get shared(): FeedIconDownloader {
    if (FeedIconDownloader.instance === undefined) {
      FeedIconDownloader.instance = new FeedIconDownloader();
    }
    return FeedIconDownloader.instance;
  }

  private static readonly specialCasesToSkip: string[] = ['macsparky.com', 'xkcd.com',
    SpecialCase.rachelByTheBayHostName, SpecialCase.openRSSOrgHostName];
  /**
   * Feed URLs whose declared icon URL is wrong — ignore it and use the homepage icon.
   */
  private static readonly feedURLSubstringsToIgnoreFeedIconURL: string[] =
    ['propublica.org', 'clubic.com', 'comptoir-hardware.com', 'cowcotland', '404media.co',
      'awfulannouncing.com', 'michalzelazny.com'];

  private homePagesWithNoIconURL: Set<string> = new Set<string>();
  private cache: Map<string, IconImage> = new Map<string, IconImage>();
  private waitingForFeedURLs: Map<string, Feed[]> = new Map<string, Feed[]>();
  private feedsWaitingForHTMLMetadata: Feed[] = [];
  private listeners: FeedIconAvailableListener[] = [];

  constructor() {
    ImageDownloader.shared.addListener((url: string) => {
      this.imageDidBecomeAvailable(url);
    });
    HTMLMetadataDownloader.shared.addListener((record: HTMLMetadataRecord) => {
      this.htmlMetadataDidBecomeAvailable(record.url);
    });
  }

  addListener(listener: FeedIconAvailableListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: FeedIconAvailableListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  emptyCache(): void {
    this.cache.clear();
  }

  /** The in-memory icon for `feed` without triggering a download. */
  cachedIcon(feed: Feed): IconImage | undefined {
    return this.cache.get(feed.feedID);
  }

  icon(feed: Feed): IconImage | undefined {
    const cached: IconImage | undefined = this.cache.get(feed.feedID);
    if (cached !== undefined) {
      return cached;
    }
    if (SpecialCase.urlStringContainSpecialCase(feed.url,
      FeedIconDownloader.specialCasesToSkip)) {
      return undefined;
    }

    // The stored icon URL remembers an icon discovered via the home page; a feed that
    // declares its own icon supersedes it.
    // <https://github.com/Ranchero-Software/NetNewsWire/issues/5376>
    const feedDeclaresIconURL: boolean = feed.iconURL !== undefined
      && !FeedIconDownloader.shouldIgnoreFeedIconURL(feed);

    if (!feedDeclaresIconURL) {
      const previouslyFound: string | undefined =
        ImageMetadataDatabase.shared.iconURLForFeedURL(feed.url);
      if (previouslyFound !== undefined) {
        this.iconForURL(previouslyFound, feed, (data: ArrayBuffer | undefined) => {
          if (this.cache.has(feed.feedID) || data === undefined) {
            return;
          }
          this.cache.set(feed.feedID, new IconImage(previouslyFound));
          this.postFeedIconDidBecomeAvailable(feed);
        });
        return undefined;
      }
    }

    this.checkFeedIconURL(feed);
    return undefined;
  }

  private checkFeedIconURL(feed: Feed): void {
    const iconURL: string | undefined = feed.iconURL;
    if (iconURL === undefined || FeedIconDownloader.shouldIgnoreFeedIconURL(feed)) {
      this.checkHomePageURL(feed);
      return;
    }
    this.iconForURL(iconURL, feed, (data: ArrayBuffer | undefined, isDefinitive: boolean) => {
      if (this.cache.has(feed.feedID)) {
        return;
      }
      if (data !== undefined) {
        this.cache.set(feed.feedID, new IconImage(iconURL));
        ImageMetadataDatabase.shared.saveFeedIconURL(feed.url, iconURL);
        this.postFeedIconDidBecomeAvailable(feed);
        return;
      }
      if (isDefinitive) {
        // The declared icon failed or isn't an image. A still-downloading icon is no
        // reason to fall back to the home page's icon.
        this.checkHomePageURL(feed);
      }
    });
  }

  private checkHomePageURL(feed: Feed): void {
    const homePageURL: string | undefined = feed.homePageURL;
    if (homePageURL === undefined || this.homePagesWithNoIconURL.has(homePageURL)) {
      return;
    }
    if (SpecialCase.urlStringContainSpecialCase(homePageURL,
      FeedIconDownloader.specialCasesToSkip)) {
      return;
    }

    const metadata: HTMLMetadataRecord | undefined =
      HTMLMetadataDownloader.shared.cachedMetadata(homePageURL);
    if (metadata === undefined) {
      this.feedsWaitingForHTMLMetadata.push(feed);
      return;
    }

    const iconURL: string | undefined = bestWebsiteIconURL(metadata);
    if (iconURL === undefined) {
      this.homePagesWithNoIconURL.add(homePageURL);
      return;
    }
    this.homePagesWithNoIconURL.delete(homePageURL);
    this.iconForURL(iconURL, feed, (data: ArrayBuffer | undefined) => {
      if (this.cache.has(feed.feedID) || data === undefined) {
        return;
      }
      this.cache.set(feed.feedID, new IconImage(iconURL));
      ImageMetadataDatabase.shared.saveFeedIconURL(feed.url, iconURL);
      this.postFeedIconDidBecomeAvailable(feed);
    });
  }

  /**
   * `isDefinitive` is false when the image is still downloading — the image-available
   * listener re-runs `icon(feed)` when it arrives.
   */
  private iconForURL(url: string, feed: Feed,
    resultBlock: (data: ArrayBuffer | undefined, isDefinitive: boolean) => void): void {
    const sanitized: string = FeedIconDownloader.sanitizedIconURL(url);
    const kind: ActivityKind =
      new ActivityKind(ActivityKindType.downloadFeedImage, sanitized);
    const owner: ActivityOwner = new ActivityOwner(ActivityOwnerKind.feedImageDownloader);
    const data: ArrayBuffer | undefined =
      ImageDownloader.shared.image(sanitized, owner, kind, feed.nameForDisplay);
    if (data !== undefined) {
      resultBlock(data, true);
      return;
    }
    const unfetchable: boolean =
      !sanitized.startsWith('http://') && !sanitized.startsWith('https://');
    if (unfetchable || ImageMetadataDatabase.shared.recentlyFailed(sanitized)) {
      resultBlock(undefined, true);
      return;
    }
    const waiting: Feed[] | undefined = this.waitingForFeedURLs.get(sanitized);
    if (waiting === undefined) {
      this.waitingForFeedURLs.set(sanitized, [feed]);
    } else if (waiting.indexOf(feed) < 0) {
      waiting.push(feed);
    }
    resultBlock(undefined, false);
  }

  private imageDidBecomeAvailable(url: string): void {
    const feeds: Feed[] | undefined = this.waitingForFeedURLs.get(url);
    if (feeds === undefined) {
      return;
    }
    // A single image URL may be shared by multiple feeds.
    this.waitingForFeedURLs.delete(url);
    for (const feed of feeds) {
      this.icon(feed);
    }
  }

  private htmlMetadataDidBecomeAvailable(url: string): void {
    // A homepage URL may be shared by multiple feeds.
    const feeds: Feed[] =
      this.feedsWaitingForHTMLMetadata.filter((feed: Feed) => feed.homePageURL === url);
    this.feedsWaitingForHTMLMetadata =
      this.feedsWaitingForHTMLMetadata.filter((feed: Feed) => feed.homePageURL !== url);
    for (const feed of feeds) {
      this.icon(feed);
    }
  }

  private postFeedIconDidBecomeAvailable(feed: Feed): void {
    for (const listener of this.listeners) {
      listener(feed);
    }
  }

  private static shouldIgnoreFeedIconURL(feed: Feed): boolean {
    return SpecialCase.urlStringContainSpecialCase(feed.url,
      FeedIconDownloader.feedURLSubstringsToIgnoreFeedIconURL);
  }

  /**
   * WordPress /wp-content/uploads/ URLs often carry query params pinning a 32x32 size;
   * dropping them yields a larger image.
   */
  private static sanitizedIconURL(url: string): string {
    if (url.indexOf('/wp-content/uploads/') < 0) {
      return url;
    }
    return strippingQueryAndFragment(url);
  }
}

// MARK: - IconImageCache (Shared/IconImageCache.swift)

/**
 * The per-sidebar-item icon cache the rows read. The downloaders are the source of truth
 * and are consulted ahead of the local dictionaries, so a newly arrived icon replaces a
 * stale one; the dictionaries keep the last known icons across the downloaders' flushes.
 * <https://github.com/Ranchero-Software/NetNewsWire/issues/5376>
 */
export class IconImageCache {
  static readonly shared: IconImageCache = new IconImageCache();

  private smartFeedIconImageCache: Map<string, IconImage> = new Map<string, IconImage>();
  private feedIconImageCache: Map<string, IconImage> = new Map<string, IconImage>();
  private faviconImageCache: Map<string, IconImage> = new Map<string, IconImage>();
  private authorIconImageCache: Map<string, IconImage> = new Map<string, IconImage>();

  /** NetNewsWire's own feeds always get the app's icon. */
  static isNetNewsWireBrandedFeed(feed: Feed): boolean {
    const homePageURL: string | undefined = feed.homePageURL;
    if (homePageURL !== undefined) {
      const host: string | undefined = hostOf(homePageURL);
      if (host !== undefined && (host === 'nnw.ranchero.com' || host === 'netnewswire.blog'
        || host.endsWith('netnewswire.com'))) {
        return true;
      }
    }
    return feed.url.startsWith('https://ranchero.com/downloads/netnewswire');
  }

  imageForFeed(feed: Feed): IconImage | undefined {
    if (IconImageCache.isNetNewsWireBrandedFeed(feed)) {
      return new IconImage(undefined, 'app_icon');
    }
    const key: string = feed.sidebarItemID.description();

    const feedIcon: IconImage | undefined = FeedIconDownloader.shared.cachedIcon(feed);
    if (feedIcon !== undefined) {
      this.feedIconImageCache.set(key, feedIcon);
      return feedIcon;
    }
    const cachedFeedIcon: IconImage | undefined = this.feedIconImageCache.get(key);
    if (cachedFeedIcon !== undefined) {
      return cachedFeedIcon;
    }
    const favicon: IconImage | undefined = FaviconDownloader.shared.cachedFaviconAsIcon(feed);
    if (favicon !== undefined) {
      this.faviconImageCache.set(key, favicon);
      return favicon;
    }
    return this.faviconImageCache.get(key);
  }

  imageForSmartFeed(sidebarItemID: SidebarItemIdentifier,
    smallIcon: IconImage): IconImage {
    const key: string = sidebarItemID.description();
    const cached: IconImage | undefined = this.smartFeedIconImageCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    this.smartFeedIconImageCache.set(key, smallIcon);
    return smallIcon;
  }

  imageForAuthor(author: Author): IconImage | undefined {
    const cached: IconImage | undefined = this.authorIconImageCache.get(author.authorID);
    if (cached !== undefined) {
      return cached;
    }
    const avatarURL: string | undefined = author.avatarURL;
    if (avatarURL === undefined) {
      return undefined;
    }
    const kind: ActivityKind = new ActivityKind(ActivityKindType.downloadAvatar, avatarURL);
    const owner: ActivityOwner = new ActivityOwner(ActivityOwnerKind.avatarDownloader);
    const data: ArrayBuffer | undefined =
      ImageDownloader.shared.image(avatarURL, owner, kind);
    if (data === undefined) {
      return undefined;
    }
    const iconImage: IconImage = new IconImage(avatarURL);
    this.authorIconImageCache.set(author.authorID, iconImage);
    return iconImage;
  }

  /** Warms the caches for a page of rows — the source's prefetch pass. */
  prefetchImagesForFeeds(feeds: Feed[]): void {
    for (const feed of feeds) {
      FeedIconDownloader.shared.icon(feed);
      FaviconDownloader.shared.faviconAsIcon(feed);
    }
  }

  emptyCache(): void {
    this.smartFeedIconImageCache.clear();
    this.feedIconImageCache.clear();
    this.faviconImageCache.clear();
    this.authorIconImageCache.clear();
    ImageDownloader.shared.emptyCache();
    FaviconDownloader.shared.emptyCache();
    FeedIconDownloader.shared.emptyCache();
  }

  /** ColorHash of the feed URL — the color a feed with no icon at all is drawn in. */
  static colorHashForFeed(feed: Feed): number {
    return new ColorHash(feed.url).colorValue;
  }
}
