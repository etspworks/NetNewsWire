/**
 * AccountStatsViewPage (source: iOS/AccountStats/AccountStatsView.swift
 * + Shared/AccountStats/AccountStatsViewModel.swift).
 *
 * One section per account with seven stat rows, a Totals
 * section when more than one account exists, the Vacuum Databases action and the help link.
 * Every number is queried through AccountStatsModel (AccountStatsModel) — the captured
 * state is empty, and nothing here is transcribed from it.
 *
 * Styled from the iOS reference capture of AccountStatsView
 * with the tokens in the style baseline — an inset-grouped list (one white card
 * per section on the grouped-gray page), an inline centred nav title with the round glass
 * Refresh chip, and the two Button sections the source renders as a card / bare footer link.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountChange, AccountService } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { AccountStatsModel, AccountStatsRowData, AccountStatsTotals }
  from '../common/account/AccountStatsModel';
import { BrowserService } from '../common/system/BrowserService';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'AccountStatsViewPage';

const helpURL: string = 'https://netnewswire.com/help/account-stats.html';

/** One `StatItem` of the source's seven-row stat block. */
class StatItem {
  readonly label: ResourceStr;
  readonly value: string;

  constructor(label: ResourceStr, value: string) {
    this.label = label;
    this.value = value;
  }
}

@Entry
@Component
struct AccountStatsViewPage {
  @State rows: AccountStatsRowData[] = [];
  @State totals: AccountStatsTotals = new AccountStatsTotals([]);
  @State isVacuuming: boolean = false;

  private readonly model: AccountStatsModel = new AccountStatsModel();
  /** Kept so it can be removed again — the source's three account notifications. */
  private accountListener: (change: AccountChange, account?: AccountService) => void =
    (change: AccountChange): void => {
      if (change === AccountChange.state) {
        this.refresh();
      }
    };

  aboutToAppear(): void {
    AccountManager.shared.addListener(this.accountListener);
    this.refresh();
  }

  aboutToDisappear(): void {
    AccountManager.shared.removeListener(this.accountListener);
  }

  /** The toolbar Refresh button and `.task`: re-query every account's sizes and counts. */
  private refresh(): void {
    this.model.refresh().then((): void => {
      this.rows = this.model.sortedAccountStats;
      this.totals = this.model.totals;
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'refresh failed: %{public}s', String(e));
    });
  }

  /** Vacuum Databases: VACUUM every account store, then refresh. Both buttons disable. */
  private vacuum(): void {
    if (this.isVacuuming) {
      return;
    }
    this.isVacuuming = true;
    const sizeBefore: number = this.totals.databaseSizeBytes;
    this.model.vacuumAllDatabases().then((): void => {
      this.rows = this.model.sortedAccountStats;
      this.totals = this.model.totals;
      // The source has no completion feedback beyond the ProgressView, but VACUUM finishes in
      // well under a second on a few-MB store, so the disabled buttons and the spinner flash
      // by and a store with nothing to reclaim leaves the Databases row unchanged — a
      // successful run and a silent failure look identical. Report the before/after size.
      this.getUIContext().getPromptAction().showToast({
        message: 'Vacuumed databases: ' + AccountStatsModel.formattedByteCount(sizeBefore) +
          ' → ' + AccountStatsModel.formattedByteCount(this.totals.databaseSizeBytes)
      });
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'vacuum failed: %{public}s', String(e));
      this.getUIContext().getPromptAction().showToast({ message: 'Vacuum failed.' });
    }).finally((): void => {
      this.isVacuuming = false;
    });
  }

  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, helpURL)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open help: %{public}s', String(e));
      });
  }

  private statItems(databaseSizeBytes: number, feedCount: number, folderCount: number,
    articleCount: number, statusesCount: number, unreadCount: number,
    starredCount: number): StatItem[] {
    return [
      new StatItem($r('app.string.databases'),
        AccountStatsModel.formattedByteCount(databaseSizeBytes)),
      new StatItem($r('app.string.feeds'), feedCount.toString()),
      new StatItem($r('app.string.folders'), folderCount.toString()),
      new StatItem($r('app.string.articles'), articleCount.toString()),
      new StatItem($r('app.string.statuses'), statusesCount.toString()),
      new StatItem($r('app.string.unread'), unreadCount.toString()),
      new StatItem($r('app.string.starred'), starredCount.toString())
    ];
  }

  private rowItems(row: AccountStatsRowData): StatItem[] {
    return this.statItems(row.databaseSizeBytes, row.feedCount, row.folderCount,
      row.articleCount, row.statusesCount, row.unreadCount, row.starredCount);
  }

  private totalItems(totals: AccountStatsTotals): StatItem[] {
    return this.statItems(totals.databaseSizeBytes, totals.feedCount, totals.folderCount,
      totals.articleCount, totals.statusesCount, totals.unreadCount, totals.starredCount);
  }

  /** The account name, or "<name> (<typeName>)" when they differ. */
  private headerTitle(row: AccountStatsRowData): string {
    return row.name === row.typeName ? row.name : row.name + ' (' + row.typeName + ')';
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /** `.foregroundStyle(row.isActive ? .primary : .secondary)` — a whole inactive row dims. */
  private rowColor(isActive: boolean): ResourceColor {
    return isActive
      ? $r('sys.color.ohos_id_color_text_primary') : $r('sys.color.ohos_id_color_text_secondary');
  }

  /** Only a section's first/last row rounds; the middle rows stay square (one card per section). */
  private rowCorners(index: number, count: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const corners: BorderRadiuses = {
      topLeft: index === 0 ? radius : 0,
      topRight: index === 0 ? radius : 0,
      bottomLeft: index === count - 1 ? radius : 0,
      bottomRight: index === count - 1 ? radius : 0
    };
    return corners;
  }

  @Builder
  statsRow(item: StatItem, index: number, count: number, isActive: boolean, isBold: boolean) {
    Column() {
      Row() {
        Text(item.label)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(isBold ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.rowColor(isActive))
        Blank()
        Text(item.value)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(isBold ? FontWeight.Medium : FontWeight.Regular)
          .fontColor(this.rowColor(isActive))
      }
      .width('100%')
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      .constraintSize({ minHeight: 49 })
      .alignItems(VerticalAlign.Center)

      // The grouped hairline between rows of one card — never under the card's last row.
      if (index < count - 1) {
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
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(this.rowCorners(index, count))
  }

  @Builder
  sectionHeader(title: ResourceStr) {
    Text(title)
      .width('100%')
      .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
      .fontWeight(FontWeight.Bold)
      // The capture's grouped header is GREY, unlike the sidebar header the baseline derived.
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_m')
      })
      .constraintSize({ minHeight: 36 })
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      // Nav bar, iOS inline form: the centred title with the topBarTrailing Refresh chip on top
      // (capture: title y74-95 centred, the round glass button at x334-370, y67-103).
      Stack() {
        Text($r('app.string.account_stats'))
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          // The pushed screen's automatic back item: chevron + the title of the screen it
          // returns to, as ONE control. The chevron and the label used to be two siblings,
          // each with its own onClick, so the press/focus outline covered the arrow only
          //. The Row carries the padding, the id and the tap, so the highlight
          // now covers "< Settings" as a whole.
          Row({ space: 2 }) {
            SymbolGlyph($r('sys.symbol.chevron_left'))
              .fontSize(22)
              // Both nav controls are the plain tinted glyphs SwiftUI
              // gives a toolbar Button — no filled chip behind them.
              .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])

            Text('Settings')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          }
          .padding({ left: 6, right: 10, top: 6, bottom: 6 })
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .accessibilityText('Settings')
          .id('BackButton')
          .onClick(() => {
            router.back();
          })

          Blank()
          Button({ type: ButtonType.Circle }) {
            SymbolGlyph($r('sys.symbol.arrow_clockwise'))
              .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
              // AccountStatsView.swift:88 is a bare toolbar Button — SS1 shows the tinted
              // circular arrow on the page background, no chip behind it.
              .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
          }
          .padding(6)
          .backgroundColor(Color.Transparent)
          .id('account_stats_refresh')
          .enabled(!this.isVacuuming)
          .opacity(this.isVacuuming ? 0.4 : 1)
          .onClick(() => {
            this.refresh();
          })
        }
        .width('100%')
        // The bar-button row must not swallow taps meant for the title beneath it.
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(44)
      // The sheet card's top edge is the nav bar's top edge, so the title and both bar
      // buttons sat flush against the rounded corner. iOS leaves the bar
      // breathing room below the status bar; this is that gap.
      .margin({ top: 8 })
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      List() {
        ForEach(this.rows, (row: AccountStatsRowData) => {
          ListItemGroup({ header: this.sectionHeader(this.headerTitle(row)) }) {
            ForEach(this.rowItems(row), (item: StatItem, index: number) => {
              ListItem() {
                this.statsRow(item, index, 7, row.isActive, false)
              }
            }, (item: StatItem, index: number) => row.accountID + '-' + index)
          }
        }, (row: AccountStatsRowData) => row.accountID)

        // Totals exist only when more than one account does — the same 7 rows, semibold.
        if (this.rows.length > 1) {
          ListItemGroup({ header: this.sectionHeader($r('app.string.totals')) }) {
            ForEach(this.totalItems(this.totals), (item: StatItem, index: number) => {
              ListItem() {
                this.statsRow(item, index, 7, true, true)
              }
            }, (item: StatItem, index: number) => 'totals-' + index)
          }
        }

        ListItem() {
          Column({ space: 8 }) {
            Button($r('app.string.vacuum_databases'))
              .id('account_stats_vacuum')
              .type(ButtonType.Normal)
              .width('100%')
              .height(49)
              .backgroundColor($r('sys.color.ohos_id_color_background'))
              .borderRadius($r('sys.float.ohos_id_corner_radius_default_s'))
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .enabled(!this.isVacuuming)
              // the source disables both buttons while vacuuming — show it, don't eat taps.
              .opacity(this.isVacuuming ? 0.4 : 1)
              .onClick(() => {
                this.vacuum();
              })
            // The section footer sits on the bare grouped background, centred.
            Text($r('app.string.vacuuming_may_make_databases_faster'))
              .width('100%')
              .textAlign(TextAlign.Center)
              .fontSize($r('sys.float.ohos_id_text_size_body3'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            // In-flight state: the source keeps the spinner in the footer while vacuuming.
            if (this.isVacuuming) {
              LoadingProgress()
                .width(24)
                .height(24)
                .color($r('sys.color.ohos_id_color_text_secondary'))
            }
          }
          .width('100%')
          .padding({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
        }

        ListItem() {
          // An empty Section whose footer is the help link — no card, just the tinted label.
          Button($r('app.string.account_stats_help'))
            .id('account_stats_help')
            .type(ButtonType.Normal)
            .width('100%')
            .backgroundColor(Color.Transparent)
            .fontSize($r('sys.float.ohos_id_text_size_body2'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .padding({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
            .onClick(() => {
              this.openHelp();
            })
        }
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      // The 16vp grouped-list side inset — the cards are x16..374 in the 390pt capture.
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .id('AccountStatsView')
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
