/**
 * HTMLMetadataRecord — port of
 * Modules/HTMLMetadata/Sources/HTMLMetadata/HTMLMetadataRecord.swift
 *
 * Everything the app learns about a site's page: favicons, apple-touch icons, feed links,
 * OpenGraph images and the Twitter image. The icon-selection rules (bestWebsiteIconURL and
 * friends) are part of the type in the source and are ported verbatim — they are what
 * decides which favicon a feed row actually shows.
 */

export interface Favicon {
  type?: string;
  urlString?: string;
}

export interface AppleTouchIcon {
  rel?: string;
  sizes?: string;
  width: number;
  height: number;
  urlString?: string;
}

export interface FeedLink {
  title?: string;
  type?: string;
  urlString?: string;
}

export interface OpenGraphImage {
  url?: string;
  secureURL?: string;
  mimeType?: string;
  width: number;
  height: number;
  altText?: string;
}

export interface HTMLMetadataRecord {
  url: string;
  favicons: Favicon[];
  appleTouchIcons: AppleTouchIcon[];
  feedLinks: FeedLink[];
  openGraphImages: OpenGraphImage[];
  twitterImageURL?: string;
}

const badOpenGraphURLs: string[] = ['https://s0.wp.com/i/blank.jpg'];

export function bestWebsiteIconURL(record: HTMLMetadataRecord): string | undefined {
  const appleTouchIcon: string | undefined = largestAppleTouchIcon(record);
  if (appleTouchIcon !== undefined) {
    return appleTouchIcon;
  }
  const openGraphImageURL: string | undefined = largestOpenGraphImageURL(record);
  if (openGraphImageURL !== undefined) {
    return openGraphImageURL;
  }
  return record.twitterImageURL;
}

/** Skips banner-shaped images (wider than 2:1) and picks the largest of the rest. */
export function largestOpenGraphImageURL(record: HTMLMetadataRecord): string | undefined {
  if (record.openGraphImages.length === 0) {
    return undefined;
  }
  let bestImage: OpenGraphImage | undefined = undefined;
  for (const image of record.openGraphImages) {
    if (image.height > 0 && image.width / image.height > 2) {
      continue;
    }
    if (bestImage === undefined) {
      bestImage = image;
      continue;
    }
    if (image.height > bestImage.height && image.width > bestImage.width) {
      bestImage = image;
    }
  }
  if (bestImage === undefined) {
    return undefined;
  }
  const url: string | undefined = bestImage.secureURL !== undefined
    ? bestImage.secureURL
    : bestImage.url;
  if (url === undefined || badOpenGraphURLs.includes(url)) {
    return undefined;
  }
  return url;
}

export function largestAppleTouchIcon(record: HTMLMetadataRecord): string | undefined {
  if (record.appleTouchIcons.length === 0) {
    return undefined;
  }
  let bestImage: AppleTouchIcon | undefined = undefined;
  for (const image of record.appleTouchIcons) {
    if (image.height > 0 && image.width / image.height > 2) {
      continue;
    }
    if (bestImage === undefined) {
      bestImage = image;
      continue;
    }
    if (image.height > bestImage.height && image.width > bestImage.width) {
      bestImage = image;
    }
  }
  return bestImage === undefined ? undefined : bestImage.urlString;
}
