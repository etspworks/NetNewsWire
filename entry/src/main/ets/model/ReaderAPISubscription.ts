/**
 * ReaderAPISubscription / ReaderAPICategory — port of
 * Modules/Account/Sources/Account/ReaderAPI/ReaderAPISubscription.swift, plus the tag and
 * tagging types declared alongside it (ReaderAPITag.swift, ReaderAPITagging.swift).
 */

export interface ReaderAPICategoryWire {
  id: string;
  label: string;
}

export interface ReaderAPICategory {
  categoryId: string;
  categoryLabel: string;
}

export function readerAPICategoryFromJSON(wire: ReaderAPICategoryWire): ReaderAPICategory {
  const category: ReaderAPICategory = { categoryId: wire.id, categoryLabel: wire.label };
  return category;
}

export interface ReaderAPISubscriptionWire {
  id: string;
  title?: string;
  categories: ReaderAPICategoryWire[];
  url?: string;
  htmlUrl?: string;
  iconUrl?: string;
}

export interface ReaderAPISubscription {
  feedID: string;
  name?: string;
  categories: ReaderAPICategory[];
  feedURL?: string;
  homePageURL?: string;
  iconURL?: string;
}

export function readerAPISubscriptionFromJSON(
  wire: ReaderAPISubscriptionWire): ReaderAPISubscription {
  const categories: ReaderAPICategory[] = [];
  for (const categoryWire of wire.categories) {
    categories.push(readerAPICategoryFromJSON(categoryWire));
  }
  const subscription: ReaderAPISubscription = {
    feedID: wire.id,
    name: wire.title,
    categories: categories,
    feedURL: wire.url,
    homePageURL: wire.htmlUrl,
    iconURL: wire.iconUrl
  };
  return subscription;
}

/** feedURL when present, else the feedID with its "feed/" prefix stripped. */
export function readerAPISubscriptionURL(subscription: ReaderAPISubscription): string {
  const feedURL: string | undefined = subscription.feedURL;
  if (feedURL !== undefined) {
    return feedURL;
  }
  const feedID: string = subscription.feedID;
  return feedID.startsWith('feed/') ? feedID.substring('feed/'.length) : feedID;
}

export interface ReaderAPISubscriptionContainerWire {
  subscriptions: ReaderAPISubscriptionWire[];
}

/** POST /subscription/quickadd response. */
export interface ReaderAPIQuickAddResultWire {
  numResults: number;
  error?: string;
  streamId?: string;
}

export interface ReaderAPITagWire {
  id: string;
  type?: string;
}

export interface ReaderAPITag {
  tagID: string;
  type?: string;
}

export function readerAPITagFromJSON(wire: ReaderAPITagWire): ReaderAPITag {
  const tag: ReaderAPITag = { tagID: wire.id, type: wire.type };
  return tag;
}

/** Everything after "/label/" in the tag ID is the folder name. */
export function readerAPITagFolderName(tag: ReaderAPITag): string | undefined {
  const index: number = tag.tagID.indexOf('/label/');
  if (index < 0) {
    return undefined;
  }
  return tag.tagID.substring(index + '/label/'.length);
}

export interface ReaderAPITagContainerWire {
  tags: ReaderAPITagWire[];
}

export interface ReaderAPITaggingWire {
  id: number;
  feed_id: number;
  name: string;
}

export interface ReaderAPITagging {
  taggingID: number;
  feedID: number;
  name: string;
}

export function readerAPITaggingFromJSON(wire: ReaderAPITaggingWire): ReaderAPITagging {
  const tagging: ReaderAPITagging = {
    taggingID: wire.id,
    feedID: wire.feed_id,
    name: wire.name
  };
  return tagging;
}
