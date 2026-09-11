/**
 * BinaryDiskCache — port of Modules/RSCore/Sources/RSCore/BinaryDiskCache.swift
 *
 * Flat folder of key-named files holding raw bytes. Backs the image and favicon caches.
 * Errors are swallowed exactly as the Swift subscript does — a cache miss and a read
 * failure are the same thing to the caller. Every open file descriptor is closed in a
 * `finally`.
 */

import fs from '@ohos.file.fs';
import { AppContext } from './AppContext';

export class BinaryDiskCache {
  readonly folder: string;

  constructor(folder: string) {
    this.folder = AppContext.ensureFolder(folder);
  }

  private filePath(key: string): string {
    return this.folder + '/' + key;
  }

  has(key: string): boolean {
    try {
      return fs.accessSync(this.filePath(key));
    } catch (e) {
      return false;
    }
  }

  /** Returns undefined for a missing or unreadable file. */
  data(key: string): ArrayBuffer | undefined {
    const path: string = this.filePath(key);
    let file: fs.File | undefined = undefined;
    try {
      if (!fs.accessSync(path)) {
        return undefined;
      }
      const size: number = fs.statSync(path).size;
      if (size <= 0) {
        return undefined;
      }
      file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      const bytesRead: number = fs.readSync(file.fd, buffer);
      return bytesRead === size ? buffer : buffer.slice(0, bytesRead);
    } catch (e) {
      return undefined;
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  setData(key: string, data: ArrayBuffer): void {
    const path: string = this.filePath(key);
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, data);
    } catch (e) {
      // Cache writes are best-effort, as in the source.
    } finally {
      if (file !== undefined) {
        fs.closeSync(file);
      }
    }
  }

  deleteData(key: string): void {
    try {
      const path: string = this.filePath(key);
      if (fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      // Ignored.
    }
  }

  /** Deletes every cached file. Used by the "empty caches" action. */
  removeAll(): void {
    try {
      const names: string[] = fs.listFileSync(this.folder);
      for (const name of names) {
        this.deleteData(name);
      }
    } catch (e) {
      // Ignored.
    }
  }
}
