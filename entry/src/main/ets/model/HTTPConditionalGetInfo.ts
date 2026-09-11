/**
 * HTTPConditionalGetInfo — port of Modules/RSWeb/Sources/RSWeb/HTTPConditionalGetInfo.swift
 */

export interface HTTPConditionalGetInfo {
  lastModified?: string;
  etag?: string;
}

/** The source init is failable: nil when both values are nil. */
export function makeConditionalGetInfo(lastModified?: string, etag?: string): HTTPConditionalGetInfo | undefined {
  if (lastModified === undefined && etag === undefined) {
    return undefined;
  }
  const info: HTTPConditionalGetInfo = { lastModified: lastModified, etag: etag };
  return info;
}

export function conditionalGetInfoFromHeaders(headers: Map<string, string>): HTTPConditionalGetInfo | undefined {
  return makeConditionalGetInfo(headers.get('Last-Modified'), headers.get('Etag'));
}

/**
 * Request headers for a conditional GET.
 * Bug seen in the wild: a Last-Modified with the last possible 32-bit date (2038) — ignore those.
 */
export function conditionalGetRequestHeaders(info: HTTPConditionalGetInfo): Map<string, string> {
  const headers: Map<string, string> = new Map<string, string>();
  const lastModified: string | undefined = info.lastModified;
  if (lastModified !== undefined && !lastModified.includes('2038')) {
    headers.set('If-Modified-Since', lastModified);
  }
  if (info.etag !== undefined) {
    headers.set('If-None-Match', info.etag);
  }
  return headers;
}
