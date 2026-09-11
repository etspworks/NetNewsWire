/**
 * ArticleExtractor — port of Shared/Article Extractor/ArticleExtractor.swift.
 *
 * Reader View. The article link is HMAC-SHA1 signed with the Mercury client secret and
 * sent base64-encoded to extract.feedbin.com; the four states drive the reader-view button.
 *
 * SecretKey.mercuryClientID / .mercuryClientSecret were Xcode build-time secrets with no
 * self-signed equivalent, so they are read from preferences (settable on the Settings
 * screen). Without them the extractor reports `failedToParse` with a "not configured"
 * message rather than issuing an unsigned request — and the article view falls back to
 * the ORIGINAL body, never a blank page.
 */

import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ExtractedArticle, ExtractedArticleKeys } from '../../model/ExtractedArticle';
import { DownloadResponse } from '../../model/DownloadResponse';
import { AppDefaults } from '../prefs/AppDefaults';
import { Downloader, UserAgentStyle, responseIsOK } from '../net/DownloadSession';
import {
  JsonObject, getNumber, getString, parseJsonObject
} from '../util/Json';
import { parseURL } from '../util/Urls';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleExtractor';

const clientURL: string = 'https://extract.feedbin.com/parser';

export enum ArticleExtractorState {
  ready = 'ready',
  processing = 'processing',
  failedToParse = 'failedToParse',
  complete = 'complete',
  cancelled = 'cancelled'
}

/** Preference keys for the credentials Xcode injected at build time. */
export class MercuryKeys {
  static readonly clientIDKey: string = 'mercuryClientID';
  static readonly clientSecretKey: string = 'mercuryClientSecret';
}

export interface ArticleExtractorDelegate {
  articleExtractionDidFail(error: Error): void;
  articleExtractionDidComplete(extractedArticle: ExtractedArticle): void;
}

/** Lowercase-hex HMAC-SHA1, the Swift `String.hmacUsingSHA1(key:)`. */
export function hmacSHA1Hex(message: string, key: string): string {
  const encoder: util.TextEncoder = new util.TextEncoder();
  const generator: cryptoFramework.SymKeyGenerator = cryptoFramework.createSymKeyGenerator('HMAC');
  const keyBlob: cryptoFramework.DataBlob = { data: encoder.encodeInto(key) };
  const symKey: cryptoFramework.SymKey = generator.convertKeySync(keyBlob);
  const mac: cryptoFramework.Mac = cryptoFramework.createMac('SHA1');
  mac.initSync(symKey);
  const input: cryptoFramework.DataBlob = { data: encoder.encodeInto(message) };
  mac.updateSync(input);
  const digest: cryptoFramework.DataBlob = mac.doFinalSync();

  const hexDigits: string = '0123456789abcdef';
  let out: string = '';
  for (let i: number = 0; i < digest.data.length; i++) {
    const b: number = digest.data[i];
    out += hexDigits.charAt((b >> 4) & 0x0f);
    out += hexDigits.charAt(b & 0x0f);
  }
  return out;
}

/**
 * Site-specific transformations. Naver Blog's desktop URLs are a JavaScript-heavy SPA the
 * extractor cannot parse; the mobile host renders static HTML.
 */
export function specialCaseExtractionLink(articleLink: string): string | undefined {
  const parsed = parseURL(articleLink);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.host.toLowerCase() !== 'blog.naver.com') {
    return undefined;
  }
  parsed.host = 'm.blog.naver.com';
  parsed.search = '';
  return parsed.href;
}

function decodeExtractedArticle(json: JsonObject): ExtractedArticle {
  const article: ExtractedArticle = {
    title: getString(json, ExtractedArticleKeys.title),
    author: getString(json, ExtractedArticleKeys.author),
    datePublished: getString(json, ExtractedArticleKeys.datePublished),
    dek: getString(json, ExtractedArticleKeys.dek),
    leadImageURL: getString(json, ExtractedArticleKeys.leadImageURL),
    content: getString(json, ExtractedArticleKeys.content),
    nextPageURL: getString(json, ExtractedArticleKeys.nextPageURL),
    url: getString(json, ExtractedArticleKeys.url),
    domain: getString(json, ExtractedArticleKeys.domain),
    excerpt: getString(json, ExtractedArticleKeys.excerpt),
    wordCount: getNumber(json, ExtractedArticleKeys.wordCount),
    direction: getString(json, ExtractedArticleKeys.direction),
    totalPages: getNumber(json, ExtractedArticleKeys.totalPages),
    renderedPages: getNumber(json, ExtractedArticleKeys.renderedPages)
  };
  return article;
}

export class ArticleExtractor {
  readonly articleLink: string;
  private readonly delegate: ArticleExtractorDelegate;
  private readonly url: string;

  article?: ExtractedArticle;
  state: ArticleExtractorState = ArticleExtractorState.ready;

  private constructor(articleLink: string, delegate: ArticleExtractorDelegate, url: string) {
    this.articleLink = articleLink;
    this.delegate = delegate;
    this.url = url;
  }

  /** Returns undefined when the link or the credentials cannot produce a request URL. */
  static create(articleLink: string,
    delegate: ArticleExtractorDelegate): ArticleExtractor | undefined {
    const username: string | undefined = AppDefaults.stringValue(MercuryKeys.clientIDKey);
    const secret: string | undefined = AppDefaults.stringValue(MercuryKeys.clientSecretKey);
    if (username === undefined || username.length === 0
      || secret === undefined || secret.length === 0) {
      hilog.warn(DOMAIN, TAG, 'Reader View is not configured: no Mercury client credentials');
      return undefined;
    }

    const special: string | undefined = specialCaseExtractionLink(articleLink);
    const articleLinkToUse: string = special === undefined ? articleLink : special;
    const signature: string = hmacSHA1Hex(articleLinkToUse, secret);

    const encoder: util.TextEncoder = new util.TextEncoder();
    const base64Helper: util.Base64Helper = new util.Base64Helper();
    const base64URL: string = base64Helper.encodeToStringSync(encoder.encodeInto(articleLinkToUse));

    const fullURL: string = clientURL + '/' + username + '/' + signature + '?base64_url='
      + encodeURIComponent(base64URL);
    if (parseURL(fullURL) === undefined) {
      return undefined;
    }
    return new ArticleExtractor(articleLink, delegate, fullURL);
  }

  /** True when Reader View can run at all — the Settings screen surfaces this. */
  static isConfigured(): boolean {
    const username: string | undefined = AppDefaults.stringValue(MercuryKeys.clientIDKey);
    const secret: string | undefined = AppDefaults.stringValue(MercuryKeys.clientSecretKey);
    return username !== undefined && username.length > 0
      && secret !== undefined && secret.length > 0;
  }

  async process(): Promise<void> {
    this.state = ArticleExtractorState.processing;

    let response: DownloadResponse;
    try {
      response = await Downloader.shared.download(this.url, UserAgentStyle.browser);
    } catch (e) {
      this.fail(new Error('The article could not be downloaded for Reader View.'));
      return;
    }
    // `guard self.state != .cancelled` — cancel() may have run during the await.
    if (this.isCancelled()) {
      return;
    }

    const data: ArrayBuffer | undefined = response.data;
    if (data === undefined || !responseIsOK(response)) {
      this.fail(new Error('The article could not be downloaded for Reader View.'));
      return;
    }

    const options: util.TextDecoderOptions = { ignoreBOM: true };
    const text: string =
      util.TextDecoder.create('utf-8', options).decodeToString(new Uint8Array(data));
    const json: JsonObject | undefined = parseJsonObject(text);
    if (json === undefined) {
      this.fail(new Error('The Reader View response could not be decoded.'));
      return;
    }

    const decoded: ExtractedArticle = decodeExtractedArticle(json);
    this.article = decoded;
    if (decoded.content === undefined) {
      this.fail(new Error('The Reader View response had no content.'));
      return;
    }
    this.state = ArticleExtractorState.complete;
    this.delegate.articleExtractionDidComplete(decoded);
  }

  cancel(): void {
    this.state = ArticleExtractorState.cancelled;
  }

  /** Read in its own scope so `state`'s value is the live one, not the last one assigned. */
  private isCancelled(): boolean {
    return this.state === ArticleExtractorState.cancelled;
  }

  private fail(error: Error): void {
    if (this.isCancelled()) {
      return;
    }
    this.state = ArticleExtractorState.failedToParse;
    this.delegate.articleExtractionDidFail(error);
  }
}
