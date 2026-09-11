/**
 * ArticleWebView (the migrated WebViewController; the web view screen
 * is deferred INTO this component).
 * Source: iOS/Article/WebViewController.swift + PreloadedWebView.swift.
 *
 * The Web component that renders the HTML ArticleRenderer produced, plus everything
 * WKWebView did for the source:
 *   - the JS bridge. The ported article scripts still post through
 *     `window.webkit.messageHandlers.<name>.postMessage(body)`, so a tiny shim maps those
 *     four names onto ONE typed ArkTS proxy method (`post(name, body)`), and this component
 *     decodes each message into a typed callback. There is no WKUserScript on HarmonyOS:
 *     ArticleRenderer.pageHTML already inlines main.js / main_ios.js / newsfoot.js, and the
 *     shim is inserted ahead of them.
 *   - onInterceptRequest replaces WKContentRuleList (ArticleRenderer.shouldBlockURL).
 *   - onLoadIntercept replaces decidePolicyFor: http(s) opens the browser (system or in-app),
 *     mailto/tel hand off to the system, and a media source URL is never navigated.
 *   - the avatar <img> in the template uses the `nnwImageIcon:<articleID>` scheme, which the
 *     source served with a WKURLSchemeHandler. HarmonyOS would need a process-wide
 *     customizeSchemes registration for that, so the resolved icon URL is substituted into
 *     the document instead — the same bytes from IconImageCache, one moving part fewer.
 *   - the coalesced window.scrollY write-back, the top/bottom show-bars tap zones and
 *     stopWebViewActivity.
 */

import webview from '@ohos.web.webview';
import util from '@ohos.util';
import common from '@ohos.app.ability.common';
import Want from '@ohos.app.ability.Want';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { imageIconScheme, shouldBlockURL } from '../common/article/ArticleRenderer';
import { BrowserService } from '../common/system/BrowserService';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { JsonObject, getNumber, getString, getStringArray, parseJsonObject } from '../common/util/Json';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleWebView';
/** The empty document the Web starts on; every article arrives through loadData. */
const bootstrapDocument: string = 'article/blank.html';
/** 1x1 transparent GIF — the avatar <img> src while the feed icon is still downloading. */
const transparentPixel: string =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The source's WebViewController.MessageName. */
export class ArticleMessageName {
  static readonly imageWasClicked: string = 'imageWasClicked';
  static readonly imageWasShown: string = 'imageWasShown';
  static readonly showFeedInspector: string = 'showFeedInspector';
  static readonly mediaSourceURLs: string = 'mediaSourceURLs';
}

/** The source's ImageClickMessage. */
export class ImageClickMessage {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageTitle: string;
  readonly imageURL: string;

  constructor(x: number, y: number, width: number, height: number, imageTitle: string,
    imageURL: string) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.imageTitle = imageTitle;
    this.imageURL = imageURL;
  }
}

/** The count + selected index the find engine returns (the source's FindInArticleState). */
export class FindInArticleState {
  readonly count: number;
  readonly index: number;

  constructor(count: number, index: number) {
    this.count = count;
    this.index = index;
  }
}

/**
 * The command channel the article page drives the web view through — the ArkUI controller
 * pattern (like WebviewController itself). State flows back the other way through the
 * component's typed callbacks.
 */
export class ArticleWebViewBridge {
  updateFind?: (text: string) => void;
  selectNextResult?: () => void;
  selectPreviousResult?: () => void;
  endFind?: () => void;
  reloadArticleImage?: (imageSrc: string) => void;
  showClickedImage?: () => void;
  hideClickedImage?: () => void;
  stopWebViewActivity?: () => void;
}

/** The registered JavaScript object. ONE narrow method, so the contract stays typed. */
class ArticleWebBridgeObject {
  handler?: (name: string, body: string) => void;

  post(name: string, body: string): void {
    const handler: ((name: string, body: string) => void) | undefined = this.handler;
    if (handler !== undefined) {
      handler(name, body);
    }
  }
}

/** window.webkit.messageHandlers -> the ArkTS proxy. Inserted at the top of <head>. */
const bridgeShim: string = '<script type="text/javascript">\n'
  + '(function(){\n'
  + '  function nnwHandler(name){\n'
  + '    return { postMessage: function(body){\n'
  + '      try { nnwArkBridge.post(name, typeof body === "string" ? body : JSON.stringify(body)); }\n'
  + '      catch (e) { }\n'
  + '    } };\n'
  + '  }\n'
  + '  window.webkit = window.webkit || {};\n'
  + '  window.webkit.messageHandlers = {\n'
  + '    imageWasClicked: nnwHandler("imageWasClicked"),\n'
  + '    imageWasShown: nnwHandler("imageWasShown"),\n'
  + '    showFeedInspector: nnwHandler("showFeedInspector"),\n'
  + '    mediaSourceURLs: nnwHandler("mediaSourceURLs")\n'
  + '  };\n'
  + '})();\n'
  + '</script>\n';

@Component
export struct ArticleWebView {
  /** The complete document from ArticleRenderer — a @Prop so a re-render reloads it. */
  @Prop @Watch('onHTMLChanged') html: string = '';
  /** ArticleRenderer.Rendering.baseURL. */
  @Prop baseURL: string = '';
  /** The current article's id — the `nnwImageIcon:<articleID>` avatar src to rewrite. */
  @Prop articleID: string = '';
  /** The resolved feed-icon URL IconImageCache holds for this article, if any. */
  @Prop avatarURL: string = '';
  /** AppDefaults.logicalArticleFullscreenEnabled — the show-bars zones only exist while hidden. */
  @Link barsHidden: boolean;

  /** The page's command channel; filled in aboutToAppear. */
  bridge: ArticleWebViewBridge = new ArticleWebViewBridge();

  onShowBars?: () => void;
  onImageClicked?: (message: ImageClickMessage) => void;
  onImageWasShown?: () => void;
  onShowFeedInspector?: () => void;
  onFindStateChanged?: (state: FindInArticleState) => void;

  private controller: webview.WebviewController = new webview.WebviewController();
  private controllerReady: boolean = false;
  private loadedHTML: string = '';
  private mediaSourceURLs: Set<string> = new Set<string>();
  private scrollTimer: number = -1;
  private pendingScrollY: number = 0;
  private bridgeObject: ArticleWebBridgeObject = new ArticleWebBridgeObject();
  private blockedResponse: WebResourceResponse = new WebResourceResponse();

  aboutToAppear(): void {
    this.bridgeObject.handler = (name: string, body: string): void => {
      this.onBridgeMessage(name, body);
    };
    this.bridge.updateFind = (text: string): void => {
      this.updateFind(text);
    };
    this.bridge.selectNextResult = (): void => {
      this.evaluate('selectNextResult()');
    };
    this.bridge.selectPreviousResult = (): void => {
      this.evaluate('selectPreviousResult()');
    };
    this.bridge.endFind = (): void => {
      this.evaluate('endFind()');
    };
    this.bridge.reloadArticleImage = (imageSrc: string): void => {
      this.evaluate('reloadArticleImage("' + imageSrc + '")');
    };
    this.bridge.showClickedImage = (): void => {
      this.evaluate('showClickedImage();');
    };
    this.bridge.hideClickedImage = (): void => {
      this.evaluate('hideClickedImage();');
    };
    this.bridge.stopWebViewActivity = (): void => {
      this.stopWebViewActivity();
    };
  }

  aboutToDisappear(): void {
    // The source pauses in-flight media before the view goes away.
    this.stopWebViewActivity();
    if (this.scrollTimer !== -1) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = -1;
    }
  }

  /** @Watch on the html prop — the page re-rendered, so reload the document. */
  private onHTMLChanged(): void {
    this.renderPage();
  }

  private renderPage(): void {
    if (!this.controllerReady || this.html.length === 0 || this.html === this.loadedHTML) {
      return;
    }
    this.loadedHTML = this.html;
    try {
      const base: string = this.baseURL.length > 0 ? this.baseURL : 'https://localhost/';
      this.controller.loadData(this.prepareHTML(this.html), 'text/html', 'UTF-8', base);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'the article document could not be loaded');
    }
  }

  /** Insert the messageHandlers shim, and resolve the avatar's custom-scheme src. */
  private prepareHTML(html: string): string {
    let out: string = html;
    if (this.articleID.length > 0) {
      // The `nnwImageIcon:` scheme has no handler here, so an unsubstituted src renders the
      // engine's broken-image glyph. The source's WKURLSchemeHandler fails the request when
      // the icon is not cached yet and WebKit draws nothing, so stand in a transparent pixel
      // until the download lands and reloadArticleImage() swaps in the real one.
      const src: string = this.avatarURL.length > 0 ? this.avatarURL : transparentPixel;
      out = out.split(imageIconScheme + ':' + this.articleID).join(src);
    }
    const headOpen: number = out.toLowerCase().indexOf('<head');
    if (headOpen < 0) {
      return bridgeShim + out;
    }
    const headEnd: number = out.indexOf('>', headOpen);
    if (headEnd < 0) {
      return bridgeShim + out;
    }
    return out.substring(0, headEnd + 1) + bridgeShim + out.substring(headEnd + 1);
  }

  private evaluate(script: string): void {
    if (!this.controllerReady) {
      return;
    }
    this.controller.runJavaScript(script)
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'script failed: %{public}s', err.message);
      });
  }

  /** The source's stopWebViewActivity: stop media, cancel any in-flight image load. */
  private stopWebViewActivity(): void {
    this.evaluate('stopMediaPlayback();');
    this.evaluate('cancelImageLoad();');
  }

  // MARK: - The JS bridge

  private onBridgeMessage(name: string, body: string): void {
    if (name === ArticleMessageName.imageWasShown) {
      const shown: (() => void) | undefined = this.onImageWasShown;
      if (shown !== undefined) {
        shown();
      }
      return;
    }
    if (name === ArticleMessageName.imageWasClicked) {
      this.imageWasClicked(body);
      return;
    }
    if (name === ArticleMessageName.showFeedInspector) {
      const inspector: (() => void) | undefined = this.onShowFeedInspector;
      if (inspector !== undefined) {
        inspector();
      }
      return;
    }
    if (name === ArticleMessageName.mediaSourceURLs) {
      this.setMediaSourceURLs(body);
    }
  }

  private imageWasClicked(body: string): void {
    const json: JsonObject | undefined = parseJsonObject(body);
    if (json === undefined) {
      return;
    }
    const imageURL: string | undefined = getString(json, 'imageURL');
    if (imageURL === undefined || imageURL.length === 0) {
      return;
    }
    const title: string | undefined = getString(json, 'imageTitle');
    const message: ImageClickMessage = new ImageClickMessage(
      getNumber(json, 'x') ?? 0, getNumber(json, 'y') ?? 0,
      getNumber(json, 'width') ?? 0, getNumber(json, 'height') ?? 0,
      title === undefined ? '' : title, imageURL);
    const clicked: ((message: ImageClickMessage) => void) | undefined = this.onImageClicked;
    if (clicked !== undefined) {
      clicked(message);
    }
  }

  /** The message body is a JSON array of strings. */
  private setMediaSourceURLs(body: string): void {
    const urls: Set<string> = new Set<string>();
    const parsed: JsonObject | undefined = parseJsonObject('{"urls":' + body + '}');
    if (parsed !== undefined) {
      const list: string[] | undefined = getStringArray(parsed, 'urls');
      if (list !== undefined) {
        for (const entry of list) {
          urls.add(entry);
        }
      }
    }
    this.mediaSourceURLs = urls;
  }

  // MARK: - Find in article

  private updateFind(text: string): void {
    if (!this.controllerReady) {
      return;
    }
    const options: string = '{"text":' + JSON.stringify(text)
      + ',"caseSensitive":false,"regex":false}';
    const encoder: util.TextEncoder = new util.TextEncoder();
    const base64Helper: util.Base64Helper = new util.Base64Helper();
    const encoded: string = base64Helper.encodeToStringSync(encoder.encodeInto(options));
    this.controller.runJavaScript('updateFind("' + encoded + '")')
      .then((result: string) => {
        this.publishFindState(result);
      })
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'updateFind failed: %{public}s', err.message);
      });
  }

  /** The engine answers with a base64 FindInArticleState, JSON-quoted by runJavaScript. */
  private publishFindState(result: string): void {
    const handler: ((state: FindInArticleState) => void) | undefined = this.onFindStateChanged;
    if (handler === undefined) {
      return;
    }
    let encoded: string = result;
    if (encoded.startsWith('"') && encoded.endsWith('"') && encoded.length >= 2) {
      encoded = encoded.substring(1, encoded.length - 1);
    }
    if (encoded.length === 0 || encoded === 'null') {
      handler(new FindInArticleState(0, 0));
      return;
    }
    try {
      const base64Helper: util.Base64Helper = new util.Base64Helper();
      const options: util.TextDecoderOptions = { ignoreBOM: true };
      const text: string = util.TextDecoder.create('utf-8', options)
        .decodeToString(base64Helper.decodeSync(encoded));
      const json: JsonObject | undefined = parseJsonObject(text);
      if (json === undefined) {
        handler(new FindInArticleState(0, 0));
        return;
      }
      handler(new FindInArticleState(getNumber(json, 'count') ?? 0,
        getNumber(json, 'index') ?? 0));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'the find state could not be decoded');
      handler(new FindInArticleState(0, 0));
    }
  }

  // MARK: - Navigation policy (the source's decidePolicyFor)

  private handleLink(url: string): boolean {
    // WebKit reports a tap on a not-yet-loaded video's controls as a link activation on the
    // media source. The tap already operated the control — never open a browser for it.
    if (this.mediaSourceURLs.has(url)) {
      return true;
    }
    const lower: string = url.toLowerCase();
    const context: common.UIAbilityContext =
      this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      BrowserService.shared.openLink(context, url)
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'could not open the link: %{public}s', err.message);
        });
      return true;
    }
    if (lower.startsWith('mailto:') || lower.startsWith('tel:')) {
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: url
      };
      context.startAbility(want).catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'cannot handle %{public}s: %{public}s', url, err.message);
        this.getUIContext().getPromptAction()
          .showToast({ message: 'This device cannot send emails.' });
      });
      return true;
    }
    return false;
  }

  private onScrolled(yOffset: number): void {
    this.pendingScrollY = yOffset;
    if (this.scrollTimer !== -1) {
      clearTimeout(this.scrollTimer);
    }
    // The source coalesces the scroll-position write on a 0.3s queue.
    this.scrollTimer = setTimeout((): void => {
      this.scrollTimer = -1;
      const scrollY: number = Math.round(this.pendingScrollY);
      if (scrollY !== AppDefaults.articleWindowScrollY) {
        AppDefaults.articleWindowScrollY = scrollY;
      }
    }, 300);
  }

  private showBars(): void {
    const handler: (() => void) | undefined = this.onShowBars;
    if (handler !== undefined) {
      handler();
    }
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Web({ src: $rawfile(bootstrapDocument), controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .imageAccess(true)
        .zoomAccess(true)
        .id('article_web_view')
        .javaScriptProxy({
          object: this.bridgeObject,
          name: 'nnwArkBridge',
          methodList: ['post'],
          controller: this.controller
        })
        .onControllerAttached(() => {
          this.controllerReady = true;
          this.renderPage();
        })
        .onPageEnd((event) => {
          const url: string = event === undefined ? '' : event.url;
          if (url.indexOf(bootstrapDocument) >= 0) {
            // onControllerAttached fires while the `src` navigation to the bootstrap
            // document is still in flight, so the loadData issued there is overwritten by
            // blank.html landing afterwards — and `html === loadedHTML` then refuses to load
            // the article ever again, leaving a permanently empty article view. Clearing the
            // guard makes renderPage() re-issue the load against the settled engine.
            this.loadedHTML = '';
            this.renderPage();
            return;
          }
          this.renderPage();
          if (this.loadedHTML.length > 0) {
            hilog.info(DOMAIN, TAG, 'onPageEnd: article rendered (%{public}d bytes)',
              this.loadedHTML.length);
          }
        })
        .onInterceptRequest((event) => {
          // WKContentRuleList's replacement: refuse a blocked subresource outright.
          if (event !== undefined && shouldBlockURL(event.request.getRequestUrl())) {
            this.blockedResponse.setResponseData('');
            this.blockedResponse.setResponseEncoding('utf-8');
            this.blockedResponse.setResponseMimeType('text/plain');
            this.blockedResponse.setResponseCode(403);
            this.blockedResponse.setReasonMessage('Blocked');
            return this.blockedResponse;
          }
          return null;
        })
        .onLoadIntercept((event) => {
          if (event === undefined) {
            return false;
          }
          const request: WebResourceRequest = event.data;
          if (!request.isRequestGesture()) {
            return false;
          }
          return this.handleLink(request.getRequestUrl());
        })
        .onScroll((event) => {
          this.onScrolled(event.yOffset);
        })
        .onRenderExited(() => {
          // webViewWebContentProcessDidTerminate: never leave the article blank — the
          // source forces a full reload rather than rendering into a dead process.
          hilog.warn(DOMAIN, TAG, 'the web render process exited; reloading the article');
          this.loadedHTML = '';
          this.renderPage();
        })

      // The two 44pt tap zones that bring the bars back in full screen. They exist ONLY
      // while the bars are hidden, and the frame holding them is hit-test transparent, so
      // they can never swallow a tap on the article body.
      if (this.barsHidden) {
        Column() {
          Column()
            .width('100%')
            .height(44)
            .id('article_show_bars_top')
            .onClick(() => {
              this.showBars();
            })
          Blank()
          Column()
            .width('100%')
            .height(44)
            .id('article_show_bars_bottom')
            .onClick(() => {
              this.showBars();
            })
        }
        .width('100%')
        .height('100%')
        .hitTestBehavior(HitTestMode.Transparent)
      }
    }
    .width('100%')
    .height('100%')
  }
}
