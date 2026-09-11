/**
 * RefreshProgressView.
 * Source: iOS/MainFeed/RefreshProgressView.swift.
 *
 * Two mutually exclusive states, exactly as the source's `progressChanged(animated:)`:
 *  - a refresh is running  -> the progress bar (numberCompleted / numberOfTasks), label hidden;
 *  - nothing running       -> the progress bar hidden and the "Updated <relative>" label, which
 *                             reads "Updated Just Now" inside the first 60 seconds and is
 *                             re-computed every 60s (`scheduleUpdateRefreshLabel`).
 *
 * It subscribes to CombinedRefreshProgress (the source's .progressInfoDidChange observer) and
 * mirrors the percentage into AppStorage under `nnwRefreshProgress`, which is the key the feed
 * and timeline pages bind with @StorageLink.
 */

import i18n from '@ohos.i18n';
import intl from '@ohos.intl';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CombinedRefreshProgress } from '../common/account/AccountDelegate';
import { AccountManager } from '../common/account/AccountManager';
import { ProgressInfo } from '../model/ProgressInfo';

const DOMAIN: number = 0x0001;
const TAG: string = 'RefreshProgressView';

/** AppStorage key: 0..1 refresh completion, published for the toolbars that bind it. */
export const refreshProgressKey: string = 'nnwRefreshProgress';

/** RelativeDateTimeFormatter(dateTimeStyle: .named) over the largest fitting unit. */
export function relativeTimeString(from: Date, to: Date): string {
  const seconds: number = Math.round((from.getTime() - to.getTime()) / 1000);
  const absolute: number = Math.abs(seconds);
  let value: number = seconds;
  let unit: string = 'second';
  if (absolute >= 86400) {
    value = Math.round(seconds / 86400);
    unit = 'day';
  } else if (absolute >= 3600) {
    value = Math.round(seconds / 3600);
    unit = 'hour';
  } else if (absolute >= 60) {
    value = Math.round(seconds / 60);
    unit = 'minute';
  }
  try {
    // An EMPTY locale resolves to ICU's root locale, whose pattern is the bare signed number
    // ("-2 min") — the toolbar read "Updated -2 min" instead of "2 minutes ago".
    const formatter: intl.RelativeTimeFormat =
      new intl.RelativeTimeFormat(i18n.System.getSystemLocale(),
        { numeric: 'auto', style: 'long' });
    return formatter.format(value, unit);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'RelativeTimeFormat unavailable: %{public}s', (e as Error).message);
    return value + ' ' + unit;
  }
}

@Component
export struct RefreshProgressView {
  @State private isComplete: boolean = true;
  @State private percent: number = 0;
  @State private refreshLabel: string = '';
  /** False until a refresh has ever completed — the source shows no label at all then. */
  @State private hasRefreshed: boolean = false;

  private progressListener: () => void = (): void => {
    this.progressChanged();
  };
  private labelTimerID: number = -1;

  aboutToAppear(): void {
    CombinedRefreshProgress.shared.addListener(this.progressListener);
    this.progressChanged();
    // scheduleUpdateRefreshLabel(): the source re-computes the relative string every 60s.
    this.labelTimerID = setInterval(() => {
      this.updateRefreshLabel();
    }, 60000);
  }

  aboutToDisappear(): void {
    try {
      CombinedRefreshProgress.shared.removeListener(this.progressListener);
    } finally {
      if (this.labelTimerID >= 0) {
        clearInterval(this.labelTimerID);
        this.labelTimerID = -1;
      }
    }
  }

  private progressChanged(): void {
    const info: ProgressInfo = CombinedRefreshProgress.shared.progressInfo;
    const complete: boolean = CombinedRefreshProgress.shared.isComplete || info.isComplete;
    let next: number = 1;
    if (!complete && info.numberOfTasks > 0) {
      next = info.numberCompleted / info.numberOfTasks;
    }
    // "Don't let the progress bar go backwards unless we need to go back more than 25%."
    if (complete || next > this.percent || this.percent - next > 0.25) {
      this.percent = complete ? 0 : next;
    }
    this.isComplete = complete;
    AppStorage.setOrCreate<number>(refreshProgressKey, complete ? 0 : this.percent);
    if (complete) {
      this.updateRefreshLabel();
    }
  }

  private updateRefreshLabel(): void {
    const lastRefresh: Date | undefined = AccountManager.shared.lastRefreshCompletedDate;
    if (lastRefresh === undefined) {
      this.hasRefreshed = false;
      this.refreshLabel = '';
      return;
    }
    this.hasRefreshed = true;
    const now: Date = new Date();
    if (now.getTime() > lastRefresh.getTime() + 60000) {
      this.refreshLabel = relativeTimeString(lastRefresh, now);
    } else {
      this.refreshLabel = '';
    }
  }

  build() {
    // the toolbar's centred progress/status slot. Loading -> the thin linear bar on
    // the accent tint; settled -> the grey `.footnote` "Updated …" label; never refreshed ->
    // nothing at all, exactly as the source's progressChanged(animated:).
    Column() {
      if (!this.isComplete) {
        Progress({ value: this.percent * 100, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(4)
          .color($r('sys.color.ohos_id_color_text_primary_activated'))
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      } else if (this.hasRefreshed && this.refreshLabel.length > 0) {
        Text($r('app.string.updated', this.refreshLabel))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .textAlign(TextAlign.Center)
      } else if (this.hasRefreshed) {
        Text($r('app.string.updated_just_now'))
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .textAlign(TextAlign.Center)
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }
}
