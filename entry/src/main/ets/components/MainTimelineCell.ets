/**
 * MainTimelineCell.
 * Source: iOS/MainTimeline/Cell/{MainTimelineCell,MainTimelineCellData,MainTimelineCellLayout}.swift.
 *
 * The timeline row's text block: title, summary, and the date + feed-name/byline line.
 * MainTimelineCellData's rules are reproduced verbatim:
 *   - an empty title AND an empty summary render "(No Text)";
 *   - showFeedName is tri-state — .feed shows the feed name, .byline the byline, .none hides
 *     the line entirely;
 *   - the line count comes from AppDefaults.timelineNumberOfLines (the page passes it in).
 * The leading indicator (star / unread dot) and the feed icon are IconViews supplied by the
 * page, exactly as the source's `configure(article:)` builds the cell data on the controller.
 */

import { ShowFeedName } from '../common/SceneCoordinator';
import {
  articleFeed, logicalDatePublished, truncatedFeedName, truncatedSummary, truncatedTitle
} from '../common/article/ArticleText';
import { IconImageCache } from '../common/images/IconImageCache';
import { Article } from '../model/Article';
import { Author } from '../model/Author';
import { Feed } from '../model/Feed';
import { IconImage } from '../model/IconImage';
import { IconSize, iconSizeDimension } from '../model/IconSize';

/**
 * MainTimelineCellData — everything one timeline row renders, built on the controller side
 * exactly as `MainTimelineModernViewController.configure(article:)` does.
 */
export class MainTimelineCellData {
  readonly articleID: string;
  readonly title: string;
  readonly summary: string;
  readonly dateString: string;
  readonly feedName: string;
  readonly byline: string;
  readonly showFeedName: ShowFeedName;
  readonly iconURL: string;
  readonly iconSymbolName: string;
  readonly showIcon: boolean;
  readonly read: boolean;
  readonly starred: boolean;
  readonly numberOfLines: number;
  readonly iconDimension: number;

  constructor(article: Article, showFeedName: ShowFeedName, showIcons: boolean,
    numberOfLines: number, iconSize: IconSize) {
    this.articleID = article.articleID;
    this.title = truncatedTitle(article);
    this.summary = truncatedSummary(article);
    this.dateString = timelineDateString(logicalDatePublished(article));

    const feed: Feed | undefined = articleFeed(article);
    this.feedName = feed === undefined ? '' : truncatedFeedName(feed.nameForDisplay);
    this.byline = articleByline(article, feed);
    this.showFeedName = showFeedName;

    let iconURL: string = '';
    let symbolName: string = '';
    if (showIcons) {
      const icon: IconImage | undefined = articleIconImage(article, feed);
      if (icon !== undefined) {
        iconURL = icon.sourceURL === undefined ? '' : icon.sourceURL;
        symbolName = icon.resourceName === undefined ? '' : icon.resourceName;
      }
    }
    this.iconURL = iconURL;
    this.iconSymbolName = symbolName;
    this.showIcon = showIcons && (iconURL.length > 0 || symbolName.length > 0);

    this.read = article.status.read;
    this.starred = article.status.starred;
    this.numberOfLines = numberOfLines;
    this.iconDimension = iconSizeDimension(iconSize);
  }

  /** `article.status.starred ? star.fill : (read ? hidden : circle.fill)` */
  get indicatorSymbol(): string {
    if (this.starred) {
      return 'star.fill';
    }
    return this.read ? '' : 'circle.fill';
  }
}

/**
 * ArticleStringFormatter.dateString(_:) — today shows the time, otherwise the date.
 *
 * The source's `timeFormatter` is `dateStyle .none` + `timeStyle .short`, i.e. hour and
 * minute with NO seconds; `toLocaleTimeString()` with no options is the LONG style and was
 * rendering '2:47:28 AM' where the source renders '23:01'.
 */
export function timelineDateString(date: Date): string {
  const now: Date = new Date();
  const isToday: boolean = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (!isToday) {
    // The source's `dateFormatter` is `dateStyle .medium` + `timeStyle .none` — an
    // abbreviated month and a four-digit year, no time at all ('29 Jul 1954').
    // `toLocaleDateString()` with no options is the SHORT numeric style and was rendering
    // '7/29/54'. Components rather than `dateStyle: 'medium'` so the locale still decides
    // day-first vs month-first, exactly as DateFormatter does.
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
  const hours: string = date.getHours().toString().padStart(2, '0');
  const minutes: string = date.getMinutes().toString().padStart(2, '0');
  return hours + ':' + minutes;
}

/** Article.byline() — the authors, minus an author whose name IS the feed name. */
export function articleByline(article: Article, feed: Feed | undefined): string {
  let authors: Author[] | undefined = article.authors;
  if (authors === undefined || authors.length === 0) {
    authors = feed === undefined ? undefined : feed.authors;
  }
  if (authors === undefined || authors.length === 0) {
    return '';
  }
  if (authors.length === 1 && feed !== undefined && authors[0].name === feed.nameForDisplay) {
    return '';
  }

  let byline: string = '';
  let isFirstAuthor: boolean = true;
  for (const author of authors) {
    if (!isFirstAuthor) {
      byline += ', ';
    }
    isFirstAuthor = false;

    let emailAddress: string | undefined = author.emailAddress;
    if (emailAddress !== undefined
      && (emailAddress.indexOf('noreply@') >= 0 || emailAddress.indexOf('no-reply@') >= 0)) {
      emailAddress = undefined;
    }
    const name: string | undefined = author.name;
    if (emailAddress !== undefined && emailAddress.indexOf(' ') >= 0) {
      byline += emailAddress;               // probably name plus email address
    } else if (name !== undefined && emailAddress !== undefined) {
      byline += name + ' <' + emailAddress + '>';
    } else if (name !== undefined) {
      byline += name;
    } else if (emailAddress !== undefined) {
      byline += '<' + emailAddress + '>';
    } else if (author.url !== undefined) {
      byline += author.url;
    }
  }
  return byline;
}

/** IconImageCache.imageForArticle(_:) — the author avatar first, then the feed's icon. */
export function articleIconImage(article: Article, feed: Feed | undefined): IconImage | undefined {
  const authors: Author[] | undefined = article.authors;
  if (authors !== undefined && authors.length === 1) {
    const avatar: IconImage | undefined = IconImageCache.shared.imageForAuthor(authors[0]);
    if (avatar !== undefined) {
      return avatar;
    }
  }
  return feed === undefined ? undefined : IconImageCache.shared.imageForFeed(feed);
}

/** LazyForEach's adapter over the coordinator's article set. */
export class ArticleDataSource implements IDataSource {
  private items: Article[] = [];
  private listeners: DataChangeListener[] = [];
  /** What each row was last told to render: identity + the two mutable status flags. */
  private renderedKeys: string[] = [];

  totalCount(): number {
    return this.items.length;
  }

  getData(index: number): Article {
    return this.items[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * `MainTimelineModernViewController.statusesDidChange(_:)` -> `reloadCells(articles)`:
   * the source reloads exactly the rows whose status moved.
   *
   * Marking an article read/unread/starred mutates the SHARED ArticleStatus in place (every
   * fetch is handed the same instance out of ArticlesDatabase's statusCache), so the array,
   * the Article instances and their identities are all unchanged. `onDataReloaded()` on its
   * own leaves such a row in LazyForEach's cache and never re-runs the item builder for it,
   * which is why a mark-unread or a star made on the article page only showed up after a
   * pull-to-refresh had replaced the whole array. `onDataChange(index)` is the notification
   * that means "this row's CONTENT changed" and forces that one row to be rebuilt.
   */
  reload(items: Article[]): void {
    const keys: string[] = [];
    for (const article of items) {
      keys.push(article.articleID + (article.status.read ? '-r' : '-u')
        + (article.status.starred ? 's' : 'n'));
    }
    const previous: string[] = this.renderedKeys;
    this.items = items;
    this.renderedKeys = keys;

    // A different row count is a different article set — nothing can be reused by index.
    if (previous.length !== keys.length) {
      for (const listener of this.listeners) {
        listener.onDataReloaded();
      }
      return;
    }
    for (let index: number = 0; index < keys.length; index++) {
      if (keys[index] === previous[index]) {
        continue;
      }
      for (const listener of this.listeners) {
        listener.onDataChange(index);
      }
    }
  }
}

@Component
export struct MainTimelineCell {
  @Prop title: string = '';
  @Prop summary: string = '';
  @Prop dateString: string = '';
  @Prop feedName: string = '';
  @Prop byline: string = '';
  @Prop showFeedName: ShowFeedName = ShowFeedName.none;
  /** AppDefaults.timelineNumberOfLines — 0 means "no limit" in the source. */
  @Prop numberOfLines: number = 0;

  private lineLimit(): number {
    return this.numberOfLines > 0 ? this.numberOfLines : 99;
  }

  /**
   * Style only: `summaryView.textColor = cellData.title.isEmpty ? .label : .secondaryLabel`
   * — MainTimelineCell.updateColors(active:) in the source.
   */
  private summaryColor(): ResourceColor {
    return this.title.length === 0
      ? $r('sys.color.ohos_id_color_text_primary')
      : $r('sys.color.ohos_id_color_text_secondary');
  }

  build() {
    // Typography, straight off MainTimelineDefaultCellLayout: title .headline,
    // summary .body, date/feedName .footnote (capture: title 2 lines x72..370, the
    // feed name at the left of the meta line and the date right-aligned at x370).
    Column() {
      // MainTimelineCellLayout.rectForSummary: `linesLeft = numberOfLines - linesUsedByTitle`
      // — title and summary share ONE line budget, so a 2-line title suppresses the summary
      // entirely. Two independently clamped Texts gave 2+2 lines and rows ~1.6x too tall.
      // One Text of two Spans reproduces the shared budget: the summary starts on a fresh
      // line and gets whatever the title left over.
      if (this.title.length > 0 || this.summary.length > 0) {
        Text() {
          if (this.title.length > 0) {
            Span(this.title)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontWeight(FontWeight.Medium)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
          }
          if (this.summary.length > 0) {
            Span(this.title.length > 0 ? '\n' + this.summary : this.summary)
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor(this.summaryColor())
          }
        }
        .maxLines(this.lineLimit())
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
      }
      // "(No Text)" — the source substitutes it when title AND summary are both empty.
      if (this.title.length === 0 && this.summary.length === 0) {
        Text($r('app.string.no_text'))
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .width('100%')
      }
      Row({ space: 8 }) {
        if (this.showFeedName === ShowFeedName.feed) {
          Text(this.feedName)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        } else if (this.showFeedName === ShowFeedName.byline) {
          Text(this.byline)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .fontSize($r('sys.float.ohos_id_text_size_body3'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        Blank()
        Text(this.dateString)
          .maxLines(1)
          .fontSize($r('sys.float.ohos_id_text_size_body3'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .alignItems(HorizontalAlign.Start)
    // NOT width('100%'): this struct's root IS the direct child of the page's row Row, after
    // the unread indicator (and the feed icon) plus their 8vp gaps. '100%' resolves to the
    // PARENT's full content width, so the block overflowed the row's right inset and clipped
    // the trailing date off the screen edge. layoutWeight takes what the leading slots left.
    .layoutWeight(1)
  }
}
