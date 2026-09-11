/**
 * AppContext — the sandbox folders every service needs.
 *
 * Port of the AppConfig helpers in RSCore (AppConfig.dataFolder /
 * AppConfig.cacheSubfolder(named:)). On HarmonyOS the sandbox roots come from the
 * ability Context, which a .ts service cannot fetch on its own, so the UIAbility
 * hands it over once at startup.
 */

import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';

export class AppContext {
  private static context?: common.Context;

  /** Called once from EntryAbility.onCreate. */
  static setContext(context: common.Context): void {
    AppContext.context = context;
  }

  static isReady(): boolean {
    return AppContext.context !== undefined;
  }

  static get(): common.Context {
    const context: common.Context | undefined = AppContext.context;
    if (context === undefined) {
      throw new Error('AppContext.setContext has not been called yet');
    }
    return context;
  }

  /** Durable app data — databases, OPML files, themes. */
  static dataFolder(): string {
    return AppContext.get().filesDir;
  }

  /** Evictable cache — downloaded images and favicons. */
  static cacheFolder(): string {
    return AppContext.get().cacheDir;
  }

  /** Creates the folder if needed and returns its path. */
  static ensureFolder(path: string): string {
    if (!fs.accessSync(path)) {
      fs.mkdirSync(path, true);
    }
    return path;
  }

  static dataSubfolder(name: string): string {
    return AppContext.ensureFolder(AppContext.dataFolder() + '/' + name);
  }

  static cacheSubfolder(name: string): string {
    return AppContext.ensureFolder(AppContext.cacheFolder() + '/' + name);
  }

  /** Path of a database file inside the data folder. */
  static dataFilePath(filename: string): string {
    return AppContext.dataFolder() + '/' + filename;
  }
}
