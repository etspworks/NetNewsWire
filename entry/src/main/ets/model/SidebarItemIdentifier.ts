/**
 * SidebarItemIdentifier — port of Modules/Account/Sources/Account/SidebarItemIdentifier.swift
 *
 * Swift enum with associated values -> discriminator + payload fields.
 * The userInfo dictionary shape (including the legacy "webFeedID" fallback key) is kept
 * verbatim: it is what state restoration reads.
 */

/** ReadFilterType — Modules/Account/Sources/Account/SidebarItem.swift (co-located here). */
export enum ReadFilterType {
  read = 'read',
  none = 'none',
  alwaysRead = 'alwaysRead'
}

export enum SidebarItemIdentifierType {
  smartFeed = 'smartFeed',
  feed = 'feed',
  folder = 'folder'
}

export class SidebarItemIdentifier {
  readonly type: SidebarItemIdentifierType;
  /** smartFeed only — a unique identifier. */
  readonly id?: string;
  readonly accountID?: string;
  readonly feedID?: string;
  readonly folderName?: string;

  constructor(type: SidebarItemIdentifierType, id?: string, accountID?: string,
    feedID?: string, folderName?: string) {
    this.type = type;
    this.id = id;
    this.accountID = accountID;
    this.feedID = feedID;
    this.folderName = folderName;
  }

  static smartFeed(id: string): SidebarItemIdentifier {
    return new SidebarItemIdentifier(SidebarItemIdentifierType.smartFeed, id);
  }

  static feed(accountID: string, feedID: string): SidebarItemIdentifier {
    return new SidebarItemIdentifier(SidebarItemIdentifierType.feed, undefined, accountID, feedID);
  }

  static folder(accountID: string, folderName: string): SidebarItemIdentifier {
    return new SidebarItemIdentifier(SidebarItemIdentifierType.folder, undefined, accountID,
      undefined, folderName);
  }

  description(): string {
    if (this.type === SidebarItemIdentifierType.smartFeed) {
      return '(typeName): ' + (this.id !== undefined ? this.id : '');
    }
    if (this.type === SidebarItemIdentifierType.feed) {
      return '(typeName): ' + (this.accountID !== undefined ? this.accountID : '') + '_'
        + (this.feedID !== undefined ? this.feedID : '');
    }
    return '(typeName): ' + (this.accountID !== undefined ? this.accountID : '') + '_'
      + (this.folderName !== undefined ? this.folderName : '');
  }

  userInfo(): Map<string, string> {
    const d: Map<string, string> = new Map<string, string>();
    d.set('type', this.type as string);
    if (this.id !== undefined) {
      d.set('id', this.id);
    }
    if (this.accountID !== undefined) {
      d.set('accountID', this.accountID);
    }
    if (this.feedID !== undefined) {
      d.set('feedID', this.feedID);
    }
    if (this.folderName !== undefined) {
      d.set('folderName', this.folderName);
    }
    return d;
  }

  static fromUserInfo(userInfo: Map<string, string>): SidebarItemIdentifier | undefined {
    const type: string | undefined = userInfo.get('type');
    if (type === undefined) {
      return undefined;
    }
    if (type === 'smartFeed') {
      const id: string | undefined = userInfo.get('id');
      return id === undefined ? undefined : SidebarItemIdentifier.smartFeed(id);
    }
    const accountID: string | undefined = userInfo.get('accountID');
    if (accountID === undefined) {
      return undefined;
    }
    if (type === 'feed') {
      let feedID: string | undefined = userInfo.get('feedID');
      if (feedID === undefined) {
        // Legacy key written by older builds.
        feedID = userInfo.get('webFeedID');
      }
      return feedID === undefined ? undefined : SidebarItemIdentifier.feed(accountID, feedID);
    }
    if (type === 'folder') {
      const folderName: string | undefined = userInfo.get('folderName');
      return folderName === undefined
        ? undefined
        : SidebarItemIdentifier.folder(accountID, folderName);
    }
    return undefined;
  }

  equals(other: SidebarItemIdentifier): boolean {
    return this.type === other.type
      && this.id === other.id
      && this.accountID === other.accountID
      && this.feedID === other.feedID
      && this.folderName === other.folderName;
  }
}
