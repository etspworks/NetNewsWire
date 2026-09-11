/**
 * DateParser — port of Modules/RSParser/Sources/RSParser/Utilities/DateParser.swift
 *
 * Liberal parser for the two date shapes feeds use: RFC 822/2822 pubDate
 * ("Tue, 05 Aug 2025 09:12:00 -0700") and W3C / ISO 8601 ("2025-08-05T09:12:00Z").
 * Components are converted with Howard Hinnant's days-from-civil algorithm — pure
 * integer arithmetic, exactly as in the source, so no locale or calendar is involved.
 *
 * The Swift version scans UTF-8 bytes; this scans char codes, which is equivalent for
 * every byte a date string can contain.
 */

const ZERO: number = 48;   // '0'
const NINE: number = 57;   // '9'
const UPPER_A: number = 65;
const UPPER_Z: number = 90;
const LOWER_A: number = 97;
const LOWER_Z: number = 122;

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

function isAlpha(c: number): boolean {
  return (c >= UPPER_A && c <= UPPER_Z) || (c >= LOWER_A && c <= LOWER_Z);
}

function offsetSeconds(hours: number, minutes: number = 0): number {
  return hours < 0 ? hours * 3600 - minutes * 60 : hours * 3600 + minutes * 60;
}

/** Lowercased abbreviation -> offset in seconds. "gmt"/"utc" are handled as 0 separately. */
const TIME_ZONE_OFFSETS: Map<string, number> = buildTimeZoneOffsets();

function buildTimeZoneOffsets(): Map<string, number> {
  const m: Map<string, number> = new Map<string, number>();
  m.set('pdt', offsetSeconds(-7)); m.set('pst', offsetSeconds(-8));
  m.set('est', offsetSeconds(-5)); m.set('edt', offsetSeconds(-4));
  m.set('mdt', offsetSeconds(-6)); m.set('mst', offsetSeconds(-7));
  m.set('cst', offsetSeconds(-6)); m.set('cdt', offsetSeconds(-5));
  m.set('act', offsetSeconds(-8)); m.set('aft', offsetSeconds(4, 30));
  m.set('amt', offsetSeconds(4)); m.set('art', offsetSeconds(-3));
  m.set('ast', offsetSeconds(3)); m.set('azt', offsetSeconds(4));
  m.set('bit', offsetSeconds(-12)); m.set('bdt', offsetSeconds(8));
  m.set('acst', offsetSeconds(9, 30)); m.set('aest', offsetSeconds(10));
  m.set('akst', offsetSeconds(-9)); m.set('amst', offsetSeconds(5));
  m.set('awst', offsetSeconds(8)); m.set('azost', offsetSeconds(-1));
  m.set('biot', offsetSeconds(6)); m.set('brt', offsetSeconds(-3));
  m.set('bst', offsetSeconds(6)); m.set('btt', offsetSeconds(6));
  m.set('cat', offsetSeconds(2)); m.set('cct', offsetSeconds(6, 30));
  m.set('cet', offsetSeconds(1)); m.set('cest', offsetSeconds(2));
  m.set('chast', offsetSeconds(12, 45)); m.set('chst', offsetSeconds(10));
  m.set('cist', offsetSeconds(-8)); m.set('ckt', offsetSeconds(-10));
  m.set('clt', offsetSeconds(-4)); m.set('clst', offsetSeconds(-3));
  m.set('cot', offsetSeconds(-5)); m.set('cost', offsetSeconds(-4));
  m.set('cvt', offsetSeconds(-1)); m.set('cxt', offsetSeconds(7));
  m.set('east', offsetSeconds(-6)); m.set('eat', offsetSeconds(3));
  m.set('ect', offsetSeconds(-4)); m.set('eest', offsetSeconds(3));
  m.set('eet', offsetSeconds(2)); m.set('fjt', offsetSeconds(12));
  m.set('fkst', offsetSeconds(-4)); m.set('galt', offsetSeconds(-6));
  m.set('get', offsetSeconds(4)); m.set('gft', offsetSeconds(-3));
  m.set('gilt', offsetSeconds(7)); m.set('git', offsetSeconds(-9));
  m.set('gst', offsetSeconds(-2)); m.set('gyt', offsetSeconds(-4));
  m.set('hast', offsetSeconds(-10)); m.set('hkt', offsetSeconds(8));
  m.set('hmt', offsetSeconds(5)); m.set('irkt', offsetSeconds(8));
  m.set('irst', offsetSeconds(3, 30)); m.set('ist', offsetSeconds(2));
  m.set('jst', offsetSeconds(9)); m.set('krat', offsetSeconds(7));
  m.set('kst', offsetSeconds(9)); m.set('lhst', offsetSeconds(10, 30));
  m.set('lint', offsetSeconds(14)); m.set('magt', offsetSeconds(11));
  m.set('mit', offsetSeconds(-9, 30)); m.set('msk', offsetSeconds(3));
  m.set('mut', offsetSeconds(4)); m.set('ndt', offsetSeconds(-2, 30));
  m.set('nft', offsetSeconds(11, 30)); m.set('npt', offsetSeconds(5, 45));
  m.set('nt', offsetSeconds(-3, 30)); m.set('omst', offsetSeconds(6));
  m.set('pett', offsetSeconds(12)); m.set('phot', offsetSeconds(13));
  m.set('pkt', offsetSeconds(5)); m.set('ret', offsetSeconds(4));
  m.set('samt', offsetSeconds(4)); m.set('sast', offsetSeconds(2));
  m.set('sbt', offsetSeconds(11)); m.set('sct', offsetSeconds(4));
  m.set('slt', offsetSeconds(5, 30)); m.set('sst', offsetSeconds(8));
  m.set('taht', offsetSeconds(-10)); m.set('tha', offsetSeconds(7));
  m.set('uyt', offsetSeconds(-3)); m.set('uyst', offsetSeconds(-2));
  m.set('vet', offsetSeconds(-4, 30)); m.set('vlat', offsetSeconds(10));
  m.set('wat', offsetSeconds(1)); m.set('wet', offsetSeconds(0));
  m.set('west', offsetSeconds(1)); m.set('yakt', offsetSeconds(9));
  m.set('yekt', offsetSeconds(5));
  return m;
}

/** Scan cursor — Swift's `inout finalIndex`. */
class Scan {
  finalIndex: number = 0;
}

/**
 * Consume up to `maxDigits` digits from `startingIndex`, skipping leading non-digits.
 * Returns undefined when no digits were found; `scan.finalIndex` is the last index examined.
 */
function nextNumericValue(s: string, startingIndex: number, maxDigits: number,
  scan: Scan): number | undefined {
  const limit: number = maxDigits > 4 ? 4 : maxDigits;
  const end: number = s.length;
  let i: number = startingIndex;

  while (i < end) {
    if (isDigit(s.charCodeAt(i))) {
      break;
    }
    scan.finalIndex = i;
    i += 1;
  }
  if (i >= end) {
    return undefined;
  }

  let value: number = 0;
  let digitsRead: number = 0;
  while (i < end) {
    const c: number = s.charCodeAt(i);
    if (!isDigit(c)) {
      break;
    }
    value = value * 10 + (c - ZERO);
    digitsRead += 1;
    scan.finalIndex = i;
    i += 1;
    if (digitsRead >= limit) {
      break;
    }
  }
  return value;
}

/** Up to three letters interpreted as a month number, exactly as the source decides it. */
function nextMonthValue(s: string, startingIndex: number, scan: Scan): number | undefined {
  let c0: number = 0;
  let c1: number = 0;
  let c2: number = 0;
  let charsRead: number = 0;
  let i: number = startingIndex;

  while (i < s.length) {
    scan.finalIndex = i;
    const c: number = s.charCodeAt(i);
    if (!isAlpha(c)) {
      if (charsRead === 0) {
        i += 1;
        continue;
      }
      break;
    }
    const lower: number = c | 0x20;
    if (charsRead === 0) {
      if (lower === 102) { return 2; }   // f -> Feb
      if (lower === 115) { return 9; }   // s -> Sep
      if (lower === 111) { return 10; }  // o -> Oct
      if (lower === 110) { return 11; }  // n -> Nov
      if (lower === 100) { return 12; }  // d -> Dec
      c0 = lower;
    } else if (charsRead === 1) {
      c1 = lower;
    } else {
      c2 = lower;
    }
    charsRead += 1;
    if (charsRead >= 3) {
      break;
    }
    i += 1;
  }

  if (charsRead < 2) {
    return undefined;
  }
  if (c0 === 106) {                      // j
    if (c1 === 97) { return 1; }         // Jan
    if (c1 === 117) {                    // Ju…
      return (charsRead >= 3 && c2 === 110) ? 6 : 7;
    }
    return 1;
  }
  if (c0 === 109) {                      // m
    return (charsRead >= 3 && c2 === 121) ? 5 : 3;  // May : Mar
  }
  if (c0 === 97) {                       // a
    return c1 === 117 ? 8 : 4;           // Aug : Apr
  }
  return 1;
}

function parseNumericTimeZoneOffset(s: string, startingIndex: number): number {
  const isPlus: boolean = s.charAt(startingIndex) === '+';
  const end: number = s.length;
  let i: number = startingIndex + 1;

  let hours: number = 0;
  let hoursRead: number = 0;
  while (i < end && hoursRead < 2) {
    const c: number = s.charCodeAt(i);
    if (!isDigit(c)) {
      break;
    }
    hours = hours * 10 + (c - ZERO);
    hoursRead += 1;
    i += 1;
  }

  if (i < end && (s.charAt(i) === ':' || s.charAt(i) === ' ')) {
    i += 1;
  }

  let minutes: number = 0;
  let minutesRead: number = 0;
  while (i < end && minutesRead < 2) {
    const c: number = s.charCodeAt(i);
    if (!isDigit(c)) {
      break;
    }
    minutes = minutes * 10 + (c - ZERO);
    minutesRead += 1;
    i += 1;
  }

  if (hours === 0 && minutes === 0) {
    return 0;
  }
  const seconds: number = hours * 3600 + minutes * 60;
  return isPlus ? seconds : -seconds;
}

function lookupAlphaTimeZone(s: string, startingIndex: number): number {
  let abbreviation: string = '';
  let i: number = startingIndex;
  while (i < s.length && abbreviation.length < 5) {
    const c: number = s.charCodeAt(i);
    if (isAlpha(c)) {
      abbreviation += String.fromCharCode(c | 0x20);
      i += 1;
      continue;
    }
    if (s.charAt(i) === ':' || s.charAt(i) === ' ') {
      i += 1;
      continue;
    }
    break;
  }
  if (abbreviation.length === 0 || abbreviation === 'gmt' || abbreviation === 'utc') {
    return 0;
  }
  const offset: number | undefined = TIME_ZONE_OFFSETS.get(abbreviation);
  return offset === undefined ? 0 : offset;
}

function parsedTimeZoneOffset(s: string, startingIndex: number): number {
  let i: number = startingIndex;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === ' ' || c === ':') {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= s.length) {
    return 0;
  }
  const first: string = s.charAt(i);
  if (first === 'z' || first === 'Z') {
    return 0;
  }
  if (first === '+' || first === '-') {
    return parseNumericTimeZoneOffset(s, i);
  }
  if (isAlpha(s.charCodeAt(i))) {
    return lookupAlphaTimeZone(s, i);
  }
  return 0;
}

/**
 * Broken-down UTC components -> Date, via days-from-civil. No calendar, no locale.
 * https://howardhinnant.github.io/date_algorithms.html
 */
function dateWithComponents(year: number, month: number, day: number, hour: number,
  minute: number, second: number, milliseconds: number, timeZoneOffset: number): Date {
  const shiftedYear: number = month <= 2 ? year - 1 : year;
  const era: number = Math.trunc((shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400);
  const yearOfEra: number = shiftedYear - era * 400;
  const shiftedMonth: number = month > 2 ? month - 3 : month + 9;
  const dayOfYear: number = Math.trunc((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra: number = yearOfEra * 365 + Math.trunc(yearOfEra / 4)
    - Math.trunc(yearOfEra / 100) + dayOfYear;
  const daysSinceEpoch: number = era * 146097 + dayOfEra - 719468;

  const epochSeconds: number = daysSinceEpoch * 86400 + hour * 3600 + minute * 60
    + second - timeZoneOffset;
  let millis: number = epochSeconds * 1000;
  if (milliseconds > 0) {
    millis += milliseconds;
  }
  return new Date(millis);
}

function looksLikePubDate(s: string): boolean {
  return s.indexOf(' ') >= 0 || s.indexOf(',') >= 0;
}

function looksLikeW3CDate(s: string): boolean {
  for (let i: number = 0; i < s.length; i++) {
    const c: string = s.charAt(i);
    if (c === ' ' || c === '\r' || c === '\n' || c === '\t') {
      continue;
    }
    if (s.length - i < 5) {
      return false;
    }
    const separator: string = s.charAt(i + 4);
    return isDigit(s.charCodeAt(i)) && isDigit(s.charCodeAt(i + 1))
      && isDigit(s.charCodeAt(i + 2)) && isDigit(s.charCodeAt(i + 3))
      && (separator === '-' || separator === '/');
  }
  return false;
}

function parsePubDate(s: string): Date {
  const scan: Scan = new Scan();
  let day: number | undefined = nextNumericValue(s, 0, 2, scan);
  if (day === undefined || day < 1) {
    day = 1;
  }
  const monthValue: number | undefined = nextMonthValue(s, scan.finalIndex + 1, scan);
  const month: number = monthValue === undefined ? 1 : monthValue;

  let year: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 4, scan);
  if (year !== undefined && year < 100) {
    year = year + 2000;
  }

  const hourValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const hour: number = hourValue === undefined || hourValue < 0 ? 0 : hourValue;

  const minuteValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const minute: number = minuteValue === undefined || minuteValue < 0 ? 0 : minuteValue;

  let currentIndex: number = scan.finalIndex + 1;
  let second: number = 0;
  if (currentIndex < s.length && s.charAt(currentIndex) === ':') {
    const secondValue: number | undefined = nextNumericValue(s, currentIndex, 2, scan);
    second = secondValue === undefined ? 0 : secondValue;
  }

  currentIndex = scan.finalIndex + 1;
  let timeZoneOffset: number = 0;
  if (currentIndex < s.length && s.charAt(currentIndex) === ' ') {
    timeZoneOffset = parsedTimeZoneOffset(s, currentIndex);
  }

  return dateWithComponents(year === undefined ? 1970 : year, month, day, hour, minute,
    second, 0, timeZoneOffset);
}

function parseW3CDate(s: string): Date {
  const scan: Scan = new Scan();
  const yearValue: number | undefined = nextNumericValue(s, 0, 4, scan);
  const year: number = yearValue === undefined ? 1970 : yearValue;
  const monthValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const month: number = monthValue === undefined ? 1 : monthValue;
  const dayValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const day: number = dayValue === undefined ? 1 : dayValue;
  const hourValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const hour: number = hourValue === undefined ? 0 : hourValue;
  const minuteValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const minute: number = minuteValue === undefined ? 0 : minuteValue;
  const secondValue: number | undefined = nextNumericValue(s, scan.finalIndex + 1, 2, scan);
  const second: number = secondValue === undefined ? 0 : secondValue;

  let currentIndex: number = scan.finalIndex + 1;
  let milliseconds: number = 0;
  if (currentIndex < s.length && s.charAt(currentIndex) === '.') {
    const millisValue: number | undefined = nextNumericValue(s, currentIndex, 3, scan);
    milliseconds = millisValue === undefined ? 0 : millisValue;
    currentIndex = scan.finalIndex + 1;
    while (currentIndex < s.length && isDigit(s.charCodeAt(currentIndex))) {
      currentIndex += 1;
    }
  }

  const timeZoneOffset: number = parsedTimeZoneOffset(s, currentIndex);
  return dateWithComponents(year, month, day, hour, minute, second, milliseconds,
    timeZoneOffset);
}

/** DateParser.date(from:) — undefined for input that is too short or too long. */
export function parseDate(dateString?: string): Date | undefined {
  if (dateString === undefined) {
    return undefined;
  }
  const s: string = dateString;
  if (s.length < 6 || s.length > 150) {
    return undefined;
  }
  if (looksLikeW3CDate(s)) {
    return parseW3CDate(s);
  }
  if (looksLikePubDate(s)) {
    return parsePubDate(s);
  }
  return parseW3CDate(s);
}
