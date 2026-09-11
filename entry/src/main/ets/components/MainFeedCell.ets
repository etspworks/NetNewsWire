/**
 * MainFeedCollectionViewCell.
 * Source: iOS/MainFeed/Collection View Cells/MainFeedCollectionViewCell.swift.
 *
 * Feed / smart-feed sidebar row body: the title and the right-aligned unread count, which
 * the source hides entirely at 0 (`unreadCountLabel.isHidden = newValue == 0`). The favicon
 * is supplied by the owning page — `configureIcon(cell:)` is a view-controller method in the
 * source, so the page reads IconImageCache and renders the IconView ahead of this row body.
 *
 * This module also carries the sidebar's shared row plumbing, because two screens render the
 * same tree: the main feed screen and the Feeds backdrop behind the current activity screen's sheet.
 */

import { SidebarRow, nameForDisplayOf, unreadCountOf } from '../common/tree/TreeController';
import { IconImageCache } from '../common/images/IconImageCache';
import { AccountService } from '../common/account/Account';
import { SmartFeedsController } from '../common/account/SmartFeedsController';
import { Feed } from '../model/Feed';
import { Folder } from '../model/Folder';
import { IconImage } from '../model/IconImage';
import { Node } from '../model/Node';
import { SmartFeed } from '../model/SmartFeed';

/** Everything one sidebar row renders, resolved from its Node exactly as the source's
 * `configure(_:sidebarItemNode:)` + `configureIcon(_:sidebarItem:)` do. */
export class SidebarRowInfo {
  readonly title: string;
  readonly unreadCount: number;
  readonly iconURL: string;
  readonly symbolName: string;
  /** IconImage.preferredColor — the smart feeds' orange/blue/yellow tints. 0 = none. */
  readonly tintColor: number;
  readonly isFolder: boolean;
  /** A section header (Smart Feeds or an account), not a selectable sidebar item. */
  readonly isGroupItem: boolean;
  /** node.parent?.representedObject is Folder -> indentationLevel 1. */
  readonly indentationLevel: number;
  readonly key: string;

  constructor(title: string, unreadCount: number, iconURL: string, symbolName: string,
    tintColor: number, isFolder: boolean, isGroupItem: boolean, indentationLevel: number,
    key: string) {
    this.title = title;
    this.unreadCount = unreadCount;
    this.iconURL = iconURL;
    this.symbolName = symbolName;
    this.tintColor = tintColor;
    this.isFolder = isFolder;
    this.isGroupItem = isGroupItem;
    this.indentationLevel = indentationLevel;
    this.key = key;
  }
}

export function sidebarRowInfo(row: SidebarRow): SidebarRowInfo {
  const obj: Object = row.node.representedObject;
  const title: string = nameForDisplayOf(obj);
  const isFolder: boolean = obj instanceof Folder;
  const isGroupItem: boolean = row.isGroupItem
    || obj instanceof AccountService || obj instanceof SmartFeedsController;

  let iconURL: string = '';
  let symbolName: string = '';
  let tintColor: number = 0;
  if (obj instanceof Feed) {
    const icon: IconImage | undefined = IconImageCache.shared.imageForFeed(obj);
    if (icon !== undefined) {
      iconURL = icon.sourceURL === undefined ? '' : icon.sourceURL;
      symbolName = icon.resourceName === undefined ? '' : icon.resourceName;
      tintColor = icon.preferredColor === undefined ? 0 : icon.preferredColor;
    }
  } else if (obj instanceof SmartFeed) {
    const icon: IconImage =
      IconImageCache.shared.imageForSmartFeed(obj.sidebarItemID, obj.smallIcon);
    iconURL = icon.sourceURL === undefined ? '' : icon.sourceURL;
    symbolName = icon.resourceName === undefined ? '' : icon.resourceName;
    tintColor = icon.preferredColor === undefined ? 0 : icon.preferredColor;
  } else if (isFolder) {
    symbolName = 'folder';
  }

  const parent: Node | undefined = row.node.parent;
  const indentationLevel: number =
    parent !== undefined && parent.representedObject instanceof Folder ? 1 : 0;

  return new SidebarRowInfo(title, unreadCountOf(obj), iconURL, symbolName, tintColor,
    isFolder, isGroupItem, indentationLevel, row.node.uniqueID.toString());
}

/** LazyForEach's adapter over SceneCoordinator.sidebarRows (IDataSource is .ets-only). */
export class SidebarRowDataSource implements IDataSource {
  private rows: SidebarRow[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.rows.length;
  }

  getData(index: number): SidebarRow {
    return this.rows[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  reload(rows: SidebarRow[]): void {
    this.rows = rows;
    for (const listener of this.listeners) {
      listener.onDataReloaded();
    }
  }

  /**
   * Grouped-list geometry (styling only — the row set is unchanged). The capture renders
   * each section as ONE inset card, so a section's first row rounds its top corners, its last
   * row rounds its bottom corners, and every row but the last carries a separator. A section
   * header is always pushed at level 0 (TreeController.visibleRows), which is what delimits
   * the card.
   */
  isFirstInSection(index: number): boolean {
    if (index <= 0 || index >= this.rows.length) {
      return false;
    }
    return this.rows[index - 1].level === 0;
  }

  isLastInSection(index: number): boolean {
    if (index < 0 || index >= this.rows.length) {
      return false;
    }
    if (index === this.rows.length - 1) {
      return true;
    }
    return this.rows[index + 1].level === 0;
  }
}

@Component
export struct MainFeedCollectionViewCell {
  @Prop feedTitle: string = '';
  @Prop unreadCount: number = 0;

  build() {
    // .body / .label title, .body / .secondaryLabel count (capture: title x64 h20,
    // count right-aligned at the card's 16pt inner inset).
    Row({ space: 8 }) {
      Text(this.feedTitle)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      // isHidden = true at 0 — never render a "0".
      if (this.unreadCount > 0) {
        Text(this.unreadCount.toString())
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
    }
    // NOT width('100%'): this struct's root IS the direct child of the page's row Row, next
    // to the favicon and its 8vp gap. '100%' resolves to the PARENT's full content width, so
    // the body overflowed the card by icon+gap and clipped the trailing unread count off the
    // screen edge. layoutWeight takes the space the icon left over.
    .layoutWeight(1)
    .alignItems(VerticalAlign.Center)
  }
}
