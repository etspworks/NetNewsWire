/**
 * NewsBlurStory — port of Modules/NewsBlur/Sources/NewsBlur/Models/NewsBlurStory.swift
 *
 * imageURL is the FIRST value of the secure_image_urls object, and datePublished is
 * story_timestamp parsed as a decimal string of seconds — both computed properties in the
 * source, both reproduced here. Losing either blanks the timeline row's thumbnail or date.
 */

export interface NewsBlurStoryWire {
  story_hash: string;
  story_feed_id: number;
  story_title?: string;
  story_permalink?: string;
  story_authors?: string;
  story_content?: string;
  /** Map of original URL -> https-rewritten URL; the first value is the story image. */
  secure_image_urls?: Map<string, string>;
  story_tags?: string[];
  story_timestamp: string;
}

export interface NewsBlurStory {
  storyID: string;
  feedID: number;
  title?: string;
  url?: string;
  authorName?: string;
  contentHTML?: string;
  imageURL?: string;
  tags?: string[];
  datePublished?: Date;
}

export function newsBlurStoryFromJSON(wire: NewsBlurStoryWire,
  secureImageURLs?: Map<string, string>): NewsBlurStory {
  const imageURLs: Map<string, string> | undefined =
    secureImageURLs !== undefined ? secureImageURLs : wire.secure_image_urls;
  const story: NewsBlurStory = {
    storyID: wire.story_hash,
    feedID: wire.story_feed_id,
    title: wire.story_title,
    url: wire.story_permalink,
    authorName: wire.story_authors,
    contentHTML: wire.story_content,
    imageURL: firstImageURL(imageURLs),
    tags: wire.story_tags,
    datePublished: newsBlurDatePublished(wire.story_timestamp)
  };
  return story;
}

/** The source returns secure_image_urls.first?.value. */
export function firstImageURL(imageURLs?: Map<string, string>): string | undefined {
  if (imageURLs === undefined) {
    return undefined;
  }
  for (const value of imageURLs.values()) {
    return value;
  }
  return undefined;
}

/**
 * story_timestamp is a string of seconds since 1970. Swift's doubleValue yields 0 for a
 * non-numeric string, so the source dates such a story 1970 rather than dropping it.
 */
export function newsBlurDatePublished(timestamp: string): Date {
  const interval: number = Number.parseFloat(timestamp);
  return new Date((Number.isNaN(interval) ? 0 : interval) * 1000);
}
