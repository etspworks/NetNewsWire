/**
 * ActivityLog — port of Modules/ActivityLog/Sources/ActivityLog/ActivityLog.swift
 * (+ ActivityLogDataSize.swift).
 *
 * In-memory log of app activities (refreshes, downloads, status syncs). Each activity moves
 * pending -> running -> completed/failed, and the Current Activity screen shows the live
 * ones while the Activity Log screen shows the completed ring (capped at 500).
 *
 * The source posts `.activityDidChange`; HarmonyOS has no NotificationCenter, so listeners
 * register directly and the screens subscribe from `aboutToAppear`.
 */

import { Activity, ActivityKind, ActivityOwner, completedActivitiesLimit }
  from '../../model/Activity';

export type ActivityChangeListener = () => void;

export class ActivityLog {
  static readonly shared: ActivityLog = new ActivityLog();

  /** Activities created but not yet started. */
  pendingActivities: Activity[] = [];
  /** Activities currently in progress. */
  runningActivities: Activity[] = [];
  /** Recently completed or failed activities. */
  completedActivities: Activity[] = [];

  readonly completedActivitiesLimit: number = completedActivitiesLimit;

  private nextID: number = 0;
  private nextTaskNumber: number = 1;
  private listeners: ActivityChangeListener[] = [];

  addListener(listener: ActivityChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: ActivityChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /** A unique, incrementing task number for use in activity detail strings. */
  nextTaskNumberString(): string {
    const number: number = this.nextTaskNumber;
    this.nextTaskNumber += 1;
    return '#' + number;
  }

  // MARK: - Creating activities

  createActivity(owner: ActivityOwner, kind: ActivityKind, detail?: string): number {
    const id: number = this.nextID;
    this.nextID += 1;
    this.pendingActivities.push(new Activity(id, owner, kind, detail));
    this.postDidChange();
    return id;
  }

  /**
   * Creates and completes an activity in one call — for instantaneous markers or work
   * already finished by the time it is logged. No start timestamp, so no duration.
   */
  logCompletedActivity(owner: ActivityOwner, kind: ActivityKind, detail?: string,
    message?: string): void {
    const id: number = this.createActivity(owner, kind, detail);
    this.didCompleteWithID(id, message, false, false);
  }

  // MARK: - Lifecycle by kind

  didStart(owner: ActivityOwner, kind: ActivityKind): void {
    const activity: Activity | undefined = this.findPendingActivity(owner, kind);
    if (activity === undefined) {
      return;
    }
    activity.didStart();
    this.movePendingToRunning(activity);
    this.postDidChange();
  }

  /**
   * Moves the activity from pending to running without a start timestamp; does nothing if
   * it is already running. Used when an activity completes without ever truly starting.
   */
  startIfNeeded(owner: ActivityOwner, kind: ActivityKind): void {
    if (this.findRunningActivity(owner, kind) !== undefined) {
      return;
    }
    const activity: Activity | undefined = this.findPendingActivity(owner, kind);
    if (activity === undefined) {
      return;
    }
    activity.didStartWithoutTimestamp();
    this.movePendingToRunning(activity);
    this.postDidChange();
  }

  /**
   * Completes the running activity matching (owner, kind), promoting it from pending first
   * if it was never explicitly started. Best-effort. Assumes at most one active activity
   * per (owner, kind) — use the id-based API for concurrent same-kind work.
   */
  didComplete(owner: ActivityOwner, kind: ActivityKind, message?: string,
    durationIsSignificant: boolean = true, returnedFromCache: boolean = false): void {
    const activity: Activity | undefined = this.ensureRunning(owner, kind);
    if (activity === undefined) {
      return;
    }
    activity.durationIsSignificant = durationIsSignificant;
    activity.didComplete(message, returnedFromCache);
    this.moveToCompleted(activity);
    this.postDidChange();
  }

  didFail(owner: ActivityOwner, kind: ActivityKind, error: Error): void {
    const activity: Activity | undefined = this.ensureRunning(owner, kind);
    if (activity === undefined) {
      return;
    }
    activity.durationIsSignificant = false;
    activity.didFail(error);
    this.moveToCompleted(activity);
    this.postDidChange();
  }

  // MARK: - Lifecycle by ID

  didStartWithID(id: number): void {
    const activity: Activity | undefined = this.findPendingActivityWithID(id);
    if (activity === undefined) {
      return;
    }
    activity.didStart();
    this.movePendingToRunning(activity);
    this.postDidChange();
  }

  didCompleteWithID(id: number, message?: string, durationIsSignificant: boolean = true,
    returnedFromCache: boolean = false): void {
    const activity: Activity | undefined = this.ensureRunningWithID(id);
    if (activity === undefined) {
      return;
    }
    activity.durationIsSignificant = durationIsSignificant;
    activity.didComplete(message, returnedFromCache);
    this.moveToCompleted(activity);
    this.postDidChange();
  }

  didFailWithID(id: number, error: Error): void {
    const activity: Activity | undefined = this.ensureRunningWithID(id);
    if (activity === undefined) {
      return;
    }
    activity.durationIsSignificant = false;
    activity.didFail(error);
    this.moveToCompleted(activity);
    this.postDidChange();
  }

  // MARK: - Queries

  pendingActivitiesFor(owner: ActivityOwner): Activity[] {
    return this.pendingActivities.filter((a: Activity) => a.owner.equals(owner));
  }

  runningActivitiesFor(owner: ActivityOwner): Activity[] {
    return this.runningActivities.filter((a: Activity) => a.owner.equals(owner));
  }

  completedActivitiesFor(owner: ActivityOwner): Activity[] {
    return this.completedActivities.filter((a: Activity) => a.owner.equals(owner));
  }

  /** Formats a download size for an activity message — for example "39 kB". */
  static dataSizeMessage(byteLength: number): string {
    if (byteLength < 1000) {
      return byteLength + ' bytes';
    }
    if (byteLength < 1000 * 1000) {
      return Math.round(byteLength / 1000) + ' kB';
    }
    return (byteLength / (1000 * 1000)).toFixed(1) + ' MB';
  }

  // MARK: - Private

  private ensureRunning(owner: ActivityOwner, kind: ActivityKind): Activity | undefined {
    const running: Activity | undefined = this.findRunningActivity(owner, kind);
    if (running !== undefined) {
      return running;
    }
    const pending: Activity | undefined = this.findPendingActivity(owner, kind);
    if (pending === undefined) {
      return undefined;
    }
    pending.didStartWithoutTimestamp();
    this.movePendingToRunning(pending);
    return pending;
  }

  private ensureRunningWithID(id: number): Activity | undefined {
    const running: Activity | undefined = this.findRunningActivityWithID(id);
    if (running !== undefined) {
      return running;
    }
    const pending: Activity | undefined = this.findPendingActivityWithID(id);
    if (pending === undefined) {
      return undefined;
    }
    pending.didStartWithoutTimestamp();
    this.movePendingToRunning(pending);
    return pending;
  }

  private findPendingActivity(owner: ActivityOwner,
    kind: ActivityKind): Activity | undefined {
    return this.pendingActivities.find((a: Activity) =>
      a.owner.equals(owner) && a.kind.equals(kind));
  }

  private findPendingActivityWithID(id: number): Activity | undefined {
    return this.pendingActivities.find((a: Activity) => a.id === id);
  }

  private findRunningActivity(owner: ActivityOwner,
    kind: ActivityKind): Activity | undefined {
    return this.runningActivities.find((a: Activity) =>
      a.owner.equals(owner) && a.kind.equals(kind));
  }

  private findRunningActivityWithID(id: number): Activity | undefined {
    return this.runningActivities.find((a: Activity) => a.id === id);
  }

  private movePendingToRunning(activity: Activity): void {
    this.pendingActivities = this.pendingActivities.filter((a: Activity) => a !== activity);
    this.runningActivities.push(activity);
  }

  private moveToCompleted(activity: Activity): void {
    this.runningActivities = this.runningActivities.filter((a: Activity) => a !== activity);
    this.completedActivities.push(activity);
    if (this.completedActivities.length > this.completedActivitiesLimit) {
      this.completedActivities = this.completedActivities.slice(
        this.completedActivities.length - this.completedActivitiesLimit);
    }
  }

  private postDidChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
