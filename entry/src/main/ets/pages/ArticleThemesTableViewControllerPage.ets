/**
 * ArticleThemesTableViewControllerPage
 * (source: iOS/Settings/ArticleThemesTableViewController.swift + ArticleThemeImporter.swift).
 *
 * The rows come from ArticleThemesManager (never a literal
 * list), the checkmark marks the current theme, the trailing swipe deletes a user theme
 * (suppressed for bundled app themes) and themes_import opens the document picker.
 */

import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import picker from '@ohos.file.picker';
import {
  ArticleThemesManager,
  ArticleThemesChangeListener,
  ArticleThemeRef,
  StagedTheme
} from '../common/article/ArticleThemesManager';
import { VibrantBasicTableViewCell } from '../components/VibrantCell';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleThemesTableViewControllerPage';
/** Capture: each theme row is 52pt tall; iOS sizes it from content, so no token fits. */
const themeRowHeight: number = 52;

@Entry
@Component
struct ArticleThemesTableViewControllerPage {
  /** ArticleThemesManager.themeNames — the default theme plus every installed .nnwtheme. */
  @State themeNames: string[] = [];
  /** The current theme name, mirrored into AppStorage so the article body follows it. */
  @StorageLink('currentThemeName') currentThemeName: string = '';

  /** .ArticleThemeNamesDidChangeNotification — reload when the installed set changes. */
  private themeNamesListener: ArticleThemesChangeListener = () => {
    this.reloadThemeNames();
  };

  aboutToAppear(): void {
    ArticleThemesManager.shared.start();
    ArticleThemesManager.shared.addThemeNamesListener(this.themeNamesListener);
    this.reloadThemeNames();
  }

  aboutToDisappear(): void {
    ArticleThemesManager.shared.removeThemeNamesListener(this.themeNamesListener);
  }

  private reloadThemeNames(): void {
    this.themeNames = ArticleThemesManager.shared.themeNames;
    this.currentThemeName = ArticleThemesManager.shared.currentThemeName;
  }

  /** didSelectRowAt: set the current theme, then pop back to Settings. */
  private selectTheme(themeName: string): void {
    ArticleThemesManager.shared.currentThemeName = themeName;
    this.currentThemeName = ArticleThemesManager.shared.currentThemeName;
    router.back();
  }

  /**
   * Bundled themes cannot be deleted — the source suppresses the swipe action for them.
   * Read off the loaded refs, not articleThemeWithThemeName: that one re-reads template.html,
   * stylesheet.css and core.css from disk, and this runs for every row on every frame.
   */
  private isAppTheme(themeName: string): boolean {
    for (const ref of ArticleThemesManager.shared.themeRefs()) {
      if (ref.displayName === themeName) {
        return ref.isAppTheme;
      }
    }
    return true;
  }

  /** "Delete Theme?" confirmation, then ArticleThemesManager.deleteTheme. */
  private confirmDelete(themeName: string): void {
    this.getUIContext().showAlertDialog({
      title: 'Delete Theme?',
      // The trailing "?." is the source's own typo (ArticleThemesTableViewController.swift:87)
      // and is carried verbatim — the port is compared against it string for string.
      message: 'Are you sure you want to delete the theme “' + themeName + '”?.',
      primaryButton: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'theme delete cancelled');
        }
      },
      secondaryButton: {
        value: 'Delete',
        fontColor: Color.Red,
        action: () => {
          ArticleThemesManager.shared.deleteTheme(themeName);
          this.reloadThemeNames();
        }
      }
    });
  }

  /**
   * themes_import: UIDocumentPickerViewController -> ArticleThemeImporter.importTheme.
   *
   * The source opens the picker on `UTType.netNewsWireTheme`, which is a PACKAGE — a folder.
   * The phone's system picker cannot return one: a folder select is answered with "This
   * feature isn't supported yet." and no picker ever appears. So this asks for the file the
   * theme actually ships as, the `.zip` netnewswire.com distributes, and unpacks it on import.
   *
   * A user who already unpacked the theme walks into the `X.nnwtheme` folder instead, so the
   * filters carry the three files a theme is made of as well: without them that folder opens
   * empty, which reads as "the app cannot import themes" rather than "pick the zip". Selecting
   * all three reassembles the bundle (ArticleThemesManager.stageTheme).
   */
  private importTheme(): void {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 3;
    options.fileSuffixFilters = ['.zip', '.nnwtheme', '.plist', '.css', '.html'];

    const context: common.UIAbilityContext =
      this.getUIContext().getHostContext() as common.UIAbilityContext;
    const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    documentPicker.select(options)
      .then((uris: string[]) => {
        // Cancel returns nothing: the theme list is left exactly as the picker found it.
        if (uris.length === 0) {
          return;
        }
        this.stageImport(uris);
      })
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'the document picker was dismissed: %{public}s', err.message);
      });
  }

  /** The importer reads the theme BEFORE it asks, so a bad file fails with nothing installed. */
  private stageImport(uris: string[]): void {
    ArticleThemesManager.shared.stageTheme(uris)
      .then((staged: StagedTheme) => {
        this.confirmImport(staged);
      })
      .catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'the theme could not be staged: %{public}s', err.message);
        this.presentImportError(err.message);
      });
  }

  /** The importer's "Install theme “X” by Y?" confirmation. */
  private confirmImport(staged: StagedTheme): void {
    this.getUIContext().showAlertDialog({
      title: 'Install theme “' + staged.info.name + '” by ' + staged.info.creatorName + '?',
      message: 'Author’s website:\n' + staged.info.creatorHomePage,
      primaryButton: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'theme import cancelled');
        }
      },
      secondaryButton: {
        value: 'Install Theme',
        action: () => {
          this.installTheme(staged);
        }
      }
    });
  }

  /** The importer's "Duplicate Theme" branch. */
  private installTheme(staged: StagedTheme): void {
    const existing: ArticleThemeRef | undefined =
      ArticleThemesManager.shared.existingThemeFor(staged.folderPath, staged.info.name);
    if (existing === undefined) {
      this.copyInTheme(staged);
      return;
    }
    if (existing.isAppTheme) {
      // The source can only ever collide with an installed theme, so it always offers
      // Overwrite. A bundled theme's folder is inside the package and cannot be replaced,
      // so the name collision is refused instead of leaving two rows called the same thing.
      this.presentImportError('The theme “' + staged.info.name
        + '” is built in and cannot be replaced.');
      return;
    }
    this.getUIContext().showAlertDialog({
      title: 'Duplicate Theme',
      message: 'The theme “' + staged.info.name + '” already exists. Overwrite it?',
      primaryButton: {
        value: 'Cancel',
        action: () => {
          hilog.info(DOMAIN, TAG, 'duplicate theme import cancelled');
        }
      },
      secondaryButton: {
        value: 'Overwrite',
        action: () => {
          this.copyInTheme(staged);
        }
      }
    });
  }

  private copyInTheme(staged: StagedTheme): void {
    try {
      ArticleThemesManager.shared.importTheme(staged);
      this.reloadThemeNames();
      this.getUIContext().getPromptAction()
        .showToast({ message: 'The theme “' + staged.info.name + '” has been installed.' });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'the theme could not be installed');
      this.presentImportError('The theme could not be installed.');
    }
  }

  /** .didFailToImportThemeWithError — the source surfaces the importer's error to the user. */
  private presentImportError(message: string): void {
    this.getUIContext().showAlertDialog({
      title: 'Import Failed',
      message: message,
      confirm: {
        value: 'OK',
        action: () => {
          hilog.info(DOMAIN, TAG, 'theme import error dismissed');
        }
      }
    });
  }

  /**
   * Trailing swipe action — the shape the Feeds screen's working swipe uses
   * (MainFeedCollectionViewControllerPage.ets:874 `swipeActions`): a Row of buttons, handed
   * to `.swipeAction({ end: this.deleteAction(name) })` as a bare builder call.
   *
   * Whether the row gets a swipe at all is decided at the ListItem (a bundled theme carries
   * none, as the source suppresses the action for it) — NOT with an `if` inside this builder.
   *
   * Nothing here may be sized in PERCENT: the swipe-action node is measured as part of the
   * ListItem, and a '100%' height resolves against the LIST, which stretched every row to
   * the full list height — only the first theme fit on screen. Fixed heights only.
   */
  @Builder
  deleteAction(themeName: string) {
    Row() {
      Button('Delete')
        .type(ButtonType.Normal)
        .height(themeRowHeight)
        .padding({ left: 20, right: 20 })
        .backgroundColor($r('sys.color.ohos_id_color_warning'))
        .fontColor($r('sys.color.ohos_id_color_foreground_contrary'))
        .fontSize($r('sys.float.ohos_id_text_size_body2'))
        .id('themes_delete')
        .onClick(() => {
          this.confirmDelete(themeName);
        })
    }
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /** One inset-grouped card: only the first row rounds at the top, the last at the bottom. */
  private rowCorners(index: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const corners: BorderRadiuses = {
      topLeft: index === 0 ? radius : 0,
      topRight: index === 0 ? radius : 0,
      bottomLeft: index === this.themeNames.length - 1 ? radius : 0,
      bottomRight: index === this.themeNames.length - 1 ? radius : 0
    };
    return corners;
  }

  @Builder
  themeRow(themeName: string, index: number) {
    Column() {
      // The checkmark accessory marks the row whose name is ArticleThemesManager' current
      // theme — a tint-coloured `checkmark` at the trailing edge, hit-test transparent so
      // it can never swallow the row's own tap.
      Stack({ alignContent: Alignment.End }) {
        VibrantBasicTableViewCell({
          label: themeName,
          detail: '',
          rowId: 'themes_itemroot',
          onTap: () => {
            this.selectTheme(themeName);
          }
        })
        if (themeName === this.currentThemeName) {
          SymbolGlyph($r('sys.symbol.checkmark'))
            .fontSize(20)
            .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])
            .hitTestBehavior(HitTestMode.None)
        }
      }
      .width('100%')
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
      .constraintSize({ minHeight: themeRowHeight })

      // The grouped-list hairline, inset 16 inside the card and dropped on the last row.
      if (index < this.themeNames.length - 1) {
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
    .borderRadius(this.rowCorners(index))
  }

  build() {
    // The source presents this screen inside the Settings SHEET: a card with rounded top
    // corners below a dimmed status-bar band. The scrim and the safe-area expansion live on
    // this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      // Inline nav bar: the automatic back item, a CENTERED title, and
      // the import button as the trailing round glass bar button the capture shows as "+".
      Stack() {
        Text($r('app.string.theme'))
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

          Button() {
            SymbolGlyph($r('sys.symbol.plus'))
              .fontSize(22)
              .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          }
          .type(ButtonType.Circle)
          .width(36)
          .height(36)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .accessibilityText('Import Theme')
          .id('themes_import')
          .onClick(() => {
            this.importTheme();
          })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(54)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      List() {
        ForEach(this.themeNames, (themeName: string, index: number) => {
          // A bundled theme cannot be deleted, so its ListItem carries NO swipe action —
          // the way the Feeds list gives an account row none and a feed row one
          // (MainFeedCollectionViewControllerPage.ets:1049-1062). The `as SwipeActionOptions`
          // cast that used to sit here hid the builder call from the ets builder transform:
          // the Delete button was built straight into the ListItem, laid out centred over the
          // row instead of off-screen to the right, and the ListItem
          // registered no swipe at all, so a horizontal drag fell through to the row's own
          // tap target and popped the page back to Settings.
          if (this.isAppTheme(themeName)) {
            ListItem() {
              this.themeRow(themeName, index)
            }
          } else {
            ListItem() {
              this.themeRow(themeName, index)
            }
            .swipeAction({ end: this.deleteAction(themeName) })
          }
        }, (themeName: string) => themeName)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      // The 16pt grouped-list side inset — the card is x16..374 in a 390pt capture, and the
      // first section starts 35pt below the bar.
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: 35
      })
    }
    .id('ArticleThemesTableViewController')
    .width('100%')
    .height('100%')
    // systemGroupedBackground
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    // iOS runs the grouped grey under the home indicator; without this the page stops at the
    // safe area and the band below it is painted white.
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
