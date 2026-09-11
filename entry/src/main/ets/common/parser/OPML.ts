/**
 * OPML — port of:
 *   RSParser/Feeds/XML/OPMLParser.swift    the reader
 *   Account/OPMLNormalizer.swift           the flatten-nested-folders rule
 *   Account/OPMLFile.swift                 the per-account Subscriptions.opml auto-save
 *   Account/{Account,Folder,Feed}.OPMLString + Shared/Exporters/OPMLExporter.swift  the writer
 *
 * The writer is split into the three pieces the source composes (document wrapper, folder
 * outline, feed outline) so the Account aggregate — which lands in a later pass — supplies
 * the tree without this module depending on it.
 */

import fs from '@ohos.file.fs';
import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { OPMLDocument, OPMLItem } from '../../model/OPMLDocument';
import { CoalescingQueue } from '../util/CoalescingQueue';
import { escapingSpecialXMLCharacters, prependingTabs } from '../util/Strings';
import { XmlHandler, XmlParser, decodeXmlBytes } from './XmlScan';
import { ParserData } from './FeedParser';

const DOMAIN: number = 0x0001;
const TAG: string = 'OPML';

export class OPMLError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super('The file "' + fileName + '" isn’t an OPML file.');
    this.fileName = fileName;
  }
}

// MARK: - Reading

class OPMLParserDelegate implements XmlHandler {
  readonly document: OPMLDocument;
  private readonly parser: XmlParser;
  private itemStack: OPMLItem[];
  private collectingTitleOnDocument: boolean = false;

  constructor(urlString: string) {
    this.document = new OPMLDocument(urlString);
    this.itemStack = [this.document];
    this.parser = new XmlParser(this);
  }

  parse(text: string): OPMLDocument {
    this.parser.parse(text);
    return this.document;
  }

  private get currentItem(): OPMLItem {
    return this.itemStack.length === 0
      ? this.document
      : this.itemStack[this.itemStack.length - 1];
  }

  startElement(localName: string, prefix: string | undefined,
    attributes: Map<string, string>, selfClosing: boolean): boolean {
    if (localName === 'title') {
      this.parser.beginStoringCharacters();
      // Only the document-level title matters.
      this.collectingTitleOnDocument = this.itemStack.length === 1;
      return false;
    }
    if (localName !== 'outline') {
      return false;
    }
    const item: OPMLItem = new OPMLItem(attributes);
    this.currentItem.addChild(item);
    // A self-closing <outline …/> has no children, so it must not be pushed — the scanner
    // emits its endElement immediately and would otherwise pop the parent.
    this.itemStack.push(item);
    return false;
  }

  endElement(localName: string, prefix: string | undefined): void {
    if (localName === 'title') {
      if (this.collectingTitleOnDocument) {
        this.document.title = this.parser.currentStringWithTrimmedWhitespace();
      }
      this.collectingTitleOnDocument = false;
      return;
    }
    if (localName === 'outline') {
      if (this.itemStack.length > 1) {
        this.itemStack.pop();
      }
    }
  }

  characters(text: string): void {
    // Accumulation is handled by XmlParser's character buffer.
  }

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void {
    // OPML never requests raw capture.
  }
}

/** Looks for `<opml` (case-insensitive) in the first 4 KB, as the source validates. */
function looksLikeOPML(text: string): boolean {
  const head: string = text.substring(0, Math.min(text.length, 4096)).toLowerCase();
  return head.indexOf('<opml') >= 0;
}

/** Throws OPMLError when the data doesn't look like OPML. */
export function parseOPML(parserData: ParserData): OPMLDocument {
  const text: string = decodeXmlBytes(parserData.data);
  if (!looksLikeOPML(text)) {
    throw new OPMLError(parserData.url);
  }
  return new OPMLParserDelegate(parserData.url).parse(text);
}

export function parseOPMLString(text: string, urlString: string): OPMLDocument {
  if (!looksLikeOPML(text)) {
    throw new OPMLError(urlString);
  }
  return new OPMLParserDelegate(urlString).parse(text);
}

// MARK: - Normalizing (Account/OPMLNormalizer.swift)

class OPMLNormalizer {
  normalizedOPMLItems: OPMLItem[] = [];

  normalize(items: OPMLItem[], parentFolder?: OPMLItem): void {
    const feedsToAdd: OPMLItem[] = [];

    for (const item of items) {
      if (item.feedSpecifier !== undefined) {
        let alreadyPresent: boolean = false;
        for (const candidate of feedsToAdd) {
          const a: string | undefined = candidate.feedSpecifier?.feedURL;
          const b: string | undefined = item.feedSpecifier?.feedURL;
          if (a !== undefined && a === b) {
            alreadyPresent = true;
            break;
          }
        }
        if (!alreadyPresent) {
          feedsToAdd.push(item);
        }
        continue;
      }

      if (item.titleFromAttributes === undefined) {
        // A folder with no name is never created; its items move one level up.
        const children: OPMLItem[] | undefined = item.children;
        if (children !== undefined) {
          this.normalize(children, parentFolder);
        }
        continue;
      }

      feedsToAdd.push(item);
      const children: OPMLItem[] | undefined = item.children;
      if (children !== undefined) {
        this.normalize(children, parentFolder === undefined ? item : parentFolder);
      }
    }

    if (parentFolder !== undefined) {
      for (const feed of feedsToAdd) {
        let alreadyPresent: boolean = false;
        const existingChildren: OPMLItem[] | undefined = parentFolder.children;
        if (existingChildren !== undefined) {
          for (const child of existingChildren) {
            const a: string | undefined = child.feedSpecifier?.feedURL;
            const b: string | undefined = feed.feedSpecifier?.feedURL;
            if (a !== undefined && a === b) {
              alreadyPresent = true;
              break;
            }
          }
        }
        if (!alreadyPresent) {
          parentFolder.addChild(feed);
        }
      }
      return;
    }
    for (const feed of feedsToAdd) {
      this.normalizedOPMLItems.push(feed);
    }
  }
}

/** Flattens folders-inside-folders and de-duplicates feeds, as the source requires. */
export function normalizeOPMLItems(items: OPMLItem[]): OPMLItem[] {
  const normalizer: OPMLNormalizer = new OPMLNormalizer();
  normalizer.normalize(items, undefined);
  return normalizer.normalizedOPMLItems;
}

// MARK: - Writing

/**
 * The `<outline …/>` line for one feed. `name` is the feed's editedName ?? name ?? "" —
 * NOT nameForDisplay, so that "Untitled" is never written to disk (issue #527).
 */
export function opmlStringForFeed(name: string, homePageURL: string | undefined,
  feedURL: string, indentLevel: number): string {
  const escapedName: string = escapingSpecialXMLCharacters(name);
  const escapedHomePageURL: string = homePageURL === undefined
    ? '' : escapingSpecialXMLCharacters(homePageURL);
  const escapedFeedURL: string = escapingSpecialXMLCharacters(feedURL);
  const s: string = '<outline text="' + escapedName + '" title="' + escapedName
    + '" description="" type="rss" version="RSS" htmlUrl="' + escapedHomePageURL
    + '" xmlUrl="' + escapedFeedURL + '"/>\n';
  return prependingTabs(s, indentLevel);
}

/**
 * The `<outline>…</outline>` block for one folder. `childStrings` are already-rendered
 * feed lines; an empty folder collapses to a self-closing outline, as in the source.
 */
export function opmlStringForFolder(title: string, externalID: string | undefined,
  childStrings: string[], indentLevel: number,
  allowCustomAttributes: boolean = false): string {
  const attrExternalID: string = (allowCustomAttributes && externalID !== undefined)
    ? ' nnw_externalID="' + escapingSpecialXMLCharacters(externalID) + '"'
    : '';
  const escapedTitle: string = escapingSpecialXMLCharacters(title);

  if (childStrings.length === 0) {
    return prependingTabs('<outline text="' + escapedTitle + '" title="' + escapedTitle
      + '"' + attrExternalID + '/>\n', indentLevel);
  }

  let s: string = prependingTabs('<outline text="' + escapedTitle + '" title="'
    + escapedTitle + '"' + attrExternalID + '>\n', indentLevel);
  for (const childString of childStrings) {
    s += childString;
  }
  s += prependingTabs('</outline>\n', indentLevel);
  return s;
}

/** Wraps rendered outlines in the OPML document the source writes. */
export function opmlDocumentString(title: string, body: string): string {
  const escapedTitle: string = escapingSpecialXMLCharacters(title);
  const openingText: string = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!-- OPML generated by NetNewsWire -->\n'
    + '<opml version="1.1">\n'
    + '\t<head>\n'
    + '\t\t<title>' + escapedTitle + '</title>\n'
    + '\t</head>\n'
    + '<body>\n\n';
  const closingText: string = '\t</body>\n</opml>\n';
  return openingText + body + closingText;
}

// MARK: - OPMLFile (Account/OPMLFile.swift)

/**
 * The per-account Subscriptions.opml file. `markAsDirty()` from any structure change;
 * the write is coalesced on a 0.5s queue exactly as the source does.
 */
export class OPMLFile {
  private readonly filePath: string;
  private readonly documentProvider: () => string;
  private readonly saveQueue: CoalescingQueue = new CoalescingQueue('Save Queue', 500);
  private isDirty: boolean = false;

  constructor(filePath: string, documentProvider: () => string) {
    this.filePath = filePath;
    this.documentProvider = documentProvider;
  }

  markAsDirty(): void {
    this.isDirty = true;
    this.saveQueue.add(this.filePath, () => {
      this.saveToDiskIfNeeded();
    });
  }

  /** The document's top-level outlines, or undefined when the file is absent/unreadable. */
  load(): OPMLItem[] | undefined {
    const text: string | undefined = this.readFile();
    if (text === undefined) {
      return undefined;
    }
    try {
      const document: OPMLDocument = parseOPMLString(text, this.filePath);
      return document.children;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'OPML import failed: %{public}s', String(e));
      return undefined;
    }
  }

  save(): void {
    const text: string = opmlDocumentString('Subscriptions', this.documentProvider());
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(this.filePath,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'OPML save to disk failed: %{public}s', String(e));
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  /** Writes an arbitrary OPML document (Settings export). */
  static writeDocument(filePath: string, contents: string): void {
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(filePath,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, contents);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'OPML export failed: %{public}s', String(e));
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  /** Reads an OPML file from disk (Settings import, DefaultFeeds.opml). */
  static readDocument(filePath: string): OPMLItem[] | undefined {
    let file: fs.File | undefined = undefined;
    try {
      if (!fs.accessSync(filePath)) {
        return undefined;
      }
      const size: number = fs.statSync(filePath).size;
      if (size <= 0) {
        return undefined;
      }
      file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      fs.readSync(file.fd, buffer);
      const document: OPMLDocument = parseOPML(new ParserData(filePath, buffer));
      return document.children;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'OPML read failed: %{public}s', String(e));
      return undefined;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  private saveToDiskIfNeeded(): void {
    if (this.isDirty) {
      this.isDirty = false;
      this.save();
    }
  }

  private readFile(): string | undefined {
    let file: fs.File | undefined = undefined;
    try {
      if (!fs.accessSync(this.filePath)) {
        return undefined;
      }
      const size: number = fs.statSync(this.filePath).size;
      if (size <= 0) {
        return undefined;
      }
      file = fs.openSync(this.filePath, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      fs.readSync(file.fd, buffer);
      const options: util.TextDecoderOptions = { ignoreBOM: true };
      return util.TextDecoder.create('utf-8', options)
        .decodeToString(new Uint8Array(buffer));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'OPML read from disk failed: %{public}s', String(e));
      return undefined;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }
}
