/**
 * AddFeedFolderViewControllerPage.
 * Source: iOS/Add/AddFeedFolderViewController.swift, iOS/Add/Add.storyboard.
 *
 * The container picker Add Feed presents (.currentContext). ONE flat section: every active
 * account followed by its sorted folders, un-indented, with a checkmark on the caller's
 * initial container. Tapping a row returns that container to the delegate and dismisses —
 * except for an account that declares .disallowFeedInRootFolder, whose row is inert
 * (`tableView.selectRow(at: nil, ...)`).
 *
 * `AddFeedFolderViewController` is the mountable overlay body; the @Entry page exists so the
 * captured states stay replayable by route.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { AddComboTableViewCell } from '../components/AddComboCell';
import { accountIconName } from '../components/IconView';
import { ContainerRef } from '../common/account/Account';
import { AccountManager } from '../common/account/AccountManager';
import { containerKey } from '../common/tree/TreeController';
import { AccountBehaviorKind, behaviorsContain } from '../model/AccountBehavior';
import { sortedFolders } from '../model/Folder';
import { dismissTo } from '../common/util/Navigation';

const DOMAIN: number = 0x0001;
const TAG: string = 'AddFeedFolderViewControllerPage';

/** One row of the flat picker — an account or one of its folders. */
export class ContainerRow {
  readonly container: ContainerRef;
  readonly label: string;
  readonly iconName: string;
  /** account.behaviors.contains(.disallowFeedInRootFolder) — the row does not respond. */
  readonly isInert: boolean;
  readonly key: string;

  constructor(container: ContainerRef, label: string, iconName: string, isInert: boolean) {
    this.container = container;
    this.label = label;
    this.iconName = iconName;
    this.isInert = isInert;
    this.key = containerKey(container.containerID);
  }
}

/** viewDidLoad(): every active account, each followed by its sorted folders. */
export function buildContainerRows(): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const account of AccountManager.shared.sortedActiveAccounts) {
    const inert: boolean =
      behaviorsContain(account.behaviors, AccountBehaviorKind.disallowFeedInRootFolder);
    rows.push(new ContainerRow(ContainerRef.forAccount(account), account.nameForDisplay,
      accountIconName(account.type), inert));
    for (const folder of sortedFolders(account.folders())) {
      rows.push(new ContainerRow(ContainerRef.forFolder(account, folder),
        folder.nameForDisplay, 'folder', false));
    }
  }
  return rows;
}

@Component
export struct AddFeedFolderViewController {
  /** AccountManager active accounts each followed by its sorted folders, one flat section. */
  @State containers: ContainerRow[] = [];
  /** The caller's initial container — the row carrying the checkmark. */
  @State selectedContainerId: string = '';
  /** initialContainer, handed in by AddFeedViewController. */
  @Prop initialContainerKey: string = '';

  /** delegate?.didSelect(container:) */
  onContainerSelected: (container: ContainerRef) => void = (container: ContainerRef): void => {
    hilog.warn(DOMAIN, TAG, 'container %{public}s selected with no delegate',
      container.nameForDisplay);
  };
  onCancelled: () => void = (): void => {
    hilog.debug(DOMAIN, TAG, 'container picker cancelled');
  };

  aboutToAppear(): void {
    this.containers = buildContainerRows();
    this.selectedContainerId = this.initialContainerKey;
    if (this.containers.length === 0) {
      // buildContainerRows() reads AccountManager, and EntryAbility does not await
      // AppBootstrap, so a deep-linked open lists no container to pick at all. start()
      // returns the load already in flight.
      AccountManager.shared.start()
        .then(() => {
          this.containers = buildContainerRows();
        })
        .catch((err: Error) => {
          hilog.warn(DOMAIN, TAG, 'accounts did not load: %{public}s', err.message);
        });
    }
  }

  private selectRow(row: ContainerRow): void {
    if (row.isInert) {
      // The source swallows the tap for an account that forbids feeds in its root folder.
      hilog.info(DOMAIN, TAG, 'account forbids feeds in its root folder — tap ignored');
      return;
    }
    this.selectedContainerId = row.key;
    this.onContainerSelected(row.container);
  }

  build() {
    // Unlike the two Add sheets this one is a PLAIN table: full-bleed white rows on a white
    // page, the hairline inset past the icon column (capture: rows x0..390, sep from x49).
    Column() {
      Stack() {
        Text('Select Folder')
          .width('100%')
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          Button($r('app.string.cancel'))
            .id('addfeedfolder_cancel')
            .type(ButtonType.Capsule)
            .height(36)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .onClick(() => {
              this.onCancelled();
            })
          Blank()
        }
        .width('100%')
        .hitTestBehavior(HitTestMode.Transparent)
      }
      .width('100%')
      .height(54)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      List() {
        ForEach(this.containers, (row: ContainerRow) => {
          ListItem() {
            AddComboTableViewCell({
              label: row.label,
              symbolName: row.iconName,
              isChecked: row.key === this.selectedContainerId
            })
          }
          .id('addfeedfolder_itemroot')
          // An account that forbids feeds in its root folder swallows the tap — say so.
          .opacity(row.isInert ? 0.4 : 1)
          .onClick(() => {
            this.selectRow(row);
          })
        }, (row: ContainerRow) => row.key)
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .divider({
        strokeWidth: 0.5,
        color: $r('sys.color.ohos_id_color_list_separator'),
        startMargin: 48
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}

@Entry
@Component
struct AddFeedFolderViewControllerPage {
  @State overlayShown: boolean = true;

  onPageShow(): void {
    // The page's own root is an empty Stack — all content lives in the bindSheet. A
    // router.pushUrl closes that sheet and the `$$` two-way binding latches overlayShown
    // to false, so coming back would render the empty backdrop. Re-present it.
    this.overlayShown = true;
  }

  /** .currentContext — Add Feed presents this picker, so every dismissal uncovers it. */
  private dismissSelf(): void {
    this.overlayShown = false;
    dismissTo('pages/AddFeedViewControllerPage');
  }

  @Builder
  overlayBody() {
    AddFeedFolderViewController({
      onContainerSelected: (container: ContainerRef): void => {
        hilog.info(DOMAIN, TAG, 'picked container %{public}s', container.nameForDisplay);
        this.dismissSelf();
      },
      onCancelled: (): void => {
        this.dismissSelf();
      }
    })
  }

  build() {
    Stack() {
    }
    .id('AddFeedFolderViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .bindSheet($$this.overlayShown, this.overlayBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false,
        // A drag-down never hides the page, so onPageShow does not fire and the restore
        // above cannot run: the drag would leave the empty root on screen. Same as Cancel.
        shouldDismiss: (action: SheetDismiss): void => {
          action.dismiss();
          this.dismissSelf();
        } })
  }
}
