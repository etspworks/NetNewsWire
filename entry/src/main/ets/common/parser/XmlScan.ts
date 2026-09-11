/**
 * XmlScan — port of Modules/RSParser/Sources/RSParser/XML/XMLSAXParser.swift (+ XMLScanner,
 * XMLEncoding).
 *
 * A liberal, single-pass XML scanner with a SAX-style handler. The source stopped using
 * libxml2 and hand-rolled this for two reasons that both apply here: feeds in the wild are
 * malformed, and `<content type="xhtml">` needs its inner markup captured VERBATIM.
 * `@ohos.xml` XmlPullParser can do neither (no raw-subtree capture, and attributes arrive
 * on a separate callback), so the scanner is ported rather than replaced.
 *
 * Character accumulation follows the source: the buffer is cleared on every start tag, so
 * a nested element cannot contaminate its parent's text.
 */

import util from '@ohos.util';
import { decodingHTMLEntities, trimmingWhitespace } from '../util/Strings';

export interface XmlHandler {
  /**
   * Returns true to ask for raw inner capture of this element (Atom's xhtml content).
   * The scanner then emits `rawInnerContent` followed by `endElement`.
   */
  startElement(localName: string, prefix: string | undefined, attributes: Map<string, string>,
    selfClosing: boolean): boolean;

  endElement(localName: string, prefix: string | undefined): void;

  characters(text: string): void;

  rawInnerContent(localName: string, prefix: string | undefined, html: string): void;
}

/** Bytes -> string, honoring an `encoding="…"` in the XML declaration. */
export function decodeXmlBytes(buffer: ArrayBuffer): string {
  const bytes: Uint8Array = new Uint8Array(buffer);
  let encoding: string = 'utf-8';
  const prefixLength: number = Math.min(bytes.length, 256);
  let head: string = '';
  for (let i: number = 0; i < prefixLength; i++) {
    head += String.fromCharCode(bytes[i]);
  }
  const match: RegExpMatchArray | null = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  if (match !== null && match.length > 1) {
    encoding = match[1].toLowerCase();
  }
  const options: util.TextDecoderOptions = { ignoreBOM: true };
  try {
    return util.TextDecoder.create(encoding, options).decodeToString(bytes);
  } catch (e) {
    return util.TextDecoder.create('utf-8', options).decodeToString(bytes);
  }
}

function isNameChar(c: string): boolean {
  return c !== '' && c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n'
    && c !== '>' && c !== '/' && c !== '=';
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

class ParsedName {
  readonly localName: string;
  readonly prefix?: string;

  constructor(qualifiedName: string) {
    const colon: number = qualifiedName.indexOf(':');
    if (colon > 0) {
      this.prefix = qualifiedName.substring(0, colon);
      this.localName = qualifiedName.substring(colon + 1);
    } else {
      this.localName = qualifiedName;
    }
  }
}

class OpenElement {
  readonly localName: string;
  readonly prefix?: string;

  constructor(localName: string, prefix?: string) {
    this.localName = localName;
    this.prefix = prefix;
  }
}

export class XmlParser {
  private readonly handler: XmlHandler;
  private storingCharacters: boolean = false;
  private charactersBuffer: string = '';

  constructor(handler: XmlHandler) {
    this.handler = handler;
  }

  /** Start accumulating text for the element just started. */
  beginStoringCharacters(): void {
    this.storingCharacters = true;
    this.charactersBuffer = '';
  }

  endStoringCharacters(): void {
    this.storingCharacters = false;
    this.charactersBuffer = '';
  }

  /** Raw accumulated characters, or undefined when not storing. */
  currentCharacters(): string | undefined {
    return this.storingCharacters ? this.charactersBuffer : undefined;
  }

  /** Accumulated text, trimmed; undefined when empty or not storing. */
  currentStringWithTrimmedWhitespace(): string | undefined {
    if (!this.storingCharacters || this.charactersBuffer.length === 0) {
      return undefined;
    }
    const trimmed: string = trimmingWhitespace(this.charactersBuffer);
    return trimmed.length === 0 ? undefined : trimmed;
  }

  parse(text: string): void {
    const openElements: OpenElement[] = [];
    let i: number = 0;
    const length: number = text.length;

    while (i < length) {
      const lessThan: number = text.indexOf('<', i);
      if (lessThan < 0) {
        this.appendCharacters(text.substring(i));
        break;
      }
      if (lessThan > i) {
        this.appendCharacters(text.substring(i, lessThan));
      }

      // <!-- comment -->, <![CDATA[…]]>, <!DOCTYPE …>, <?pi?>
      if (text.startsWith('<!--', lessThan)) {
        const end: number = text.indexOf('-->', lessThan + 4);
        i = end < 0 ? length : end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', lessThan)) {
        const end: number = text.indexOf(']]>', lessThan + 9);
        const stop: number = end < 0 ? length : end;
        this.appendRawCharacters(text.substring(lessThan + 9, stop));
        i = end < 0 ? length : end + 3;
        continue;
      }
      if (text.startsWith('<!', lessThan) || text.startsWith('<?', lessThan)) {
        const end: number = text.indexOf('>', lessThan + 2);
        i = end < 0 ? length : end + 1;
        continue;
      }

      // </name>
      if (text.startsWith('</', lessThan)) {
        const end: number = text.indexOf('>', lessThan + 2);
        const stop: number = end < 0 ? length : end;
        const name: ParsedName = new ParsedName(trimmingWhitespace(
          text.substring(lessThan + 2, stop)));
        if (openElements.length > 0) {
          openElements.pop();
        }
        this.handler.endElement(name.localName, name.prefix);
        i = end < 0 ? length : end + 1;
        continue;
      }

      // <name attr="value" …> or <name … />
      const tagEnd: number = this.findTagEnd(text, lessThan);
      if (tagEnd < 0) {
        break;
      }
      const inner: string = text.substring(lessThan + 1, tagEnd);
      const selfClosing: boolean = inner.endsWith('/');
      const tagBody: string = selfClosing ? inner.substring(0, inner.length - 1) : inner;

      let nameEnd: number = 0;
      while (nameEnd < tagBody.length && isNameChar(tagBody.charAt(nameEnd))) {
        nameEnd += 1;
      }
      const name: ParsedName = new ParsedName(tagBody.substring(0, nameEnd));
      const attributes: Map<string, string> = XmlParser.parseAttributes(tagBody, nameEnd);

      // libxml clears the character buffer on each new start tag; so does the source.
      this.endStoringCharacters();
      const wantsRaw: boolean =
        this.handler.startElement(name.localName, name.prefix, attributes, selfClosing);

      if (selfClosing) {
        this.handler.endElement(name.localName, name.prefix);
        i = tagEnd + 1;
        continue;
      }

      // <script>/<style> bodies are not markup — skip them wholesale so a `<` inside
      // JavaScript can't be read as a tag. (No-op for feeds; needed for HTML pages.)
      const lowerName: string = name.localName.toLowerCase();
      if (lowerName === 'script' || lowerName === 'style') {
        const bodyEnd: number = this.captureRawInnerContent(text, tagEnd + 1,
          tagBody.substring(0, nameEnd));
        const closeEnd: number = text.indexOf('>', bodyEnd);
        this.handler.endElement(name.localName, name.prefix);
        i = closeEnd < 0 ? length : closeEnd + 1;
        continue;
      }

      if (wantsRaw) {
        const capture: number = this.captureRawInnerContent(text, tagEnd + 1,
          tagBody.substring(0, nameEnd));
        this.handler.rawInnerContent(name.localName, name.prefix,
          text.substring(tagEnd + 1, capture));
        // Skip past the matching end tag.
        const closeEnd: number = text.indexOf('>', capture);
        this.handler.endElement(name.localName, name.prefix);
        i = closeEnd < 0 ? length : closeEnd + 1;
        continue;
      }

      openElements.push(new OpenElement(name.localName, name.prefix));
      i = tagEnd + 1;
    }

    // Liberal: close anything still open.
    while (openElements.length > 0) {
      const open: OpenElement | undefined = openElements.pop();
      if (open !== undefined) {
        this.handler.endElement(open.localName, open.prefix);
      }
    }
  }

  /** Index of the '>' closing the tag that starts at `start`, skipping quoted values. */
  private findTagEnd(text: string, start: number): number {
    let i: number = start + 1;
    let quote: string = '';
    while (i < text.length) {
      const c: string = text.charAt(i);
      if (quote.length > 0) {
        if (c === quote) {
          quote = '';
        }
      } else if (c === '"' || c === '\'') {
        quote = c;
      } else if (c === '>') {
        return i;
      }
      i += 1;
    }
    return -1;
  }

  /**
   * Index of the '<' opening the end tag that matches the element opened at `start`.
   * Nested elements of the same name are counted so `<div><div/></div>` closes correctly.
   */
  private captureRawInnerContent(text: string, start: number, qualifiedName: string): number {
    const openTag: string = '<' + qualifiedName;
    const closeTag: string = '</' + qualifiedName;
    let depth: number = 1;
    let i: number = start;
    while (i < text.length) {
      const lessThan: number = text.indexOf('<', i);
      if (lessThan < 0) {
        return text.length;
      }
      if (text.startsWith(closeTag, lessThan)) {
        depth -= 1;
        if (depth === 0) {
          return lessThan;
        }
        i = lessThan + closeTag.length;
        continue;
      }
      if (text.startsWith(openTag, lessThan)) {
        const tagEnd: number = this.findTagEnd(text, lessThan);
        if (tagEnd < 0) {
          return text.length;
        }
        if (text.charAt(tagEnd - 1) !== '/') {
          depth += 1;
        }
        i = tagEnd + 1;
        continue;
      }
      i = lessThan + 1;
    }
    return text.length;
  }

  private appendCharacters(raw: string): void {
    const text: string = decodingHTMLEntities(raw);
    if (this.storingCharacters) {
      this.charactersBuffer += text;
    }
    this.handler.characters(text);
  }

  /** CDATA content is passed through verbatim — no entity decoding. */
  private appendRawCharacters(text: string): void {
    if (this.storingCharacters) {
      this.charactersBuffer += text;
    }
    this.handler.characters(text);
  }

  /** Attributes keyed by their qualified name, e.g. `xml:base`, `rdf:about`, `href`. */
  private static parseAttributes(tagBody: string, from: number): Map<string, string> {
    const attributes: Map<string, string> = new Map<string, string>();
    let i: number = from;
    while (i < tagBody.length) {
      while (i < tagBody.length && isSpace(tagBody.charAt(i))) {
        i += 1;
      }
      if (i >= tagBody.length) {
        break;
      }
      let nameStart: number = i;
      while (i < tagBody.length && isNameChar(tagBody.charAt(i))) {
        i += 1;
      }
      const attributeName: string = tagBody.substring(nameStart, i);
      if (attributeName.length === 0) {
        i += 1;
        continue;
      }
      while (i < tagBody.length && isSpace(tagBody.charAt(i))) {
        i += 1;
      }
      if (i >= tagBody.length || tagBody.charAt(i) !== '=') {
        // Valueless attribute, e.g. `<option selected>`.
        attributes.set(attributeName, '');
        continue;
      }
      i += 1;
      while (i < tagBody.length && isSpace(tagBody.charAt(i))) {
        i += 1;
      }
      if (i >= tagBody.length) {
        attributes.set(attributeName, '');
        break;
      }
      const quote: string = tagBody.charAt(i);
      let value: string = '';
      if (quote === '"' || quote === '\'') {
        i += 1;
        const end: number = tagBody.indexOf(quote, i);
        const stop: number = end < 0 ? tagBody.length : end;
        value = tagBody.substring(i, stop);
        i = end < 0 ? tagBody.length : end + 1;
      } else {
        const valueStart: number = i;
        while (i < tagBody.length && !isSpace(tagBody.charAt(i))) {
          i += 1;
        }
        value = tagBody.substring(valueStart, i);
      }
      attributes.set(attributeName, decodingHTMLEntities(value));
    }
    return attributes;
  }
}

/** Case-insensitive attribute lookup — the RSS parser's objectForCaseInsensitiveKey. */
export function attributeForCaseInsensitiveKey(attributes: Map<string, string>,
  key: string): string | undefined {
  const direct: string | undefined = attributes.get(key);
  if (direct !== undefined) {
    return direct;
  }
  const target: string = key.toLowerCase();
  let found: string | undefined = undefined;
  attributes.forEach((value: string, name: string) => {
    if (found === undefined && name.toLowerCase() === target) {
      found = value;
    }
  });
  return found;
}
