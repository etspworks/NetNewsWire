/**
 * EntryAbility — the app entry point.
 *
 * Owns five things the rest of the app depends on:
 *   1. the ORDERED bootstrap (AppBootstrap: AppContext -> AppDefaults -> AccountManager ->
 *      themes/timers/notifications). Every database and disk cache resolves its path through
 *      AppContext, so this runs before anything else touches data;
 *   2. deep-link routing — `--ps targetPage <RouteName>` (read in BOTH onCreate and onNewWant,
 *      launch type singleton) opens `pages/<RouteName>Page` once the window content is loaded;
 *   3. notification want params (nnwNotificationAction / accountID / articleID);
 *   4. the OAuth redirect `netnewswire://auth/feedly?code=…` — AppDelegate's URL handling in
 *      the source, which is where OAuthAccountAuthorizationOperation's browser round trip ends;
 *   5. the `feed:` / `feeds:` subscription links — SceneDelegate's `openURLContexts`, which
 *      presents Add Feed prefilled with the link rather than subscribing on its own, after
 *      SceneCoordinator's dismissIfLaunchingFromExternalAction().
 */

import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { promptAction, router, UIContext, window } from '@kit.ArkUI';
import { AppBootstrap } from '../common/state/AppBootstrap';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { AccountManager } from '../common/account/AccountManager';
import { AccountService } from '../common/account/Account';
import {
  FeedlyAccountDelegate, FeedlyAuthorizationCancelledError, OAuthAuthorizationGrant
} from '../common/account/FeedlyAccountDelegate';
import { AccountType } from '../model/AccountType';
import { Credentials } from '../model/Credentials';
import { AppDefaults, UserInterfaceColorPalette } from '../common/prefs/AppDefaults';
import {
  NotificationAction, NotificationActionKeys, UserNotificationManager
} from '../common/notify/UserNotificationManager';
import { normalizedURL } from '../common/util/Urls';
// SceneDelegate's own `mayBeURL` gate. It lives on the Add Feed screen because that is where
// the source's String+RSCore extension is used from; this is the second caller, not a copy.
import { mayBeURL } from '../pages/AddFeedViewControllerPage';

const DOMAIN: number = 0x0001;
const TAG: string = 'EntryAbility';
/** Cold-start root — the source app opens on the sidebar (MainFeedCollectionViewController). */
const ROOT_PAGE: string = 'pages/MainFeedCollectionViewControllerPage';
const TARGET_PAGE_KEY: string = 'targetPage';
/** showAddFeed(initialFeed:) has no coordinator here — the screen is a route with params. */
const ADD_FEED_PAGE: string = 'pages/AddFeedViewControllerPage';
/**
 * The two screens SceneCoordinator.dismissIfLaunchingFromExternalAction() dismisses, by
 * router state NAME (no `pages/` prefix, no extension): the in-app browser hosts every
 * `SFSafariViewController`, and Settings is `SettingsViewController`.
 */
const IN_APP_BROWSER_PAGE_NAME: string = 'InAppBrowserPage';
const SETTINGS_PAGE_NAME: string = 'SettingsViewControllerPage';
const ADD_FEED_PAGE_NAME: string = 'AddFeedViewControllerPage';

export default class EntryAbility extends UIAbility {
  private uiContext: UIContext | undefined = undefined;
  /** Route requested before the window content was ready; flushed by routePending(). */
  private pendingRoute: string = '';
  /** A `feed:`/`feeds:` link, already normalized; flushed by routePending() too. */
  private pendingAddFeed: string = '';

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.readWant(want);
    AppBootstrap.start(this.context, 'EntryAbility')
      .then(() => {
        // Only now is AppDefaults loaded — reading it in onCreate throws, because
        // AppContext is not set up yet.
        this.applyStoredColorPalette();
      })
      .catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'bootstrap failed: %{public}s', err.message);
      });
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.readWant(want);
    this.routePending();
  }

  onDestroy(): void {
    AppBootstrap.shutDown();
  }

  /**
   * A cold-launch `targetPage` is an OVERRIDE, so it becomes the window's INITIAL content
   * rather than a push over the root: a push issued from this callback races the root page's
   * own entry transition and is dropped, which left every deep link sitting on the root page.
   *
   * Restoration still runs in FULL on a deep link. It restores MODEL state only — the saved
   * sidebar item and article are handed to SceneCoordinator, which publishes them; every
   * `showColumn`/`pushUrl` in this app is issued from an explicit user handler, so nothing
   * about restoring a selection navigates and the deep-linked page keeps the window.
   * Suppressing it instead left a deep-linked article page permanently on "No selection".
   */
  onWindowStageCreate(windowStage: window.WindowStage): void {
    const deepLink: string = this.pendingRoute;
    this.pendingRoute = '';
    const initial: string = deepLink.length > 0 ? deepLink : ROOT_PAGE;
    hilog.info(DOMAIN, TAG, 'loading initial page %{public}s', initial);
    windowStage.loadContent(initial, (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load content: %{public}s', JSON.stringify(err));
        if (initial !== ROOT_PAGE) {
          windowStage.loadContent(ROOT_PAGE);
        }
        return;
      }
      try {
        this.uiContext = windowStage.getMainWindowSync().getUIContext();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'no UIContext from the main window');
      }
      AppBootstrap.restoreState().catch((error: Error) => {
        hilog.error(DOMAIN, TAG, 'state restore failed: %{public}s', error.message);
      });
      this.routePending();
    });
  }

  onWindowStageDestroy(): void {
    this.uiContext = undefined;
  }

  onForeground(): void {
    AppBootstrap.willEnterForeground();
  }

  onBackground(): void {
    AppBootstrap.didEnterBackground();
  }

  /**
   * The source's `overrideUserInterfaceStyle`, re-applied on every launch.
   *
   * This used to set COLOR_MODE_NOT_SET unconditionally, which threw the user's saved
   * choice away on every cold start: the Color Palette screen kept the checkmark on Dark
   * and the app still came up light.
   */
  private applyStoredColorPalette(): void {
    if (!AppDefaults.isLoaded()) {
      return;
    }
    try {
      const palette: UserInterfaceColorPalette = AppDefaults.userInterfaceColorPalette;
      let mode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
      if (palette === UserInterfaceColorPalette.light) {
        mode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
      } else if (palette === UserInterfaceColorPalette.dark) {
        mode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
      }
      this.context.getApplicationContext().setColorMode(mode);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to set colorMode: %{public}s', JSON.stringify(err));
    }
  }

  /** Deep link + notification params, from a cold launch (onCreate) or a warm one (onNewWant). */
  private readWant(want: Want): void {
    // A browsable Want carries its payload in `uri`, not in `parameters` — and the
    // `params === undefined` return below would drop it before anything looked.
    this.readOAuthRedirect(want.uri);
    this.readFeedSubscription(want.uri);
    const params: Record<string, Object> | undefined = want.parameters;
    if (params === undefined) {
      return;
    }
    const target: Object | undefined = params[TARGET_PAGE_KEY];
    hilog.info(DOMAIN, TAG, 'want %{public}s=%{public}s', TARGET_PAGE_KEY, String(target));
    if (typeof target === 'string' && target.length > 0) {
      // The replay passes the ROUTE NAME (the page-identity marker); the page file is <Name>Page.
      this.pendingRoute = target.startsWith('pages/') ? target : `pages/${target}Page`;
    }
    const action: Object | undefined = params[NotificationActionKeys.action];
    const accountID: Object | undefined = params[NotificationActionKeys.accountID];
    const articleID: Object | undefined = params[NotificationActionKeys.articleID];
    if (typeof action !== 'string' || typeof accountID !== 'string'
      || typeof articleID !== 'string') {
      return;
    }
    if (action === NotificationAction.openArticle) {
      SceneCoordinator.shared.selectSidebarItemAndArticle(accountID, articleID)
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'open-article failed: %{public}s', err.message);
        });
    } else {
      UserNotificationManager.shared.handleAction(action, accountID, articleID)
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'notification action failed: %{public}s', err.message);
        });
    }
  }

  /**
   * `scene(_:openURLContexts:)` — "Handle the feed: and feeds: schemes".
   *
   * Verbatim from SceneDelegate: normalize the whole link, and present Add Feed prefilled
   * with it ONLY when the result `mayBeURL`. The source never subscribes on its own — the
   * user still picks the account and the folder and taps Add — so neither does this.
   *
   * normalizedURL() is RSCore's, so both payload shapes a feed: link uses arrive correct:
   * `feed:https://example.com/rss` keeps its inner scheme, `feed://example.com/rss` loses
   * the `//` and gains `http://` (and `feeds://` gains `https://`). Junk — `feed://`, an
   * empty host, a `javascript:` payload — fails mayBeURL and is dropped here, so the feed
   * finder never sees it.
   *
   * `netnewswire:` cannot reach this: the scheme test below is exact, and readOAuthRedirect
   * matches on the full `netnewswire://auth/feedly` base. The two branches are disjoint.
   *
   * The URI is not logged — a feed link may carry credentials in its userinfo component,
   * and this app writes to hilog.
   */
  private readFeedSubscription(uri: string | undefined): void {
    if (uri === undefined) {
      return;
    }
    const lower: string = uri.toLowerCase();
    if (!lower.startsWith('feed:') && !lower.startsWith('feeds:')) {
      return;
    }
    const normalized: string = normalizedURL(uri);
    if (!mayBeURL(normalized)) {
      hilog.info(DOMAIN, TAG, 'ignoring a feed link that is not a URL');
      return;
    }
    // routePending() runs on BOTH paths — the loadContent callback on a cold launch and
    // onNewWant on a warm one — so the push waits for a window either way.
    this.pendingAddFeed = normalized;
  }

  /**
   * OAuthAccountAuthorizationOperation's closing half.
   *
   * iOS never needs a URL handler for this: ASWebAuthenticationSession captures
   * `netnewswire://auth/feedly?code=…` itself and hands it back to the operation still in
   * memory. HarmonyOS has no such session, so the redirect comes back through the scheme
   * module.json5 registers (entity.system.browsable) as an ordinary Want — warm through
   * onNewWant, or cold through onCreate if the system reclaimed the app while the browser
   * was open. readWant() is on both paths, so both are covered.
   *
   * Note what is NOT logged: the URI carries a one-time authorization code, and this app
   * writes to hilog.
   */
  private readOAuthRedirect(uri: string | undefined): void {
    if (uri === undefined || !FeedlyAccountDelegate.isOAuthRedirect(uri)) {
      return;
    }
    const redirectURL: string = uri;
    hilog.info(DOMAIN, TAG, 'handling the Feedly authorization redirect');
    // On a cold start this runs before AppDefaults (which holds the request's `state`) and
    // AccountManager exist. start() memoizes its promise, so this awaits the SAME bootstrap
    // onCreate kicked off rather than starting a second one.
    AppBootstrap.start(this.context, 'EntryAbility')
      .then((): Promise<OAuthAuthorizationGrant> => {
        return FeedlyAccountDelegate.completeOAuthAuthorization(redirectURL);
      })
      .then((grant: OAuthAuthorizationGrant): Promise<void> => {
        return this.saveFeedlyAccount(grant);
      })
      .catch((err: Error): void => {
        if (err instanceof FeedlyAuthorizationCancelledError) {
          // Deny on the consent page is a cancellation, not a failure: the source shows
          // nothing and leaves the user where they are.
          hilog.info(DOMAIN, TAG, 'the Feedly authorization was cancelled');
          return;
        }
        hilog.error(DOMAIN, TAG, 'feedly authorization failed: %{public}s', err.message);
        this.showMessage(err.message);
      });
  }

  /**
   * OAuthAccountAuthorizationOperation.saveAccount. It lives here rather than on the
   * delegate because AccountManager reaches FeedlyAccountDelegate back through
   * AccountDelegate, and importing it there would close that cycle.
   */
  private async saveFeedlyAccount(grant: OAuthAuthorizationGrant): Promise<void> {
    const username: string = grant.accessToken.username;
    if (AccountManager.shared.duplicateServiceAccount(AccountType.feedly, username)) {
      throw new Error('There is already a Feedly account with that username created.');
    }
    const account: AccountService = await AccountManager.shared.createAccount(AccountType.feedly);
    try {
      // The refresh token first: storing it propagates the value to the account delegate,
      // and the access token has to win that race (performReauthorization's own order).
      const refreshToken: Credentials | undefined = grant.refreshToken;
      if (refreshToken !== undefined) {
        await account.storeCredentials(refreshToken);
      }
      await account.storeCredentials(grant.accessToken);
    } catch (e) {
      // Don't leave behind an account with no credentials.
      await AccountManager.shared.deleteAccount(account);
      throw e as Error;
    }
    this.showMessage('The Feedly account has been added.');
    account.refreshAll().catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'refresh after add failed: %{public}s', String(e));
    });
  }

  /**
   * No screen owns this flow — the redirect can arrive with the app cold, and the Add
   * Account screen that started it may be long gone — so the outcome is a toast over
   * whatever is on top, not an alert on a page that has to exist.
   */
  private showMessage(message: string): void {
    const ctx: UIContext | undefined = this.uiContext;
    try {
      if (ctx !== undefined) {
        ctx.getPromptAction().showToast({ message: message, duration: 3000 });
        return;
      }
      // The window content was not up yet; the deprecated global still reaches the UI.
      promptAction.showToast({ message: message, duration: 3000 });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'no UI to report to: %{public}s', message);
    }
  }

  /**
   * The push for a `feed:`/`feeds:` link, once there is a window to push into.
   *
   * Same reasoning as readOAuthRedirect: on a cold launch this runs before AccountManager
   * exists, and Add Feed resolves its default container out of it, so it awaits the SAME
   * memoized bootstrap onCreate kicked off rather than starting a second one. With no
   * account able to take a feed the screen still opens — the source presents it
   * unconditionally, with Add disabled until there is a container.
   */
  private routePendingAddFeed(): void {
    const feedURL: string = this.pendingAddFeed;
    if (feedURL.length === 0) {
      return;
    }
    this.pendingAddFeed = '';
    AppBootstrap.start(this.context, 'EntryAbility')
      .then((): void => {
        // showAddFeed() presents on the split view controller. UIKit drops a `present` issued
        // while that controller is ALREADY presenting, so in the source a second `feed:` link
        // arriving over an open Add Feed changes nothing — the sheet the user is filling in
        // stays, with the feed it was opened for. `pushUrl` has no such rule and stacked a
        // second Add Feed on top of the first, so the drop is spelled out here.
        // dismissIfLaunchingFromExternalAction() does NOT close Add Feed: it dismisses the
        // browser and Settings only, so Add Feed is left exactly as the source leaves it.
        if (this.currentPageName() === ADD_FEED_PAGE_NAME) {
          hilog.info(DOMAIN, TAG, 'Add Feed is already open; ignoring the second feed link');
          return;
        }
        const params: Record<string, string> = { 'initialFeed': feedURL };
        const ctx: UIContext | undefined = this.uiContext;
        const push: Promise<void> = ctx !== undefined
          ? ctx.getRouter().pushUrl({ url: ADD_FEED_PAGE, params: params })
          : router.pushUrl({ url: ADD_FEED_PAGE, params: params });
        push.catch((err: BusinessError): void => {
          hilog.error(DOMAIN, TAG, 'add feed from a feed link failed: %{public}s', err.message);
        });
      })
      .catch((err: Error): void => {
        hilog.error(DOMAIN, TAG, 'bootstrap failed for a feed link: %{public}s', err.message);
      });
  }

  /** The router state's page name, or '' when there is no window content yet. */
  private currentPageName(): string {
    try {
      const ctx: UIContext | undefined = this.uiContext;
      const state: router.RouterState = ctx !== undefined
        ? ctx.getRouter().getState()
        : router.getState();
      return state.name;
    } catch (e) {
      return '';
    }
  }

  /**
   * SceneCoordinator.dismissIfLaunchingFromExternalAction().
   *
   * The source runs this on every incoming external action — `scene(_:openURLContexts:)` and
   * a notification response — and it dismisses the foremost presented controller ONLY when
   * that controller is an `SFSafariViewController` or a `SettingsViewController`. Anything
   * else (Add Feed, an inspector, an account sheet) is left alone. It never gates the action:
   * the dismiss is fire-and-forget and the link or notification is handled either way.
   */
  private dismissIfLaunchingFromExternalAction(): void {
    const name: string = this.currentPageName();
    if (name !== IN_APP_BROWSER_PAGE_NAME && name !== SETTINGS_PAGE_NAME) {
      return;
    }
    hilog.info(DOMAIN, TAG, 'dismissing %{public}s for an external action', name);
    const ctx: UIContext | undefined = this.uiContext;
    if (ctx !== undefined) {
      ctx.getRouter().back();
      return;
    }
    router.back();
  }

  private routePending(): void {
    // Both callers ARE the external action: onNewWant (a warm `aa start`, a notification, a
    // feed or OAuth link) and the loadContent callback on a cold one.
    this.dismissIfLaunchingFromExternalAction();
    this.routePendingAddFeed();
    const url: string = this.pendingRoute;
    if (url.length === 0 || url === ROOT_PAGE) {
      this.pendingRoute = '';
      return;
    }
    this.pendingRoute = '';
    const ctx: UIContext | undefined = this.uiContext;
    if (ctx !== undefined) {
      ctx.getRouter().pushUrl({ url: url }).catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'deep link to %{public}s failed: %{public}s', url, err.message);
      });
      return;
    }
    router.pushUrl({ url: url }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'deep link to %{public}s failed: %{public}s', url, err.message);
    });
  }
}
