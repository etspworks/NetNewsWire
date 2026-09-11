/**
 * ParsedItem — port of Modules/RSParser/Sources/RSParser/Feeds/ParsedItem.swift
 *
 * Note the source's init rule for contentHTML: when `markdown` is present it renders the
 * markdown and uses that, falling back to the passed contentHTML when the render is empty.
 * makeParsedItem() reproduces it (the renderer is injected by the parser service).
 */

import { ParsedAttachment } from './ParsedAttachment';
import { ParsedAuthor } from './ParsedAuthor';

export interface ParsedItem {
  /** Undefined when not syncing. */
  syncServiceID?: string;
  /** RSS guid, for instance; may be calculated. */
  uniqueID: string;
  feedURL: string;
  url?: string;
  externalURL?: string;
  title?: string;
  language?: string;
  contentHTML?: string;
  contentText?: string;
  markdown?: string;
  summary?: string;
  imageURL?: string;
  bannerImageURL?: string;
  datePublished?: Date;
  dateModified?: Date;
  authors?: ParsedAuthor[];
  tags?: string[];
  attachments?: ParsedAttachment[];
}

/**
 * Applies the source's markdown-to-HTML rule: rendered markdown wins, unless it renders
 * empty, in which case the supplied contentHTML is kept.
 */
export function resolvedContentHTML(contentHTML?: string, markdown?: string,
  renderMarkdown?: (markdown: string) => string): string | undefined {
  if (markdown === undefined || renderMarkdown === undefined) {
    return contentHTML;
  }
  const rendered: string = renderMarkdown(markdown);
  return rendered.length === 0 ? contentHTML : rendered;
}
