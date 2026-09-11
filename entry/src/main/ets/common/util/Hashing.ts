/**
 * Hashing — the MD5 the source takes from RSCore's `String.md5String`.
 *
 * Article and author IDs are MD5 hashes of a seed string. The models export the seed
 * (articleIDSeed / authorIDSeed) and this module does the hashing, because a model
 * must not depend on a system kit. `@ohos.security.cryptoFramework` exposes a
 * synchronous Md (updateSync/digestSync), so the IDs stay synchronous exactly as in
 * the Swift source — do not change these to async, article IDs must keep matching.
 */

import cryptoFramework from '@ohos.security.cryptoFramework';
import util from '@ohos.util';
import { articleIDSeed } from '../../model/Article';
import { authorIDSeed } from '../../model/Author';

const HEX_DIGITS: string = '0123456789abcdef';

function hexString(bytes: Uint8Array): string {
  let out: string = '';
  for (let i: number = 0; i < bytes.length; i++) {
    const b: number = bytes[i];
    out += HEX_DIGITS.charAt((b >> 4) & 0x0f);
    out += HEX_DIGITS.charAt(b & 0x0f);
  }
  return out;
}

/** Lowercase hex MD5 of the UTF-8 bytes of `s` — the same digest the source writes. */
export function md5String(s: string): string {
  const md: cryptoFramework.Md = cryptoFramework.createMd('MD5');
  const encoder: util.TextEncoder = new util.TextEncoder();
  const input: cryptoFramework.DataBlob = { data: encoder.encodeInto(s) };
  md.updateSync(input);
  const digest: cryptoFramework.DataBlob = md.digestSync();
  return hexString(digest.data);
}

/** MD5 of raw bytes — used for the disk-cache key of downloaded image data. */
export function md5OfBytes(bytes: Uint8Array): string {
  const md: cryptoFramework.Md = cryptoFramework.createMd('MD5');
  const input: cryptoFramework.DataBlob = { data: bytes };
  md.updateSync(input);
  const digest: cryptoFramework.DataBlob = md.digestSync();
  return hexString(digest.data);
}

/** Articles.articleID — md5("<feedID> <uniqueID>"). */
export function articleID(feedID: string, uniqueID: string): string {
  return md5String(articleIDSeed(feedID, uniqueID));
}

/** Articles.authorID — md5 of the author's identifying fields. */
export function authorID(name?: string, url?: string, avatarURL?: string,
  emailAddress?: string): string {
  return md5String(authorIDSeed(name, url, avatarURL, emailAddress));
}
