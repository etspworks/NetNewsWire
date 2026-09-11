/**
 * AccountType — port of the enum in Modules/Account/Sources/Account/Account.swift
 *
 * Raw values must not change: they are stored on disk.
 */

export enum AccountType {
  onMyMac = 1,
  cloudKit = 2,
  feedly = 16,
  feedbin = 17,
  newsBlur = 19,
  freshRSS = 20,
  inoreader = 21,
  bazQux = 22,
  theOldReader = 23
}

export function accountTypeIsDeveloperRestricted(type: AccountType): boolean {
  return type === AccountType.cloudKit
    || type === AccountType.feedbin
    || type === AccountType.feedly
    || type === AccountType.inoreader;
}

/**
 * Display name. The on-device account name is localized (DefaultAccountNames strings);
 * the service names are proper nouns and are not translated.
 *
 * `.onMyMac` names the account that lives on THIS device, so the source picks the idiom
 * per platform ("On My Mac" on macOS, "On My iPhone" on iOS). On HarmonyOS neither is
 * true, so the port says "On My Device" — the wording the (as yet unread) string resource
 * `account_name_on_my_device` was already named for.
 */
export function accountTypeDisplayName(type: AccountType): string {
  if (type === AccountType.onMyMac) {
    return 'On My Device';
  }
  if (type === AccountType.cloudKit) {
    return 'iCloud';
  }
  if (type === AccountType.feedly) {
    return 'Feedly';
  }
  if (type === AccountType.feedbin) {
    return 'Feedbin';
  }
  if (type === AccountType.newsBlur) {
    return 'NewsBlur';
  }
  if (type === AccountType.freshRSS) {
    return 'FreshRSS';
  }
  if (type === AccountType.inoreader) {
    return 'Inoreader';
  }
  if (type === AccountType.bazQux) {
    return 'BazQux';
  }
  return 'The Old Reader';
}
