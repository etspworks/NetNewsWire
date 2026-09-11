/**
 * OPMLDocument / OPMLItem / OPMLFeedSpecifier — port of
 * Modules/RSParser/Sources/RSParser/OPML/{OPMLDocument,OPMLItem,OPMLFeedSpecifier}.swift
 *
 * An OPMLItem is an outline node. Leaf items (feeds) have no children and produce a
 * feedSpecifier; folder items have children and no feedSpecifier. The attribute fallback
 * order for a title is `title` then `text`, exactly as the source resolves it.
 */

export interface OPMLFeedSpecifier {
  title?: string;
  feedDescription?: string;
  homePageURL?: string;
  feedURL: string;
}

export class OPMLItem {
  attributes?: Map<string, string>;
  children?: OPMLItem[];

  constructor(attributes?: Map<string, string>) {
    this.attributes = attributes;
  }

  addChild(child: OPMLItem): void {
    if (this.children === undefined) {
      this.children = [];
    }
    this.children.push(child);
  }

  /** Title resolved via the OPML attribute fallback order: `title` then `text`. */
  get titleFromAttributes(): string | undefined {
    const attributes: Map<string, string> | undefined = this.attributes;
    if (attributes === undefined) {
      return undefined;
    }
    const title: string | undefined = attributes.get('title');
    return title !== undefined ? title : attributes.get('text');
  }

  /** True when the item has children — i.e. it is a folder rather than a feed. */
  get isFolder(): boolean {
    const children: OPMLItem[] | undefined = this.children;
    return children !== undefined && children.length > 0;
  }

  /** Undefined for folder items and for items missing an `xmlUrl` attribute. */
  get feedSpecifier(): OPMLFeedSpecifier | undefined {
    const attributes: Map<string, string> | undefined = this.attributes;
    if (attributes === undefined) {
      return undefined;
    }
    const feedURL: string | undefined = attributes.get('xmlUrl');
    if (feedURL === undefined || feedURL.length === 0) {
      return undefined;
    }
    const specifier: OPMLFeedSpecifier = {
      title: this.titleFromAttributes,
      feedDescription: attributes.get('description'),
      homePageURL: attributes.get('htmlUrl'),
      feedURL: feedURL
    };
    return specifier;
  }
}

/**
 * The root of an OPML document — an OPMLItem that also carries the document-level title
 * (from <title> in <head>) and the URL it was loaded from.
 */
export class OPMLDocument extends OPMLItem {
  title?: string;
  url?: string;

  constructor(url?: string) {
    super();
    this.url = url;
  }
}
