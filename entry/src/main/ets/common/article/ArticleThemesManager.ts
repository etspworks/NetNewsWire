/**
 * ArticleThemesManager — port of Shared/ArticleStyles/ArticleThemesManager.swift plus
 * ArticleThemeDownloader.swift.
 *
 * Two theme sources, exactly as the source has: the app's own bundled `.nnwtheme`
 * bundles (Bundle.main -> rawfile `themes/<Name>.nnwtheme/`) and the user's installed
 * themes (Application Support/Themes -> the sandbox `Themes` folder). A theme is a
 * folder holding Info.plist + stylesheet.css + template.html.
 *
 * Two bundled theme directories were renamed with underscores so the rawfile path is
 * safe (`Tiqoe_Dark.nnwtheme`, `Verdana_Revival.nnwtheme`); their user-facing name is
 * the Info.plist `Name` key, which is what themeNames and currentThemeName carry.
 *
 * NSFilePresenter has no HarmonyOS counterpart, so the installed-theme folder is
 * re-scanned on demand (start / import / delete / download) rather than watched.
 */

import fs from '@ohos.file.fs';
import util from '@ohos.util';
import zlib from '@ohos.zlib';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ArticleTheme, defaultArticleThemeInfo } from '../../model/ArticleTheme';
import { ArticleThemePlist, ArticleThemePlistKeys } from '../../model/ArticleThemePlist';
import { AppDefaults } from '../prefs/AppDefaults';
import { AppContext } from '../util/AppContext';
import { Downloader, UserAgentStyle, responseIsOK } from '../net/DownloadSession';
import { DownloadResponse } from '../../model/DownloadResponse';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleThemesManager';

const bundledThemesRawfileDir: string = 'themes';
const articleRawfileDir: string = 'article';
const installedThemesFolderName: string = 'Themes';
const themeImportFolderName: string = 'ThemeImport';

export type ArticleThemesChangeListener = () => void;

/** Where a theme's three files live — rawfile (bundled) or the sandbox (installed). */
export class ArticleThemeRef {
  readonly displayName: string;
  /** rawfile dir (`themes/X.nnwtheme`) or absolute sandbox path. */
  readonly path: string;
  readonly isAppTheme: boolean;
  readonly info: ArticleThemePlist;

  constructor(displayName: string, path: string, isAppTheme: boolean, info: ArticleThemePlist) {
    this.displayName = displayName;
    this.path = path;
    this.isAppTheme = isAppTheme;
    this.info = info;
  }
}

/**
 * A picked or downloaded theme, unpacked into the cache and checked, not yet installed.
 * The source's ArticleThemeImporter builds `ArticleTheme(url:isAppTheme:)` BEFORE it puts
 * its alert up, so a malformed theme fails before the user is asked anything and before
 * anything lands in Themes/.
 */
export class StagedTheme {
  /** The `.nnwtheme` folder, still in the cache. */
  readonly folderPath: string;
  readonly info: ArticleThemePlist;

  constructor(folderPath: string, info: ArticleThemePlist) {
    this.folderPath = folderPath;
    this.info = info;
  }
}

/**
 * Reads the handful of keys the app needs out of an Info.plist. A full plist parser is
 * not needed: the theme plists are flat `<key>/<string>|<integer>` pairs.
 * ponytail: flat-plist scan; swap for a real plist reader if themes ever nest.
 */
export function parseThemePlist(xml: string): ArticleThemePlist | undefined {
  const values: Map<string, string> = new Map<string, string>();
  const re: RegExp = /<key>\s*([^<]+?)\s*<\/key>\s*<(string|integer|real)>\s*([\s\S]*?)\s*<\/\2>/g;
  let match: RegExpExecArray | null = re.exec(xml);
  while (match !== null) {
    values.set(match[1], match[3]);
    match = re.exec(xml);
  }

  const name: string | undefined = values.get(ArticleThemePlistKeys.name);
  const themeIdentifier: string | undefined = values.get(ArticleThemePlistKeys.themeIdentifier);
  if (name === undefined || themeIdentifier === undefined) {
    return undefined;
  }
  const creatorHomePage: string | undefined = values.get(ArticleThemePlistKeys.creatorHomePage);
  const creatorName: string | undefined = values.get(ArticleThemePlistKeys.creatorName);
  const versionString: string | undefined = values.get(ArticleThemePlistKeys.version);
  const version: number = versionString === undefined ? 1 : Number.parseInt(versionString, 10);
  const plist: ArticleThemePlist = {
    name: name,
    themeIdentifier: themeIdentifier,
    creatorHomePage: creatorHomePage === undefined ? '' : creatorHomePage,
    creatorName: creatorName === undefined ? '' : creatorName,
    version: Number.isNaN(version) ? 1 : version
  };
  return plist;
}

function decodeUTF8(bytes: Uint8Array): string {
  const options: util.TextDecoderOptions = { ignoreBOM: true };
  return util.TextDecoder.create('utf-8', options).decodeToString(bytes);
}

export function rawfileText(path: string): string | undefined {
  try {
    return decodeUTF8(AppContext.get().resourceManager.getRawFileContentSync(path));
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'rawfile missing: %{public}s', path);
    return undefined;
  }
}

function fileText(path: string): string | undefined {
  let file: fs.File | undefined = undefined;
  try {
    if (!fs.accessSync(path)) {
      return undefined;
    }
    file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const stat: fs.Stat = fs.statSync(file.fd);
    const bytes: ArrayBuffer = new ArrayBuffer(stat.size);
    fs.readSync(file.fd, bytes);
    return decodeUTF8(new Uint8Array(bytes));
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'could not read %{public}s', path);
    return undefined;
  } finally {
    if (file !== undefined) {
      fs.closeSync(file);
    }
  }
}

export class ArticleThemesManager {
  static readonly shared: ArticleThemesManager = new ArticleThemesManager();

  private didStart: boolean = false;
  private refs: ArticleThemeRef[] = [];
  private theme: ArticleTheme = new ArticleTheme(undefined, undefined, undefined, true,
    defaultArticleThemeInfo);
  private nameListeners: ArticleThemesChangeListener[] = [];
  private currentThemeListeners: ArticleThemesChangeListener[] = [];

  /** Application Support/Themes — created on demand, exactly as the source's init does. */
  get folderPath(): string {
    return AppContext.dataSubfolder(installedThemesFolderName);
  }

  start(): void {
    if (this.didStart) {
      return;
    }
    this.didStart = true;
    this.updateThemeNames();
    this.updateCurrentTheme();
  }

  addThemeNamesListener(listener: ArticleThemesChangeListener): void {
    this.nameListeners.push(listener);
  }

  removeThemeNamesListener(listener: ArticleThemesChangeListener): void {
    this.nameListeners =
      this.nameListeners.filter((l: ArticleThemesChangeListener) => l !== listener);
  }

  addCurrentThemeListener(listener: ArticleThemesChangeListener): void {
    this.currentThemeListeners.push(listener);
  }

  removeCurrentThemeListener(listener: ArticleThemesChangeListener): void {
    this.currentThemeListeners =
      this.currentThemeListeners.filter((l: ArticleThemesChangeListener) => l !== listener);
  }

  get currentThemeName(): string {
    const name: string | undefined = AppDefaults.currentThemeName;
    return name === undefined ? AppDefaults.defaultThemeName : name;
  }

  set currentThemeName(value: string) {
    if (value === this.currentThemeName) {
      return;
    }
    AppDefaults.currentThemeName = value;
    this.updateThemeNames();
    this.updateCurrentTheme();
  }

  get currentTheme(): ArticleTheme {
    return this.theme;
  }

  get themeNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs) {
      names.push(ref.displayName);
    }
    return names;
  }

  themeRefs(): ArticleThemeRef[] {
    return this.refs.slice();
  }

  /**
   * The theme an import would collide with — the source's `themeExists(filename:)` widened
   * to the display name. The source only compares the on-disk filename, but the theme rows
   * are keyed by name in ArkUI's ForEach, so two refs sharing one display name lose a row
   * instead of showing a duplicate.
   */
  existingThemeFor(sourcePath: string, themeName: string): ArticleThemeRef | undefined {
    const filename: string = lastPathComponent(sourcePath);
    for (const ref of this.refs) {
      if (ref.displayName === themeName) {
        return ref;
      }
      if (!ref.isAppTheme && lastPathComponent(ref.path) === filename) {
        return ref;
      }
    }
    return undefined;
  }

  /**
   * Unpacks what the picker handed back into the cache and reads its theme, throwing if it
   * is not one.
   *
   * The source picks the `.nnwtheme` PACKAGE straight out of UIDocumentPickerViewController.
   * A HarmonyOS phone's system picker cannot return a folder — it answers a folder select
   * with "This feature isn't supported yet." — so there are three ways in, in the order a
   * user actually meets them:
   *
   * 1. the `.zip` netnewswire.com distributes, unzipped here, the same step downloadTheme does;
   * 2. the package itself, which a 2-in-1's picker can still hand back, exactly as iOS's does;
   * 3. the three files INSIDE an unpacked `X.nnwtheme` folder, selected together. A phone
   *    picker will walk into that folder and grants a URI per file, never for the folder, so
   *    the bundle is reassembled from the files rather than read through its parent (which
   *    the picker never granted and the sandbox refuses).
   */
  async stageTheme(uris: string[]): Promise<StagedTheme> {
    const staging: string = AppContext.cacheSubfolder(themeImportFolderName);
    safeRemove(staging);
    AppContext.ensureFolder(staging);

    if (uris.length === 0) {
      throw new Error('There is no NetNewsWire theme available.');
    }
    const uri: string = uris[0];
    if (uris.length > 1 || !(uri.endsWith('.zip') || uri.endsWith(ArticleTheme.nnwThemeSuffix))) {
      return stagedThemeFromFiles(uris, staging);
    }
    if (uri.endsWith(ArticleTheme.nnwThemeSuffix)) {
      return stagedThemeAt(uri);
    }

    const zipPath: string = staging + '/import.zip';
    let picked: fs.File | undefined = undefined;
    try {
      picked = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      fs.copyFileSync(picked.fd, zipPath);
    } catch (e) {
      throw new Error('The NetNewsWire theme could not be read.');
    } finally {
      if (picked !== undefined) {
        fs.closeSync(picked);
      }
    }

    const unzipFolder: string = AppContext.ensureFolder(staging + '/unzipped');
    try {
      await zlib.decompressFile(zipPath, unzipFolder);
    } catch (e) {
      throw new Error('The NetNewsWire theme could not be unarchived.');
    }
    const themeFolder: string | undefined = findThemeFolder(unzipFolder);
    if (themeFolder === undefined) {
      throw new Error('There is no NetNewsWire theme available.');
    }
    return stagedThemeAt(themeFolder);
  }

  /**
   * Copies a staged theme into the installed-themes folder. The source replaces the
   * same-named FILE; any installed theme carrying the same display name goes too, so the
   * list can never end up with two rows under one name.
   */
  importTheme(staged: StagedTheme): void {
    for (const ref of this.refs) {
      if (!ref.isAppTheme && ref.displayName === staged.info.name) {
        safeRemove(ref.path);
      }
    }
    const destination: string = this.folderPath + '/' + lastPathComponent(staged.folderPath);
    safeRemove(destination);
    copyFolder(staged.folderPath, destination);
    this.updateThemeNames();
    this.updateCurrentTheme();
  }

  deleteTheme(themeName: string): void {
    const ref: ArticleThemeRef | undefined = this.refFor(themeName);
    if (ref === undefined || ref.isAppTheme) {
      return;
    }
    try {
      fs.rmdirSync(ref.path);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'could not delete theme %{public}s', themeName);
    }
    this.updateThemeNames();
    this.updateCurrentTheme();
  }

  articleThemeWithThemeName(themeName: string): ArticleTheme | undefined {
    if (themeName === AppDefaults.defaultThemeName) {
      return ArticleThemesManager.defaultTheme();
    }
    const ref: ArticleThemeRef | undefined = this.refFor(themeName);
    if (ref === undefined) {
      return undefined;
    }
    const template: string | undefined = ref.isAppTheme
      ? rawfileText(ref.path + '/template.html') : fileText(ref.path + '/template.html');
    const stylesheet: string | undefined = ref.isAppTheme
      ? rawfileText(ref.path + '/stylesheet.css') : fileText(ref.path + '/stylesheet.css');
    if (template === undefined || stylesheet === undefined) {
      return undefined;
    }
    // A theme's stylesheet is appended to the app's core.css, exactly as ArticleTheme does.
    const core: string = ArticleThemesManager.coreCSS();
    return new ArticleTheme(ref.path, template, core + '\n' + stylesheet, ref.isAppTheme, ref.info);
  }

  /**
   * Downloads a theme archive, unzips it and installs the `.nnwtheme` folder inside.
   * Returns the installed theme's display name.
   */
  async downloadTheme(urlString: string): Promise<string> {
    const response: DownloadResponse =
      await Downloader.shared.download(urlString, UserAgentStyle.browser);
    const data: ArrayBuffer | undefined = response.data;
    if (data === undefined || data.byteLength === 0 || !responseIsOK(response)) {
      throw new Error('The NetNewsWire theme could not be downloaded.');
    }

    const downloadsFolder: string = AppContext.cacheSubfolder('Downloads');
    const stamp: string = Date.now().toString();
    const zipPath: string = downloadsFolder + '/' + stamp + '.zip';
    const unzipFolder: string = downloadsFolder + '/' + stamp;

    let zipFile: fs.File | undefined = undefined;
    try {
      zipFile = fs.openSync(zipPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE);
      fs.writeSync(zipFile.fd, data);
    } finally {
      if (zipFile !== undefined) {
        fs.closeSync(zipFile);
      }
    }

    try {
      AppContext.ensureFolder(unzipFolder);
      await zlib.decompressFile(zipPath, unzipFolder);
      const themeFolder: string | undefined = findThemeFolder(unzipFolder);
      if (themeFolder === undefined) {
        throw new Error('There is no NetNewsWire theme available.');
      }
      const staged: StagedTheme = stagedThemeAt(themeFolder);
      this.importTheme(staged);
      return staged.info.name;
    } finally {
      safeRemove(zipPath);
      safeRemove(unzipFolder);
    }
  }

  /** Application Support/Downloads clean-up — the source's ArticleThemeDownloader.cleanUp(). */
  cleanUpDownloads(): void {
    const downloadsFolder: string = AppContext.cacheSubfolder('Downloads');
    try {
      for (const name of fs.listFileSync(downloadsFolder)) {
        safeRemove(downloadsFolder + '/' + name);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'could not clean up theme downloads');
    }
  }

  // MARK: - Private

  private refFor(themeName: string): ArticleThemeRef | undefined {
    for (const ref of this.refs) {
      if (ref.displayName === themeName) {
        return ref;
      }
    }
    // The source resolves an INSTALLED theme by its FOLDER name
    // (ArticleThemesManager.swift:223 pathForThemeName -> pathIsPathForThemeName), while this
    // port keys the rows on the Info.plist `Name`. The two are not the same string for every
    // theme — a three-file import lands the bundle as `Imported.nnwtheme` when the picker's
    // parent folder is not one — and a stored name that resolves to nothing is rewritten to
    // Default by updateCurrentTheme. Fall back to the source's own rule.
    for (const ref of this.refs) {
      if (!ref.isAppTheme && ArticleTheme.pathIsPathForThemeName(themeName, ref.path)) {
        return ref;
      }
    }
    return undefined;
  }

  private updateThemeNames(): void {
    const refs: ArticleThemeRef[] = [];

    // Bundled themes.
    try {
      for (const entry of
        AppContext.get().resourceManager.getRawFileListSync(bundledThemesRawfileDir)) {
        if (!entry.endsWith(ArticleTheme.nnwThemeSuffix)) {
          continue;
        }
        const path: string = bundledThemesRawfileDir + '/' + entry;
        const info: ArticleThemePlist | undefined = readThemeInfo(path, true);
        if (info !== undefined) {
          refs.push(new ArticleThemeRef(info.name, path, true, info));
        }
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'could not list bundled themes');
    }

    // Installed themes.
    const folder: string = this.folderPath;
    try {
      for (const entry of fs.listFileSync(folder)) {
        if (!entry.endsWith(ArticleTheme.nnwThemeSuffix)) {
          continue;
        }
        const path: string = folder + '/' + entry;
        const info: ArticleThemePlist | undefined = readThemeInfo(path, false);
        // A row the user can SEE has to be a row the user can SELECT. Admitting an installed
        // folder on its Info.plist alone let a half-copied theme (Info.plist landed,
        // stylesheet.css/template.html did not) show up as a row that
        // articleThemeWithThemeName cannot load — and selecting it then reset the stored
        // theme to Default. Same three files the importer checks, checked again on the scan.
        if (info !== undefined && fs.accessSync(path + '/stylesheet.css')
          && fs.accessSync(path + '/template.html')) {
          refs.push(new ArticleThemeRef(info.name, path, false, info));
        }
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'could not list installed themes');
    }

    refs.sort((a: ArticleThemeRef, b: ArticleThemeRef): number => {
      const lhs: string = a.displayName.toLowerCase();
      const rhs: string = b.displayName.toLowerCase();
      return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
    });

    // The Default theme leads the list, it does not sort into it: the source's
    // ArticleThemesManager.updateThemeNames sorts ONLY the bundled + installed names, and
    // ArticleThemesTableViewController renders `themeNames.count + 1` rows with
    // `ArticleTheme.defaultTheme.name` pinned at row 0. Sorting it in put Default 3rd.
    refs.unshift(new ArticleThemeRef(AppDefaults.defaultThemeName, '', true,
      defaultArticleThemeInfo));

    if (!sameNames(refs, this.refs)) {
      this.refs = refs;
      for (const listener of this.nameListeners) {
        listener();
      }
    }
  }

  private updateCurrentTheme(): void {
    let themeName: string = this.currentThemeName;
    // refFor, not themeNames.indexOf: the display name is one of TWO names an installed
    // theme answers to (see refFor), and a name-only match dropped the other one on the
    // floor — as a reset to Default, taking whatever the user had chosen before with it.
    const ref: ArticleThemeRef | undefined = this.refFor(themeName);
    if (ref === undefined) {
      themeName = AppDefaults.defaultThemeName;
      AppDefaults.currentThemeName = themeName;
    } else if (ref.displayName !== themeName) {
      // Resolved through the folder name: store the name the ROWS carry, so the checkmark
      // (themeName === currentThemeName) lands on the row the user tapped.
      themeName = ref.displayName;
      AppDefaults.currentThemeName = themeName;
    }

    let articleTheme: ArticleTheme | undefined = this.articleThemeWithThemeName(themeName);
    if (articleTheme === undefined) {
      // The theme is installed — it resolved just above — but its files would not read. The
      // source clears the stored name here; on this port that also DESTROYS the user's
      // choice (selecting an unreadable theme reset a previously chosen one to Default), so
      // the name is kept and the default CSS is rendered until the read succeeds.
      hilog.error(DOMAIN, TAG, 'the theme %{public}s could not be loaded', themeName);
      articleTheme = ArticleThemesManager.defaultTheme();
    }

    if (articleTheme.name !== this.theme.name || articleTheme.css !== this.theme.css) {
      this.theme = articleTheme;
      for (const listener of this.currentThemeListeners) {
        listener();
      }
    }
  }

  /** The app's own theme: core.css + stylesheet.css + template.html from rawfile. */
  static defaultTheme(): ArticleTheme {
    const template: string | undefined = rawfileText(articleRawfileDir + '/template.html');
    const stylesheet: string | undefined = rawfileText(articleRawfileDir + '/stylesheet.css');
    const css: string = ArticleThemesManager.coreCSS() + '\n'
      + (stylesheet === undefined ? '' : stylesheet) + '\n';
    return new ArticleTheme(undefined, template, css, true, defaultArticleThemeInfo);
  }

  static coreCSS(): string {
    const core: string | undefined = rawfileText(articleRawfileDir + '/core.css');
    return core === undefined ? '' : core;
  }
}

// MARK: - File helpers

function lastPathComponent(path: string): string {
  const parts: string[] = path.split('/');
  return parts[parts.length - 1];
}

function secondToLastPathComponent(path: string): string {
  const parts: string[] = path.split('/');
  return parts.length < 2 ? '' : parts[parts.length - 2];
}

function sameNames(a: ArticleThemeRef[], b: ArticleThemeRef[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i: number = 0; i < a.length; i++) {
    if (a[i].displayName !== b[i].displayName) {
      return false;
    }
  }
  return true;
}

/**
 * The source's `ArticleTheme(url:isAppTheme:)` init: a folder is a theme only if it carries
 * a readable Info.plist plus the two files the renderer needs. Throws the way that init does,
 * so a corrupt or truncated archive is reported instead of half-installed.
 */
function stagedThemeAt(themeFolder: string): StagedTheme {
  const info: ArticleThemePlist | undefined = readThemeInfo(themeFolder, false);
  if (info === undefined || !fs.accessSync(themeFolder + '/stylesheet.css')
    || !fs.accessSync(themeFolder + '/template.html')) {
    throw new Error('The NetNewsWire theme is missing or damaged.');
  }
  return new StagedTheme(themeFolder, info);
}

/**
 * Rebuilds a theme folder out of the loose files a phone picker returns when the user opens
 * an unpacked `X.nnwtheme` folder and selects what is inside it. The folder name is taken
 * from the files' own parent so an install keeps the name it was distributed under.
 *
 * The error names the three files rather than saying "damaged": a user who picked one file,
 * or the wrong file, has to be told what the theme actually is, and the alternative.
 */
function stagedThemeFromFiles(uris: string[], staging: string): StagedTheme {
  const parent: string = secondToLastPathComponent(uris[0]);
  const folderName: string = parent.endsWith(ArticleTheme.nnwThemeSuffix)
    ? parent : 'Imported' + ArticleTheme.nnwThemeSuffix;
  const themeFolder: string = AppContext.ensureFolder(staging + '/' + folderName);
  for (const uri of uris) {
    let picked: fs.File | undefined = undefined;
    try {
      picked = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      fs.copyFileSync(picked.fd, themeFolder + '/' + lastPathComponent(uri));
    } catch (e) {
      throw new Error('The NetNewsWire theme could not be read.');
    } finally {
      if (picked !== undefined) {
        fs.closeSync(picked);
      }
    }
  }
  const info: ArticleThemePlist | undefined = readThemeInfo(themeFolder, false);
  if (info === undefined || !fs.accessSync(themeFolder + '/stylesheet.css')
    || !fs.accessSync(themeFolder + '/template.html')) {
    throw new Error('Select the theme .zip, or open the .nnwtheme folder and select all three '
      + 'files inside it: Info.plist, stylesheet.css and template.html.');
  }
  return new StagedTheme(themeFolder, info);
}

function readThemeInfo(path: string, isAppTheme: boolean): ArticleThemePlist | undefined {
  const xml: string | undefined = isAppTheme
    ? rawfileText(path + '/Info.plist') : fileText(path + '/Info.plist');
  if (xml === undefined) {
    return undefined;
  }
  return parseThemePlist(xml);
}

/** Deep search for the enclosed `.nnwtheme` folder, skipping the zip's __MACOSX entries. */
function findThemeFolder(searchPath: string): string | undefined {
  let names: string[] = [];
  try {
    names = fs.listFileSync(searchPath);
  } catch (e) {
    return undefined;
  }
  for (const name of names) {
    if (name === '__MACOSX') {
      continue;
    }
    const path: string = searchPath + '/' + name;
    if (name.endsWith(ArticleTheme.nnwThemeSuffix)) {
      return path;
    }
    if (fs.statSync(path).isDirectory()) {
      const found: string | undefined = findThemeFolder(path);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function copyFolder(source: string, destination: string): void {
  AppContext.ensureFolder(destination);
  for (const name of fs.listFileSync(source)) {
    const from: string = source + '/' + name;
    const to: string = destination + '/' + name;
    if (fs.statSync(from).isDirectory()) {
      copyFolder(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function safeRemove(path: string): void {
  try {
    if (!fs.accessSync(path)) {
      return;
    }
    if (fs.statSync(path).isDirectory()) {
      fs.rmdirSync(path);
    } else {
      fs.unlinkSync(path);
    }
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'could not remove %{public}s', path);
  }
}
