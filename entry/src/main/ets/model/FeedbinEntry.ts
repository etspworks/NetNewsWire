/**
 * FeedbinEntry — port of Modules/Account/Sources/Account/Feedbin/FeedbinEntry.swift
 *
 * FeedbinEntryWire mirrors the JSON exactly (the Swift CodingKeys), so a parsed response
 * casts straight onto it; feedbinEntryFromJSON() is the Swift Decodable init and fills
 * every field the source fills.
 *
 * Feedbin's dates cannot be decoded by a standard 8601 strategy, so the source keeps them
 * as strings and parses each one lazily — a single bad date then costs one date, not the
 * whole batch. Same here: datePublished/dateArrived stay strings.
 */

/** The JSON shape, key for key. */
export interface FeedbinEntryJSONFeedAuthorWire {
  url?: string;
  avatar?: string;
}

export interface FeedbinEntryJSONFeedWire {
  author?: FeedbinEntryJSONFeedAuthorWire;
  external_url?: string;
}

export interface FeedbinEntryWire {
  id: number;
  feed_id: number;
  title?: string;
  url?: string;
  author?: string;
  content?: string;
  summary?: string;
  published?: string;
  created_at?: string;
  json_feed?: FeedbinEntryJSONFeedWire;
}

export interface FeedbinEntryJSONFeedAuthor {
  url?: string;
  avatarURL?: string;
}

export interface FeedbinEntryJSONFeed {
  jsonFeedAuthor?: FeedbinEntryJSONFeedAuthor;
  jsonFeedExternalURL?: string;
}

export interface FeedbinEntry {
  articleID: number;
  feedID: number;
  title?: string;
  url?: string;
  authorName?: string;
  contentHTML?: string;
  summary?: string;
  /** Feedbin's "published" — parsed on demand. */
  datePublished?: string;
  /** Feedbin's "created_at". */
  dateArrived?: string;
  jsonFeed?: FeedbinEntryJSONFeed;
}

export function feedbinEntryFromJSON(wire: FeedbinEntryWire): FeedbinEntry {
  const entry: FeedbinEntry = {
    articleID: wire.id,
    feedID: wire.feed_id,
    title: wire.title,
    url: wire.url,
    authorName: wire.author,
    contentHTML: wire.content,
    summary: wire.summary,
    datePublished: wire.published,
    dateArrived: wire.created_at,
    jsonFeed: feedbinEntryJSONFeedFromJSON(wire.json_feed)
  };
  return entry;
}

export function feedbinEntryJSONFeedFromJSON(wire?: FeedbinEntryJSONFeedWire): FeedbinEntryJSONFeed | undefined {
  if (wire === undefined) {
    return undefined;
  }
  let author: FeedbinEntryJSONFeedAuthor | undefined = undefined;
  const authorWire: FeedbinEntryJSONFeedAuthorWire | undefined = wire.author;
  if (authorWire !== undefined) {
    author = { url: authorWire.url, avatarURL: authorWire.avatar };
  }
  const jsonFeed: FeedbinEntryJSONFeed = {
    jsonFeedAuthor: author,
    jsonFeedExternalURL: wire.external_url
  };
  return jsonFeed;
}
