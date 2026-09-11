/**
 * ArticleThemePlist — port of Shared/ArticleStyles/ArticleThemePlist.swift
 *
 * The Info.plist inside a .nnwtheme bundle. The plist keys are capitalized (Name,
 * ThemeIdentifier, ...) — those are the on-disk names a theme file actually carries.
 */

export interface ArticleThemePlist {
  name: string;
  themeIdentifier: string;
  creatorHomePage: string;
  creatorName: string;
  version: number;
}

interface ArticleThemePlistKeysShape {
  name: string;
  themeIdentifier: string;
  creatorHomePage: string;
  creatorName: string;
  version: string;
}

export const ArticleThemePlistKeys: ArticleThemePlistKeysShape = {
  name: 'Name',
  themeIdentifier: 'ThemeIdentifier',
  creatorHomePage: 'CreatorHomePage',
  creatorName: 'CreatorName',
  version: 'Version',
};
