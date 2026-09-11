/**
 * ProgressInfo — port of Modules/RSCore/Sources/RSCore/RSProgress.swift
 *
 * All counts are estimates; callers do not have to predict exactly how many tasks they add
 * or complete.
 */

export class ProgressInfo {
  readonly numberOfTasks: number;
  readonly numberCompleted: number;
  readonly numberRemaining: number;

  constructor(numberOfTasks: number = 0, numberCompleted: number = 0, numberRemaining: number = 0) {
    this.numberOfTasks = numberOfTasks;
    this.numberCompleted = numberCompleted;
    this.numberRemaining = numberRemaining;
  }

  get isComplete(): boolean {
    return this.numberRemaining < 1;
  }

  equals(other: ProgressInfo): boolean {
    return this.numberOfTasks === other.numberOfTasks
      && this.numberCompleted === other.numberCompleted
      && this.numberRemaining === other.numberRemaining;
  }

  static combined(progressInfos: ProgressInfo[]): ProgressInfo {
    let numberOfTasks: number = 0;
    let numberCompleted: number = 0;
    let numberRemaining: number = 0;
    for (const progressInfo of progressInfos) {
      numberOfTasks += progressInfo.numberOfTasks;
      numberCompleted += progressInfo.numberCompleted;
      numberRemaining += progressInfo.numberRemaining;
    }
    return new ProgressInfo(numberOfTasks, numberCompleted, numberRemaining);
  }
}
