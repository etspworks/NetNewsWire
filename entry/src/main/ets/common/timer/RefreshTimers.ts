/**
 * RefreshTimers — port of Shared/Timer/{RefreshInterval,AccountRefreshTimer,
 * ArticleStatusSyncTimer}.swift.
 *
 * Both timers are one-shot Timers the source re-arms after every fire (so a changed
 * interval takes effect immediately); `setTimeout` reproduces that exactly.
 * `suspend()` / `resume()` carry the suspendedFireDate behaviour: a tick missed while the
 * app was suspended fires immediately on resume.
 *
 * `refreshInterval` was a Mac-only AppDefaults key in the source and is not in the ported
 * AppDefaults, so it is read through the generic accessor under the same key name.
 *
 * Deferred background refresh: BackgroundTasksKit's `workScheduler` (see
 * harmonyos-features.md). A denial is not fatal — the app still refreshes on the
 * foreground timer, exactly as the source's BGTaskScheduler failure path does.
 */

import workScheduler from '@ohos.resourceschedule.workScheduler';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppDefaults } from '../prefs/AppDefaults';
import { AccountManager } from '../account/AccountManager';
import { ActivityLog } from '../log/ActivityLog';
import { ActivityKind, ActivityKindType, ActivityOwner, ActivityOwnerKind }
  from '../../model/Activity';

const DOMAIN: number = 0x0001;
const TAG: string = 'RefreshTimers';

/** The AppDefaults key the refresh interval is stored under. */
export const refreshIntervalKey: string = 'refreshInterval';

/** RefreshInterval.swift — the raw values are persisted, so they must not change. */
export enum RefreshInterval {
  manually = 1,
  every30Minutes = 3,
  everyHour = 4,
  every2Hours = 5,
  every4Hours = 6,
  every8Hours = 7
}

export const allRefreshIntervals: RefreshInterval[] = [
  RefreshInterval.manually,
  RefreshInterval.every30Minutes,
  RefreshInterval.everyHour,
  RefreshInterval.every2Hours,
  RefreshInterval.every4Hours,
  RefreshInterval.every8Hours
];

export function refreshIntervalSeconds(interval: RefreshInterval): number {
  switch (interval) {
    case RefreshInterval.every30Minutes:
      return 30 * 60;
    case RefreshInterval.everyHour:
      return 60 * 60;
    case RefreshInterval.every2Hours:
      return 2 * 60 * 60;
    case RefreshInterval.every4Hours:
      return 4 * 60 * 60;
    case RefreshInterval.every8Hours:
      return 8 * 60 * 60;
    default:
      return 0;
  }
}

export function refreshIntervalDescription(interval: RefreshInterval): string {
  switch (interval) {
    case RefreshInterval.every30Minutes:
      return 'Every 30 Minutes';
    case RefreshInterval.everyHour:
      return 'Every Hour';
    case RefreshInterval.every2Hours:
      return 'Every 2 Hours';
    case RefreshInterval.every4Hours:
      return 'Every 4 Hours';
    case RefreshInterval.every8Hours:
      return 'Every 8 Hours';
    default:
      return 'Manually';
  }
}

export function currentRefreshInterval(): RefreshInterval {
  const raw: number = AppDefaults.intValue(refreshIntervalKey);
  for (const interval of allRefreshIntervals) {
    if ((interval as number) === raw) {
      return interval;
    }
  }
  return RefreshInterval.manually;
}

export function setCurrentRefreshInterval(interval: RefreshInterval): void {
  AppDefaults.setInt(refreshIntervalKey, interval as number);
  AccountRefreshTimer.shared.update();
}

/** AccountRefreshTimer.swift — the timed "refresh all". */
export class AccountRefreshTimer {
  static readonly shared: AccountRefreshTimer = new AccountRefreshTimer();

  shuttingDown: boolean = false;
  /** The source's isSystemSleeping; on HarmonyOS this is "app is suspended". */
  isSystemSleeping: boolean = false;

  private timerID?: number;
  private nextFireDate?: Date;
  private lastTimedRefresh?: Date;
  private readonly launchTime: Date = new Date();
  private suspendedFireDate?: Date;

  fireOldTimer(): void {
    const fireDate: Date | undefined = this.nextFireDate;
    if (fireDate !== undefined && fireDate.getTime() < Date.now()
      && currentRefreshInterval() !== RefreshInterval.manually) {
      this.timedRefresh();
    }
  }

  invalidate(): void {
    if (this.timerID !== undefined) {
      clearTimeout(this.timerID);
      this.timerID = undefined;
    }
    this.nextFireDate = undefined;
  }

  suspend(): void {
    this.suspendedFireDate = this.nextFireDate;
    this.invalidate();
  }

  resume(): void {
    if (this.shuttingDown) {
      return;
    }
    const dueDate: Date | undefined = this.suspendedFireDate;
    this.suspendedFireDate = undefined;
    if (dueDate !== undefined && dueDate.getTime() < Date.now()) {
      this.timedRefresh();
    } else {
      this.update();
    }
  }

  update(): void {
    if (this.shuttingDown) {
      return;
    }

    const interval: RefreshInterval = currentRefreshInterval();
    if (interval === RefreshInterval.manually) {
      this.invalidate();
      return;
    }

    const secondsToAdd: number = refreshIntervalSeconds(interval);
    const lastRefreshDate: Date =
      this.lastTimedRefresh === undefined ? this.launchTime : this.lastTimedRefresh;
    let nextRefreshTime: number = lastRefreshDate.getTime() + secondsToAdd * 1000;
    if (nextRefreshTime < Date.now()) {
      nextRefreshTime = Date.now() + secondsToAdd * 1000;
    }
    if (this.nextFireDate !== undefined && this.nextFireDate.getTime() === nextRefreshTime) {
      return;
    }

    this.invalidate();
    this.nextFireDate = new Date(nextRefreshTime);
    this.timerID = setTimeout(() => {
      this.timedRefresh();
    }, Math.max(0, nextRefreshTime - Date.now()));
  }

  private timedRefresh(): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.isSystemSleeping) {
      ActivityLog.shared.logCompletedActivity(new ActivityOwner(ActivityOwnerKind.app),
        new ActivityKind(ActivityKindType.refreshAll), 'Skipped — the app is suspended');
      this.lastTimedRefresh = new Date();
      this.update();
      return;
    }

    this.lastTimedRefresh = new Date();
    this.update();

    AccountManager.shared.refreshAll().catch((error: Error) => {
      hilog.warn(DOMAIN, TAG, 'timed refresh failed: %{public}s', error.message);
    });
  }
}

/** ArticleStatusSyncTimer.swift — drains the queued read/starred statuses. */
export class ArticleStatusSyncTimer {
  static readonly shared: ArticleStatusSyncTimer = new ArticleStatusSyncTimer();

  private static readonly normalIntervalSeconds: number = 120;
  private static readonly idleBackoffIntervalSeconds: number = 1800;

  shuttingDown: boolean = false;

  private timerID?: number;
  private nextFireDate?: Date;
  private lastTimedRefresh?: Date;
  private readonly launchTime: Date = new Date();
  /** True when the most recent timed run was a no-op; the next fire is pushed out. */
  private lastRunWasIdle: boolean = false;

  fireOldTimer(): void {
    const fireDate: Date | undefined = this.nextFireDate;
    if (fireDate !== undefined && fireDate.getTime() < Date.now()) {
      this.timedRefresh();
    }
  }

  start(): void {
    this.shuttingDown = false;
    this.update();
  }

  stop(): void {
    this.shuttingDown = true;
    this.invalidate();
  }

  invalidate(): void {
    if (this.timerID !== undefined) {
      clearTimeout(this.timerID);
      this.timerID = undefined;
    }
    this.nextFireDate = undefined;
  }

  update(): void {
    if (this.shuttingDown) {
      return;
    }

    const intervalSeconds: number = this.lastRunWasIdle
      ? ArticleStatusSyncTimer.idleBackoffIntervalSeconds
      : ArticleStatusSyncTimer.normalIntervalSeconds;
    const lastRefreshDate: Date =
      this.lastTimedRefresh === undefined ? this.launchTime : this.lastTimedRefresh;
    let nextRefreshTime: number = lastRefreshDate.getTime() + intervalSeconds * 1000;
    if (nextRefreshTime < Date.now()) {
      nextRefreshTime = Date.now() + intervalSeconds * 1000;
    }
    if (this.nextFireDate !== undefined && this.nextFireDate.getTime() === nextRefreshTime) {
      return;
    }

    this.invalidate();
    this.nextFireDate = new Date(nextRefreshTime);
    this.timerID = setTimeout(() => {
      this.timedRefresh();
    }, Math.max(0, nextRefreshTime - Date.now()));
  }

  /**
   * User-initiated status changes were queued — leave idle backoff so the next fire
   * happens on the normal cadence instead of 30 minutes out. (The source hears this on
   * the .AccountDidQueueArticleStatuses notification.)
   */
  didQueueArticleStatuses(): void {
    if (!this.lastRunWasIdle) {
      return;
    }
    this.lastRunWasIdle = false;
    this.update();
  }

  private timedRefresh(): void {
    if (this.shuttingDown) {
      return;
    }

    this.lastTimedRefresh = new Date();
    this.update();

    AccountManager.shared.syncArticleStatusAll().then((didWork: boolean) => {
      this.lastRunWasIdle = !didWork;
      // Re-schedule now that we know whether to back off.
      this.update();
    }).catch((error: Error) => {
      hilog.warn(DOMAIN, TAG, 'status sync failed: %{public}s', error.message);
    });
  }
}

// MARK: - Deferred background refresh (BGTaskScheduler substitution)

const backgroundRefreshWorkID: number = 1001;
export const backgroundRefreshWorkName: string = 'com.ranchero.NetNewsWire.FeedRefresh';

/**
 * Schedules the deferred refresh — the BGTaskScheduler substitution. workScheduler's
 * `repeatCycleTime` is the closest equivalent of "no earlier than", gated on having a
 * network so it never fires offline.
 *
 * `abilityName` must name a WorkSchedulerExtensionAbility declared in module.json5; the
 * UI layer owns the manifest, so it passes its own name in. Nothing here fails hard if
 * the system declines: the foreground timer above still refreshes.
 */
export function scheduleBackgroundRefresh(bundleName: string,
  abilityName: string = 'RefreshWorkAbility'): void {
  const info: workScheduler.WorkInfo = {
    workId: backgroundRefreshWorkID,
    bundleName: bundleName,
    abilityName: abilityName,
    networkType: workScheduler.NetworkType.NETWORK_TYPE_ANY,
    isRepeat: true,
    repeatCycleTime: 30 * 60 * 1000,
    isPersisted: true
  };
  try {
    workScheduler.startWork(info);
  } catch (e) {
    // A denial is not fatal: the foreground timer still refreshes.
    hilog.warn(DOMAIN, TAG, 'background refresh not scheduled: %{public}s',
      (e as Error).message);
  }
}

export function cancelBackgroundRefresh(): void {
  try {
    workScheduler.stopAndClearWorks();
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'could not clear the background refresh work');
  }
}
