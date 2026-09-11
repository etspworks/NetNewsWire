/**
 * Navigation — dismissal routing for the modally-presented pages.
 *
 * A modal in the source is presented BY a screen and dismissing it uncovers that screen
 * again: Cancel on Add Feed / Add Folder uncovers the feed list, and picking a container in
 * Add Feed Folder uncovers the Add Feed sheet. The @Entry pages that keep those modals
 * replayable by route have no presenter behind them, so dismissing left an empty page.
 *
 * Pushed normally there IS a back stack; opened by route (deep link) there is not, so the
 * fallback replaces the route with the presenter rather than uncovering nothing.
 */

import { router } from '@kit.ArkUI';
import { BrowserService } from '../system/BrowserService';

/**
 * True while the in-app browser is the page on top.
 *
 * Pushing it closes whatever `bindSheet` was open underneath, and a page that treats that
 * close as "the user dismissed me" calls router.back() — which pops the browser again, so
 * the link opened and vanished. Ask this before acting on a sheet that closed itself.
 */
export function isBrowsingInApp(): boolean {
  return BrowserService.shared.pendingInAppURL !== undefined;
}

export function dismissTo(presenterUrl: string): void {
  const depth: number = parseInt(router.getLength(), 10);
  if (!isNaN(depth) && depth > 1) {
    router.back();
    return;
  }
  router.replaceUrl({ url: presenterUrl });
}
