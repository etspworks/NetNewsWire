/**
 * AccountBehavior — port of Modules/Account/Sources/Account/AccountBehaviors.swift
 *
 * Swift models this as an enum with one associated value on
 * disallowMarkAsUnreadAfterPeriod(Int); ArkTS has no associated values, so the payload
 * rides alongside the discriminator.
 */

export enum AccountBehaviorKind {
  /** No copies of a feed that is in a folder to the root folder. */
  disallowFeedCopyInRootFolder = 'disallowFeedCopyInRootFolder',
  /** No feeds in the root folder. */
  disallowFeedInRootFolder = 'disallowFeedInRootFolder',
  /** A feed may not be in more than one folder. */
  disallowFeedInMultipleFolders = 'disallowFeedInMultipleFolders',
  /** No folder management. */
  disallowFolderManagement = 'disallowFolderManagement',
  /** No OPML imports. */
  disallowOPMLImports = 'disallowOPMLImports',
  /** No mark-as-unread after `days` days. */
  disallowMarkAsUnreadAfterPeriod = 'disallowMarkAsUnreadAfterPeriod'
}

export class AccountBehavior {
  readonly kind: AccountBehaviorKind;
  /** Set only for disallowMarkAsUnreadAfterPeriod. */
  readonly days?: number;

  constructor(kind: AccountBehaviorKind, days?: number) {
    this.kind = kind;
    this.days = days;
  }

  equals(other: AccountBehavior): boolean {
    return this.kind === other.kind && this.days === other.days;
  }
}

export function behaviorsContain(behaviors: AccountBehavior[], kind: AccountBehaviorKind): boolean {
  for (const behavior of behaviors) {
    if (behavior.kind === kind) {
      return true;
    }
  }
  return false;
}

export function markAsUnreadPeriodDays(behaviors: AccountBehavior[]): number | undefined {
  for (const behavior of behaviors) {
    if (behavior.kind === AccountBehaviorKind.disallowMarkAsUnreadAfterPeriod) {
      return behavior.days;
    }
  }
  return undefined;
}
