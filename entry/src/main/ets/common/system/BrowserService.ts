/**
 * BrowserService — link opening, ported from SceneCoordinator's showBrowserFor... /
 * showInAppBrowser and the SFSafariViewController presentation.
 *
 * SFSafariViewController has no HarmonyOS counterpart: the in-app browser is an ArkWeb
 * `Web` page inside the app (the screen layer owns it and reads `pendingInAppURL`), and
 * the system browser is `startAbility` with an `ohos.want.action.viewData` want.
 *
 * `AppDefaults.useSystemBrowser` is the source's "Open Links in NetNewsWire" preference,
 * inverted: when it is on, links leave the app.
 */

import common from '@ohos.app.ability.common';
import Want from '@ohos.app.ability.Want';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { Feed } from '../../model/Feed';
import { AppDefaults } from '../prefs/AppDefaults';
import { preferredLink } from '../article/ArticleText';
import { isHTTPOrHTTPSURL } from '../util/Urls';
import { ShareService } from './ShareService';

const DOMAIN: number = 0x0001;
const TAG: string = 'BrowserService';

export type InAppBrowserListener = (urlString: string) => void;

export class BrowserService {
  static readonly shared: BrowserService = new BrowserService();

  /** The URL the in-app browser page should show; the screen clears it when dismissed. */
  private pendingURL?: string;
  private listeners: InAppBrowserListener[] = [];

  addInAppBrowserListener(listener: InAppBrowserListener): void {
    this.listeners.push(listener);
  }

  removeInAppBrowserListener(listener: InAppBrowserListener): void {
    this.listeners = this.listeners.filter((l: InAppBrowserListener) => l !== listener);
  }

  get pendingInAppURL(): string | undefined {
    return this.pendingURL;
  }

  /**
   * The source also donated an NSUserActivity here (`activityManager.browsing(url:)`) for
   * Handoff; HarmonyOS has no Handoff, so the browsing session is only local state.
   */
  endedBrowsing(): void {
    this.pendingURL = undefined;
  }

  /** Honours the preference: the system browser, or the in-app Web page. */
  async openLink(context: common.UIAbilityContext, urlString: string): Promise<void> {
    if (!isHTTPOrHTTPSURL(urlString)) {
      hilog.warn(DOMAIN, TAG, 'refusing to open a non-http(s) link');
      return;
    }
    if (AppDefaults.useSystemBrowser) {
      await this.openInSystemBrowser(context, urlString);
      return;
    }
    this.openInAppBrowser(urlString);
  }

  openInAppBrowser(urlString: string): void {
    this.pendingURL = urlString;
    for (const listener of this.listeners) {
      listener(urlString);
    }
    if (this.listeners.length > 0) {
      // A screen hosts the browser itself (a sheet over its own content) — it just did.
      return;
    }
    // Nothing hosts it, which was true of EVERY call site: the source got the browser from
    // UIKit's own presentation, so recording the URL and notifying no one made the tap dead.
    router.pushUrl({ url: 'pages/InAppBrowserPage' }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'in-app browser did not open: %{public}s', err.message);
    });
  }

  /**
   * Hands the URL to the system browser. If no ability can handle it (or the call is
   * rejected), the in-app Web page takes over rather than the tap doing nothing.
   */
  async openInSystemBrowser(context: common.UIAbilityContext, urlString: string): Promise<void> {
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: urlString
    };
    try {
      await context.startAbility(want);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'no system browser; using the in-app browser instead');
      this.openInAppBrowser(urlString);
    }
  }

  async openArticle(context: common.UIAbilityContext, article: Article): Promise<void> {
    const link: string | undefined = preferredLink(article);
    if (link === undefined) {
      return;
    }
    await this.openLink(context, link);
  }

  async openFeedHomePage(context: common.UIAbilityContext, feed: Feed): Promise<void> {
    const homePageURL: string | undefined = feed.homePageURL;
    if (homePageURL === undefined) {
      return;
    }
    await this.openLink(context, homePageURL);
  }

  /** The source's "Copy Feed URL" / "Copy Home Page URL" commands. */
  copyLink(urlString: string): void {
    ShareService.copyToClipboard(urlString);
  }
}
