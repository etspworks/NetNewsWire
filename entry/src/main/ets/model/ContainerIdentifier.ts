/**
 * ContainerIdentifier — port of Modules/Account/Sources/Account/ContainerIdentifier.swift
 *
 * Swift enum with associated values -> discriminator + payload fields.
 * userInfo()/fromUserInfo() keep the same wire shape the source encodes.
 */

export enum ContainerIdentifierType {
  smartFeedController = 'smartFeedController',
  account = 'account',
  folder = 'folder'
}

export class ContainerIdentifier {
  readonly type: ContainerIdentifierType;
  readonly accountID?: string;
  readonly folderName?: string;

  constructor(type: ContainerIdentifierType, accountID?: string, folderName?: string) {
    this.type = type;
    this.accountID = accountID;
    this.folderName = folderName;
  }

  static smartFeedController(): ContainerIdentifier {
    return new ContainerIdentifier(ContainerIdentifierType.smartFeedController);
  }

  static account(accountID: string): ContainerIdentifier {
    return new ContainerIdentifier(ContainerIdentifierType.account, accountID);
  }

  static folder(accountID: string, folderName: string): ContainerIdentifier {
    return new ContainerIdentifier(ContainerIdentifierType.folder, accountID, folderName);
  }

  userInfo(): Map<string, string> {
    const d: Map<string, string> = new Map<string, string>();
    d.set('type', this.type as string);
    if (this.accountID !== undefined) {
      d.set('accountID', this.accountID);
    }
    if (this.folderName !== undefined) {
      d.set('folderName', this.folderName);
    }
    return d;
  }

  static fromUserInfo(userInfo: Map<string, string>): ContainerIdentifier | undefined {
    const type: string | undefined = userInfo.get('type');
    if (type === undefined) {
      return undefined;
    }
    if (type === 'smartFeedController') {
      return ContainerIdentifier.smartFeedController();
    }
    const accountID: string | undefined = userInfo.get('accountID');
    if (accountID === undefined) {
      return undefined;
    }
    if (type === 'account') {
      return ContainerIdentifier.account(accountID);
    }
    if (type === 'folder') {
      const folderName: string | undefined = userInfo.get('folderName');
      if (folderName === undefined) {
        return undefined;
      }
      return ContainerIdentifier.folder(accountID, folderName);
    }
    return undefined;
  }

  equals(other: ContainerIdentifier): boolean {
    return this.type === other.type
      && this.accountID === other.accountID
      && this.folderName === other.folderName;
  }
}
