/**
 * NewsBlurFeed / NewsBlurFeedsResponse — port of
 * Modules/NewsBlur/Sources/NewsBlur/Models/NewsBlurFeed.swift
 *
 * NewsBlur returns `feeds` and `flat_folders` as objects keyed by feed ID / folder name
 * rather than arrays, so the Swift type hand-decodes them with generic coding keys. The
 * key walk belongs to the NewsBlur service (it needs a JSON reader); the per-object decode
 * and the source's visibility filter live here.
 *
 * That filter matters: some feeds listed in `feeds` appear in no folder, and NewsBlur's own
 * apps hide them — dropping it would show feeds the source never shows.
 */

export interface NewsBlurFeedWire {
  id: number;
  feed_title: string;
  feed_address: string;
  feed_link?: string;
  favicon_url?: string;
}

export interface NewsBlurFeed {
  name: string;
  feedID: number;
  feedURL: string;
  homePageURL?: string;
  faviconURL?: string;
}

export function newsBlurFeedFromJSON(wire: NewsBlurFeedWire): NewsBlurFeed {
  const feed: NewsBlurFeed = {
    name: wire.feed_title,
    feedID: wire.id,
    feedURL: wire.feed_address,
    homePageURL: wire.feed_link,
    faviconURL: wire.favicon_url
  };
  return feed;
}

export interface NewsBlurFolder {
  name: string;
  feedIDs: number[];
}

export interface NewsBlurFeedsResponse {
  feeds: NewsBlurFeed[];
  folders: NewsBlurFolder[];
}

export interface NewsBlurFolderRelationship {
  folderName: string;
  feedID: number;
}

export function newsBlurFolderRelationships(folder: NewsBlurFolder): NewsBlurFolderRelationship[] {
  const relationships: NewsBlurFolderRelationship[] = [];
  for (const feedID of folder.feedIDs) {
    const relationship: NewsBlurFolderRelationship = { folderName: folder.name, feedID: feedID };
    relationships.push(relationship);
  }
  return relationships;
}

/**
 * The source's filter: keep only the feeds that appear in at least one folder. Feeds absent
 * from `flat_folders` are hidden by NewsBlur's own mobile and web apps.
 */
export function visibleNewsBlurFeeds(feeds: NewsBlurFeed[],
  folders: NewsBlurFolder[]): NewsBlurFeed[] {
  const visibleFeedIDs: number[] = [];
  for (const folder of folders) {
    for (const feedID of folder.feedIDs) {
      visibleFeedIDs.push(feedID);
    }
  }
  const visible: NewsBlurFeed[] = [];
  for (const feed of feeds) {
    if (visibleFeedIDs.includes(feed.feedID)) {
      visible.push(feed);
    }
  }
  return visible;
}
