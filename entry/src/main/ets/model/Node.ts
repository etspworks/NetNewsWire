/**
 * Node — port of Modules/RSTree/Sources/RSTree/Node.swift
 *
 * The sidebar tree node. representedObject is AnyObject in Swift; ArkTS's `Object` is the
 * equivalent non-any top type.
 */

export class Node {
  private static incrementingID: number = 0;

  readonly representedObject: Object;
  readonly uniqueID: number;
  parent?: Node;
  canHaveChildNodes: boolean = false;
  isGroupItem: boolean = false;
  childNodes: Node[] = [];

  constructor(representedObject: Object, parent?: Node) {
    this.representedObject = representedObject;
    this.parent = parent;
    this.uniqueID = Node.incrementingID;
    Node.incrementingID += 1;
  }

  get isRoot(): boolean {
    return this.parent === undefined;
  }

  get numberOfChildNodes(): number {
    return this.childNodes.length;
  }

  get isLeaf(): boolean {
    return this.numberOfChildNodes < 1;
  }

  get level(): number {
    const parent: Node | undefined = this.parent;
    return parent === undefined ? 0 : parent.level + 1;
  }

  /** Index path from the root, as the source's IndexPath. */
  get indexPath(): number[] {
    const parent: Node | undefined = this.parent;
    if (parent === undefined) {
      return [0];
    }
    const path: number[] = parent.indexPath.slice();
    const childIndex: number = parent.indexOfChild(this);
    if (childIndex >= 0) {
      path.push(childIndex);
    }
    return path;
  }

  static genericRootNode(representedObject: Object): Node {
    const node: Node = new Node(representedObject, undefined);
    node.canHaveChildNodes = true;
    return node;
  }

  existingOrNewChildNode(representedObject: Object): Node {
    const existing: Node | undefined = this.childNodeRepresentingObject(representedObject);
    if (existing !== undefined) {
      return existing;
    }
    return this.createChildNode(representedObject);
  }

  /** Just creates — does not add it. */
  createChildNode(representedObject: Object): Node {
    return new Node(representedObject, this);
  }

  childAtIndex(index: number): Node | undefined {
    if (index >= this.childNodes.length || index < 0) {
      return undefined;
    }
    return this.childNodes[index];
  }

  indexOfChild(node: Node): number {
    for (let i: number = 0; i < this.childNodes.length; i++) {
      if (this.childNodes[i] === node) {
        return i;
      }
    }
    return -1;
  }

  childNodeRepresentingObject(obj: Object): Node | undefined {
    return this.findNodeRepresentingObject(obj, false);
  }

  descendantNodeRepresentingObject(obj: Object): Node | undefined {
    return this.findNodeRepresentingObject(obj, true);
  }

  private findNodeRepresentingObject(obj: Object, recursively: boolean): Node | undefined {
    for (const childNode of this.childNodes) {
      if (childNode.representedObject === obj) {
        return childNode;
      }
      if (recursively) {
        const found: Node | undefined = childNode.findNodeRepresentingObject(obj, true);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }
}
