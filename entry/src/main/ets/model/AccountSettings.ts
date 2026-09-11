/**
 * AccountSettings — port of Modules/Account/Sources/Account/AccountSettings.swift
 * (formerly AccountMetadata; renamed in this checkout.)
 *
 * Backed by UserDefaults in the source, by `preferences` here. The model holds the values;
 * the AccountSettings service owns the read/write. The defaults-key layout is reproduced
 * exactly (`<accountID>-<key>`) because it is what already-stored values are filed under.
 */

import { HTTPConditionalGetInfo } from './HTTPConditionalGetInfo';

export enum AccountSettingKey {
  name = 'name',
  isActive = 'isActive',
  username = 'username',
  conditionalGetInfo = 'conditionalGetInfo',
  lastArticleFetchStartTime = 'lastArticleFetchStartTime',
  lastRefreshCompletedDate = 'lastRefreshCompletedDate',
  endpointURL = 'endpointURL',
  externalID = 'externalID',
  imported = 'imported'
}

export class AccountSettings {
  readonly accountID: string;
  readonly dataFolder: string;

  name?: string;
  /** Registered default is true. */
  isActive: boolean = true;
  /** Never "" — the source trims and coerces blank to nil. */
  username?: string;
  lastArticleFetchStartTime?: Date;
  lastRefreshCompletedDate?: Date;
  endpointURL?: string;
  externalID?: string;
  /** Whether the legacy Settings.plist has already been imported. */
  plistImported: boolean = false;
  /** endpoint -> conditional GET info, one entry per sync endpoint. */
  conditionalGetInfo: Map<string, HTTPConditionalGetInfo> = new Map<string, HTTPConditionalGetInfo>();

  constructor(accountID: string, dataFolder: string) {
    this.accountID = accountID;
    this.dataFolder = dataFolder;
  }

  defaultsKey(key: AccountSettingKey): string {
    return this.accountID + '-' + (key as string);
  }

  conditionalGetInfoDefaultsKey(endpoint: string): string {
    return this.accountID + '-' + (AccountSettingKey.conditionalGetInfo as string) + '-' + endpoint;
  }

  conditionalGetInfoFor(endpoint: string): HTTPConditionalGetInfo | undefined {
    return this.conditionalGetInfo.get(endpoint);
  }

  setConditionalGetInfo(info: HTTPConditionalGetInfo | undefined, endpoint: string): void {
    if (info === undefined) {
      this.conditionalGetInfo.delete(endpoint);
    } else {
      this.conditionalGetInfo.set(endpoint, info);
    }
  }
}
