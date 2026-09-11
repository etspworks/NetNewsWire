/**
 * ParsedAttachment — port of Modules/RSParser/Sources/RSParser/Feeds/ParsedAttachment.swift
 */

export interface ParsedAttachment {
  url: string;
  mimeType?: string;
  title?: string;
  sizeInBytes?: number;
  durationInSeconds?: number;
}

/** The source init is failable: nil when the url is empty. */
export function makeParsedAttachment(url: string, mimeType?: string, title?: string,
  sizeInBytes?: number, durationInSeconds?: number): ParsedAttachment | undefined {
  if (url.length === 0) {
    return undefined;
  }
  const attachment: ParsedAttachment = {
    url: url,
    mimeType: mimeType,
    title: title,
    sizeInBytes: sizeInBytes,
    durationInSeconds: durationInSeconds
  };
  return attachment;
}
