/**
 * FeedParser — port of the RSParser feed parsers:
 *   Feeds/FeedParser.swift           format dispatch
 *   Feeds/FeedType.swift             + Data+ProbablyFormat.swift  format sniffing
 *   Feeds/XML/RSSParser.swift        RSS 2.0 / RSS 1.0 (RDF)
 *   Feeds/XML/AtomParser.swift       Atom
 *   Feeds/XML/RSSItem.swift          the shared item, incl. the MD5 uniqueID rule
 *   Feeds/JSON/JSONFeedParser.swift  JSON Feed 1.1
 *   Feeds/JSON/RSSInJSONParser.swift RSS-in-JSON
 *
 * The uniqueID fallback hashes a seed with MD5 — "Don't change this without a super-good
 * reason! It would mean article IDs would no longer match, and people would have many
 * duplicates." Kept byte-for-byte.
 */

import { FeedType, minNumberOfBytesRequired } from '../../model/FeedType';
import { ParsedFeed } from '../../model/ParsedFeed';
import { ParsedItem } from '../../model/ParsedItem';
import { ParsedAuthor } from '../../model/ParsedAuthor';
import { ParsedAttachment, makeParsedAttachment } from '../../model/ParsedAttachment';
import { ParsedHub } from '../../model/ParsedHub';
import { md5String, md5OfBytes } from '../util/Hashing';
import { parseDate } from '../util/DateParser';
import { decodingHTMLEntities } from '../util/Strings';
import { resolveURL } from '../util/Urls';
import { JsonObject, parseJsonObject, getString, getBoolean, getNumber, getObject,
  getObjectArray, getStringArray, getStringOrNumberAsString } from '../util/Json';
import { XmlHandler, XmlParser, decodeXmlBytes, attributeForCaseInsensitiveKey }
  from './XmlScan';

/** Bytes to parse plus the URL they came from — RSParser's ParserData. */
export class ParserData {
  readonly url: string;
  readonly data: ArrayBuffer;

  constructor(url: string, data: ArrayBuffer) {
    this.url = url;
    this.data = data;
  }
}

// MARK: - Format sniffing (Data+ProbablyFormat.swift)

/** ASCII view of the first bytes, for the byte-level format heuristics. */
function asciiOf(data: ArrayBuffer, limit: number): string {
  const bytes: Uint8Array = new Uint8Array(data);
  const count: number = Math.min(bytes.length, limit);
  let s: string = '';
  for (let i: number = 0; i < count; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function startsWithASCII(ascii: string, needle: string): boolean {
  let i: number = 0;
  while (i < ascii.length) {
    const c: string = ascii.charAt(i);
    if (c === ' ' || c === '\r' || c === '\n' || c === '\t') {
      i += 1;
      continue;
    }
    if (c === needle.charAt(0)) {
      return ascii.startsWith(needle, i);
    }
    // Allow a BOM of up to four bytes at the very start.
    if (i < 4) {
      i += 1;
      continue;
    }
    return false;
  }
  return false;
}

/** Sniffs the feed format the same way the source does, on the same byte thresholds. */
export function feedType(parserData: ParserData, isPartialData: boolean = false): FeedType {
  if (parserData.data.byteLength < minNumberOfBytesRequired) {
    return FeedType.unknown;
  }
  // The markers all appear near the top of a feed; 64 KB is more than enough and keeps
  // the ASCII copy bounded for a large feed.
  const ascii: string = asciiOf(parserData.data, 65536);
  const isProbablyJSON: boolean = startsWithASCII(ascii, '{');

  if (isProbablyJSON
    && (ascii.indexOf('://jsonfeed.org/version/') >= 0
      || ascii.indexOf(':\\/\\/jsonfeed.org\\/version\\/') >= 0)) {
    return FeedType.jsonFeed;
  }
  if (isProbablyJSON && ascii.indexOf('rss') >= 0 && ascii.indexOf('channel') >= 0
    && ascii.indexOf('item') >= 0) {
    return FeedType.rssInJSON;
  }
  if (ascii.indexOf('<rss') >= 0 || ascii.indexOf('<rdf:RDF') >= 0
    || (ascii.indexOf('<channel>') >= 0 && ascii.indexOf('<pubDate>') >= 0)) {
    return FeedType.rss;
  }
  if (ascii.indexOf('<feed') >= 0) {
    return FeedType.atom;
  }
  if (isPartialData && isProbablyJSON) {
    // A JSON Feed's version marker can appear at the very end of the document.
    return FeedType.unknown;
  }
  return FeedType.notAFeed;
}

export function canParse(parserData: ParserData): boolean {
  const type: FeedType = feedType(parserData);
  return type === FeedType.jsonFeed || type === FeedType.rssInJSON
    || type === FeedType.rss || type === FeedType.atom;
}

export function mightBeAbleToParseBasedOnPartialData(parserData: ParserData): boolean {
  const type: FeedType = feedType(parserData, true);
  return type === FeedType.jsonFeed || type === FeedType.rssInJSON
    || type === FeedType.rss || type === FeedType.atom || type === FeedType.unknown;
}

/** Parses any supported feed format. Returns undefined when the data is not a feed. */
export function parseFeed(parserData: ParserData): ParsedFeed | undefined {
  const type: FeedType = feedType(parserData);
  if (type === FeedType.jsonFeed) {
    return parseJSONFeed(parserData);
  }
  if (type === FeedType.rssInJSON) {
    return parseRSSInJSON(parserData);
  }
  if (type === FeedType.rss) {
    return parseRSS(parserData);
  }
  if (type === FeedType.atom) {
    return parseAtom(parserData);
  }
  return undefined;
}

// MARK: - RSSItem (Feeds/XML/RSSItem.swift)

/** The mutable item both XML parsers build; converted to a ParsedItem at the end. */
class RSSItem {
  guid?: string;
  title?: string;
  body?: string;
  summary?: string;
  markdown?: string;
  /** External link. */
  link?: string;
  /** URL of the item itself. */
  permalink?: string;
  language?: string;
  datePublished?: Date;
  dateModified?: Date;
  authors: ParsedAuthor[] = [];
  attachments: ParsedAttachment[] = [];

  /** guid when present; otherwise the MD5 of the source's exact seed order. */
  get uniqueID(): string {
    const guid: string | undefined = this.guid;
    if (guid !== undefined && guid.length > 0) {
      return guid;
    }
    let datePublishedString: string | undefined = undefined;
    if (this.datePublished !== undefined) {
      datePublishedString = Math.round(this.datePublished.getTime() / 1000).toString();
    }

    let s: string = '';
    if (this.permalink !== undefined && this.permalink.length > 0
      && datePublishedString !== undefined) {
      s = this.permalink + datePublishedString;
    } else if (this.link !== undefined && this.link.length > 0
      && datePublishedString !== undefined) {
      s = this.link + datePublishedString;
    } else if (this.title !== undefined && this.title.length > 0
      && datePublishedString !== undefined) {
      s = this.title + datePublishedString;
    } else if (datePublishedString !== undefined) {
      s = datePublishedString;
    } else if (this.permalink !== undefined && this.permalink.length > 0) {
      s = this.permalink;
    } else if (this.link !== undefined && this.link.length > 0) {
      s = this.link;
    } else if (this.title !== undefined && this.title.length > 0) {
      s = this.title;
    } else if (this.body !== undefined && this.body.length > 0) {
      s = this.body;
    }
    return md5String(s);
  }

  toParsedItem(feedURL: string): ParsedItem {
    // An empty body with a non-empty summary promotes the summary and drops it.
    let contentHTML: string | undefined = this.body;
    let itemSummary: string | undefined = this.summary;
    if ((contentHTML === undefined || contentHTML.length === 0)
      && itemSummary !== undefined && itemSummary.length > 0) {
      contentHTML = itemSummary;
      itemSummary = undefined;
    }
    const item: ParsedItem = {
      syncServiceID: undefined,
      uniqueID: this.uniqueID,
      feedURL: feedURL,
      url: this.permalink,
      externalURL: this.link,
      title: this.title,
      language: this.language,
      contentHTML: contentHTML,
      contentText: undefined,
      markdown: this.markdown,
      summary: itemSummary,
      imageURL: undefined,
      bannerImageURL: undefined,
      datePublished: this.datePublished,
      dateModified: this.dateModified,
      authors: this.authors.length === 0 ? undefined : this.authors,
      tags: undefined,
      attachments: this.attachments.length === 0 ? undefined : this.attachments
    };
    return item;
  }
}

/** RSS authors are supposed to be email addresses but often aren't — classify by content. */
function authorFromSingleString(s: string): ParsedAuthor {
  if (s.indexOf('@') >= 0) {
    const author: ParsedAuthor = { emailAddress: s };
    return author;
  }
  if (s.toLowerCase().startsWith('http')) {
    const author: ParsedAuthor = { url: s };
    return author;
  }
  const author: ParsedAuthor = { name: s };
  return author;
}

// MARK: - RSS (Feeds/XML/RSSParser.swift)

class RSSDelegate implements XmlHandler {
  private readonly feedURLString: string;
  private readonly parser: XmlParser;

  private title?: string;
  private homepageURLString?: string;
  private language?: string;
  private channelImageURLString?: string;
  private isRDF: boolean = false;
  private endRSSFound: boolean = false;

  private items: RSSItem[] = [];
  private parsingArticle: boolean = false;
  private parsingAuthor: boolean = false;
  private parsingChannelImage: boolean = false;
  private currentAttributes: Map<string, string> = new Map<string, string>();
  private namespaceElementDepth: number = 0;

  constructor(urlString: string) {
    this.feedURLString = urlString;
    this.parser = new XmlParser(this);
  }

  parse(text: string): ParsedFeed {
    this.parser.parse(text);
    return this.buildParsedFeed();
  }

  private buildParsedFeed(): ParsedFeed {
    const parsedItems: ParsedItem[] = [];
    for (const item of this.items) {
      parsedItems.push(item.toParsedItem(this.feedURLString));
    }
    const feed: ParsedFeed = {
      type: FeedType.rss,
      title: this.title,
      homePageURL: this.homepageURLString,
      feedURL: this.feedURLString,
      language: this.language,
      feedDescription: undefined,
      nextURL: undefined,
      iconURL: this.channelImageURLString,
      faviconURL: undefined,
      authors: undefined,
      expired: false,
      hubs: undefined,
      items: parsedItems
    };
    return feed;
  }

  private get currentItem(): RSSItem | undefined {
    return this.items.length === 0 ? undefined : this.items[this.items.length - 1];
  }

  startElement(localName: string, prefix: string | undefined,
    attributes: Map<string, string>, selfClosing: boolean): boolean {
    if (this.endRSSFound) {
      return false;
    }
    const isUnprefixed: boolean = prefix === undefined;

    if (this.namespaceElementDepth > 0) {
      this.namespaceElementDepth += 1;
      return false;
    }
    if (this.parsingArticle && prefix !== undefined && !RSSDelegate.isDublinCore(prefix)
      && !RSSDelegate.isContent(prefix) && !RSSDelegate.isSource(prefix)) {
      // Skip an element in an unexpected namespace and its whole subtree, so a nested
      // unprefixed <title> can't be mistaken for one of the item's own elements.
      this.namespaceElementDepth = 1;
      return false;
    }

    // The RDF root is always prefixed in practice (`<rdf:RDF>`), so only the local name
    // matters — an isUnprefixed guard here silently broke every RSS 1.0 feed.
    if (localName === 'RDF') {
      this.isRDF = true;
      return false;
    }

    if ((this.isRDF && localName === 'item') || localName === 'guid'
      || localName === 'enclosure') {
      this.currentAttributes = attributes;
    } else {
      this.currentAttributes = new Map<string, string>();
    }

    if (isUnprefixed && localName === 'item') {
      this.items.push(new RSSItem());
      this.parsingArticle = true;
      if (this.isRDF) {
        const about: string | undefined = this.currentAttributes.get('rdf:about');
        if (about !== undefined && about.length > 0) {
          const item: RSSItem | undefined = this.currentItem;
          if (item !== undefined) {
            item.guid = about;
            item.permalink = about;
          }
        }
      }
    } else if (isUnprefixed && localName === 'image') {
      this.parsingChannelImage = true;
    } else if (isUnprefixed && localName === 'author') {
      if (this.parsingArticle) {
        this.parsingAuthor = true;
      }
    }

    if (!this.parsingChannelImage) {
      this.parser.beginStoringCharacters();
    } else if (isUnprefixed && localName === 'url') {
      this.parser.beginStoringCharacters();
    }
    return false;
  }

  endElement(localName: string, prefix: string | undefined): void {
    if (this.endRSSFound) {
      return;
    }
    const isUnprefixed: boolean = prefix === undefined;

    if (this.namespaceElementDepth > 0) {
      this.namespaceElementDepth -= 1;
      return;
    }
    if (this.isRDF && localName === 'RDF') {
      this.endRSSFound = true;
      return;
    }
    if (isUnprefixed && localName === 'rss') {
      this.endRSSFound = true;
      return;
    }
    if (this.parsingChannelImage && !this.parsingArticle && isUnprefixed
      && localName === 'url') {
      this.channelImageURLString = this.parser.currentStringWithTrimmedWhitespace();
      return;
    }
    if (isUnprefixed && localName === 'image') {
      this.parsingChannelImage = false;
      return;
    }
    if (isUnprefixed && localName === 'item') {
      this.parsingArticle = false;
      return;
    }
    if (this.parsingArticle) {
      this.handleArticleElementEnd(localName, prefix);
      if (isUnprefixed && localName === 'author') {
        this.parsingAuthor = false;
      }
      return;
    }
    if (!this.parsingChannelImage) {
      this.handleFeedElementEnd(localName, prefix);
    }
  }

  characters(text: string): void {
    // Accumulation is handled by XmlParser's character buffer.
  }

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void {
    // RSS never requests raw capture.
  }

  private static isDublinCore(prefix: string): boolean {
    return prefix === 'dc';
  }

  private static isContent(prefix: string): boolean {
    return prefix === 'content';
  }

  private static isSource(prefix: string): boolean {
    return prefix === 'source';
  }

  private handleArticleElementEnd(localName: string, prefix: string | undefined): void {
    const article: RSSItem | undefined = this.currentItem;
    if (article === undefined) {
      return;
    }

    if (prefix !== undefined) {
      if (RSSDelegate.isDublinCore(prefix)) {
        if (localName === 'creator') {
          this.addAuthor(article, this.parser.currentStringWithTrimmedWhitespace());
        } else if (localName === 'date') {
          article.datePublished = parseDate(this.parser.currentCharacters());
        }
        return;
      }
      if (RSSDelegate.isContent(prefix) && localName === 'encoded') {
        const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
        if (s !== undefined && s.length > 0) {
          article.body = s;
        }
        return;
      }
      // `source:markdown` — scripting.com's namespace, used by WordLand-generated feeds.
      if (RSSDelegate.isSource(prefix) && localName === 'markdown') {
        article.markdown = this.parser.currentStringWithTrimmedWhitespace();
      }
      return;
    }

    if (localName === 'guid') {
      this.handleGuid(article);
    } else if (localName === 'pubDate') {
      article.datePublished = parseDate(this.parser.currentCharacters());
    } else if (localName === 'author') {
      this.addAuthor(article, this.parser.currentStringWithTrimmedWhitespace());
    } else if (localName === 'link') {
      if (article.link === undefined) {
        const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
        if (s !== undefined && s.length > 0) {
          article.link = this.resolve(s);
        }
      }
    } else if (localName === 'description') {
      if (article.body === undefined) {
        article.body = this.parser.currentStringWithTrimmedWhitespace();
      }
    } else if (!this.parsingAuthor && localName === 'title') {
      const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
      if (s !== undefined) {
        article.title = s;
      }
    } else if (localName === 'enclosure') {
      this.handleEnclosure(article);
    }
  }

  private handleGuid(article: RSSItem): void {
    const guid: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
    if (guid === undefined) {
      return;
    }
    article.guid = guid;
    const isPermaLinkValue: string | undefined =
      attributeForCaseInsensitiveKey(this.currentAttributes, 'ispermalink');
    if (isPermaLinkValue === undefined || isPermaLinkValue.toLowerCase() !== 'false') {
      if (RSSDelegate.stringIsProbablyURLOrRelativePath(guid)) {
        article.permalink = this.resolve(guid);
      }
    }
  }

  private handleEnclosure(article: RSSItem): void {
    const enclosureURL: string | undefined = this.currentAttributes.get('url');
    if (enclosureURL === undefined || enclosureURL.length === 0) {
      return;
    }
    const lengthString: string | undefined = this.currentAttributes.get('length');
    const length: number = lengthString === undefined
      ? 0
      : (Number.isNaN(Number.parseInt(lengthString, 10)) ? 0 : Number.parseInt(lengthString, 10));
    const attachment: ParsedAttachment | undefined = makeParsedAttachment(enclosureURL,
      this.currentAttributes.get('type'), undefined, length > 0 ? length : undefined,
      undefined);
    if (attachment !== undefined) {
      article.attachments.push(attachment);
    }
  }

  private handleFeedElementEnd(localName: string, prefix: string | undefined): void {
    if (prefix !== undefined) {
      return;
    }
    if (localName === 'link') {
      if (this.homepageURLString === undefined || this.homepageURLString.length === 0) {
        this.homepageURLString = this.parser.currentStringWithTrimmedWhitespace();
      }
    } else if (localName === 'title') {
      this.title = this.parser.currentStringWithTrimmedWhitespace();
    } else if (localName === 'language') {
      this.language = this.parser.currentStringWithTrimmedWhitespace();
    }
  }

  private addAuthor(article: RSSItem, s?: string): void {
    if (s === undefined || s.length === 0) {
      return;
    }
    article.authors.push(authorFromSingleString(s));
  }

  /** Bad guids are often integers; guids starting with "tag:" aren't URLs. */
  private static stringIsProbablyURLOrRelativePath(s: string): boolean {
    if (s.indexOf(' ') >= 0) {
      return false;
    }
    if (s.indexOf('/') < 0) {
      return false;
    }
    return !s.toLowerCase().startsWith('tag:');
  }

  private resolve(s: string): string {
    if (s.toLowerCase().startsWith('http')) {
      return s;
    }
    const base: string | undefined = this.homepageURLString;
    if (base === undefined || base.length === 0) {
      return s;
    }
    const resolved: string | undefined = resolveURL(s, base);
    return resolved === undefined ? s : resolved;
  }
}

export function parseRSS(parserData: ParserData): ParsedFeed {
  return new RSSDelegate(parserData.url).parse(decodeXmlBytes(parserData.data));
}

// MARK: - Atom (Feeds/XML/AtomParser.swift)

class AtomAuthor {
  name?: string;
  emailAddress?: string;
  url?: string;

  toParsedAuthor(): ParsedAuthor | undefined {
    if (this.name === undefined && this.emailAddress === undefined && this.url === undefined) {
      return undefined;
    }
    const author: ParsedAuthor = {
      name: this.name,
      url: this.url,
      avatarURL: undefined,
      emailAddress: this.emailAddress
    };
    return author;
  }
}

class AtomDelegate implements XmlHandler {
  private readonly feedURLString: string;
  private readonly isDaringFireball: boolean;
  private readonly parser: XmlParser;

  private feedTitle?: string;
  private homepageURLString?: string;
  private language?: string;
  private iconURLString?: string;
  private logoURLString?: string;

  private items: RSSItem[] = [];
  private rootAuthor?: ParsedAuthor;
  private currentAuthor?: AtomAuthor;

  private parsingArticle: boolean = false;
  private parsingAuthor: boolean = false;
  private parsingSource: boolean = false;
  private endFeedFound: boolean = false;
  private namespaceElementDepth: number = 0;

  private attributesStack: Map<string, string>[] = [];
  /** Effective xml:base per open element — kept exactly parallel to attributesStack. */
  private baseURLStack: (string | undefined)[] = [];

  constructor(urlString: string) {
    this.feedURLString = urlString;
    this.isDaringFireball = urlString.indexOf('daringfireball.net/') >= 0;
    this.parser = new XmlParser(this);
  }

  parse(text: string): ParsedFeed {
    this.parser.parse(text);
    return this.buildParsedFeed();
  }

  private buildParsedFeed(): ParsedFeed {
    // Apply the root author to any item that has none.
    const rootAuthor: ParsedAuthor | undefined = this.rootAuthor;
    if (rootAuthor !== undefined) {
      for (const item of this.items) {
        if (item.authors.length === 0) {
          item.authors.push(rootAuthor);
        }
      }
    }
    // <atom:logo> is the larger image, <atom:icon> the favicon; no logo falls back to icon.
    const iconURL: string | undefined =
      this.logoURLString === undefined ? this.iconURLString : this.logoURLString;
    const parsedItems: ParsedItem[] = [];
    for (const item of this.items) {
      parsedItems.push(item.toParsedItem(this.feedURLString));
    }
    const feed: ParsedFeed = {
      type: FeedType.atom,
      title: this.feedTitle,
      homePageURL: this.homepageURLString,
      feedURL: this.feedURLString,
      language: this.language,
      feedDescription: undefined,
      nextURL: undefined,
      iconURL: iconURL,
      faviconURL: this.iconURLString,
      authors: undefined,
      expired: false,
      hubs: undefined,
      items: parsedItems
    };
    return feed;
  }

  private get currentArticle(): RSSItem | undefined {
    return this.items.length === 0 ? undefined : this.items[this.items.length - 1];
  }

  private get currentAttributes(): Map<string, string> {
    return this.attributesStack.length === 0
      ? new Map<string, string>()
      : this.attributesStack[this.attributesStack.length - 1];
  }

  private get effectiveBaseURL(): string | undefined {
    return this.baseURLStack.length === 0
      ? undefined
      : this.baseURLStack[this.baseURLStack.length - 1];
  }

  startElement(localName: string, prefix: string | undefined,
    attributes: Map<string, string>, selfClosing: boolean): boolean {
    if (this.endFeedFound) {
      return false;
    }
    this.attributesStack.push(attributes);
    this.pushBaseURL(attributes);

    if (this.namespaceElementDepth > 0) {
      this.namespaceElementDepth += 1;
      return false;
    }
    if (this.parsingArticle && prefix !== undefined) {
      this.namespaceElementDepth = 1;
      return false;
    }

    if (localName === 'entry') {
      this.parsingArticle = true;
      this.items.push(new RSSItem());
      return false;
    }
    if (localName === 'author') {
      this.parsingAuthor = true;
      this.currentAuthor = new AtomAuthor();
      return false;
    }
    if (localName === 'source') {
      this.parsingSource = true;
      return false;
    }

    const isContentTag: boolean = localName === 'content';
    const isSummaryTag: boolean = localName === 'summary';
    if (this.parsingArticle && (isContentTag || isSummaryTag)) {
      if (isContentTag) {
        const article: RSSItem | undefined = this.currentArticle;
        if (article !== undefined) {
          article.language = attributes.get('xml:lang');
        }
      }
      if (attributes.get('type') === 'xhtml') {
        // Hand off to the scanner — get the raw inner bytes.
        return true;
      }
    }

    if (!this.parsingArticle && localName === 'link') {
      this.addHomePageLink();
      return false;
    }
    if (localName === 'feed') {
      this.language = attributes.get('xml:lang');
    }

    this.parser.beginStoringCharacters();
    return false;
  }

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void {
    const article: RSSItem | undefined = this.currentArticle;
    if (article === undefined) {
      return;
    }
    // The content element is still on the stacks here, so effectiveBaseURL includes its
    // own xml:base.
    const base: string | undefined = this.effectiveBaseURL;
    const resolvedHTML: string = base === undefined ? html : resolveRelativeURLs(html, base);
    if (localName === 'content') {
      article.body = resolvedHTML;
    } else if (localName === 'summary') {
      article.summary = resolvedHTML;
    }
  }

  endElement(localName: string, prefix: string | undefined): void {
    try {
      if (localName === 'feed') {
        this.endFeedFound = true;
        return;
      }
      if (this.endFeedFound) {
        return;
      }
      if (this.namespaceElementDepth > 0) {
        this.namespaceElementDepth -= 1;
        return;
      }
      if (this.parsingAuthor) {
        this.handleAuthorElementEnd(localName);
        return;
      }
      if (localName === 'entry') {
        this.parsingArticle = false;
        return;
      }
      if (this.parsingArticle && !this.parsingSource) {
        this.handleArticleElementEnd(localName, prefix);
        return;
      }
      if (localName === 'source') {
        this.parsingSource = false;
        return;
      }
      if (!this.parsingArticle && !this.parsingSource) {
        this.handleFeedElementEnd(localName, prefix);
      }
    } finally {
      if (this.attributesStack.length > 0) {
        this.attributesStack.pop();
      }
      if (this.baseURLStack.length > 0) {
        this.baseURLStack.pop();
      }
    }
  }

  characters(text: string): void {
    // Accumulation is handled by XmlParser's character buffer.
  }

  private handleArticleElementEnd(localName: string, prefix: string | undefined): void {
    const article: RSSItem | undefined = this.currentArticle;
    if (article === undefined || prefix !== undefined) {
      return;
    }
    if (localName === 'id') {
      article.guid = this.parser.currentStringWithTrimmedWhitespace();
    } else if (localName === 'title') {
      article.title = this.parser.currentStringWithTrimmedWhitespace();
    } else if (localName === 'content') {
      // Overwrite only if there are characters — raw XHTML already set it.
      const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
      if (s !== undefined) {
        article.body = this.resolvedHTMLBody(s);
      }
    } else if (localName === 'summary') {
      const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
      if (s !== undefined) {
        article.summary = this.resolvedHTMLBody(s);
      }
    } else if (localName === 'link') {
      this.handleArticleLink();
    } else if (localName === 'published') {
      article.datePublished = parseDate(this.parser.currentCharacters());
    } else if (localName === 'updated') {
      article.dateModified = parseDate(this.parser.currentCharacters());
    } else if (localName === 'issued') {
      if (article.datePublished === undefined) {
        article.datePublished = parseDate(this.parser.currentCharacters());
      }
    } else if (localName === 'modified') {
      if (article.dateModified === undefined) {
        article.dateModified = parseDate(this.parser.currentCharacters());
      }
    }
  }

  private handleArticleLink(): void {
    const article: RSSItem | undefined = this.currentArticle;
    if (article === undefined) {
      return;
    }
    const attributes: Map<string, string> = this.currentAttributes;
    const urlString: string | undefined = attributes.get('href');
    if (urlString === undefined || urlString.length === 0) {
      return;
    }
    const resolved: string | undefined = this.resolvedURLString(urlString);
    if (resolved === undefined) {
      return;
    }
    const relValue: string | undefined = attributes.get('rel');
    const rel: string = relValue === undefined ? 'alternate' : relValue;

    if (rel === 'enclosure') {
      const lengthString: string | undefined = attributes.get('length');
      const length: number = lengthString === undefined
        ? 0
        : (Number.isNaN(Number.parseInt(lengthString, 10))
          ? 0 : Number.parseInt(lengthString, 10));
      const attachment: ParsedAttachment | undefined = makeParsedAttachment(resolved,
        attributes.get('type'), attributes.get('title'), length > 0 ? length : undefined,
        undefined);
      if (attachment !== undefined) {
        article.attachments.push(attachment);
      }
      return;
    }

    if (this.isDaringFireball) {
      if (resolved.startsWith('https://daringfireball.net/')) {
        if (article.permalink === undefined || article.permalink.length === 0) {
          article.permalink = resolved;
        }
      } else {
        if (article.link === undefined || article.link.length === 0) {
          article.link = resolved;
        }
      }
      return;
    }

    if (rel === 'related') {
      if (article.link === undefined || article.link.length === 0) {
        article.link = resolved;
      }
    }
    if (rel === 'alternate') {
      if (article.permalink === undefined || article.permalink.length === 0) {
        article.permalink = resolved;
      }
    }
  }

  private handleAuthorElementEnd(localName: string): void {
    if (localName === 'author') {
      this.parsingAuthor = false;
      const current: AtomAuthor | undefined = this.currentAuthor;
      if (current !== undefined) {
        const author: ParsedAuthor | undefined = current.toParsedAuthor();
        if (this.parsingArticle) {
          const article: RSSItem | undefined = this.currentArticle;
          if (author !== undefined && article !== undefined) {
            article.authors.push(author);
          }
        } else if (this.rootAuthor === undefined && author !== undefined) {
          this.rootAuthor = author;
        }
      }
      this.currentAuthor = undefined;
      return;
    }
    const author: AtomAuthor | undefined = this.currentAuthor;
    if (author === undefined) {
      return;
    }
    if (localName === 'name') {
      author.name = this.parser.currentStringWithTrimmedWhitespace();
    } else if (localName === 'email') {
      author.emailAddress = this.parser.currentStringWithTrimmedWhitespace();
    } else if (localName === 'uri') {
      const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
      if (s !== undefined) {
        const resolved: string | undefined = this.resolvedURLString(s);
        author.url = resolved === undefined ? s : resolved;
      }
    }
  }

  private handleFeedElementEnd(localName: string, prefix: string | undefined): void {
    if (prefix !== undefined) {
      return;
    }
    if (localName === 'title') {
      if (this.feedTitle === undefined || this.feedTitle.length === 0) {
        this.feedTitle = this.parser.currentStringWithTrimmedWhitespace();
      }
    } else if (localName === 'icon') {
      const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
      if (s !== undefined && s.length > 0) {
        const resolved: string | undefined = this.resolvedURLString(s);
        this.iconURLString = resolved === undefined ? s : resolved;
      }
    } else if (localName === 'logo') {
      if (this.logoURLString === undefined) {
        const s: string | undefined = this.parser.currentStringWithTrimmedWhitespace();
        if (s !== undefined && s.length > 0) {
          const resolved: string | undefined = this.resolvedURLString(s);
          this.logoURLString = resolved === undefined ? s : resolved;
        }
      }
    }
  }

  private addHomePageLink(): void {
    if (this.homepageURLString !== undefined && this.homepageURLString.length > 0) {
      return;
    }
    const attributes: Map<string, string> = this.currentAttributes;
    const rawLink: string | undefined = attributes.get('href');
    if (rawLink === undefined || rawLink.length === 0) {
      return;
    }
    const rel: string | undefined = attributes.get('rel');
    // rel="alternate", or no rel (the spec says alternate is the default).
    if (rel === undefined || rel === 'alternate') {
      this.homepageURLString = this.resolvedURLString(rawLink);
    }
  }

  /**
   * RFC 4287: xml:base applies to its element and everything below it, and a relative
   * xml:base resolves against the nearest enclosing base — the feed URL when there is none.
   */
  private pushBaseURL(attributes: Map<string, string>): void {
    const inherited: string | undefined = this.effectiveBaseURL;
    const xmlBase: string | undefined = attributes.get('xml:base');
    if (xmlBase === undefined || xmlBase.length === 0) {
      this.baseURLStack.push(inherited);
      return;
    }
    const outerBase: string = inherited === undefined ? this.feedURLString : inherited;
    const resolved: string | undefined = resolveURL(xmlBase, outerBase);
    if (resolved === undefined) {
      this.baseURLStack.push(inherited);
      return;
    }
    const lower: string = resolved.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      // A garbage or non-http base (tag:, urn:) would poison resolution — inherit instead.
      this.baseURLStack.push(inherited);
      return;
    }
    this.baseURLStack.push(resolved);
  }

  /**
   * Rewrite relative URLs in an escaped-HTML body when an xml:base is in effect.
   * type="text" (and an absent type, which means text) is never rewritten.
   */
  private resolvedHTMLBody(html: string): string {
    const type: string | undefined = this.currentAttributes.get('type');
    const base: string | undefined = this.effectiveBaseURL;
    if (base === undefined || (type !== 'html' && type !== 'text/html')) {
      return html;
    }
    return resolveRelativeURLs(html, base);
  }

  private resolvedURLString(s: string): string | undefined {
    if (AtomDelegate.isValidURLString(s)) {
      return s;
    }
    const base: string | undefined = this.effectiveBaseURL;
    if (base !== undefined) {
      const resolved: string | undefined = resolveURL(s, base);
      if (resolved !== undefined && AtomDelegate.isValidURLString(resolved)) {
        return resolved;
      }
    }
    let fallbackBase: string | undefined = this.homepageURLString;
    if (fallbackBase === undefined || fallbackBase.length === 0) {
      fallbackBase = this.feedURLString;
    }
    if (fallbackBase.length === 0) {
      return undefined;
    }
    const resolved: string | undefined = resolveURL(s, fallbackBase);
    if (resolved !== undefined && resolved.length > 0
      && AtomDelegate.isValidURLString(resolved)) {
      return resolved;
    }
    return undefined;
  }

  private static isValidURLString(s: string): boolean {
    const lower: string = s.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://');
  }
}

/** HTMLRelativeURLResolver — rewrites src/href attributes against a base URL. */
export function resolveRelativeURLs(html: string, baseURL: string): string {
  return html.replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi,
    (match: string, prefix: string, quote: string, value: string): string => {
      const trimmed: string = value.trim();
      if (trimmed.length === 0) {
        return match;
      }
      const lower: string = trimmed.toLowerCase();
      if (lower.startsWith('http://') || lower.startsWith('https://')
        || lower.startsWith('data:') || lower.startsWith('mailto:')
        || lower.startsWith('#')) {
        return match;
      }
      const resolved: string | undefined = resolveURL(trimmed, baseURL);
      return resolved === undefined ? match : prefix + quote + resolved + quote;
    });
}

export function parseAtom(parserData: ParserData): ParsedFeed {
  return new AtomDelegate(parserData.url).parse(decodeXmlBytes(parserData.data));
}

// MARK: - JSON Feed (Feeds/JSON/JSONFeedParser.swift)

const JSON_FEED_VERSION_MARKER: string = '://jsonfeed.org/version/';

/** As of 2018 these feeds put HTML entities in their title elements. */
function isSpecialCaseTitleWithEntitiesFeed(feedURL: string): boolean {
  const lower: string = feedURL.toLowerCase();
  const matchStrings: string[] = ['kottke.org', 'pxlnv.com', 'macstories.net',
    'macobserver.com'];
  for (const matchString of matchStrings) {
    if (lower.indexOf(matchString) >= 0) {
      return true;
    }
  }
  return false;
}

function parseJSONAuthor(d: JsonObject): ParsedAuthor | undefined {
  const name: string | undefined = getString(d, 'name');
  const authorURL: string | undefined = getString(d, 'url');
  const avatar: string | undefined = getString(d, 'avatar');
  if (name === undefined && authorURL === undefined && avatar === undefined) {
    return undefined;
  }
  const author: ParsedAuthor = {
    name: name,
    url: authorURL,
    avatarURL: avatar,
    emailAddress: undefined
  };
  return author;
}

function parseJSONAuthors(d: JsonObject): ParsedAuthor[] | undefined {
  const authorsArray: JsonObject[] | undefined = getObjectArray(d, 'authors');
  if (authorsArray !== undefined) {
    const authors: ParsedAuthor[] = [];
    for (const authorObject of authorsArray) {
      const author: ParsedAuthor | undefined = parseJSONAuthor(authorObject);
      if (author !== undefined) {
        authors.push(author);
      }
    }
    return authors.length === 0 ? undefined : authors;
  }
  const authorDictionary: JsonObject | undefined = getObject(d, 'author');
  if (authorDictionary === undefined) {
    return undefined;
  }
  const author: ParsedAuthor | undefined = parseJSONAuthor(authorDictionary);
  return author === undefined ? undefined : [author];
}

function parseJSONHubs(d: JsonObject): ParsedHub[] | undefined {
  const hubsArray: JsonObject[] | undefined = getObjectArray(d, 'hubs');
  if (hubsArray === undefined) {
    return undefined;
  }
  const hubs: ParsedHub[] = [];
  for (const hubDictionary of hubsArray) {
    const hubURL: string | undefined = getString(hubDictionary, 'url');
    const hubType: string | undefined = getString(hubDictionary, 'type');
    if (hubURL === undefined || hubType === undefined) {
      continue;
    }
    const hub: ParsedHub = { type: hubType, url: hubURL };
    hubs.push(hub);
  }
  return hubs.length === 0 ? undefined : hubs;
}

function parseJSONAttachments(itemDictionary: JsonObject): ParsedAttachment[] | undefined {
  const attachmentsArray: JsonObject[] | undefined = getObjectArray(itemDictionary,
    'attachments');
  if (attachmentsArray === undefined) {
    return undefined;
  }
  const attachments: ParsedAttachment[] = [];
  for (const attachmentObject of attachmentsArray) {
    const attachmentURL: string | undefined = getString(attachmentObject, 'url');
    const mimeType: string | undefined = getString(attachmentObject, 'mime_type');
    if (attachmentURL === undefined || mimeType === undefined) {
      continue;
    }
    const attachment: ParsedAttachment | undefined = makeParsedAttachment(attachmentURL,
      mimeType, getString(attachmentObject, 'title'),
      getNumber(attachmentObject, 'size_in_bytes'),
      getNumber(attachmentObject, 'duration_in_seconds'));
    if (attachment !== undefined) {
      attachments.push(attachment);
    }
  }
  return attachments.length === 0 ? undefined : attachments;
}

function parseJSONItem(itemDictionary: JsonObject, feedURL: string): ParsedItem | undefined {
  const uniqueID: string | undefined = getStringOrNumberAsString(itemDictionary, 'id');
  if (uniqueID === undefined) {
    return undefined;
  }
  const contentHTML: string | undefined = getString(itemDictionary, 'content_html');
  const contentText: string | undefined = getString(itemDictionary, 'content_text');
  if (contentHTML === undefined && contentText === undefined) {
    return undefined;
  }

  let title: string | undefined = getString(itemDictionary, 'title');
  if (title !== undefined && isSpecialCaseTitleWithEntitiesFeed(feedURL)) {
    title = decodingHTMLEntities(title);
  }

  const item: ParsedItem = {
    syncServiceID: undefined,
    uniqueID: uniqueID,
    feedURL: feedURL,
    url: getString(itemDictionary, 'url'),
    externalURL: getString(itemDictionary, 'external_url'),
    title: title,
    language: getString(itemDictionary, 'language'),
    contentHTML: contentHTML,
    contentText: contentText,
    markdown: undefined,
    summary: getString(itemDictionary, 'summary'),
    imageURL: getString(itemDictionary, 'image'),
    bannerImageURL: getString(itemDictionary, 'banner_image'),
    datePublished: parseDate(getString(itemDictionary, 'date_published')),
    dateModified: parseDate(getString(itemDictionary, 'date_modified')),
    authors: parseJSONAuthors(itemDictionary),
    tags: getStringArray(itemDictionary, 'tags'),
    attachments: parseJSONAttachments(itemDictionary)
  };
  return item;
}

export function parseJSONFeed(parserData: ParserData): ParsedFeed | undefined {
  const d: JsonObject | undefined = parseJsonObject(decodeXmlBytes(parserData.data));
  if (d === undefined) {
    return undefined;
  }
  const version: string | undefined = getString(d, 'version');
  if (version === undefined || version.indexOf(JSON_FEED_VERSION_MARKER) < 0) {
    return undefined;
  }
  const itemsArray: JsonObject[] | undefined = getObjectArray(d, 'items');
  if (itemsArray === undefined) {
    return undefined;
  }
  const title: string | undefined = getString(d, 'title');
  if (title === undefined) {
    return undefined;
  }

  const items: ParsedItem[] = [];
  for (const itemDictionary of itemsArray) {
    const item: ParsedItem | undefined = parseJSONItem(itemDictionary, parserData.url);
    if (item !== undefined) {
      items.push(item);
    }
  }

  const feedURLValue: string | undefined = getString(d, 'feed_url');
  const expired: boolean | undefined = getBoolean(d, 'expired');
  const feed: ParsedFeed = {
    type: FeedType.jsonFeed,
    title: title,
    homePageURL: getString(d, 'home_page_url'),
    feedURL: feedURLValue === undefined ? parserData.url : feedURLValue,
    language: getString(d, 'language'),
    feedDescription: getString(d, 'description'),
    nextURL: getString(d, 'next_url'),
    iconURL: getString(d, 'icon'),
    faviconURL: getString(d, 'favicon'),
    authors: parseJSONAuthors(d),
    expired: expired === undefined ? false : expired,
    hubs: parseJSONHubs(d),
    items: items
  };
  return feed;
}

// MARK: - RSS in JSON (Feeds/JSON/RSSInJSONParser.swift)

function parseRSSInJSONTags(itemDictionary: JsonObject): string[] | undefined {
  const categoryObject: JsonObject | undefined = getObject(itemDictionary, 'category');
  if (categoryObject !== undefined) {
    const oneTag: string | undefined = getString(categoryObject, '#value');
    return oneTag === undefined ? undefined : [oneTag];
  }
  const categoryArray: JsonObject[] | undefined = getObjectArray(itemDictionary, 'category');
  if (categoryArray === undefined) {
    return undefined;
  }
  const tags: string[] = [];
  for (const category of categoryArray) {
    const value: string | undefined = getString(category, '#value');
    if (value !== undefined) {
      tags.push(value);
    }
  }
  return tags.length === 0 ? undefined : tags;
}

function parseRSSInJSONAttachments(itemDictionary: JsonObject): ParsedAttachment[] | undefined {
  const enclosureObject: JsonObject | undefined = getObject(itemDictionary, 'enclosure');
  if (enclosureObject === undefined) {
    return undefined;
  }
  const attachmentURL: string | undefined = getString(enclosureObject, 'url');
  if (attachmentURL === undefined) {
    return undefined;
  }
  let attachmentSize: number | undefined = getNumber(enclosureObject, 'length');
  if (attachmentSize === undefined) {
    const sizeString: string | undefined = getString(enclosureObject, 'length');
    if (sizeString !== undefined) {
      const parsed: number = Number.parseInt(sizeString, 10);
      attachmentSize = Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  const attachment: ParsedAttachment | undefined = makeParsedAttachment(attachmentURL,
    getString(enclosureObject, 'type'), undefined, attachmentSize, undefined);
  return attachment === undefined ? undefined : [attachment];
}

function parseRSSInJSONItem(itemDictionary: JsonObject,
  feedURL: string): ParsedItem | undefined {
  const externalURL: string | undefined = getString(itemDictionary, 'link');
  const title: string | undefined = getString(itemDictionary, 'title');

  let contentHTML: string | undefined = getString(itemDictionary, 'description');
  let contentText: string | undefined = undefined;
  if (contentHTML !== undefined && contentHTML.indexOf('<') < 0) {
    contentText = contentHTML;
    contentHTML = undefined;
  }
  if (contentHTML === undefined && contentText === undefined && title === undefined) {
    return undefined;
  }

  const datePublished: Date | undefined = parseDate(getString(itemDictionary, 'pubDate'));

  let authors: ParsedAuthor[] | undefined = undefined;
  const authorEmailAddress: string | undefined = getString(itemDictionary, 'author');
  if (authorEmailAddress !== undefined) {
    const author: ParsedAuthor = { emailAddress: authorEmailAddress };
    authors = [author];
  }
  const tags: string[] | undefined = parseRSSInJSONTags(itemDictionary);
  const attachments: ParsedAttachment[] | undefined =
    parseRSSInJSONAttachments(itemDictionary);

  let uniqueID: string | undefined = getString(itemDictionary, 'guid');
  if (uniqueID === undefined) {
    // Items should have guids. When they don't, hash a combination of non-empty elements —
    // valid only for this particular feed, just like ids in JSON Feed.
    let s: string = '';
    if (datePublished !== undefined) {
      s += (datePublished.getTime() / 1000).toString();
    }
    if (title !== undefined) {
      s += title;
    }
    if (externalURL !== undefined) {
      s += externalURL;
    }
    if (authors !== undefined && authors.length > 0) {
      const email: string | undefined = authors[0].emailAddress;
      if (email !== undefined) {
        s += email;
      }
    }
    if (attachments !== undefined && attachments.length > 0) {
      s += attachments[0].url;
    }
    if (s.length === 0) {
      if (contentHTML !== undefined) {
        s = contentHTML;
      }
      if (contentText !== undefined) {
        s = contentText;
      }
    }
    uniqueID = md5String(s);
  }

  const item: ParsedItem = {
    syncServiceID: undefined,
    uniqueID: uniqueID,
    feedURL: feedURL,
    url: undefined,
    externalURL: externalURL,
    title: title,
    language: undefined,
    contentHTML: contentHTML,
    contentText: contentText,
    markdown: undefined,
    summary: undefined,
    imageURL: undefined,
    bannerImageURL: undefined,
    datePublished: datePublished,
    dateModified: undefined,
    authors: authors,
    tags: tags,
    attachments: attachments
  };
  return item;
}

export function parseRSSInJSON(parserData: ParserData): ParsedFeed | undefined {
  const parsedObject: JsonObject | undefined = parseJsonObject(decodeXmlBytes(parserData.data));
  if (parsedObject === undefined) {
    return undefined;
  }
  const rssObject: JsonObject | undefined = getObject(parsedObject, 'rss');
  if (rssObject === undefined) {
    return undefined;
  }
  const channelObject: JsonObject | undefined = getObject(rssObject, 'channel');
  if (channelObject === undefined) {
    return undefined;
  }

  // In practice the items array doesn't always sit inside the channel object, and is
  // sometimes called "items" instead of "item".
  let itemsObject: JsonObject[] | undefined = getObjectArray(channelObject, 'item');
  if (itemsObject === undefined) {
    itemsObject = getObjectArray(parsedObject, 'item');
  }
  if (itemsObject === undefined) {
    itemsObject = getObjectArray(channelObject, 'items');
  }
  if (itemsObject === undefined) {
    itemsObject = getObjectArray(parsedObject, 'items');
  }
  if (itemsObject === undefined) {
    return undefined;
  }

  let iconURL: string | undefined = undefined;
  const imageObject: JsonObject | undefined = getObject(channelObject, 'image');
  if (imageObject !== undefined) {
    iconURL = getString(imageObject, 'url');
  }

  const items: ParsedItem[] = [];
  for (const itemDictionary of itemsObject) {
    const item: ParsedItem | undefined = parseRSSInJSONItem(itemDictionary, parserData.url);
    if (item !== undefined) {
      items.push(item);
    }
  }

  const feed: ParsedFeed = {
    type: FeedType.rssInJSON,
    title: getString(channelObject, 'title'),
    homePageURL: getString(channelObject, 'link'),
    feedURL: parserData.url,
    language: getString(channelObject, 'language'),
    feedDescription: getString(channelObject, 'description'),
    nextURL: undefined,
    iconURL: iconURL,
    faviconURL: undefined,
    authors: undefined,
    expired: false,
    hubs: undefined,
    items: items
  };
  return feed;
}

/** MD5 of the raw feed bytes — LocalAccountRefresher's contentHash short-circuit. */
export function contentHash(data: ArrayBuffer): string {
  return md5OfBytes(new Uint8Array(data));
}
