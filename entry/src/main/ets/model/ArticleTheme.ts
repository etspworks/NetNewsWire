/**
 * ArticleTheme — port of Shared/ArticleStyles/ArticleTheme.swift
 *
 * The CSS + HTML template used to render an article. The default theme is the app's own
 * bundled core.css + stylesheet.css + template.html; a user theme is a .nnwtheme folder
 * whose stylesheet is appended to core.css. Loading the files is the theme service's job;
 * this is the loaded theme plus the name/creator/version rules the settings screens show.
 */

import { ArticleThemePlist } from './ArticleThemePlist';

const defaultThemeName: string = 'Default';
const unknownValue: string = 'Unknown';

export class ArticleTheme {
  static readonly nnwThemeSuffix: string = '.nnwtheme';

  /** Undefined for the built-in theme. */
  readonly url?: string;
  readonly template?: string;
  readonly css?: string;
  readonly isAppTheme: boolean;
  readonly info?: ArticleThemePlist;

  constructor(url?: string, template?: string, css?: string, isAppTheme: boolean = false,
    info?: ArticleThemePlist) {
    this.url = url;
    this.template = template;
    this.css = css;
    this.isAppTheme = isAppTheme;
    this.info = info;
  }

  get name(): string {
    const url: string | undefined = this.url;
    return url === undefined ? defaultThemeName : ArticleTheme.themeNameForPath(url);
  }

  get creatorHomePage(): string {
    const info: ArticleThemePlist | undefined = this.info;
    return info === undefined ? unknownValue : info.creatorHomePage;
  }

  get creatorName(): string {
    const info: ArticleThemePlist | undefined = this.info;
    return info === undefined ? unknownValue : info.creatorName;
  }

  get version(): string {
    const info: ArticleThemePlist | undefined = this.info;
    const version: number = info === undefined ? 0 : info.version;
    return version.toString();
  }

  static filenameWithThemeSuffixRemoved(filename: string): string {
    if (filename.endsWith(ArticleTheme.nnwThemeSuffix)) {
      return filename.substring(0, filename.length - ArticleTheme.nnwThemeSuffix.length);
    }
    return filename;
  }

  static themeNameForPath(path: string): string {
    const components: string[] = path.split('/');
    const filename: string = components[components.length - 1];
    return ArticleTheme.filenameWithThemeSuffixRemoved(filename);
  }

  static pathIsPathForThemeName(themeName: string, path: string): boolean {
    return ArticleTheme.themeNameForPath(path) === themeName;
  }
}

/** The plist the app's own built-in theme reports. */
export const defaultArticleThemeInfo: ArticleThemePlist = {
  name: 'Article Theme',
  themeIdentifier: 'com.ranchero.netnewswire.theme.article',
  creatorHomePage: 'https://netnewswire.com/',
  creatorName: 'Ranchero Software',
  version: 1
};
