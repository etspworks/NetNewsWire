/**
 * CloudKitStatsViewPage (source: iOS/Settings/CloudKitStatsView.swift
 * + Modules/Account/.../CloudKitStatsViewModel.swift).
 *
 * The source's TWO whole render modes are both built here:
 * the scan mode (status row, then either the fetch error or the two record-count sections)
 * and the clean-up mode (status, results, navigation), plus the toolbar Cancel / More menu.
 *
 * 🟥 CloudKit is the one sanctioned substitution (platform-capability). the CloudKit service
 * (CloudKitAccountDelegate) raises `iCloud sync is not available on HarmonyOS` from
 * `fetchCloudKitStats`, so the scan lands in the source's OWN error slot: the error text is
 * shown, the counts are NOT shown, `canCleanUp` stays false, and no number is fabricated.
 * In practice the delegate is never even reached: an iCloud account can never be created
 * here, so `cloudKitDelegate()` returns undefined and the scan reports
 * `cloudKitNoAccountMessage` in that same slot.
 *
 * Styled from the iOS reference capture of CloudKitStatsView
 * with the tokens in the style baseline. The capture IS the substitution's
 * steady state — the status card reading "Scan failed." and the source's own error text in red
 * below it — so that path is styled exactly as the source renders it; no number is fabricated.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { CloudKitAccountDelegate, cloudKitNoAccountMessage }
  from '../common/account/CloudKitAccountDelegate';
import { AccountDelegate } from '../common/account/AccountDelegate';
import { CloudKitCleanUpPhase, CloudKitCleanUpPlan, CloudKitCleanUpProgress, CloudKitStats }
  from '../model/CloudKitStats';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'CloudKitStatsViewPage';

const helpURL: string = 'https://netnewswire.com/help/optimize-icloud.html';

/** iOS systemGreen — the source's `.foregroundStyle(.green)` checkmark (palette.json, light). */
const systemGreen: string = '#34C759';

/** CloudKitStatsViewModel.fetchStatus. */
enum FetchStatus {
  idle = 'idle',
  fetching = 'fetching',
  completed = 'completed',
  canceled = 'canceled',
  error = 'error'
}

/** CloudKitStatsViewModel.cleanUpStatus. */
enum CleanUpStatus {
  idle = 'idle',
  cleaning = 'cleaning',
  completed = 'completed',
  canceled = 'canceled',
  error = 'error'
}

@Entry
@Component
struct CloudKitStatsViewPage {
  @State fetchStatus: FetchStatus = FetchStatus.idle;
  @State fetchErrorMessage: string = '';
  @State stats: CloudKitStats = CloudKitStats.empty;
  @State cleanUpStatus: CleanUpStatus = CleanUpStatus.idle;
  @State cleanUpErrorMessage: string = '';
  @State hasCleanUpProgress: boolean = false;
  @State cleanUpProgress: CloudKitCleanUpProgress =
    new CloudKitCleanUpProgress(CloudKitCleanUpPhase.deletingStaleStatus, 0, 0, 0);

  /** Set by Cancel so a late result from a running scan is discarded. */
  private fetchGeneration: number = 0;

  aboutToAppear(): void {
    // The source auto-starts the scan on appear when idle.
    if (this.fetchStatus === FetchStatus.idle) {
      this.fetch();
    }
  }

  onPageHide(): void {
    // The source auto-cancels when the app is backgrounded.
    if (this.fetchStatus === FetchStatus.fetching) {
      this.cancelFetch();
    }
    if (this.cleanUpStatus === CleanUpStatus.cleaning) {
      this.cancelCleanUp();
    }
  }

  private syncUnreadContent(): boolean {
    return AccountManager.shared.syncArticleContentForUnreadArticles;
  }

  private cleanUpPlan(): CloudKitCleanUpPlan {
    return this.stats.cleanUpPlan(this.syncUnreadContent());
  }

  /** The Clean Up section exists only when there is something to clean up. */
  private canCleanUp(): boolean {
    return this.fetchStatus === FetchStatus.completed && !this.cleanUpPlan().isEmpty;
  }

  private cleanUpIsActive(): boolean {
    return this.cleanUpStatus !== CleanUpStatus.idle;
  }

  /** The iCloud account's delegate, or undefined when there is no iCloud account. */
  private cloudKitDelegate(): CloudKitAccountDelegate | undefined {
    const account: AccountService | undefined = AccountManager.shared.iCloudAccount;
    if (account === undefined) {
      return undefined;
    }
    const delegate: AccountDelegate = account.delegate;
    if (delegate instanceof CloudKitAccountDelegate) {
      return delegate as CloudKitAccountDelegate;
    }
    return undefined;
  }

  /** model.fetch(): restarts the record scan. On HarmonyOS it reports unavailability. */
  private fetch(): void {
    const delegate: CloudKitAccountDelegate | undefined = this.cloudKitDelegate();
    this.fetchGeneration += 1;
    const generation: number = this.fetchGeneration;
    this.fetchErrorMessage = '';
    this.fetchStatus = FetchStatus.fetching;

    if (delegate === undefined) {
      // No iCloud account, so no delegate to ask. The sync-path wording would speak about
      // "this account" — there is none here; say what is actually true instead.
      this.fetchStatus = FetchStatus.error;
      this.fetchErrorMessage = cloudKitNoAccountMessage;
      return;
    }

    delegate.fetchCloudKitStats((partialStats: CloudKitStats): void => {
      if (generation === this.fetchGeneration) {
        this.stats = partialStats;
      }
    }).then((finalStats: CloudKitStats): void => {
      if (generation !== this.fetchGeneration) {
        return;
      }
      this.stats = finalStats;
      this.fetchStatus = FetchStatus.completed;
    }).catch((e: Object): void => {
      if (generation !== this.fetchGeneration) {
        return;
      }
      hilog.warn(DOMAIN, TAG, 'iCloud scan failed: %{public}s', String(e));
      this.fetchErrorMessage = e instanceof Error ? (e as Error).message : String(e);
      this.fetchStatus = FetchStatus.error;
    });
  }

  private cancelFetch(): void {
    this.fetchGeneration += 1;
    this.fetchStatus = FetchStatus.canceled;
  }

  /** model.cleanUp(): the destructive clean-up the confirmation guards. */
  private cleanUp(): void {
    const delegate: CloudKitAccountDelegate | undefined = this.cloudKitDelegate();
    this.cleanUpErrorMessage = '';
    this.cleanUpStatus = CleanUpStatus.cleaning;

    if (delegate === undefined) {
      this.cleanUpStatus = CleanUpStatus.error;
      this.cleanUpErrorMessage = cloudKitNoAccountMessage;
      return;
    }

    delegate.cleanUpCloudKit(false, (progress: CloudKitCleanUpProgress): void => {
      this.cleanUpProgress = progress;
      this.hasCleanUpProgress = true;
    }).then((): void => {
      this.cleanUpStatus = CleanUpStatus.completed;
    }).catch((e: Object): void => {
      hilog.warn(DOMAIN, TAG, 'iCloud clean-up failed: %{public}s', String(e));
      this.cleanUpErrorMessage = e instanceof Error ? (e as Error).message : String(e);
      this.cleanUpStatus = CleanUpStatus.error;
    });
  }

  private cancelCleanUp(): void {
    this.cleanUpStatus = CleanUpStatus.canceled;
  }

  private confirmCleanUp(): void {
    AlertDialog.show({
      title: $r('app.string.clean_up_icloud_records'),
      message: this.cleanUpConfirmationMessage(),
      primaryButton: {
        value: $r('app.string.cancel'),
        action: (): void => {
        }
      },
      secondaryButton: {
        value: $r('app.string.clean_up'),
        action: (): void => {
          this.cleanUp();
        }
      }
    });
  }

  private cleanUpConfirmationMessage(): string {
    const plan: CloudKitCleanUpPlan = this.cleanUpPlan();
    if (plan.isEmpty) {
      return this.syncUnreadContent()
        ? 'This will delete any read content records.\n\nThis may take several minutes.'
        : 'This will delete any not-starred content records.\n\nThis may take several minutes.';
    }
    let lines: string = '';
    if (plan.readContentCount > 0) {
      lines += '• ' + plan.readContentCount + (plan.readContentCount === 1
        ? ' read content record' : ' read content records') + '\n';
    }
    if (plan.unreadContentCount > 0) {
      lines += '• ' + plan.unreadContentCount + (plan.unreadContentCount === 1
        ? ' unread content record' : ' unread content records') + '\n';
    }
    return 'This will delete:\n' + lines + '\nThis may take several minutes.';
  }

  /** The text Share Stats shares — the stats, or the clean-up results while cleaning. */
  private shareText(): string {
    if (this.cleanUpIsActive()) {
      return 'Read Content Deleted: ' + this.cleanUpProgress.readContentDeleted
        + '\nUnread Content Deleted: ' + this.cleanUpProgress.unreadContentDeleted;
    }
    if (this.fetchStatus === FetchStatus.error) {
      return this.fetchErrorMessage;
    }
    return 'Status Records: ' + this.stats.statusCount
      + '\nStarred: ' + this.stats.starredStatusCount
      + '\nUnread: ' + this.stats.unreadStatusCount
      + '\nRead: ' + this.stats.readStatusCount
      + '\nArticle Content Records: ' + this.stats.articleCount
      + '\nStarred: ' + this.stats.starredArticleCount
      + '\nUnread: ' + this.stats.unreadArticleCount
      + '\nRead: ' + this.stats.readArticleCount;
  }

  private shareStats(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    ShareService.shared.shareText(context, this.shareText())
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not share the stats: %{public}s', String(e));
      });
  }

  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, helpURL)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open help: %{public}s', String(e));
      });
  }

  private cleanUpPhaseText(phase: CloudKitCleanUpPhase): ResourceStr {
    if (phase === CloudKitCleanUpPhase.deletingReadContent) {
      return $r('app.string.deleting_read_content_records');
    }
    if (phase === CloudKitCleanUpPhase.deletingUnreadContent) {
      return $r('app.string.deleting_unread_content_records');
    }
    if (phase === CloudKitCleanUpPhase.completed) {
      return $r('app.string.icloud_storage_cleanup_completed');
    }
    return '';
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /**
   * `countColor(isWarning:count:)` — secondary while working, orange above zero when the count
   * is one the source warns about, otherwise primary.
   */
  private countColor(isWarning: boolean, count: number): ResourceColor {
    if (this.fetchStatus === FetchStatus.fetching
      || this.cleanUpStatus === CleanUpStatus.cleaning) {
      return $r('sys.color.ohos_id_color_text_secondary');
    }
    if (isWarning && count > 0) {
      // .orange — ohos_id_color_alert (#ED6F21) is this SDK's orange role; warning is red.
      return $r('sys.color.ohos_id_color_alert');
    }
    return $r('sys.color.ohos_id_color_text_primary');
  }

  /** `isWarning` marks the counts the source paints orange above zero. */
  @Builder
  statsRow(label: ResourceStr, count: number, isWarning: boolean, isHeader: boolean,
    hasDivider: boolean) {
    Column() {
      Row() {
        Text(label)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(isHeader ? FontWeight.Medium : FontWeight.Regular)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
        Blank()
        Text(count.toString())
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor(this.countColor(isWarning, count))
      }
      .width('100%')
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      .constraintSize({ minHeight: 49 })
      .alignItems(VerticalAlign.Center)

      if (hasDivider) {
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
      }
    }
    .width('100%')
  }

  /** One grouped Section = one white card, inset 16 from the page. */
  @Styles
  sectionCard() {
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
    .clip(true)
    .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
  }

  @Builder
  moreMenu() {
    Menu() {
      MenuItem({ content: $r('app.string.share_stats') })
        .onClick(() => {
          this.shareStats();
        })
      MenuItem({ content: $r('app.string.help') })
        .onClick(() => {
          this.openHelp();
        })
    }
  }

  /** The topBarTrailing item: Cancel while working, otherwise the More menu. */
  @Builder
  statsToolbar() {
    Stack() {
      Text($r('app.string.icloud_storage_stats'))
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))

      Row() {
        // The pushed screen's automatic back item — the capture shows it at the far left.
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          .padding(10)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .accessibilityText('Settings')
          .id('BackButton')
          .onClick(() => {
            router.back();
          })

        Blank()
        if (this.fetchStatus === FetchStatus.fetching
          || this.cleanUpStatus === CleanUpStatus.cleaning) {
          // A text bar button — the glass capsule the capture shows for a worded action.
          Button($r('app.string.cancel'))
            .id('cloudkit_stats_cancel')
            .type(ButtonType.Capsule)
            .height(36)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              if (this.fetchStatus === FetchStatus.fetching) {
                this.cancelFetch();
              } else {
                this.cancelCleanUp();
              }
            })
        } else {
          // Label("More", systemImage: "ellipsis.circle") — icon-only in the capture.
          Button({ type: ButtonType.Circle }) {
            SymbolGlyph($r('sys.symbol.ellipsis_circle'))
              .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
              .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          }
          .padding(6)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .id('cloudkit_stats_more')
          .enabled(this.fetchStatus === FetchStatus.completed || this.cleanUpIsActive())
          // the source disables More until a scan completes — show it, don't eat taps.
          .opacity(this.fetchStatus === FetchStatus.completed || this.cleanUpIsActive() ? 1 : 0.4)
          .bindMenu(this.moreMenu())
        }
      }
      .width('100%')
      // The bar-button row must not swallow taps meant for the title beneath it.
      .hitTestBehavior(HitTestMode.Transparent)
    }
    .width('100%')
    .height(44)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
  }

  @Builder
  statusSection() {
    Column() {
      if (this.fetchStatus === FetchStatus.fetching) {
        // In-flight state: the source's small ProgressView + secondary label.
        Row({ space: 6 }) {
          LoadingProgress()
            .width(24)
            .height(24)
            .color($r('sys.color.ohos_id_color_text_secondary'))
          Text($r('app.string.scanning_icloud_storage'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .constraintSize({ minHeight: 49 })
        .alignItems(VerticalAlign.Center)
      } else if (this.fetchStatus === FetchStatus.completed) {
        Row({ space: 4 }) {
          SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor([systemGreen])
          Text($r('app.string.scan_completed'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Blank()
          Button($r('app.string.refresh'))
            .id('cloudkit_stats_refresh')
            .type(ButtonType.Normal)
            .backgroundColor(Color.Transparent)
            .padding(0)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.fetch();
            })
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .constraintSize({ minHeight: 49 })
        .alignItems(VerticalAlign.Center)
      } else if (this.fetchStatus === FetchStatus.canceled) {
        Row() {
          Text($r('app.string.canceled'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Blank()
          Button($r('app.string.refresh'))
            .id('cloudkit_stats_refresh')
            .type(ButtonType.Normal)
            .backgroundColor(Color.Transparent)
            .padding(0)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.fetch();
            })
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .constraintSize({ minHeight: 49 })
        .alignItems(VerticalAlign.Center)
      } else if (this.fetchStatus === FetchStatus.error) {
        // The steady state on HarmonyOS — the capture's "Scan failed." + Refresh card.
        Row() {
          Text($r('app.string.scan_failed'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Blank()
          Button($r('app.string.refresh'))
            .id('cloudkit_stats_refresh')
            .type(ButtonType.Normal)
            .backgroundColor(Color.Transparent)
            .padding(0)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.fetch();
            })
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
        .constraintSize({ minHeight: 49 })
        .alignItems(VerticalAlign.Center)
      }
    }
    .sectionCard()
  }

  @Builder
  recordSections() {
    Column() {
      // Section 1 — Status Records.
      Column() {
        this.statsRow($r('app.string.status_records'), this.stats.statusCount, false, true, true)
        this.statsRow($r('app.string.starred'), this.stats.starredStatusCount, false, false, true)
        this.statsRow($r('app.string.unread'), this.stats.unreadStatusCount, false, false, true)
        this.statsRow($r('app.string.read'), this.stats.readStatusCount, false, false, false)
      }
      .sectionCard()

      // Section 2 — Article Content Records.
      Column() {
        this.statsRow($r('app.string.article_content_records'), this.stats.articleCount,
          false, true, true)
        this.statsRow($r('app.string.starred'), this.stats.starredArticleCount, false, false, true)
        this.statsRow($r('app.string.unread'), this.stats.unreadArticleCount,
          !this.syncUnreadContent(), false, true)
        this.statsRow($r('app.string.read'), this.stats.readArticleCount, true, false, false)
      }
      .sectionCard()
    }
    .width('100%')
  }

  @Builder
  cleanUpSections() {
    Column() {
      // Status
      Column() {
        if (this.cleanUpStatus === CleanUpStatus.error) {
          Text($r('app.string.cleanup_failed_to_complete_but_you_may_be_ab'))
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .padding({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              top: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
              bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m')
            })
          Button($r('app.string.refresh'))
            .id('cloudkit_stats_refresh')
            .type(ButtonType.Normal)
            .width('100%')
            .height(49)
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.fetch();
            })
        } else if (this.cleanUpStatus === CleanUpStatus.canceled) {
          Text($r('app.string.cleanup_canceled'))
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
        } else if (this.cleanUpStatus === CleanUpStatus.completed) {
          Text($r('app.string.icloud_storage_cleanup_completed'))
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
        } else if (this.hasCleanUpProgress) {
          Text(this.cleanUpPhaseText(this.cleanUpProgress.phase))
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding($r('sys.float.ohos_id_elements_margin_horizontal_l'))
        }
      }
      .sectionCard()

      // Results
      Column() {
        if (this.hasCleanUpProgress) {
          this.statsRow($r('app.string.read_content_deleted'),
            this.cleanUpProgress.readContentDeleted, false, false, true)
          this.statsRow($r('app.string.unread_content_deleted'),
            this.cleanUpProgress.unreadContentDeleted, false, false, false)
        }
      }
      .sectionCard()

      // Navigation
      Column() {
        if (this.cleanUpStatus === CleanUpStatus.completed
          || this.cleanUpStatus === CleanUpStatus.canceled) {
          Button($r('app.string.return_to_previous_scan_results'))
            .id('cloudkit_stats_return')
            .type(ButtonType.Normal)
            .width('100%')
            .height(49)
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.cleanUpStatus = CleanUpStatus.idle;
              this.hasCleanUpProgress = false;
            })
          Divider()
            .strokeWidth(0.5)
            .color($r('sys.color.ohos_id_color_list_separator'))
            .margin({
              left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
              right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
            })
          Button($r('app.string.refresh_scan'))
            .id('cloudkit_stats_refresh_scan')
            .type(ButtonType.Normal)
            .width('100%')
            .height(49)
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick(() => {
              this.fetch();
            })
        }
      }
      .sectionCard()
    }
    .width('100%')
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      this.statsToolbar()

      Scroll() {
        Column() {
          if (this.cleanUpIsActive()) {
            this.cleanUpSections()
          } else {
            this.statusSection()
            if (this.fetchStatus === FetchStatus.error) {
              // The substitution reports here: the counts are NOT shown, nothing is faked.
              // `Text(fetchError.localizedDescription).foregroundStyle(.red)` in its own Section.
              Text(this.fetchErrorMessage)
                .width('100%')
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor($r('sys.color.ohos_id_color_warning'))
                .padding({
                  left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
                  right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
                })
                .constraintSize({ minHeight: 49 })
                .sectionCard()
            } else {
              this.recordSections()
            }
            if (this.canCleanUp()) {
              Button($r('app.string.clean_up_2'))
                .id('cloudkit_stats_clean_up')
                .type(ButtonType.Normal)
                .width('100%')
                .height(49)
                .backgroundColor($r('sys.color.ohos_id_color_background'))
                .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
                .onClick(() => {
                  this.confirmCleanUp();
                })
            }
            // An empty Section whose footer is the help link — no card, just the tinted label.
            Button($r('app.string.how_to_optimize_icloud_syncing'))
              .id('cloudkit_stats_help')
              .type(ButtonType.Normal)
              .width('100%')
              .backgroundColor(Color.Transparent)
              .fontSize($r('sys.float.ohos_id_text_size_body2'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .margin({ top: 35 })
              .onClick(() => {
                this.openHelp();
              })
          }
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
      }
      .align(Alignment.Top)
      .layoutWeight(1)
      .width('100%')
    }
    .id('CloudKitStatsView')
    .width('100%')
    .height('100%')
    // systemGroupedBackground — the grouped page the inset cards sit on.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
