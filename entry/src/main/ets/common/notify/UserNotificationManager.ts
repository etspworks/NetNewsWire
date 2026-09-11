/**
 * UserNotificationManager — port of Shared/UserNotifications/UserNotificationManager.swift.
 *
 * One notification per new unread article of a feed with notifications enabled, carrying
 * the source's three actions (Open / Mark as Read / Mark as Starred), withdrawn again
 * when the article is marked read.
 *
 * Permissions: publishing local notifications needs NO permission on HarmonyOS — the user
 * grants it through `requestEnableNotification`. `ohos.permission.NOTIFICATION_CONTROLLER`
 * is system_core and must never be requested (the HarmonyOS self-signed capability limits); requesting
 * it would make the install fail.
 *
 * UNNotificationCategory has no counterpart: the actions are attached per notification as
 * `actionButtons` instead of being registered once as a category.
 */

import notificationManager from '@ohos.notificationManager';
import wantAgent, { WantAgent } from '@ohos.app.ability.wantAgent';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Feed } from '../../model/Feed';
import { AccountManager } from '../account/AccountManager';
import { articleFeed, markArticles, truncatedSummary, truncatedTitle } from '../article/ArticleText';
import { localized } from '../system/Localized';

const DOMAIN: number = 0x0001;
const TAG: string = 'UserNotificationManager';

/** The wantAgent parameter keys the ability's onNewWant reads back. */
export class NotificationActionKeys {
  static readonly action: string = 'nnwNotificationAction';
  static readonly accountID: string = 'accountID';
  static readonly articleID: string = 'articleID';
}

export class NotificationAction {
  static readonly markAsRead: string = 'MARK_AS_READ';
  static readonly markAsStarred: string = 'MARK_AS_STARRED';
  static readonly openArticle: string = 'OPEN_ARTICLE';
}

/** Notification IDs must be numbers, so the source's "articleID:<id>" becomes a hash. */
function notificationID(articleID: string): number {
  let hash: number = 0;
  for (let i: number = 0; i < articleID.length; i++) {
    hash = ((hash << 5) - hash + articleID.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export class UserNotificationManager {
  static readonly shared: UserNotificationManager = new UserNotificationManager();

  private isActive: boolean = false;
  private bundleName: string = '';
  private abilityName: string = '';

  /**
   * Called once at startup with the ability the notification actions should reach.
   * Asks for notification permission the way the source's registerCategoriesAndActions
   * paired with the system prompt.
   */
  async start(bundleName: string, abilityName: string): Promise<void> {
    if (this.isActive) {
      return;
    }
    this.isActive = true;
    this.bundleName = bundleName;
    this.abilityName = abilityName;

    try {
      if (!notificationManager.isNotificationEnabledSync()) {
        await notificationManager.requestEnableNotification();
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'notifications are not enabled: %{public}s', (e as Error).message);
    }
  }

  /**
   * AppDelegate.updateBadge() — `UNUserNotificationCenter.current().setBadgeCount(unreadCount)`
   * (iOS/AppDelegate.swift:142). The source calls it from the `unreadCount` didSet, on launch
   * and on applicationDidEnterBackground; AppBootstrap does the same three.
   *
   * `notificationManager.setBadgeNumber` carries NO `@permission` tag on this SDK, so nothing
   * is added to module.json5 — which matters, because the only badge-shaped permission,
   * `ohos.permission.NOTIFICATION_CONTROLLER`, is system_core and would break the install
   * (the HarmonyOS self-signed capability limits). 0 clears the badge, >99 shows "99+", both as on iOS.
   *
   * Fire-and-forget on purpose: this is called from a change listener, and a launcher that
   * cannot show a badge must not take a caller down with it.
   */
  updateBadge(unreadCount: number): void {
    notificationManager.setBadgeNumber(unreadCount)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not set the app icon badge: %{public}s', String(e));
      });
  }

  /** The .AccountDidDownloadArticles handler: notify for each new unread article. */
  async accountDidDownloadArticles(newArticles: Article[]): Promise<void> {
    if (!this.isActive) {
      return;
    }
    for (const article of newArticles) {
      if (article.status.read) {
        continue;
      }
      const feed: Feed | undefined = articleFeed(article);
      if (feed === undefined || !feed.newArticleNotificationsEnabled) {
        continue;
      }
      await this.sendNotification(feed, article);
    }
  }

  /**
   * The .StatusesDidChange handler: a read article's notification is withdrawn.
   *
   * The source withdraws the whole set in one call
   * (removeDeliveredNotifications(withIdentifiers:), UserNotificationManager.swift:59), which
   * is what keeps "Mark All as Read" cheap there. `notificationManager.cancel` is per ID, so
   * the same set would become one IPC call per article. getActiveNotifications() returns only
   * this app's live notifications, so intersecting against it bounds the work by the number of
   * notifications actually posted — a handful — instead of by the number of articles marked
   * read, which on a busy account is thousands.
   */
  async statusesDidChange(articleIDs: string[], statusKey: ArticleStatusKey,
    flag: boolean): Promise<void> {
    if (statusKey !== ArticleStatusKey.read || !flag || articleIDs.length === 0) {
      return;
    }

    let active: notificationManager.NotificationRequest[] = [];
    try {
      active = await notificationManager.getActiveNotifications();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'could not read the active notifications: %{public}s',
        (e as Error).message);
      return;
    }

    const liveIDs: Set<number> = new Set<number>();
    for (const request of active) {
      if (request.id !== undefined) {
        liveIDs.add(request.id);
      }
    }
    if (liveIDs.size === 0) {
      return;
    }

    for (const articleID of articleIDs) {
      const id: number = notificationID(articleID);
      if (!liveIDs.delete(id)) {
        continue;
      }
      try {
        await notificationManager.cancel(id);
      } catch (e) {
        hilog.debug(DOMAIN, TAG, 'no delivered notification to cancel');
      }
      if (liveIDs.size === 0) {
        return; // Nothing left of ours is on screen; the rest of the set cannot match.
      }
    }
  }

  /** Notification action handling — called from the ability's onNewWant. */
  async handleAction(action: string, accountID: string, articleID: string): Promise<void> {
    if (action !== NotificationAction.markAsRead
      && action !== NotificationAction.markAsStarred) {
      return; // OPEN_ARTICLE is handled by the scene coordinator's selection restore.
    }
    const article: Article | undefined =
      await AccountManager.shared.fetchArticle(accountID, articleID);
    if (article === undefined) {
      return;
    }
    const statusKey: ArticleStatusKey = action === NotificationAction.markAsRead
      ? ArticleStatusKey.read : ArticleStatusKey.starred;
    await markArticles([article], statusKey, true);
    if (statusKey === ArticleStatusKey.read) {
      await this.statusesDidChange([articleID], ArticleStatusKey.read, true);
    }
  }

  private async sendNotification(feed: Feed, article: Article): Promise<void> {
    const title: string = truncatedTitle(article);
    const summary: string = truncatedSummary(article);

    const request: notificationManager.NotificationRequest = {
      id: notificationID(article.articleID),
      groupName: feed.feedID,
      wantAgent: await this.wantAgentFor(NotificationAction.openArticle, article),
      actionButtons: [
        {
          title: localized('open', 'Open'),
          wantAgent: await this.wantAgentFor(NotificationAction.openArticle, article)
        },
        {
          title: localized('mark_as_read', 'Mark as Read'),
          wantAgent: await this.wantAgentFor(NotificationAction.markAsRead, article)
        },
        {
          title: localized('mark_as_starred', 'Mark as Starred'),
          wantAgent: await this.wantAgentFor(NotificationAction.markAsStarred, article)
        }
      ],
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_MULTILINE,
        multiLine: {
          title: feed.notificationDisplayName,
          text: summary,
          briefText: title.length === 0 ? feed.notificationDisplayName : title,
          longTitle: title.length === 0 ? feed.notificationDisplayName : title,
          lines: [summary]
        }
      }
    };

    try {
      await notificationManager.publish(request);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'could not publish a notification: %{public}s',
        (e as Error).message);
    }
  }

  private async wantAgentFor(action: string, article: Article): Promise<WantAgent> {
    const parameters: Record<string, Object> = {};
    parameters[NotificationActionKeys.action] = action;
    parameters[NotificationActionKeys.accountID] = article.accountID;
    parameters[NotificationActionKeys.articleID] = article.articleID;

    const info: wantAgent.WantAgentInfo = {
      wants: [
        {
          bundleName: this.bundleName,
          abilityName: this.abilityName,
          parameters: parameters
        }
      ],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: notificationID(article.articleID),
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    return await wantAgent.getWantAgent(info);
  }
}
