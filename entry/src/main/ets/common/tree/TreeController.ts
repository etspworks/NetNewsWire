/**
 * TreeController — the RSTree port (port_rstree), plus the app's own sidebar delegate.
 *
 * Sources:
 *   Modules/RSTree/Sources/RSTree/{TreeController,NodePath,TopLevelRepresentedObject}.swift
 *   Shared/Tree/SidebarTreeControllerDelegate.swift
 *   Shared/Extensions/Node+Extensions.swift (the sort)
 *
 * `Node` itself is already ported at model/Node.ts.
 *
 * Swift resolves `node.representedObject as? SidebarItem / Container / UnreadCountProvider`
 * through protocols the app's own types conform to. ArkTS has no retroactive conformance,
 * so those protocol reads are the free functions at the bottom of this file, dispatching
 * on the concrete type — every caller (SceneCoordinator, the sidebar rows) uses them.
 *
 * The sidebar's visible rows are exposed as a flat array (`visibleRows`), which the
 * sidebar page wraps in an IDataSource for LazyForEach: IDataSource is declared only for
 * .ets component code, so a .ts service cannot implement it.
 */

import { Node } from '../../model/Node';
import { ContainerIdentifier } from '../../model/ContainerIdentifier';
import { Feed } from '../../model/Feed';
import { Folder } from '../../model/Folder';
import { SmartFeed } from '../../model/SmartFeed';
import { ReadFilterType, SidebarItemIdentifier } from '../../model/SidebarItemIdentifier';
import { AccountService } from '../account/Account';
import { AccountManager } from '../account/AccountManager';
import { SmartFeedsController } from '../account/SmartFeedsController';

/** RSTree's TopLevelRepresentedObject — a placeholder object for the root node. */
export class TopLevelRepresentedObject {
}

export interface TreeControllerDelegate {
  childNodesFor(treeController: TreeController, node: Node): Node[] | undefined;
}

export type NodeVisitBlock = (node: Node) => void;

export class TreeController {
  private readonly delegate: TreeControllerDelegate;
  readonly rootNode: Node;

  constructor(delegate: TreeControllerDelegate, rootNode?: Node) {
    this.delegate = delegate;
    this.rootNode = rootNode === undefined
      ? Node.genericRootNode(new TopLevelRepresentedObject()) : rootNode;
    this.rebuild();
  }

  /** Rebuilds and re-sorts. Returns true if anything in the whole tree changed. */
  rebuild(): boolean {
    return this.rebuildChildNodes(this.rootNode);
  }

  visitNodes(visitBlock: NodeVisitBlock): void {
    TreeController.visitNode(this.rootNode, visitBlock);
  }

  nodeInArrayRepresentingObject(nodes: Node[], representedObject: Object,
    recurse: boolean = false): Node | undefined {
    for (const oneNode of nodes) {
      if (oneNode.representedObject === representedObject) {
        return oneNode;
      }
      if (recurse && oneNode.canHaveChildNodes) {
        const found: Node | undefined =
          this.nodeInArrayRepresentingObject(oneNode.childNodes, representedObject, recurse);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }

  nodeInTreeRepresentingObject(representedObject: Object): Node | undefined {
    return this.nodeInArrayRepresentingObject([this.rootNode], representedObject, true);
  }

  /** An array might hold a leaf and its parent; drop the leaf. */
  normalizedSelectedNodes(nodes: Node[]): Node[] {
    const normalized: Node[] = [];
    for (const node of nodes) {
      if (!hasAncestorIn(node, nodes)) {
        normalized.push(node);
      }
    }
    return normalized;
  }

  private static visitNode(node: Node, visitBlock: NodeVisitBlock): void {
    visitBlock(node);
    for (const childNode of node.childNodes) {
      TreeController.visitNode(childNode, visitBlock);
    }
  }

  private rebuildChildNodes(node: Node): boolean {
    if (!node.canHaveChildNodes) {
      return false;
    }

    const childNodes: Node[] = this.delegate.childNodesFor(this, node) ?? [];
    let childNodesDidChange: boolean = !nodeArraysAreEqual(childNodes, node.childNodes);
    if (childNodesDidChange) {
      node.childNodes = childNodes;
    }

    for (const childNode of childNodes) {
      if (this.rebuildChildNodes(childNode)) {
        childNodesDidChange = true;
      }
    }

    return childNodesDidChange;
  }
}

function nodeArraysAreEqual(a: Node[], b: Node[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function hasAncestorIn(node: Node, nodes: Node[]): boolean {
  let nomad: Node | undefined = node.parent;
  while (nomad !== undefined) {
    if (nodes.indexOf(nomad) >= 0) {
      return true;
    }
    nomad = nomad.parent;
  }
  return false;
}

/** NodePath — the components from the root down to `node`. */
export class NodePath {
  readonly components: Node[];

  constructor(node: Node) {
    const temp: Node[] = [node];
    let nomad: Node = node;
    while (true) {
      const parent: Node | undefined = nomad.parent;
      if (parent === undefined) {
        break;
      }
      temp.push(parent);
      nomad = parent;
    }
    this.components = temp.reverse();
  }

  static forRepresentedObject(representedObject: Object,
    treeController: TreeController): NodePath | undefined {
    const node: Node | undefined = treeController.nodeInTreeRepresentingObject(representedObject);
    return node === undefined ? undefined : new NodePath(node);
  }
}

// MARK: - The Swift protocol reads (SidebarItem / Container / DisplayNameProvider)

export function nameForDisplayOf(obj: Object): string {
  if (obj instanceof Feed) {
    return obj.nameForDisplay;
  }
  if (obj instanceof Folder) {
    return obj.nameForDisplay;
  }
  if (obj instanceof SmartFeed) {
    return obj.nameForDisplay;
  }
  if (obj instanceof AccountService) {
    return obj.nameForDisplay;
  }
  if (obj instanceof SmartFeedsController) {
    return obj.nameForDisplay;
  }
  return '';
}

export function sidebarItemIDOf(obj: Object): SidebarItemIdentifier | undefined {
  if (obj instanceof Feed) {
    return obj.sidebarItemID;
  }
  if (obj instanceof Folder) {
    return obj.sidebarItemID;
  }
  if (obj instanceof SmartFeed) {
    return obj.sidebarItemID;
  }
  return undefined;
}

export function containerIDOf(obj: Object): ContainerIdentifier | undefined {
  if (obj instanceof Folder) {
    return obj.containerID;
  }
  if (obj instanceof AccountService) {
    return obj.containerRef.containerID;
  }
  if (obj instanceof SmartFeedsController) {
    return obj.containerID;
  }
  return undefined;
}

export function unreadCountOf(obj: Object): number {
  if (obj instanceof Feed) {
    return obj.unreadCount;
  }
  if (obj instanceof Folder) {
    return obj.unreadCount;
  }
  if (obj instanceof SmartFeed) {
    return obj.unreadCount;
  }
  if (obj instanceof AccountService) {
    return obj.unreadCount;
  }
  // SmartFeedsController is a section header, not an UnreadCountProvider.
  return 0;
}

export function defaultReadFilterTypeOf(obj: Object): ReadFilterType {
  if (obj instanceof Feed) {
    return obj.defaultReadFilterType;
  }
  if (obj instanceof Folder) {
    return obj.defaultReadFilterType;
  }
  if (obj instanceof SmartFeed) {
    return obj.defaultReadFilterType;
  }
  return ReadFilterType.none;
}

/** True for the things that can be selected in the sidebar and drive a timeline. */
export function isSidebarItem(obj: Object): boolean {
  return obj instanceof Feed || obj instanceof Folder || obj instanceof SmartFeed;
}

/** A stable Map key for a ContainerIdentifier (Swift used Hashable). */
export function containerKey(id: ContainerIdentifier): string {
  return (id.type as string) + '|' + (id.accountID === undefined ? '' : id.accountID)
    + '|' + (id.folderName === undefined ? '' : id.folderName);
}

/** A stable Map key for a SidebarItemIdentifier. */
export function sidebarItemKey(id: SidebarItemIdentifier): string {
  return id.description();
}

// MARK: - SidebarTreeControllerDelegate

export class SidebarTreeControllerDelegate implements TreeControllerDelegate {
  private filterExceptions: Set<string> = new Set<string>();
  isReadFiltered: boolean = false;

  addFilterException(sidebarItemID: SidebarItemIdentifier): void {
    this.filterExceptions.add(sidebarItemKey(sidebarItemID));
  }

  resetFilterExceptions(): void {
    this.filterExceptions = new Set<string>();
  }

  childNodesFor(treeController: TreeController, node: Node): Node[] | undefined {
    if (node.isRoot) {
      return this.childNodesForRootNode(node);
    }
    const obj: Object = node.representedObject;
    if (obj instanceof SmartFeedsController) {
      return this.childNodesForSmartFeeds(node);
    }
    if (obj instanceof AccountService || obj instanceof Folder) {
      return this.childNodesForContainerNode(node, obj);
    }
    return undefined;
  }

  private childNodesForRootNode(rootNode: Node): Node[] {
    const topLevelNodes: Node[] = [];

    const smartFeedsNode: Node = rootNode.existingOrNewChildNode(SmartFeedsController.shared);
    smartFeedsNode.canHaveChildNodes = true;
    smartFeedsNode.isGroupItem = true;
    topLevelNodes.push(smartFeedsNode);

    for (const account of AccountManager.shared.sortedActiveAccounts) {
      const accountNode: Node = rootNode.existingOrNewChildNode(account);
      accountNode.canHaveChildNodes = true;
      accountNode.isGroupItem = true;
      topLevelNodes.push(accountNode);
    }

    return topLevelNodes;
  }

  private childNodesForSmartFeeds(parentNode: Node): Node[] {
    const nodes: Node[] = [];
    // Every smart feed stays visible despite the Hide Read Feeds setting.
    for (const smartFeed of SmartFeedsController.shared.smartFeeds) {
      nodes.push(parentNode.existingOrNewChildNode(smartFeed));
    }
    return nodes;
  }

  private childNodesForContainerNode(containerNode: Node, container: Object): Node[] {
    const children: Object[] = [];

    const topLevelFeeds: Feed[] = container instanceof AccountService
      ? container.containerRef.topLevelFeeds() : (container as Folder).topLevelFeeds;
    for (const feed of topLevelFeeds) {
      if (this.passesReadFilter(feed.sidebarItemID, feed.unreadCount)) {
        children.push(feed);
      }
    }

    const folders: Folder[] | undefined = container instanceof AccountService
      ? container.folders() : (container as Folder).folders;
    if (folders !== undefined) {
      for (const folder of folders) {
        if (this.passesReadFilter(folder.sidebarItemID, folder.unreadCount)) {
          children.push(folder);
        }
      }
    }

    const updatedChildNodes: Node[] = [];
    for (const representedObject of children) {
      const existingNode: Node | undefined =
        containerNode.childNodeRepresentingObject(representedObject);
      if (existingNode !== undefined && updatedChildNodes.indexOf(existingNode) < 0) {
        updatedChildNodes.push(existingNode);
        continue;
      }
      const newNode: Node = containerNode.createChildNode(representedObject);
      if (representedObject instanceof Folder) {
        newNode.canHaveChildNodes = true;
      }
      updatedChildNodes.push(newNode);
    }

    return sortedAlphabeticallyWithFoldersAtEnd(updatedChildNodes);
  }

  private passesReadFilter(sidebarItemID: SidebarItemIdentifier, unreadCount: number): boolean {
    if (this.filterExceptions.has(sidebarItemKey(sidebarItemID))) {
      return true;
    }
    return !(this.isReadFiltered && unreadCount === 0);
  }
}

/** Node+Extensions.swift — leaves first, then containers, each alphabetically. */
export function sortedAlphabeticallyWithFoldersAtEnd(nodes: Node[]): Node[] {
  const sorted: Node[] = nodes.slice();
  sorted.sort((node1: Node, node2: Node): number => {
    if (node1.canHaveChildNodes !== node2.canHaveChildNodes) {
      return node1.canHaveChildNodes ? 1 : -1;
    }
    const name1: string = nameForDisplayOf(node1.representedObject).toLowerCase();
    const name2: string = nameForDisplayOf(node2.representedObject).toLowerCase();
    if (name1 < name2) {
      return -1;
    }
    return name1 > name2 ? 1 : 0;
  });
  return sorted;
}

// MARK: - Flattened sidebar rows

/** One visible sidebar row. `sectionIndex` is the top-level node it belongs to. */
export class SidebarRow {
  readonly node: Node;
  readonly level: number;
  readonly sectionIndex: number;
  readonly isGroupItem: boolean;

  constructor(node: Node, level: number, sectionIndex: number) {
    this.node = node;
    this.level = level;
    this.sectionIndex = sectionIndex;
    this.isGroupItem = node.isGroupItem;
  }
}

export type IsExpandedTest = (node: Node) => boolean;

/**
 * The visible rows of the tree, top to bottom — the ArkTS shape of the collection view's
 * diffable snapshot. The source's (section, row) IndexPath collapses to this flat index;
 * `sectionIndex` is preserved so the sidebar can still render section headers.
 * ponytail: flat index instead of section/row — restore sections if the sidebar ever
 * needs per-section operations beyond rendering.
 */
export function visibleRows(rootNode: Node, isExpanded: IsExpandedTest): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const sections: Node[] = rootNode.childNodes;
  for (let sectionIndex: number = 0; sectionIndex < sections.length; sectionIndex++) {
    const sectionNode: Node = sections[sectionIndex];
    rows.push(new SidebarRow(sectionNode, 0, sectionIndex));
    if (isExpanded(sectionNode)) {
      appendVisibleChildren(sectionNode, 1, sectionIndex, isExpanded, rows);
    }
  }
  return rows;
}

function appendVisibleChildren(node: Node, level: number, sectionIndex: number,
  isExpanded: IsExpandedTest, rows: SidebarRow[]): void {
  for (const childNode of node.childNodes) {
    rows.push(new SidebarRow(childNode, level, sectionIndex));
    if (childNode.canHaveChildNodes && isExpanded(childNode)) {
      appendVisibleChildren(childNode, level + 1, sectionIndex, isExpanded, rows);
    }
  }
}

/** The first descendant node whose represented object has this sidebar item ID. */
export function descendantNodeForSidebarItemID(rootNode: Node,
  sidebarItemID: SidebarItemIdentifier): Node | undefined {
  for (const childNode of rootNode.childNodes) {
    const id: SidebarItemIdentifier | undefined = sidebarItemIDOf(childNode.representedObject);
    if (id !== undefined && id.equals(sidebarItemID)) {
      return childNode;
    }
    const found: Node | undefined = descendantNodeForSidebarItemID(childNode, sidebarItemID);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
