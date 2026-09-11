/**
 * FeedbinUnreadEntry / FeedbinStarredEntry / FeedbinImportResult — port of
 * Modules/Account/Sources/Account/Feedbin/{FeedbinUnreadEntry,FeedbinStarredEntry,
 * FeedbinImportResult}.swift
 */

export interface FeedbinUnreadEntryWire {
  unread_entries: number[];
}

export interface FeedbinUnreadEntry {
  unreadEntries: number[];
}

export function feedbinUnreadEntryFromJSON(wire: FeedbinUnreadEntryWire): FeedbinUnreadEntry {
  const entry: FeedbinUnreadEntry = { unreadEntries: wire.unread_entries };
  return entry;
}

export interface FeedbinStarredEntryWire {
  starred_entries: number[];
}

export interface FeedbinStarredEntry {
  starredEntries: number[];
}

export function feedbinStarredEntryFromJSON(wire: FeedbinStarredEntryWire): FeedbinStarredEntry {
  const entry: FeedbinStarredEntry = { starredEntries: wire.starred_entries };
  return entry;
}

export interface FeedbinImportResultWire {
  id: number;
  complete: boolean;
}

export interface FeedbinImportResult {
  importResultID: number;
  complete: boolean;
}

export function feedbinImportResultFromJSON(wire: FeedbinImportResultWire): FeedbinImportResult {
  const result: FeedbinImportResult = {
    importResultID: wire.id,
    complete: wire.complete
  };
  return result;
}
