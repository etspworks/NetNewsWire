/**
 * FeedbinTag / FeedbinTagging — port of
 * Modules/Account/Sources/Account/Feedbin/{FeedbinTag,FeedbinTagging}.swift
 *
 * Feedbin models folders as tags: a tag is the folder, a tagging is one feed's membership
 * in it. The rename/delete/create request bodies live in the same Swift files.
 */

export interface FeedbinTagWire {
  id: number;
  name: string;
}

export interface FeedbinTag {
  tagID: number;
  name: string;
}

export function feedbinTagFromJSON(wire: FeedbinTagWire): FeedbinTag {
  const tag: FeedbinTag = { tagID: wire.id, name: wire.name };
  return tag;
}

export interface FeedbinTaggingWire {
  id: number;
  feed_id: number;
  name: string;
}

export interface FeedbinTagging {
  taggingID: number;
  feedID: number;
  name: string;
}

export function feedbinTaggingFromJSON(wire: FeedbinTaggingWire): FeedbinTagging {
  const tagging: FeedbinTagging = {
    taggingID: wire.id,
    feedID: wire.feed_id,
    name: wire.name
  };
  return tagging;
}

/** POST /taggings body. */
export interface FeedbinCreateTagging {
  feed_id: number;
  name: string;
}

/** POST /tags body — rename a folder. */
export interface FeedbinRenameTag {
  old_name: string;
  new_name: string;
}

/** DELETE /tags body. */
export interface FeedbinDeleteTag {
  name: string;
}
