/**
 * DownloadResponse — port of Modules/RSWeb/Sources/RSWeb/DownloadResponse.swift
 *
 * The result of a successful Downloader download. URLResponse has no HarmonyOS analogue,
 * so the two things the app actually reads off it — status code and headers — are carried
 * directly (@ohos.net.http hands back exactly these).
 */

export class DownloadResponse {
  readonly data?: ArrayBuffer;
  readonly statusCode?: number;
  readonly headers?: Map<string, string>;
  readonly url?: string;
  /**
   * True when served without a network request — from the short-term cache or by
   * coalescing onto an in-progress download for the same URL.
   */
  readonly returnedFromCache: boolean;

  constructor(data?: ArrayBuffer, statusCode?: number, headers?: Map<string, string>,
    url?: string, returnedFromCache: boolean = false) {
    this.data = data;
    this.statusCode = statusCode;
    this.headers = headers;
    this.url = url;
    this.returnedFromCache = returnedFromCache;
  }
}
