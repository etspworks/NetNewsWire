/**
 * Strings — the RSCore / RSParser string helpers the rest of the data layer needs.
 *
 * Ports of:
 *   String+RSCore.swift          collapsingWhitespace, trimmingWhitespace,
 *                                escapingSpecialXMLCharacters, prepending(tabCount:),
 *                                caseInsensitiveContains, stripping(prefix:)
 *   StripHTML.swift              strippingHTML
 *   String+HTMLEntities.swift    decodingHTMLEntities
 *   SearchTable.swift            normalizedForSearchIndex
 *
 * The Swift versions scan UTF-8 bytes for speed; these scan UTF-16 code units, which
 * produces the same text for every input the parsers see.
 */

/** Entity name -> replacement. HTML4 named entities plus the XML predefined five. */
const NAMED_ENTITIES: Map<string, string> = buildNamedEntities();

function buildNamedEntities(): Map<string, string> {
  const m: Map<string, string> = new Map<string, string>();
  // XML predefined.
  m.set('amp', '&');
  m.set('lt', '<');
  m.set('gt', '>');
  m.set('quot', '"');
  m.set('apos', '\'');
  // Latin-1 supplement.
  const latin1: string = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo '
    + 'not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo '
    + 'frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave '
    + 'Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml '
    + 'times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde '
    + 'auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde '
    + 'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
  const latin1Names: string[] = latin1.split(' ');
  for (let i: number = 0; i < latin1Names.length; i++) {
    m.set(latin1Names[i], String.fromCharCode(160 + i));
  }
  // The punctuation / symbol entities feeds actually use.
  m.set('OElig', 'Œ');
  m.set('oelig', 'œ');
  m.set('Scaron', 'Š');
  m.set('scaron', 'š');
  m.set('Yuml', 'Ÿ');
  m.set('fnof', 'ƒ');
  m.set('circ', 'ˆ');
  m.set('tilde', '˜');
  m.set('ensp', ' ');
  m.set('emsp', ' ');
  m.set('thinsp', ' ');
  m.set('zwnj', '‌');
  m.set('zwj', '‍');
  m.set('lrm', '‎');
  m.set('rlm', '‏');
  m.set('ndash', '–');
  m.set('mdash', '—');
  m.set('lsquo', '‘');
  m.set('rsquo', '’');
  m.set('sbquo', '‚');
  m.set('ldquo', '“');
  m.set('rdquo', '”');
  m.set('bdquo', '„');
  m.set('dagger', '†');
  m.set('Dagger', '‡');
  m.set('bull', '•');
  m.set('hellip', '…');
  m.set('permil', '‰');
  m.set('prime', '′');
  m.set('Prime', '″');
  m.set('lsaquo', '‹');
  m.set('rsaquo', '›');
  m.set('oline', '‾');
  m.set('frasl', '⁄');
  m.set('euro', '€');
  m.set('trade', '™');
  m.set('larr', '←');
  m.set('uarr', '↑');
  m.set('rarr', '→');
  m.set('darr', '↓');
  m.set('harr', '↔');
  m.set('minus', '−');
  m.set('lowast', '∗');
  m.set('ne', '≠');
  m.set('le', '≤');
  m.set('ge', '≥');
  m.set('loz', '◊');
  m.set('spades', '♠');
  m.set('clubs', '♣');
  m.set('hearts', '♥');
  m.set('diams', '♦');
  m.set('alpha', 'α');
  m.set('beta', 'β');
  m.set('gamma', 'γ');
  m.set('delta', 'δ');
  m.set('pi', 'π');
  m.set('sigma', 'σ');
  m.set('omega', 'ω');
  m.set('Omega', 'Ω');
  m.set('infin', '∞');
  return m;
}

/** Foundation's `.whitespacesAndNewlines`: ASCII whitespace plus the Unicode spaces. */
function isWhitespaceChar(c: string): boolean {
  const code: number = c.charCodeAt(0);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0D)) {
    return true;
  }
  if (code === 0x85 || code === 0xA0) {
    return true;
  }
  return (code >= 0x2000 && code <= 0x200A) || code === 0x2028 || code === 0x2029
    || code === 0x202F || code === 0x205F || code === 0x3000;
}

/** Trims leading and trailing whitespace / newlines. */
export function trimmingWhitespace(s: string): string {
  let start: number = 0;
  let end: number = s.length;
  while (start < end && isWhitespaceChar(s.charAt(start))) {
    start += 1;
  }
  while (end > start && isWhitespaceChar(s.charAt(end - 1))) {
    end -= 1;
  }
  return s.substring(start, end);
}

/**
 * Collapses runs of whitespace into a single space, dropping leading and trailing
 * whitespace — RSCore's `collapsingWhitespace`.
 */
export function collapsingWhitespace(s: string): string {
  let out: string = '';
  let sawNonSpace: boolean = false;
  let pendingSpace: boolean = false;
  for (let i: number = 0; i < s.length; i++) {
    const c: string = s.charAt(i);
    if (isWhitespaceChar(c)) {
      if (sawNonSpace) {
        pendingSpace = true;
      }
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    sawNonSpace = true;
    out += c;
  }
  return out;
}

/** RSCore's `escapingSpecialXMLCharacters` — escapes &, <, > and " (never '). */
export function escapingSpecialXMLCharacters(s: string): string {
  let escaped: string = '';
  for (let i: number = 0; i < s.length; i++) {
    const c: string = s.charAt(i);
    if (c === '&') {
      escaped += '&amp;';
    } else if (c === '<') {
      escaped += '&lt;';
    } else if (c === '>') {
      escaped += '&gt;';
    } else if (c === '"') {
      escaped += '&quot;';
    } else {
      escaped += c;
    }
  }
  return escaped;
}

/** RSCore's `prepending(tabCount:)`. */
export function prependingTabs(s: string, tabCount: number): string {
  let tabs: string = '';
  for (let i: number = 0; i < tabCount; i++) {
    tabs += '\t';
  }
  return tabs + s;
}

export function caseInsensitiveContains(s: string, other: string): boolean {
  return s.toLowerCase().indexOf(other.toLowerCase()) >= 0;
}

/** RSCore's `stripping(prefix:)` — case-insensitive by default, anchored. */
export function strippingPrefix(s: string, prefix: string, caseSensitive: boolean = false): string {
  if (caseSensitive) {
    return s.startsWith(prefix) ? s.substring(prefix.length) : s;
  }
  return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s.substring(prefix.length) : s;
}

interface DecodedEntity {
  text: string;
  nextIndex: number;
}

function decodeEntityAt(s: string, index: number): DecodedEntity {
  const literalAmpersand: DecodedEntity = { text: '&', nextIndex: index + 1 };
  // s.charAt(index) is '&'. Find the terminating ';' within a plausible span.
  const limit: number = Math.min(s.length, index + 34);
  let semicolon: number = -1;
  for (let i: number = index + 1; i < limit; i++) {
    const c: string = s.charAt(i);
    if (c === ';') {
      semicolon = i;
      break;
    }
    if (c === '&' || isWhitespaceChar(c)) {
      break;
    }
  }
  if (semicolon < 0) {
    return literalAmpersand;
  }
  const body: string = s.substring(index + 1, semicolon);
  if (body.length === 0) {
    return literalAmpersand;
  }
  if (body.charAt(0) === '#') {
    const isHex: boolean = body.charAt(1) === 'x' || body.charAt(1) === 'X';
    const digits: string = isHex ? body.substring(2) : body.substring(1);
    const value: number = Number.parseInt(digits, isHex ? 16 : 10);
    if (Number.isNaN(value) || value <= 0 || value > 0x10FFFF) {
      return literalAmpersand;
    }
    const numeric: DecodedEntity = {
      text: String.fromCodePoint(value),
      nextIndex: semicolon + 1
    };
    return numeric;
  }
  const named: string | undefined = NAMED_ENTITIES.get(body);
  if (named === undefined) {
    return literalAmpersand;
  }
  const decoded: DecodedEntity = { text: named, nextIndex: semicolon + 1 };
  return decoded;
}

/** RSParser's `decodingHTMLEntities()` — named, decimal and hex refs; unknown pass through. */
export function decodingHTMLEntities(s: string): string {
  if (s.indexOf('&') < 0) {
    return s;
  }
  let out: string = '';
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === '&') {
      const decoded: DecodedEntity = decodeEntityAt(s, i);
      out += decoded.text;
      i = decoded.nextIndex;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const BLOCK_TAGS: string[] = ['p>', '/p>', 'div>', '/div>', 'blockquote>', '/blockquote>',
  'br>', 'br/>', 'br />', '/li>'];

function matchesAt(lower: string, position: number, needle: string): boolean {
  return lower.startsWith(needle, position);
}

/**
 * RSCore's `strippingHTML(maxCharacters:)`. Removes tags, discards script/style bodies,
 * injects a space for block-level tags, collapses whitespace, trims. Entities are NOT
 * decoded here — same as the source.
 */
export function strippingHTML(s: string, maxCharacters: number = 0): string {
  if (s.length === 0) {
    return '';
  }
  const lower: string = s.toLowerCase();
  let out: string = '';
  let i: number = 0;
  let tagLevel: number = 0;
  let inScript: boolean = false;
  let inStyle: boolean = false;
  let lastWasSpace: boolean = true;
  let charactersAdded: number = 0;
  let inQuote: boolean = false;
  let quoteChar: string = '';

  while (i < s.length) {
    if (maxCharacters > 0 && charactersAdded >= maxCharacters) {
      break;
    }
    const c: string = s.charAt(i);

    if (c === '<') {
      if (inQuote) {
        i += 1;
        continue;
      }
      if (!inScript && !inStyle) {
        tagLevel += 1;
      }
      if (matchesAt(lower, i + 1, 'script')) {
        inScript = true;
      } else if (matchesAt(lower, i + 1, 'style')) {
        inStyle = true;
      } else if (matchesAt(lower, i + 1, '/script')) {
        inScript = false;
      } else if (matchesAt(lower, i + 1, '/style')) {
        inStyle = false;
      }
      let isBlockTag: boolean = false;
      for (const tag of BLOCK_TAGS) {
        if (matchesAt(lower, i + 1, tag)) {
          isBlockTag = true;
          break;
        }
      }
      if (isBlockTag && !lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
        charactersAdded += 1;
      }
      i += 1;
      continue;
    }

    if (c === '>') {
      if (inQuote) {
        i += 1;
        continue;
      }
      if (!inScript && !inStyle && tagLevel > 0) {
        tagLevel -= 1;
      }
      i += 1;
      continue;
    }

    if (tagLevel > 0 && !inScript && !inStyle && (c === '"' || c === '\'')) {
      if (inQuote) {
        if (c === quoteChar) {
          inQuote = false;
        }
      } else {
        inQuote = true;
        quoteChar = c;
      }
      i += 1;
      continue;
    }

    if (tagLevel > 0 || inScript || inStyle) {
      i += 1;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
        charactersAdded += 1;
      }
      i += 1;
      continue;
    }

    lastWasSpace = false;
    out += c;
    charactersAdded += 1;
    i += 1;
  }

  while (out.length > 0 && out.charAt(out.length - 1) === ' ') {
    out = out.substring(0, out.length - 1);
  }
  return out;
}

// The search table's tokenizer treats non-ASCII punctuation and symbols as word
// characters, so "'BeReal'" would index as a token a search for "bereal" can't match.
// Same rule as SearchTable.swift's `normalizedForSearchIndex`.
const PUNCTUATION_OR_SYMBOL: RegExp =
  /[!-\/:-@\[-`{-~¡-¿×÷‐-‧‰-⁞←-⯿、-〿！-＠]/g;

export function normalizedForSearchIndex(s: string): string {
  if (!PUNCTUATION_OR_SYMBOL.test(s)) {
    PUNCTUATION_OR_SYMBOL.lastIndex = 0;
    return s;
  }
  PUNCTUATION_OR_SYMBOL.lastIndex = 0;
  return collapsingWhitespace(s.replace(PUNCTUATION_OR_SYMBOL, ' '));
}
