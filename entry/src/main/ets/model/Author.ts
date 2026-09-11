/**
 * Author — port of Modules/Articles/Sources/Articles/Author.swift
 *
 * The source's failable init returns nil when name, url and emailAddress are all nil,
 * and calculates authorID as md5(name + url + avatarURL + emailAddress) when not given.
 * md5 is async on HarmonyOS (crypto framework), so the seed string is built here and
 * hashed by the data layer.
 */

export interface Author {
  authorID: string;
  name?: string;
  url?: string;
  avatarURL?: string;
  emailAddress?: string;
}

/** The source returns nil (no Author) when name, url and emailAddress are all missing. */
export function authorIsRepresentable(name?: string, url?: string, emailAddress?: string): boolean {
  return name !== undefined || url !== undefined || emailAddress !== undefined;
}

/** name + url + avatarURL + emailAddress — md5 of this is the calculated authorID. */
export function authorIDSeed(name?: string, url?: string, avatarURL?: string, emailAddress?: string): string {
  let s: string = name !== undefined ? name : '';
  s += url !== undefined ? url : '';
  s += avatarURL !== undefined ? avatarURL : '';
  s += emailAddress !== undefined ? emailAddress : '';
  return s;
}
