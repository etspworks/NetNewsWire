/**
 * CoalescingQueue — port of Modules/RSCore/Sources/RSCore/CoalescingQueue.swift
 *
 * Calls are uniqued by key; adding the same key twice runs it once. The perform date is
 * pushed off on every add, and a call older than `maxInterval` fires immediately. This is
 * what gives the per-account Subscriptions.opml save its 0.5s coalescing window.
 *
 * Swift keys a call by (weak target, selector); ArkTS has no selectors, so the caller
 * supplies a string key. Targets are not weakly held — call `cancelAll()` on teardown.
 */

export type QueueCall = () => void;

class KeyedCall {
  readonly key: string;
  readonly call: QueueCall;

  constructor(key: string, call: QueueCall) {
    this.key = key;
    this.call = call;
  }
}

export class CoalescingQueue {
  static readonly standard: CoalescingQueue = new CoalescingQueue('Standard', 50, 100);

  readonly name: string;
  isPaused: boolean = false;

  private readonly interval: number;
  private readonly maxInterval: number;
  private lastCallTime: number = Number.MAX_SAFE_INTEGER;
  private timerID: number = -1;
  private calls: KeyedCall[] = [];

  /** Intervals are milliseconds (the Swift source uses seconds). */
  constructor(name: string, interval: number = 50, maxInterval: number = 2000) {
    this.name = name;
    this.interval = interval;
    this.maxInterval = maxInterval;
  }

  add(key: string, call: QueueCall): void {
    this.restartTimer();
    let found: boolean = false;
    for (const existing of this.calls) {
      if (existing.key === key) {
        found = true;
        break;
      }
    }
    if (!found) {
      this.calls.push(new KeyedCall(key, call));
    }
    if (Date.now() - this.lastCallTime > this.maxInterval) {
      this.timerDidFire();
    }
  }

  performCallsImmediately(): void {
    if (this.isPaused) {
      return;
    }
    // Copy first — a call may enqueue more work.
    const callsToMake: KeyedCall[] = this.calls;
    this.calls = [];
    for (const keyedCall of callsToMake) {
      keyedCall.call();
    }
  }

  cancelAll(): void {
    this.invalidateTimer();
    this.calls = [];
  }

  private timerDidFire(): void {
    this.lastCallTime = Date.now();
    this.performCallsImmediately();
  }

  private restartTimer(): void {
    this.invalidateTimer();
    this.timerID = setTimeout(() => {
      this.timerID = -1;
      this.timerDidFire();
    }, this.interval);
  }

  private invalidateTimer(): void {
    if (this.timerID >= 0) {
      clearTimeout(this.timerID);
      this.timerID = -1;
    }
  }
}
