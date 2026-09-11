/**
 * HTMLMetadata — port of:
 *   RSParser/HTML/HTMLMetadataParser.swift   collects <link>/<meta> from the <head>
 *   RSParser/HTML/HTMLMetadata.swift         categorizes them (favicons, apple-touch,
 *                                            feed links, OpenGraph, Twitter)
 *   RSParser/HTML/HTMLLinkParser.swift       every <a> in the document
 *   HTMLMetadata/HTMLMetadataDownloader.swift + HTMLMetadataDatabase.swift + Table.swift
 *
 * The 3-hour per-URL attempt floor, the 149-hour cache expiry, and the failure ledger
 * (11-day retry for a 4xx, 5-hour retry for a transient failure) are all carried over —
 * they are what stops the app hammering a homepage that has no favicon.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { HTMLMetadataRecord, Favicon, AppleTouchIcon, FeedLink, OpenGraphImage }
  from '../../model/HTMLMetadataRecord';
import { XmlHandler, XmlParser, decodeXmlBytes, attributeForCaseInsensitiveKey }
  from '../parser/XmlScan';
import { Database, Row, ValuesBucket } from '../db/Database';
import { resolveURL, SpecialCase } from '../util/Urls';
import { trimmingWhitespace } from '../util/Strings';
import { Downloader, UserAgentStyle, responseIsOK } from './DownloadSession';
import { DownloadResponse } from '../../model/DownloadResponse';
import { ActivityLog } from '../log/ActivityLog';
import { ActivityKind, ActivityKindType, ActivityOwner, ActivityOwnerKind }
  from '../../model/Activity';

const DOMAIN: number = 0x0001;
const TAG: string = 'HTMLMetadata';

// MARK: - Tag collection (HTMLMetadataParser.swift)

export enum HTMLTagType {
  link = 'link',
  meta = 'meta'
}

export class HTMLTag {
  readonly type: HTMLTagType;
  readonly attributes: Map<string, string>;

  constructor(type: HTMLTagType, attributes: Map<string, string>) {
    this.type = type;
    this.attributes = attributes;
  }
}

class MetadataParserDelegate implements XmlHandler {
  private readonly scanPastHead: boolean;
  private finished: boolean = false;
  readonly tags: HTMLTag[] = [];

  constructor(scanPastHead: boolean) {
    this.scanPastHead = scanPastHead;
  }

  startElement(localName: string, prefix: string | undefined,
    attributes: Map<string, string>, selfClosing: boolean): boolean {
    if (this.finished) {
      return false;
    }
    const name: string = localName.toLowerCase();

    if (!this.scanPastHead && name === 'body') {
      this.finished = true;
      return false;
    }

    if (name === 'link') {
      if (attributes.size === 0) {
        return false;
      }
      // Match the source: only collect <link> tags carrying both `rel` and href|src.
      const rel: string | undefined = attributeForCaseInsensitiveKey(attributes, 'rel');
      if (rel === undefined || rel.length === 0) {
        return false;
      }
      const href: string | undefined = attributeForCaseInsensitiveKey(attributes, 'href');
      const src: string | undefined = attributeForCaseInsensitiveKey(attributes, 'src');
      const link: string | undefined = href === undefined ? src : href;
      if (link === undefined || link.length === 0) {
        return false;
      }
      this.tags.push(new HTMLTag(HTMLTagType.link, attributes));
      return false;
    }

    if (name === 'meta' && attributes.size > 0) {
      this.tags.push(new HTMLTag(HTMLTagType.meta, attributes));
    }
    return false;
  }

  endElement(localName: string, prefix: string | undefined): void {
  }

  characters(text: string): void {
  }

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void {
  }
}

/** One `<a>` element harvested from an HTML document. Any field may be missing. */
export class HTMLLink {
  readonly urlString?: string;
  readonly text?: string;
  readonly title?: string;

  constructor(urlString?: string, text?: string, title?: string) {
    this.urlString = urlString;
    this.text = text;
    this.title = title;
  }
}

class LinkParserDelegate implements XmlHandler {
  private readonly baseURL: string;
  readonly links: HTMLLink[] = [];

  private collectingText: boolean = false;
  private pendingURLString?: string;
  private pendingTitle?: string;
  private pendingText: string = '';

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  startElement(localName: string, prefix: string | undefined,
    attributes: Map<string, string>, selfClosing: boolean): boolean {
    if (localName.toLowerCase() === 'a') {
      // A new <a> always starts a fresh pending link, flushing any still-open one.
      this.flushPending();
      const href: string | undefined = attributeForCaseInsensitiveKey(attributes, 'href');
      this.pendingURLString = href === undefined ? undefined : resolveURL(href, this.baseURL);
      this.pendingTitle = attributeForCaseInsensitiveKey(attributes, 'title');
      this.pendingText = '';
      this.collectingText = true;
      return false;
    }
    // A nested tag inside an anchor resets the text buffer, matching the libxml2 SAX
    // behavior the original parser was measured against: `<a>x<b>y</b></a>` yields "y".
    if (this.collectingText) {
      this.pendingText = '';
    }
    return false;
  }

  endElement(localName: string, prefix: string | undefined): void {
    if (localName.toLowerCase() === 'a' && this.collectingText) {
      this.flushPending();
    }
  }

  characters(text: string): void {
    if (this.collectingText) {
      this.pendingText += text;
    }
  }

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void {
  }

  flushPending(): void {
    if (!this.collectingText) {
      return;
    }
    const decoded: string = trimmingWhitespace(this.pendingText);
    this.links.push(new HTMLLink(this.pendingURLString,
      decoded.length === 0 ? undefined : decoded, this.pendingTitle));
    this.pendingURLString = undefined;
    this.pendingTitle = undefined;
    this.pendingText = '';
    this.collectingText = false;
  }
}

/** Every `<a>` in the document, with absolute URLs. */
export function htmlLinks(html: string, urlString: string): HTMLLink[] {
  const delegate: LinkParserDelegate = new LinkParserDelegate(urlString);
  new XmlParser(delegate).parse(html);
  delegate.flushPending();
  return delegate.links;
}

// MARK: - Categorization (HTMLMetadata.swift)

const FEED_TYPE_SUFFIXES: string[] = ['/rss+xml', '/atom+xml', '/json'];

function urlStringFrom(attributes: Map<string, string>): string | undefined {
  const href: string | undefined = attributeForCaseInsensitiveKey(attributes, 'href');
  return href === undefined ? attributeForCaseInsensitiveKey(attributes, 'src') : href;
}

function absoluteURLStringFrom(attributes: Map<string, string>,
  baseURLString: string): string | undefined {
  const relative: string | undefined = urlStringFrom(attributes);
  if (relative === undefined || relative.length === 0) {
    return undefined;
  }
  return resolveURL(relative, baseURLString);
}

function isFeedType(type: string): boolean {
  const lowered: string = type.toLowerCase();
  for (const suffix of FEED_TYPE_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function parsedSize(sizes?: string): number[] {
  if (sizes === undefined) {
    return [0, 0];
  }
  const parts: string[] = sizes.split('x');
  if (parts.length !== 2) {
    return [0, 0];
  }
  const width: number = Number.parseFloat(parts[0]);
  const height: number = Number.parseFloat(parts[1]);
  if (Number.isNaN(width) || Number.isNaN(height)) {
    return [0, 0];
  }
  return [width, height];
}

function resolveFavicons(tags: HTMLTag[], baseURLString: string): Favicon[] {
  const seen: Set<string> = new Set<string>();
  const result: Favicon[] = [];
  for (const tag of tags) {
    if (tag.type !== HTMLTagType.link) {
      continue;
    }
    const raw: string | undefined = urlStringFrom(tag.attributes);
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    const rel: string | undefined = attributeForCaseInsensitiveKey(tag.attributes, 'rel');
    if (rel === undefined) {
      continue;
    }
    let hasIconRel: boolean = false;
    for (const relValue of rel.split(/\s+/)) {
      if (relValue.toLowerCase() === 'icon') {
        hasIconRel = true;
        break;
      }
    }
    if (!hasIconRel) {
      continue;
    }
    const absolute: string | undefined = absoluteURLStringFrom(tag.attributes, baseURLString);
    if (absolute === undefined || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    const favicon: Favicon = {
      type: attributeForCaseInsensitiveKey(tag.attributes, 'type'),
      urlString: absolute
    };
    result.push(favicon);
  }
  return result;
}

function resolveAppleTouchIcons(tags: HTMLTag[], baseURLString: string): AppleTouchIcon[] {
  const result: AppleTouchIcon[] = [];
  for (const tag of tags) {
    if (tag.type !== HTMLTagType.link) {
      continue;
    }
    const relValue: string | undefined =
      attributeForCaseInsensitiveKey(tag.attributes, 'rel');
    const rel: string = relValue === undefined ? '' : relValue.toLowerCase();
    if (rel !== 'apple-touch-icon' && rel !== 'apple-touch-icon-precomposed') {
      continue;
    }
    const sizes: string | undefined = attributeForCaseInsensitiveKey(tag.attributes, 'sizes');
    const size: number[] = parsedSize(sizes);
    const icon: AppleTouchIcon = {
      rel: attributeForCaseInsensitiveKey(tag.attributes, 'rel'),
      sizes: sizes,
      width: size[0],
      height: size[1],
      urlString: absoluteURLStringFrom(tag.attributes, baseURLString)
    };
    result.push(icon);
  }
  return result;
}

function resolveFeedLinks(tags: HTMLTag[], baseURLString: string): FeedLink[] {
  const result: FeedLink[] = [];
  for (const tag of tags) {
    if (tag.type !== HTMLTagType.link) {
      continue;
    }
    const relValue: string | undefined =
      attributeForCaseInsensitiveKey(tag.attributes, 'rel');
    if (relValue === undefined || relValue.toLowerCase() !== 'alternate') {
      continue;
    }
    // Exclude rel="alternate" variants that are definitely not feeds — responsive-design
    // mobile links use `media=`, i18n variants use `hreflang=`.
    const media: string | undefined = attributeForCaseInsensitiveKey(tag.attributes, 'media');
    if (media !== undefined && media.length > 0) {
      continue;
    }
    const hreflang: string | undefined =
      attributeForCaseInsensitiveKey(tag.attributes, 'hreflang');
    if (hreflang !== undefined && hreflang.length > 0) {
      continue;
    }
    // Accept feed-typed AND typeless alternates; an explicit non-feed type is filtered out.
    const type: string | undefined = attributeForCaseInsensitiveKey(tag.attributes, 'type');
    if (type !== undefined && type.length > 0 && !isFeedType(type)) {
      continue;
    }
    const raw: string | undefined = urlStringFrom(tag.attributes);
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    // Require an http(s) or relative URL — skip android-app:// / ios-app:// alternates.
    const lower: string = raw.toLowerCase();
    const acceptable: boolean = lower.startsWith('http://') || lower.startsWith('https://')
      || lower.startsWith('/') || lower.startsWith('.') || lower.indexOf(':') < 0;
    if (!acceptable) {
      continue;
    }
    const feedLink: FeedLink = {
      title: attributeForCaseInsensitiveKey(tag.attributes, 'title'),
      type: type,
      urlString: absoluteURLStringFrom(tag.attributes, baseURLString)
    };
    result.push(feedLink);
  }
  return result;
}

function resolveOpenGraphImages(tags: HTMLTag[]): OpenGraphImage[] {
  const images: OpenGraphImage[] = [];

  const ensureIndex = (): number => {
    if (images.length === 0) {
      const image: OpenGraphImage = { width: 0, height: 0 };
      images.push(image);
    }
    return images.length - 1;
  };

  for (const tag of tags) {
    if (tag.type !== HTMLTagType.meta) {
      continue;
    }
    const propertyName: string | undefined = tag.attributes.get('property');
    if (propertyName === undefined || !propertyName.startsWith('og:')) {
      continue;
    }
    const content: string | undefined = tag.attributes.get('content');
    if (content === undefined) {
      continue;
    }
    if (propertyName === 'og:image') {
      // Most likely case: og:image starts a fresh image entry.
      if (images.length > 0 && images[images.length - 1].url === undefined) {
        images[images.length - 1].url = content;
      } else {
        const image: OpenGraphImage = { width: 0, height: 0, url: content };
        images.push(image);
      }
    } else if (propertyName === 'og:image:url') {
      images[ensureIndex()].url = content;
    } else if (propertyName === 'og:image:secure_url') {
      images[ensureIndex()].secureURL = content;
    } else if (propertyName === 'og:image:type') {
      images[ensureIndex()].mimeType = content;
    } else if (propertyName === 'og:image:alt') {
      images[ensureIndex()].altText = content;
    } else if (propertyName === 'og:image:width') {
      const value: number = Number.parseFloat(content);
      images[ensureIndex()].width = Number.isNaN(value) ? 0 : value;
    } else if (propertyName === 'og:image:height') {
      const value: number = Number.parseFloat(content);
      images[ensureIndex()].height = Number.isNaN(value) ? 0 : value;
    }
  }
  return images;
}

function resolveTwitterImageURL(tags: HTMLTag[]): string | undefined {
  for (const tag of tags) {
    if (tag.type !== HTMLTagType.meta) {
      continue;
    }
    if (tag.attributes.get('name') !== 'twitter:image:src') {
      continue;
    }
    const content: string | undefined = tag.attributes.get('content');
    if (content !== undefined && content.length > 0) {
      return content;
    }
  }
  return undefined;
}

/**
 * Scrapes an HTML page into the record the icon and feed-finder services read. Scanning
 * stops at `<body>` — except for YouTube URLs, which put feed-link tags in the body.
 */
export function htmlMetadata(html: string, urlString: string): HTMLMetadataRecord {
  const scanPastHead: boolean = urlString.toLowerCase().indexOf('youtube') >= 0;
  const delegate: MetadataParserDelegate = new MetadataParserDelegate(scanPastHead);
  new XmlParser(delegate).parse(html);
  const tags: HTMLTag[] = delegate.tags;
  const record: HTMLMetadataRecord = {
    url: urlString,
    favicons: resolveFavicons(tags, urlString),
    appleTouchIcons: resolveAppleTouchIcons(tags, urlString),
    feedLinks: resolveFeedLinks(tags, urlString),
    openGraphImages: resolveOpenGraphImages(tags),
    twitterImageURL: resolveTwitterImageURL(tags)
  };
  return record;
}

// MARK: - Cache database (HTMLMetadataDatabase.swift + HTMLMetadataTable.swift)

const METADATA_TABLE: string = 'metadata';

const CREATE_STATEMENTS: string[] = [
  'CREATE TABLE IF NOT EXISTS metadata (url TEXT PRIMARY KEY NOT NULL,'
    + ' lastChecked REAL NOT NULL, statusCode INTEGER NOT NULL DEFAULT 200, favicons TEXT,'
    + ' appleTouchIcons TEXT, feedLinks TEXT, openGraphImages TEXT, twitterImageURL TEXT);'
];

class CachedRecord {
  readonly record?: HTMLMetadataRecord;
  readonly lastChecked: Date;
  readonly statusCode: number;

  constructor(record: HTMLMetadataRecord | undefined, lastChecked: Date, statusCode: number) {
    this.record = record;
    this.lastChecked = lastChecked;
    this.statusCode = statusCode;
  }

  /** The last contact returned a 4xx. */
  get isPersistentFailure(): boolean {
    return this.statusCode >= 400 && this.statusCode <= 499;
  }

  /** The last contact failed before getting a response (DNS, TLS, network). */
  get isTransientFailure(): boolean {
    return this.statusCode === 0;
  }

  get isFailure(): boolean {
    return this.isPersistentFailure || this.isTransientFailure;
  }
}

function jsonOrNull(values: Object[]): string | null {
  return values.length === 0 ? null : JSON.stringify(values);
}

function decodedArray<T>(json?: string): T[] {
  if (json === undefined || json.length === 0) {
    return [];
  }
  try {
    const parsed: Object = JSON.parse(json) as Object;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (e) {
    return [];
  }
}

export class HTMLMetadataDatabase {
  static readonly shared: HTMLMetadataDatabase = new HTMLMetadataDatabase();

  /** 149 hours — a prime number close to 6 days. */
  private static readonly cacheExpirationHours: number = 149;
  private static readonly maximumDaysWithoutCheck: number = 30;
  private static readonly persistentFailureRetryDays: number = 11;
  private static readonly transientFailureRetryHours: number = 5;

  private readonly database: Database = new Database('HTMLMetadata.db');
  private cache: Map<string, CachedRecord> = new Map<string, CachedRecord>();

  async open(): Promise<void> {
    if (this.database.isOpen()) {
      return;
    }
    await this.database.open(CREATE_STATEMENTS);
    await this.removeExpiredEntries();
    await this.database.vacuum();
  }

  async vacuum(): Promise<void> {
    await this.database.vacuum();
  }

  emptyCache(): void {
    this.cache.clear();
  }

  /** A non-expired success record, or undefined. */
  async cachedRecord(url: string): Promise<HTMLMetadataRecord | undefined> {
    const cached: CachedRecord | undefined = await this.cachedOrFetched(url);
    if (cached === undefined || cached.isFailure || cached.record === undefined) {
      return undefined;
    }
    const ageMillis: number = Date.now() - cached.lastChecked.getTime();
    if (ageMillis >= HTMLMetadataDatabase.cacheExpirationHours * 60 * 60 * 1000) {
      return undefined;
    }
    return cached.record;
  }

  /** A success record regardless of expiration — the stale fallback after a failed fetch. */
  async staleCachedRecord(url: string): Promise<HTMLMetadataRecord | undefined> {
    const cached: CachedRecord | undefined = await this.cachedOrFetched(url);
    if (cached === undefined || cached.isFailure) {
      return undefined;
    }
    return cached.record;
  }

  /** When metadata was last downloaded successfully for this URL. */
  async lastDownloadDate(url: string): Promise<Date | undefined> {
    const cached: CachedRecord | undefined = await this.cachedOrFetched(url);
    if (cached === undefined || cached.isFailure || cached.record === undefined) {
      return undefined;
    }
    return cached.lastChecked;
  }

  /** True when the last contact failed recently (4xx or transient). */
  async recentlyFailed(url: string): Promise<boolean> {
    const cached: CachedRecord | undefined = await this.cachedOrFetched(url);
    if (cached === undefined) {
      return false;
    }
    const ageMillis: number = Date.now() - cached.lastChecked.getTime();
    if (cached.isPersistentFailure) {
      return ageMillis < HTMLMetadataDatabase.persistentFailureRetryDays * 24 * 60 * 60 * 1000;
    }
    if (cached.isTransientFailure) {
      return ageMillis < HTMLMetadataDatabase.transientFailureRetryHours * 60 * 60 * 1000;
    }
    return false;
  }

  async save(record: HTMLMetadataRecord, statusCode: number): Promise<void> {
    this.cache.set(record.url, new CachedRecord(record, new Date(), statusCode));
    const twitterImageURL: string | undefined = record.twitterImageURL;
    const row: ValuesBucket = {
      'url': record.url,
      'lastChecked': Date.now() / 1000,
      'statusCode': statusCode,
      'favicons': jsonOrNull(record.favicons),
      'appleTouchIcons': jsonOrNull(record.appleTouchIcons),
      'feedLinks': jsonOrNull(record.feedLinks),
      'openGraphImages': jsonOrNull(record.openGraphImages),
      'twitterImageURL': twitterImageURL === undefined ? null : twitterImageURL
    };
    await this.database.insert(METADATA_TABLE, row, true);
  }

  /** Records a failure outcome. Accepts both 4xx and transient (statusCode 0). */
  async noteFailure(url: string, statusCode: number): Promise<void> {
    const existing: CachedRecord | undefined = this.cache.get(url);
    if (existing === undefined || existing.isFailure) {
      this.cache.set(url, new CachedRecord(undefined, new Date(), statusCode));
    }
    // The WHERE guard preserves rows with a 2xx success.
    await this.database.execute('INSERT INTO ' + METADATA_TABLE
      + ' (url, lastChecked, statusCode) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET'
      + ' lastChecked = excluded.lastChecked, statusCode = excluded.statusCode'
      + ' WHERE statusCode >= 400 OR statusCode = 0;',
      [url, Date.now() / 1000, statusCode]);
  }

  /** Records a pre-response failure (DNS, TLS, network). */
  async noteTransientFailure(url: string): Promise<void> {
    await this.noteFailure(url, 0);
  }

  async removeExpiredEntries(): Promise<void> {
    const cutoff: number = Date.now() / 1000
      - HTMLMetadataDatabase.maximumDaysWithoutCheck * 24 * 60 * 60;
    await this.database.execute('DELETE FROM ' + METADATA_TABLE + ' WHERE lastChecked < ?;',
      [cutoff]);
  }

  private async cachedOrFetched(url: string): Promise<CachedRecord | undefined> {
    const cached: CachedRecord | undefined = this.cache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    if (!this.database.isOpen()) {
      await this.open();
    }
    const rows: Row[] = await this.database.query(
      'SELECT * FROM ' + METADATA_TABLE + ' WHERE url = ?;', [url]);
    if (rows.length === 0) {
      return undefined;
    }
    const row: Row = rows[0];
    const rowURL: string | undefined = row.getString('url');
    if (rowURL === undefined) {
      return undefined;
    }
    const record: HTMLMetadataRecord = {
      url: rowURL,
      favicons: decodedArray<Favicon>(row.getString('favicons')),
      appleTouchIcons: decodedArray<AppleTouchIcon>(row.getString('appleTouchIcons')),
      feedLinks: decodedArray<FeedLink>(row.getString('feedLinks')),
      openGraphImages: decodedArray<OpenGraphImage>(row.getString('openGraphImages')),
      twitterImageURL: row.getString('twitterImageURL')
    };
    const lastChecked: Date | undefined = row.getDate('lastChecked');
    const fetched: CachedRecord = new CachedRecord(record,
      lastChecked === undefined ? new Date(0) : lastChecked,
      row.getNumberOrZero('statusCode'));
    this.cache.set(url, fetched);
    return fetched;
  }
}

// MARK: - Downloader (HTMLMetadataDownloader.swift)

export type MetadataAvailableListener = (record: HTMLMetadataRecord) => void;

export class HTMLMetadataDownloader {
  static readonly shared: HTMLMetadataDownloader = new HTMLMetadataDownloader();

  private static readonly hoursBetweenAttempts: number = 3;
  private static readonly specialCasesToSkip: string[] =
    [SpecialCase.rachelByTheBayHostName, SpecialCase.openRSSOrgHostName];

  private attemptDates: Map<string, Date> = new Map<string, Date>();
  /** In-memory mirror so `cachedMetadata` can answer synchronously. */
  private cache: Map<string, HTMLMetadataRecord> = new Map<string, HTMLMetadataRecord>();
  private listeners: MetadataAvailableListener[] = [];

  addListener(listener: MetadataAvailableListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: MetadataAvailableListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  emptyCache(): void {
    this.cache.clear();
  }

  /**
   * Cached metadata synchronously, or undefined after kicking off a fetch. Callers
   * re-query when the listener fires — the same contract as `.htmlMetadataAvailable`.
   */
  cachedMetadata(url: string): HTMLMetadataRecord | undefined {
    if (SpecialCase.urlStringContainSpecialCase(url,
      HTMLMetadataDownloader.specialCasesToSkip)) {
      return undefined;
    }
    const record: HTMLMetadataRecord | undefined = this.cache.get(url);
    if (record !== undefined) {
      return record;
    }
    this.fetchAndDownloadIfNeeded(url);
    return undefined;
  }

  private fetchAndDownloadIfNeeded(url: string): void {
    this.fetchAndDownload(url).catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'metadata fetch failed: %{public}s', String(e));
    });
  }

  private async fetchAndDownload(url: string): Promise<void> {
    const cached: HTMLMetadataRecord | undefined =
      await HTMLMetadataDatabase.shared.cachedRecord(url);
    if (cached !== undefined) {
      this.cacheRecord(cached);
      this.postAvailable(cached);
      return;
    }
    if (await HTMLMetadataDatabase.shared.recentlyFailed(url)) {
      return;
    }
    // The 3-hour per-URL attempt floor.
    const attemptDate: Date | undefined = this.attemptDates.get(url);
    if (attemptDate !== undefined
      && Date.now() - attemptDate.getTime()
        < HTMLMetadataDownloader.hoursBetweenAttempts * 60 * 60 * 1000) {
      return;
    }
    this.attemptDates.set(url, new Date());
    await this.downloadMetadata(url);
  }

  private async downloadMetadata(url: string): Promise<void> {
    const activityLog: ActivityLog = ActivityLog.shared;
    const kind: ActivityKind = new ActivityKind(ActivityKindType.downloadHTMLMetadata, url);
    const owner: ActivityOwner =
      new ActivityOwner(ActivityOwnerKind.htmlMetadataDownloader);
    const activityID: number = activityLog.createActivity(owner, kind);
    activityLog.didStartWithID(activityID);

    try {
      const response: DownloadResponse =
        await Downloader.shared.download(url, UserAgentStyle.browser);
      const data: ArrayBuffer | undefined = response.data;

      if (data !== undefined && data.byteLength > 0 && responseIsOK(response)) {
        const record: HTMLMetadataRecord = htmlMetadata(decodeXmlBytes(data), url);
        const statusCode: number =
          response.statusCode === undefined ? 200 : response.statusCode;
        await HTMLMetadataDatabase.shared.save(record, statusCode);
        this.cacheRecord(record);
        this.postAvailable(record);
        activityLog.didCompleteWithID(activityID,
          ActivityLog.dataSizeMessage(data.byteLength), !response.returnedFromCache,
          response.returnedFromCache);
        return;
      }

      const statusCode: number = response.statusCode === undefined ? -1 : response.statusCode;
      if (statusCode >= 400 && statusCode <= 499) {
        await HTMLMetadataDatabase.shared.noteFailure(url, statusCode);
      }
      // Download failed — try returning stale cached data.
      await this.returnStaleCacheIfAvailable(url);
      activityLog.didFailWithID(activityID, new Error('HTTP ' + statusCode));
    } catch (e) {
      // Pre-response failure (DNS, TLS, network).
      await HTMLMetadataDatabase.shared.noteTransientFailure(url);
      await this.returnStaleCacheIfAvailable(url);
      activityLog.didFailWithID(activityID, e as Error);
    }
  }

  private async returnStaleCacheIfAvailable(url: string): Promise<void> {
    const record: HTMLMetadataRecord | undefined =
      await HTMLMetadataDatabase.shared.staleCachedRecord(url);
    if (record !== undefined) {
      this.cacheRecord(record);
      this.postAvailable(record);
    }
  }

  private cacheRecord(record: HTMLMetadataRecord): void {
    this.cache.set(record.url, record);
  }

  private postAvailable(record: HTMLMetadataRecord): void {
    for (const listener of this.listeners) {
      listener(record);
    }
  }
}
