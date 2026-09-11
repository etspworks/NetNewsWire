/**
 * Progress — port of Modules/RSCore/Sources/RSCore/RSProgress.swift (the mutable half;
 * the immutable ProgressInfo snapshot lives in model/ProgressInfo.ts).
 *
 * Counts are estimates: after every mutation they are normalized so all three are >= 0
 * and numberOfTasks == numberCompleted + numberRemaining. Notification.Name
 * `.progressInfoDidChange` becomes a listener list, since HarmonyOS has no
 * NotificationCenter.
 */

import { ProgressInfo } from '../../model/ProgressInfo';

export type ProgressListener = (progressInfo: ProgressInfo) => void;

export class RSProgress {
  private numberOfTasks: number = 0;
  private numberCompleted: number = 0;
  private numberRemaining: number = 0;
  private children: RSProgress[] = [];
  private listeners: ProgressListener[] = [];

  progressInfo: ProgressInfo = new ProgressInfo();

  constructor(numberOfTasks: number = 0) {
    this.numberOfTasks = Math.max(0, numberOfTasks);
    this.numberRemaining = this.numberOfTasks;
    this.updateProgressInfo();
  }

  get hasNoRemainingTasks(): boolean {
    return this.numberRemaining < 1;
  }

  addListener(listener: ProgressListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: ProgressListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  updateNumberRemaining(newNumberRemaining: number): void {
    const clamped: number = Math.max(0, newNumberRemaining);
    if (clamped === this.numberRemaining) {
      return;
    }
    this.numberRemaining = clamped;
    if (this.numberCompleted + this.numberRemaining > this.numberOfTasks) {
      this.numberOfTasks = this.numberCompleted + this.numberRemaining;
    } else {
      this.numberCompleted = this.numberOfTasks - this.numberRemaining;
    }
    this.updateProgressInfo();
  }

  updateNumberCompleted(newNumberCompleted: number): void {
    const clamped: number = Math.max(0, newNumberCompleted);
    if (clamped === this.numberCompleted) {
      return;
    }
    this.numberCompleted = clamped;
    if (this.numberCompleted > this.numberOfTasks) {
      this.numberOfTasks = this.numberCompleted;
    }
    this.numberRemaining = this.numberOfTasks - this.numberCompleted;
    this.updateProgressInfo();
  }

  addTasks(count: number): void {
    if (count <= 0) {
      return;
    }
    this.numberOfTasks += count;
    this.numberRemaining = this.numberOfTasks - this.numberCompleted;
    this.updateProgressInfo();
  }

  addTask(): void {
    this.addTasks(1);
  }

  completeTasks(count: number): void {
    if (count <= 0) {
      return;
    }
    this.numberCompleted += count;
    if (this.numberCompleted > this.numberOfTasks) {
      this.numberOfTasks = this.numberCompleted;
    }
    this.numberRemaining = this.numberOfTasks - this.numberCompleted;
    this.updateProgressInfo();
  }

  completeTask(): void {
    this.completeTasks(1);
  }

  completeAll(): void {
    this.numberCompleted = this.numberOfTasks;
    this.numberRemaining = 0;
    this.updateProgressInfo();
  }

  reset(): void {
    this.numberOfTasks = 0;
    this.numberCompleted = 0;
    this.numberRemaining = 0;
    this.updateProgressInfo();
  }

  addChild(child: RSProgress): void {
    this.children.push(child);
    child.addListener(() => {
      this.updateProgressInfo();
    });
    this.updateProgressInfo();
  }

  private updateProgressInfo(): void {
    let numberOfTasks: number = this.numberOfTasks;
    let numberCompleted: number = this.numberCompleted;
    let numberRemaining: number = this.numberRemaining;

    for (const child of this.children) {
      numberOfTasks += child.progressInfo.numberOfTasks;
      numberCompleted += child.progressInfo.numberCompleted;
      numberRemaining += child.progressInfo.numberRemaining;
    }

    const updated: ProgressInfo = new ProgressInfo(numberOfTasks, numberCompleted,
      numberRemaining);
    if (updated.equals(this.progressInfo)) {
      return;
    }
    this.progressInfo = updated;
    for (const listener of this.listeners) {
      listener(updated);
    }
  }
}
