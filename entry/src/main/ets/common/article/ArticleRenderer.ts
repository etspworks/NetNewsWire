/**
 * ArticleRenderer — port of Shared/Article Rendering/ArticleRenderer.swift,
 * ArticleRenderingSpecialCases.swift, RSCore's MacroProcessor.swift and the parts of
 * WebViewConfiguration.swift / WebViewController.renderPage() that build the page.
 *
 * This produces HTML — it draws no UI. The article screen feeds `pageHTML()` to the Web
 * component (`loadData(html, 'text/html', 'UTF-8', baseURL)`).
 *
 * Two substitutions the platform forces:
 *  - WKUserScript has no ArkWeb counterpart, so main.js / main_ios.js / newsfoot.js are
 *    inlined into the page <head> instead of injected at document start.
 *  - WKContentRuleList has no ArkWeb counterpart, so ContentRules.json is compiled to a
 *    predicate the Web component applies in onInterceptRequest (`shouldBlockURL`).
 */

import intl from '@ohos.intl';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { ArticleTheme } from '../../model/ArticleTheme';
import { Author } from '../../model/Author';
import { ExtractedArticle } from '../../model/ExtractedArticle';
import { Feed } from '../../model/Feed';
import { AppDefaults } from '../prefs/AppDefaults';
import { JsonObject, asArray, asObject, getObject, getString, parseJson } from '../util/Json';
import { hostOf } from '../util/Urls';
import { rawfileText } from './ArticleThemesManager';
import {
  articleBaseURL, articleBody, articleFeed, articleExternalLink, logicalDatePublished,
  preferredLink, sanitizedTitle
} from './ArticleText';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleRenderer';

/** The scheme the template's avatar <img> uses; the Web component resolves it locally. */
export const imageIconScheme: string = 'nnwImageIcon';

const articleRawfileDir: string = 'article';

export class Rendering {
  readonly style: string;
  readonly html: string;
  readonly title: string;
  readonly baseURL: string;

  constructor(style: string, html: string, title: string, baseURL: string) {
    this.style = style;
    this.html = html;
    this.title = title;
    this.baseURL = baseURL;
  }
}

// MARK: - MacroProcessor (RSCore)

/** Replaces `[[key]]` with its substitution; an undefined macro is left as-is. */
export function renderedText(template: string, substitutions: Map<string, string>,
  macroStart: string = '[[', macroEnd: string = ']]'): string {
  if (macroStart.length === 0 || macroEnd.length === 0) {
    throw new Error('empty macro delimiter');
  }

  let result: string = '';
  let index: number = 0;

  while (true) {
    const startIndex: number = template.indexOf(macroStart, index);
    if (startIndex < 0) {
      break;
    }
    result += template.substring(index, startIndex);

    const keyStart: number = startIndex + macroStart.length;
    const endIndex: number = template.indexOf(macroEnd, keyStart);
    if (endIndex < 0) {
      index = startIndex;
      break;
    }

    const key: string = template.substring(keyStart, endIndex);
    const replacement: string | undefined = substitutions.get(key);
    result += replacement === undefined ? macroStart + key + macroEnd : replacement;
    index = endIndex + macroEnd.length;
  }

  result += template.substring(index);
  return result;
}

// MARK: - ArticleRenderingSpecialCases.swift

const redirectScriptRegex: RegExp = /<script[^>]*>[^<]*location\.href\s*=(?!=)[^<]*<\/script>/gi;

export function removeLocationHrefRedirectScripts(html: string): string {
  if (html.indexOf('location.href') < 0) {
    return html;
  }
  return html.replace(redirectScriptRegex, '');
}

/**
 * Some feeds embed a whole HTML document as item content; rendered inside the article
 * template its <html>/<body> attributes clobber the theme. Render only the body fragment.
 */
export function extractBodyFragmentIfNeeded(html: string): string {
  const lower: string = html.toLowerCase();
  if (lower.indexOf('<body') < 0 && lower.indexOf('<html') < 0
    && lower.indexOf('<!doctype') < 0) {
    return html;
  }

  const bodyOpen: number = lower.indexOf('<body');
  if (bodyOpen >= 0) {
    const tagClose: number = html.indexOf('>', bodyOpen);
    if (tagClose >= 0) {
      const contentStart: number = tagClose + 1;
      const bodyClose: number = lower.indexOf('</body', contentStart);
      return html.substring(contentStart, bodyClose < 0 ? html.length : bodyClose);
    }
  }

  return removingDocumentWrapper(html);
}

/** A document with <html>/<head> but no <body>: remove the wrapper markup, keep the rest. */
function removingDocumentWrapper(html: string): string {
  let s: string = html.replace(/<!doctype[^>]*>/i, '');
  // `<head` must not match `<header`, so the tag name is bounded.
  s = s.replace(/<head(\s[^>]*)?>[\s\S]*?<\/head\s*>/i, '');
  s = s.replace(/<html(\s[^>]*)?>/i, '');
  s = s.replace(/<\/html\s*>/i, '');
  return s;
}

export function isVergeSpecialCase(baseURL: string): boolean {
  const host: string | undefined = hostOf(baseURL);
  return host !== undefined && host.toLowerCase().indexOf('theverge.com') >= 0;
}

/** The Verge double-encodes its punctuation; the source repairs it by substitution. */
function filterVergeHTML(html: string): string {
  let s: string = html;
  // Right curly single quote
  s = s.replace(/â€™/g, '’');
  s = s.replace(/&acirc;&#128;&#153;/g, '’');
  // Left curly double quote
  s = s.replace(/â€œ/g, '“');
  s = s.replace(/â&#128;&#156;/g, '“');
  s = s.replace(/&acirc;&#128;&#156;/g, '“');
  // Right curly double quote
  s = s.replace(/â€/g, '”');
  s = s.replace(/â&#128;&#157;/g, '”');
  s = s.replace(/&acirc;&#128;&#157;/g, '”');
  // Em dash
  s = s.replace(/â€”/g, '—');
  s = s.replace(/&acirc;&#128;&#148;/g, '—');

  s = s.replace(/Â/g, '');
  s = s.replace(/&Acirc;&nbsp;/g, '');

  s = s.replace(/ &amp;hellip;/g, '…');
  s = s.replace(/&amp;hellip;/g, '…');
  return s;
}

export function filterHTMLIfNeeded(baseURL: string, html: string): string {
  let filtered: string = removeLocationHrefRedirectScripts(html);
  if (isVergeSpecialCase(baseURL)) {
    filtered = filterVergeHTML(filtered);
  }
  return filtered;
}

// MARK: - Content blocking (WKContentRuleList substitution)

let contentBlockPatterns: RegExp[] | undefined = undefined;

function loadContentBlockPatterns(): RegExp[] {
  const patterns: RegExp[] = [];
  const text: string | undefined = rawfileText(articleRawfileDir + '/ContentRules.json');
  if (text === undefined) {
    return patterns;
  }
  const parsed: Object | undefined = parseJson(text);
  const rules: Object[] | undefined = asArray(parsed);
  if (rules === undefined) {
    hilog.error(DOMAIN, TAG, 'could not parse ContentRules.json');
    return patterns;
  }
  for (const entry of rules) {
    const rule: JsonObject | undefined = asObject(entry);
    if (rule === undefined) {
      continue;
    }
    const action: JsonObject | undefined = getObject(rule, 'action');
    const trigger: JsonObject | undefined = getObject(rule, 'trigger');
    if (action === undefined || trigger === undefined) {
      continue;
    }
    // Only "block" rules matter here; the source's other actions are cosmetic.
    if (getString(action, 'type') !== 'block') {
      continue;
    }
    const urlFilter: string | undefined = getString(trigger, 'url-filter');
    if (urlFilter === undefined || urlFilter.length === 0) {
      continue;
    }
    try {
      patterns.push(new RegExp(urlFilter, 'i'));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'skipping unsupported content rule filter');
    }
  }
  return patterns;
}

/** True when the article web view must refuse this subresource request. */
export function shouldBlockURL(urlString: string): boolean {
  if (contentBlockPatterns === undefined) {
    contentBlockPatterns = loadContentBlockPatterns();
  }
  for (const pattern of contentBlockPatterns) {
    if (pattern.test(urlString)) {
      return true;
    }
  }
  return false;
}

// MARK: - Date formatting (the source's nine DateFormatters)

function formatted(date: Date, dateStyle?: string, timeStyle?: string): string {
  const options: intl.DateTimeOptions = { dateStyle: dateStyle, timeStyle: timeStyle };
  // An empty locale list resolves to the system locale, which is what DateFormatter used.
  return new intl.DateTimeFormat([], options).format(date);
}

// MARK: - ArticleRenderer

class ArticleRendererState {
  article?: Article;
  extractedArticle?: ExtractedArticle;
  theme: ArticleTheme;
  title: string = '';
  body: string = '';
  baseURL?: string;

  constructor(article: Article | undefined, extractedArticle: ExtractedArticle | undefined,
    theme: ArticleTheme) {
    this.article = article;
    this.extractedArticle = extractedArticle;
    this.theme = theme;

    const sanitized: string | undefined =
      sanitizedTitle(article === undefined ? undefined : article.title, true);
    this.title = sanitized === undefined ? '' : sanitized;

    const extractedContent: string | undefined =
      extractedArticle === undefined ? undefined : extractedArticle.content;
    if (extractedContent !== undefined) {
      this.body = extractBodyFragmentIfNeeded(extractedContent);
      this.baseURL = extractedArticle === undefined ? undefined : extractedArticle.url;
    } else {
      const rawBody: string | undefined =
        article === undefined ? undefined : articleBody(article);
      this.body = extractBodyFragmentIfNeeded(rawBody === undefined ? '' : rawBody);
      this.baseURL = article === undefined ? undefined : articleBaseURL(article);
    }
  }
}

/**
 * The source's stylesheet selects its platform rules with `@supports (-webkit-touch-callout:
 * none)` — a feature query that is true ONLY in WKWebView, which is how it tells iOS from
 * macOS. ArkWeb is Chromium and answers false, so the article view silently took the macOS
 * branch: the iOS `body .header a` accent colour was dropped (the feed-name link rendered
 * grey instead of blue), the `font-size: [[font-size]]px` Dynamic Type substitution never
 * applied (the title/body rendered at the macOS scale), and the iOS body padding was lost.
 *
 * This is an iOS port, so pin the iOS branch on and the macOS branch off. `(display: block)`
 * is always supported and `not (display: block)` never is, so the two `@supports` conditions
 * become the constants the platform check was standing in for.
 */
function platformSelectedCSS(css: string): string {
  return css
    .split('@supports not (-webkit-touch-callout: none)')
    .join('@supports not (display: block)')
    .split('@supports (-webkit-touch-callout: none)')
    .join('@supports (display: block)');
}

function styleString(theme: ArticleTheme): string {
  const css: string | undefined = theme.css;
  return css === undefined ? '' : platformSelectedCSS(css);
}

function templateString(theme: ArticleTheme): string {
  const template: string | undefined = theme.template;
  if (template !== undefined) {
    return template;
  }
  const fallback: string | undefined = rawfileText(articleRawfileDir + '/template.html');
  return fallback === undefined ? '' : fallback;
}

/** iOS body text style at the default Dynamic Type size — the theme CSS's rem base. */
const defaultBodyFontSizePoints: number = 17;
let bodyFontSizePoints: number = defaultBodyFontSizePoints;

/**
 * The source substitutes `UIFont.preferredFont(forTextStyle: .body).pointSize`, i.e. the
 * body size scaled by Dynamic Type. The system font scale lives on the UIAbility's
 * Configuration, which a .ts service cannot reach, so the article page pushes it here on
 * launch and whenever the configuration changes:
 *   setArticleBodyFontSize(17 * (config.fontSizeScale ?? 1))
 */
export function setArticleBodyFontSize(points: number): void {
  bodyFontSizePoints = points > 0 ? Math.round(points) : defaultBodyFontSizePoints;
}

function styleSubstitutions(): Map<string, string> {
  const d: Map<string, string> = new Map<string, string>();
  d.set('font-size', bodyFontSizePoints.toString());
  return d;
}

function byline(state: ArticleRendererState): string {
  const article: Article | undefined = state.article;
  if (article === undefined) {
    return '';
  }
  const feed: Feed | undefined = articleFeed(article);
  let authors: Author[] | undefined = article.authors;
  if (authors === undefined || authors.length === 0) {
    authors = feed === undefined ? undefined : feed.authors;
  }
  if (authors === undefined || authors.length === 0) {
    return '';
  }

  // A lone author whose name matches the feed adds nothing.
  if (authors.length === 1 && feed !== undefined && authors[0].name === feed.nameForDisplay) {
    return '';
  }

  let out: string = '';
  let isFirstAuthor: boolean = true;
  for (const author of authors) {
    if (!isFirstAuthor) {
      out += ', ';
    }
    isFirstAuthor = false;

    let emailAddress: string | undefined = author.emailAddress;
    if (emailAddress !== undefined
      && (emailAddress.indexOf('noreply@') >= 0 || emailAddress.indexOf('no-reply@') >= 0)) {
      emailAddress = undefined;
    }
    const name: string | undefined = author.name;
    const authorURL: string | undefined = author.url;

    if (emailAddress !== undefined && emailAddress.indexOf(' ') >= 0) {
      out += emailAddress; // probably name plus email address
    } else if (name !== undefined && authorURL !== undefined) {
      out += '<a href="' + authorURL + '">' + name + '</a>';
    } else if (name !== undefined && emailAddress !== undefined) {
      out += name + ' &lt;' + emailAddress + '&gt;';
    } else if (name !== undefined) {
      out += name;
    } else if (emailAddress !== undefined) {
      out += '&lt;' + emailAddress + '&gt;';
    } else if (authorURL !== undefined) {
      out += '<a href="' + authorURL + '">' + authorURL + '</a>';
    }
  }
  return out;
}

function articleSubstitutions(state: ArticleRendererState): Map<string, string> {
  const d: Map<string, string> = new Map<string, string>();
  const article: Article | undefined = state.article;
  if (article === undefined) {
    return d;
  }

  d.set('title', state.title);
  const link: string | undefined = preferredLink(article);
  d.set('preferred_link', link === undefined ? '' : link);

  const externalLink: string | undefined = articleExternalLink(article);
  if (externalLink !== undefined && externalLink !== link) {
    d.set('external_link_label', 'Link:');
    d.set('external_link_stripped', externalLink.replace(/^https?:\/\//i, ''));
    d.set('external_link', externalLink);
  } else {
    d.set('external_link_label', '');
    d.set('external_link_stripped', '');
    d.set('external_link', '');
  }

  d.set('body', state.body);
  d.set('text_size_class', '');
  d.set('avatar_src', imageIconScheme + ':' + article.articleID);
  d.set('dateline_style', state.title.length === 0 ? 'articleDatelineTitle' : 'articleDateline');

  const feed: Feed | undefined = articleFeed(article);
  d.set('feed_link_title', feed === undefined ? '' : feed.nameForDisplay);
  const homePageURL: string | undefined = feed === undefined ? undefined : feed.homePageURL;
  d.set('feed_link', homePageURL === undefined ? '' : homePageURL);

  d.set('byline', byline(state));

  const datePublished: Date = logicalDatePublished(article);
  d.set('datetime_long', formatted(datePublished, 'long', 'medium'));
  d.set('datetime_medium', formatted(datePublished, 'medium', 'short'));
  d.set('datetime_short', formatted(datePublished, 'short', 'short'));
  d.set('date_long', formatted(datePublished, 'long', undefined));
  d.set('date_medium', formatted(datePublished, 'medium', undefined));
  d.set('date_short', formatted(datePublished, 'short', undefined));
  d.set('time_long', formatted(datePublished, undefined, 'long'));
  d.set('time_medium', formatted(datePublished, undefined, 'medium'));
  d.set('time_short', formatted(datePublished, undefined, 'short'));

  return d;
}

function articleCSS(state: ArticleRendererState): string {
  return renderedText(styleString(state.theme), styleSubstitutions());
}

function systemMessageRendering(theme: ArticleTheme, body: string): Rendering {
  const state: ArticleRendererState = new ArticleRendererState(undefined, undefined, theme);
  return new Rendering(articleCSS(state), body, '', '');
}

export class ArticleRenderer {
  static articleHTML(article: Article, theme: ArticleTheme,
    extractedArticle?: ExtractedArticle): Rendering {
    const state: ArticleRendererState =
      new ArticleRendererState(article, extractedArticle, theme);
    const html: string =
      renderedText(templateString(theme), articleSubstitutions(state));
    return new Rendering(articleCSS(state), html, state.title,
      state.baseURL === undefined ? '' : state.baseURL);
  }

  static multipleSelectionHTML(theme: ArticleTheme): Rendering {
    return systemMessageRendering(theme, '<h3 class=\'systemMessage\'>Multiple selection</h3>');
  }

  static loadingHTML(theme: ArticleTheme): Rendering {
    return systemMessageRendering(theme, '<h3 class=\'systemMessage\'>Loading...</h3>');
  }

  static noSelectionHTML(theme: ArticleTheme): Rendering {
    return systemMessageRendering(theme, '<h3 class=\'systemMessage\'>No selection</h3>');
  }

  static noContentHTML(theme: ArticleTheme): Rendering {
    return systemMessageRendering(theme, '');
  }

  /**
   * The complete document handed to the Web component — page.html with the rendering
   * plugged in, the article scripts inlined, and the special-case filters applied.
   *
   * `getFeedInfoLabel` replaces the source's feedInfoLabelScript (a localized string
   * cannot live in a static .js file).
   */
  static pageHTML(rendering: Rendering, windowScrollY: number,
    getFeedInfoLabel: string = 'Get Feed Info'): string {
    const page: string | undefined = rawfileText(articleRawfileDir + '/page.html');
    if (page === undefined) {
      return '<html><body>' + rendering.html + '</body></html>';
    }

    const substitutions: Map<string, string> = new Map<string, string>();
    substitutions.set('title', rendering.title);
    substitutions.set('baseURL', rendering.baseURL);
    substitutions.set('style', rendering.style);
    substitutions.set('body', rendering.html);
    substitutions.set('windowScrollY', windowScrollY.toString());

    let html: string = renderedText(page, substitutions);
    html = ArticleRenderer.injectScripts(html, getFeedInfoLabel);
    return filterHTMLIfNeeded(rendering.baseURL, html);
  }

  /** Inlines the scripts WKUserScript injected at document start, in the same order. */
  private static injectScripts(html: string, getFeedInfoLabel: string): string {
    if (!AppDefaults.isArticleContentJavascriptEnabled) {
      return html;
    }

    let scripts: string = '<script type="text/javascript">const nnwGetFeedInfoLabel = '
      + JSON.stringify(getFeedInfoLabel) + ';</script>';
    const filenames: string[] = ['main.js', 'main_ios.js', 'newsfoot.js'];
    for (const filename of filenames) {
      const source: string | undefined = rawfileText(articleRawfileDir + '/' + filename);
      if (source !== undefined) {
        scripts += '\n<script type="text/javascript">\n' + source + '\n</script>';
      }
    }

    const headClose: number = html.toLowerCase().indexOf('</head>');
    if (headClose < 0) {
      return scripts + html;
    }
    return html.substring(0, headClose) + scripts + html.substring(headClose);
  }
}
