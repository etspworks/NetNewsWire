/**
 * ReaderAPIEntry — port of Modules/Account/Sources/Account/ReaderAPI/ReaderAPIEntry.swift
 *
 * The Google-Reader-compatible entry shape (FreshRSS, Inoreader, BazQux, The Old Reader),
 * plus the wrapper and the itemRefs/continuation types from ReaderAPIUnreadEntry.swift.
 *
 * uniqueIDForEntry() reproduces the source's ID rule exactly: take the last path component
 * of "tag:google.com,2005:reader/item/00058b10ce338909", and — except on The Old Reader —
 * reinterpret that hex as a decimal string.
 */

export interface ReaderAPIArticleSummary {
  content?: string;
}

export interface ReaderAPIAlternateLocationWire {
  href?: string;
}

export interface ReaderAPIAlternateLocation {
  url?: string;
}

export interface ReaderAPIEntryOrigin {
  streamId?: string;
  title?: string;
}

export interface ReaderAPIEntryWire {
  id: string;
  title?: string;
  author?: string;
  summary: ReaderAPIArticleSummary;
  alternate?: ReaderAPIAlternateLocationWire[];
  categories: string[];
  published?: number;
  crawlTimeMsec?: string;
  timestampUsec?: string;
  origin: ReaderAPIEntryOrigin;
}

export interface ReaderAPIEntry {
  articleID: string;
  title?: string;
  author?: string;
  publishedTimestamp?: number;
  crawledTimestamp?: string;
  timestampUsec?: string;
  summary: ReaderAPIArticleSummary;
  alternates?: ReaderAPIAlternateLocation[];
  categories: string[];
  origin: ReaderAPIEntryOrigin;
}

export function readerAPIEntryFromJSON(wire: ReaderAPIEntryWire): ReaderAPIEntry {
  let alternates: ReaderAPIAlternateLocation[] | undefined = undefined;
  const alternateWires: ReaderAPIAlternateLocationWire[] | undefined = wire.alternate;
  if (alternateWires !== undefined) {
    alternates = [];
    for (const alternateWire of alternateWires) {
      const alternate: ReaderAPIAlternateLocation = { url: alternateWire.href };
      alternates.push(alternate);
    }
  }
  const entry: ReaderAPIEntry = {
    articleID: wire.id,
    title: wire.title,
    author: wire.author,
    publishedTimestamp: wire.published,
    crawledTimestamp: wire.crawlTimeMsec,
    timestampUsec: wire.timestampUsec,
    summary: wire.summary,
    alternates: alternates,
    categories: wire.categories,
    origin: wire.origin
  };
  return entry;
}

export function readerAPIEntryDatePublished(entry: ReaderAPIEntry): Date | undefined {
  const unixTime: number | undefined = entry.publishedTimestamp;
  return unixTime === undefined ? undefined : new Date(unixTime * 1000);
}

/** The Old Reader keeps the raw ID part; every other variant converts hex to decimal. */
export function uniqueIDForEntry(articleID: string, isTheOldReader: boolean): string {
  const components: string[] = articleID.split('/');
  if (components.length === 0) {
    return articleID;
  }
  const idPart: string = components[components.length - 1];
  if (isTheOldReader) {
    return idPart;
  }
  const idNumber: number = Number.parseInt(idPart, 16);
  if (Number.isNaN(idNumber)) {
    return articleID;
  }
  return idNumber.toString(10);
}

export interface ReaderAPIEntryWrapperWire {
  id: string;
  updated: number;
  items: ReaderAPIEntryWire[];
}

/** GET /stream/items/ids — article-ID pages with a continuation cursor. */
export interface ReaderAPIReferenceWire {
  id?: string;
}

export interface ReaderAPIReferenceWrapperWire {
  itemRefs?: ReaderAPIReferenceWire[];
  continuation?: string;
}
