/**
 * FeedbinSubscription — port of
 * Modules/Account/Sources/Account/Feedbin/FeedbinSubscription.swift
 *
 * Plus the small request/response bodies declared alongside it in the same Swift file:
 * FeedbinCreateSubscription, FeedbinUpdateSubscription, FeedbinSubscriptionChoice.
 */

export interface FeedbinSubscriptionJSONFeedWire {
  favicon?: string;
  icon?: string;
}

export interface FeedbinSubscriptionWire {
  id: number;
  feed_id: number;
  title?: string;
  feed_url: string;
  site_url?: string;
  json_feed?: FeedbinSubscriptionJSONFeedWire;
}

export interface FeedbinSubscriptionJSONFeed {
  favicon?: string;
  icon?: string;
}

export interface FeedbinSubscription {
  subscriptionID: number;
  feedID: number;
  name?: string;
  url: string;
  homePageURL?: string;
  jsonFeed?: FeedbinSubscriptionJSONFeed;
}

export function feedbinSubscriptionFromJSON(wire: FeedbinSubscriptionWire): FeedbinSubscription {
  let jsonFeed: FeedbinSubscriptionJSONFeed | undefined = undefined;
  const jsonFeedWire: FeedbinSubscriptionJSONFeedWire | undefined = wire.json_feed;
  if (jsonFeedWire !== undefined) {
    jsonFeed = { favicon: jsonFeedWire.favicon, icon: jsonFeedWire.icon };
  }
  const subscription: FeedbinSubscription = {
    subscriptionID: wire.id,
    feedID: wire.feed_id,
    name: wire.title,
    url: wire.feed_url,
    homePageURL: wire.site_url,
    jsonFeed: jsonFeed
  };
  return subscription;
}

/** POST /subscriptions body. */
export interface FeedbinCreateSubscription {
  feed_url: string;
}

/** PATCH /subscriptions/:id body. */
export interface FeedbinUpdateSubscription {
  title: string;
}

/** A multiple-choice response when one page offers several feeds. */
export interface FeedbinSubscriptionChoiceWire {
  title?: string;
  feed_url: string;
}

export interface FeedbinSubscriptionChoice {
  name?: string;
  url: string;
}

export function feedbinSubscriptionChoiceFromJSON(
  wire: FeedbinSubscriptionChoiceWire): FeedbinSubscriptionChoice {
  const choice: FeedbinSubscriptionChoice = { name: wire.title, url: wire.feed_url };
  return choice;
}
