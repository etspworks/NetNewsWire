/**
 * DinosaursViewPage (source: iOS/Settings/DinosaursView.swift +
 * Shared/Dinosaurs/DinosaursViewModel.swift).
 *
 * The staleness picker (3 / 6 / 12 / 24 months, default 6)
 * over the stale-feed list from the stale-feed service — the rows are the REAL query over the
 * migrated databases, never a literal list. Each row swipes to Delete (confirmed, removes
 * the feed from EVERY container that holds it) and a More menu of Go to Feed / Open Home
 * Page / Copy Feed URL.
 *
 * Styled from the iOS reference capture of DinosaursView
 * with the tokens in the style baseline. The captured state has NO stale feeds,
 * so it shows the empty footer ("No dinosaurs") — the rows themselves are styled from the
 * source's own DinosaurRowView, and the list stays bound to the stale-feed service.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DinosaurDeletion, DinosaurRow, DinosaursModel, DinosaurSortKey }
  from '../common/account/DinosaursModel';
import { ContainerRef } from '../common/account/Account';
import { SceneCoordinator } from '../common/SceneCoordinator';
import { BrowserService } from '../common/system/BrowserService';
import { ShareService } from '../common/system/ShareService';
import { DinosaurRowView } from '../components/DinosaurRow';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'DinosaursViewPage';

const helpURL: string = 'https://netnewswire.com/help/dinosaurs.html';
/** The source's segmented picker values. */
const thresholds: number[] = [3, 6, 12, 24];

class DinosaurDataSource implements IDataSource {
  private rows: DinosaurRow[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.rows.length;
  }

  getData(index: number): DinosaurRow {
    return this.rows[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    this.listeners.push(listener);
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  reload(rows: DinosaurRow[]): void {
    this.rows = rows;
    for (const listener of this.listeners) {
      listener.onDataReloaded();
    }
  }
}

@Entry
@Component
struct DinosaursViewPage {
  /** The staleness picker, default 6 months, as in the source. */
  @State monthThreshold: number = 6;
  @State rowCount: number = 0;

  private readonly model: DinosaursModel = new DinosaursModel();
  private readonly dataSource: DinosaurDataSource = new DinosaurDataSource();

  aboutToAppear(): void {
    this.model.sortBy(DinosaurSortKey.lastArticleDate, true);
    this.refresh();
  }

  /** Re-runs the stale-feed query for the current threshold. */
  private refresh(): void {
    this.model.monthThreshold = this.monthThreshold;
    this.model.refresh().then((): void => {
      this.dataSource.reload(this.model.rows);
      this.rowCount = this.model.rows.length;
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'refresh failed: %{public}s', String(e));
    });
  }

  private selectThreshold(months: number): void {
    if (this.monthThreshold === months) {
      return;
    }
    this.monthThreshold = months;
    this.refresh();
  }

  /** the dinosaurs screen -> the main feed screen */
  private goToMainFeedCollectionViewController(): void {
    router.pushUrl({ url: 'pages/MainFeedCollectionViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/MainFeedCollectionViewControllerPage failed: %{public}s',
          err.message);
      });
  }

  /** More -> Go to Feed: disclose the feed in the sidebar, then leave Settings for it. */
  private goToFeed(row: DinosaurRow): void {
    SceneCoordinator.shared.discloseFeed(row.feed).then((): void => {
      this.goToMainFeedCollectionViewController();
    }).catch((e: Object): void => {
      hilog.warn(DOMAIN, TAG, 'discloseFeed failed: %{public}s', String(e));
    });
  }

  /** More -> Open Home Page. No-ops when the feed has no home page, as the source does. */
  private openHomePage(row: DinosaurRow): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openFeedHomePage(context, row.feed)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open the home page: %{public}s', String(e));
      });
  }

  /** More -> Copy Feed URL. */
  private copyFeedURL(row: DinosaurRow): void {
    ShareService.copyToClipboard(row.feedURL);
  }

  private openHelp(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, helpURL)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open help: %{public}s', String(e));
      });
  }

  /** Delete: the source's destructive confirmation first. */
  private confirmDelete(row: DinosaurRow): void {
    AlertDialog.show({
      title: $r('app.string.delete_feed'),
      message: $r('app.string.are_you_sure_you_want_to_delete_the_feed_2', row.feedName),
      primaryButton: {
        value: $r('app.string.cancel'),
        action: (): void => {
        }
      },
      secondaryButton: {
        value: $r('app.string.delete'),
        action: (): void => {
          this.deleteFeed(row);
        }
      }
    });
  }

  /** Removes the feed from EVERY container that holds it, then refreshes. */
  private deleteFeed(row: DinosaurRow): void {
    const containers: ContainerRef[] = row.account.existingContainersWithFeed(row.feed);
    const deletion: DinosaurDeletion = new DinosaurDeletion(row.feed, row.account, containers);
    this.model.performDeletions([deletion]).then((): void => {
      this.refresh();
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, 'delete failed: %{public}s', String(e));
    });
  }

  @Builder
  moreMenu(row: DinosaurRow) {
    Menu() {
      MenuItem({ content: $r('app.string.go_to_feed') })
        .id('dinosaurs_go_to_feed')
        .onClick(() => {
          this.goToFeed(row);
        })
      MenuItem({ content: $r('app.string.open_home_page') })
        .id('dinosaurs_open_home_page')
        .onClick(() => {
          this.openHomePage(row);
        })
      MenuItem({ content: $r('app.string.copy_feed_url') })
        .id('dinosaurs_copy_url')
        .onClick(() => {
          this.copyFeedURL(row);
        })
    }
  }

  /**
   * The trailing swipe actions: Delete and the More menu — both icon-only, as the source
   * draws them (`Image(systemName: "trash")` and a `Label("More", systemImage: "ellipsis")`
   * under `.labelStyle(.iconOnly)`).
   *
   * `.swipeActions(edge: .trailing)` lays its buttons out from the trailing edge inward, so
   * the source's first-declared Delete sits at the row's RIGHT edge and More to its left. An
   * ArkUI `Row` lays out leading-first, so the declaration order here is the reverse of the
   * source's: More, then Delete.
   */
  @Builder
  rowActions(row: DinosaurRow) {
    Row() {
      Button({ type: ButtonType.Normal }) {
        // The source's "ellipsis" — HarmonyOS has no bare ellipsis glyph, so this uses the
        // circled one the port already picked for a "More" menu label elsewhere.
        SymbolGlyph($r('sys.symbol.ellipsis_circle'))
          .fontSize(22)
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
      }
      .id('dinosaurs_more')
      // An icon-only button shrinks to its glyph; iOS swipe actions are ~74pt wide.
      .width(72)
      .height('100%')
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .accessibilityText('More')
      .bindMenu(this.moreMenu(row))
      Button({ type: ButtonType.Normal }) {
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(22)
          .fontColor([$r('sys.color.ohos_id_color_foreground_contrary')])
      }
      .id('dinosaurs_delete')
      .width(72)
      .height('100%')
      // .tint(.red) — the destructive swipe action.
      .backgroundColor($r('sys.color.ohos_id_color_warning'))
      // .help("Delete Feed")
      .accessibilityText('Delete Feed')
      .onClick(() => {
        this.confirmDelete(row);
      })
    }
    .height('100%')
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /** Only the list card's first/last row rounds; the middle rows stay square. */
  private rowCorners(index: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const corners: BorderRadiuses = {
      topLeft: index === 0 ? radius : 0,
      topRight: index === 0 ? radius : 0,
      bottomLeft: index === this.rowCount - 1 ? radius : 0,
      bottomRight: index === this.rowCount - 1 ? radius : 0
    };
    return corners;
  }

  /** The selected segment of the source's `.pickerStyle(.segmented)` picker. */
  private segmentBackground(months: number): ResourceColor {
    return this.monthThreshold === months
      ? $r('sys.color.ohos_id_color_background') : Color.Transparent;
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      // Nav bar, .navigationBarTitleDisplayMode(.inline) — the centred "🦖 Dinosaurs" with
      // the automatic back item leading, as the capture shows it. The back control is
      // overlaid rather than placed in a Row so the title stays centred on the bar.
      Stack() {
        Text($r('app.string.dinosaurs'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          // The source's automatic back item NAMES its destination: chevron + "Settings",
          // the screen this was pushed from. This page carried the chevron alone, so the
          // the label the tests look for was missing entirely. One Row holds both, so the
          // press outline covers the whole control.
          Row({ space: 2 }) {
            SymbolGlyph($r('sys.symbol.chevron_left'))
              .fontSize(22)
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
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(44)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // Section header: the staleness picker. A grouped header is inset 32 leading (capture:
      // the label and the picker track both start at x32, the track ends at x373).
      Column() {
        Text($r('app.string.show_feeds_that_haven_t_updated_in'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .padding({ bottom: $r('sys.float.ohos_id_elements_margin_horizontal_m') })
        // spec control "Staleness picker" — id `dinosaurs_threshold`.
        Row() {
          ForEach(thresholds, (months: number) => {
            Text($r('app.string.lld_months', months))
              .layoutWeight(1)
              .height('100%')
              .textAlign(TextAlign.Center)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontWeight(this.monthThreshold === months ? FontWeight.Medium : FontWeight.Regular)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .backgroundColor(this.segmentBackground(months))
              .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
              .onClick(() => {
                this.selectThreshold(months);
              })
          }, (months: number) => months.toString())
        }
        .id('dinosaurs_threshold')
        .width('100%')
        .height(32)
        .padding(2)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
      }
      .width('100%')
      .padding({
        left: 32,
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        bottom: 12
      })

      List() {
        LazyForEach(this.dataSource, (row: DinosaurRow, index: number) => {
          ListItem() {
            DinosaurRowView({ dinosaur: row })
          }
          .id('dinosaur_itemroot')
          .backgroundColor($r('sys.color.ohos_id_color_background'))
          .borderRadius(this.rowCorners(index))
          .swipeAction({ end: this.rowActions(row) })
        }, (row: DinosaurRow) => row.id)
      }
      // With no stale feeds the source's Section collapses and the footer follows the header
      // immediately (capture: "No dinosaurs" right under the picker) — so do not claim the
      // free space when the list is empty.
      .layoutWeight(this.rowCount === 0 ? 0 : 1)
      .width('100%')
      .cachedCount(5)
      .scrollBar(BarState.Off)
      .divider({
        strokeWidth: 0.5,
        color: $r('sys.color.ohos_id_color_list_separator'),
        startMargin: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        endMargin: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      // The 16vp grouped-list side inset.
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // The section footer — "No dinosaurs" with no rows, the swipe hint with rows.
      if (this.rowCount === 0) {
        Text($r('app.string.no_dinosaurs'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding({ left: 32, right: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
      } else {
        Text($r('app.string.swipe_a_feed_to_show_the_action_menu_and_del'))
          .width('100%')
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding({
            left: 32,
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            top: $r('sys.float.ohos_id_elements_margin_horizontal_m')
          })
      }

      // An empty Section whose footer is the help link — no card, just the tinted label.
      Button($r('app.string.dinosaurs_help'))
        .id('dinosaurs_help')
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
    .id('DinosaursView')
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
