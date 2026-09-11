/**
 * Urls — the URL helpers the parsers, downloaders and feed finder need.
 *
 * Ports of RSCore's `String.normalizedURL`, RSWeb's `SpecialCase` / URL extensions,
 * and the `URL(string:relativeTo:)` resolution the RSS/Atom/HTML parsers rely on.
 * `@ohos.url` URL is the Foundation URL replacement; every call is guarded because
 * it throws on malformed input where Foundation returned nil.
 */

import url from '@ohos.url';
import { trimmingWhitespace, strippingPrefix } from './Strings';

/** Parses a URL, optionally against a base. Returns undefined instead of throwing. */
export function parseURL(input: string, base?: string): url.URL | undefined {
  try {
    if (base !== undefined && base.length > 0) {
      return new url.URL(input, base);
    }
    return new url.URL(input);
  } catch (e) {
    return undefined;
  }
}

/** Absolute form of `input` resolved against `base` — Foundation's URL(string:relativeTo:). */
export function resolveURL(input: string, base?: string): string | undefined {
  const parsed: url.URL | undefined = parseURL(input, base);
  return parsed === undefined ? undefined : parsed.href;
}

export function hostOf(urlString: string): string | undefined {
  const parsed: url.URL | undefined = parseURL(urlString);
  if (parsed === undefined) {
    return undefined;
  }
  const hostname: string = parsed.hostname;
  return hostname.length === 0 ? undefined : hostname;
}

export function schemeOf(urlString: string): string | undefined {
  const parsed: url.URL | undefined = parseURL(urlString);
  if (parsed === undefined) {
    return undefined;
  }
  // `protocol` includes the trailing colon.
  const protocol: string = parsed.protocol;
  return protocol.length === 0 ? undefined : protocol.substring(0, protocol.length - 1);
}

export function pathOf(urlString: string): string {
  const parsed: url.URL | undefined = parseURL(urlString);
  return parsed === undefined ? '' : parsed.pathname;
}

/** Last path component, e.g. "favicon.ico". */
export function lastPathComponent(urlString: string): string {
  const path: string = pathOf(urlString);
  const parts: string[] = path.split('/');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

export function pathExtension(urlString: string): string {
  const last: string = lastPathComponent(urlString);
  const dot: number = last.lastIndexOf('.');
  return dot < 0 ? '' : last.substring(dot + 1);
}

export function isHTTPOrHTTPSURL(urlString: string): boolean {
  const lower: string = urlString.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/** Appends a suffix to the URL's PATH (micro.blog's `<path>.json` retry). */
export function appendingPathSuffix(urlString: string, suffix: string): string | undefined {
  const parsed: url.URL | undefined = parseURL(urlString);
  if (parsed === undefined) {
    return undefined;
  }
  parsed.pathname = parsed.pathname + suffix;
  return parsed.href;
}

/** Drops the query and fragment, keeping scheme/host/path. */
export function strippingQueryAndFragment(urlString: string): string {
  const parsed: url.URL | undefined = parseURL(urlString);
  if (parsed === undefined) {
    return urlString;
  }
  parsed.search = '';
  const href: string = parsed.href;
  const hash: number = href.indexOf('#');
  return hash < 0 ? href : href.substring(0, hash);
}

/** Appends a path component, keeping exactly one slash between the parts. */
export function appendingPathComponent(urlString: string, component: string,
  isDirectory: boolean = false): string {
  let base: string = urlString;
  if (!base.endsWith('/')) {
    base += '/';
  }
  const appended: string = base + component;
  return isDirectory && !appended.endsWith('/') ? appended + '/' : appended;
}

/**
 * RSCore's `String.normalizedURL`: strips a feed:/feeds: scheme, adds http(s):// when the
 * scheme is missing, and adds the trailing slash on a bare host.
 */
export function normalizedURL(input: string): string {
  let s: string = trimmingWhitespace(input);
  let wasFeeds: boolean = false;
  let lower: string = s.toLowerCase();

  if (lower.startsWith('feeds:')) {
    wasFeeds = true;
    s = strippingPrefix(s, 'feeds:');
  } else if (lower.startsWith('feed:')) {
    s = strippingPrefix(s, 'feed:');
  }

  if (s.startsWith('//')) {
    s = strippingPrefix(s, '//', true);
  }

  lower = s.toLowerCase();
  if (!lower.startsWith('http')) {
    s = (wasFeeds ? 'https' : 'http') + '://' + s;
  }

  // A top-level URL with no trailing slash gets one: https://ranchero.com -> .../
  if (s.split('/').length === 3) {
    s = s + '/';
  }
  return s;
}

// MARK: - SpecialCase (RSWeb/SpecialCases.swift)

export class SpecialCase {
  static readonly rachelByTheBayHostName: string = 'rachelbythebay.com';
  static readonly openRSSOrgHostName: string = 'openrss.org';
  static readonly youtubeHostName: string = 'youtube.com';
  static readonly redditHostName: string = 'reddit.com';
  static readonly relayFMHostName: string = 'relay.fm';

  static urlStringContainSpecialCase(urlString: string, specialCases: string[]): boolean {
    const lower: string = urlString.toLowerCase();
    for (const specialCase of specialCases) {
      if (lower.indexOf(specialCase) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** Host-only match; a leading `www.` is optional and subdomains match. */
  static urlStringMatchesDomain(urlString: string, domains: string[]): boolean {
    const host: string | undefined = hostOf(urlString);
    if (host === undefined) {
      return false;
    }
    let normalizedHost: string = host.toLowerCase();
    if (normalizedHost.startsWith('www.')) {
      normalizedHost = normalizedHost.substring(4);
    }
    for (const domain of domains) {
      if (domain.length === 0) {
        continue;
      }
      if (normalizedHost === domain || normalizedHost.endsWith('.' + domain)) {
        return true;
      }
    }
    return false;
  }
}

export function isOpenRSSOrgURL(urlString: string): boolean {
  const host: string | undefined = hostOf(urlString);
  return host === undefined
    ? false
    : SpecialCase.urlStringContainSpecialCase(host, [SpecialCase.openRSSOrgHostName]);
}

export function isRachelByTheBayURL(urlString: string): boolean {
  const host: string | undefined = hostOf(urlString);
  return host === undefined
    ? false
    : SpecialCase.urlStringContainSpecialCase(host, [SpecialCase.rachelByTheBayHostName]);
}

export function isYoutubeURL(urlString: string): boolean {
  const host: string | undefined = hostOf(urlString);
  return host === undefined
    ? false
    : SpecialCase.urlStringContainSpecialCase(host, [SpecialCase.youtubeHostName]);
}

export function isRedditURL(urlString: string): boolean {
  return SpecialCase.urlStringMatchesDomain(urlString, [SpecialCase.redditHostName]);
}
