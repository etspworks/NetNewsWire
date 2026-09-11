/**
 * UndoableCommandRunner — port of Modules/RSCore/Sources/RSCore/UndoableCommand.swift,
 * Shared/Commands/MarkStatusCommand.swift, Shared/Commands/DeleteCommand.swift and
 * Shared/Commands/MarkCommandValidationStatus.swift.
 *
 * HarmonyOS has no UndoManager and no shake-to-undo, so the runner IS the undo manager:
 * it keeps the undo and redo stacks the source got from UIKit.
 *
 * NO SCREEN EXPOSES UNDO, AND THAT MATCHES THE SOURCE. On iOS the app defines no undo
 * affordance of its own: no button, no menu entry, no key command. DeleteCommand.perform()
 * calls registerUndo() (UndoableCommand.swift:22), MainFeedCollectionViewController sets
 * canBecomeFirstResponder = true (:51) and becomeFirstResponder() (:82), and UIKit's
 * shake-to-undo then finds rootSplitViewController.undoManager up the responder chain
 * (SceneCoordinator.swift:56). The affordance is the SYSTEM's, not the app's. ArkUI has no
 * responder-chain undo manager and no shake-to-undo, so there is nothing to port; adding a
 * toolbar item or an "Undo" snackbar would be a feature the source does not have on iPhone.
 * Kept because runCommand/perform is the real delete path and the stacks are its bookkeeping.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { ArticleStatusKey } from '../../model/ArticleStatus';
import { Feed } from '../../model/Feed';
import { Folder } from '../../model/Folder';
import { Node } from '../../model/Node';
import { AccountService, ContainerRef } from '../account/Account';
import { AccountManager } from '../account/AccountManager';
import {
  articleIDsByAccountID, isAvailableToMarkUnread, markArticleIDs
} from '../article/ArticleText';
import { localized } from '../system/Localized';

const DOMAIN: number = 0x0001;
const TAG: string = 'UndoableCommandRunner';

export interface UndoableCommand {
  readonly undoActionName: string;
  readonly redoActionName: string;
  perform(): Promise<void>;
  undo(): Promise<void>;
}

export type UndoStackListener = () => void;

/**
 * The command stack. `runCommand` performs and pushes; `undo` pops to the redo stack;
 * `clearUndoableCommands` is what the timeline calls when its article set changes, so a
 * "Redo Mark Read" is never ambiguous about which articles it means.
 */
export class UndoableCommandRunner {
  static readonly shared: UndoableCommandRunner = new UndoableCommandRunner();

  private undoStack: UndoableCommand[] = [];
  private redoStack: UndoableCommand[] = [];
  private listeners: UndoStackListener[] = [];

  addListener(listener: UndoStackListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: UndoStackListener): void {
    this.listeners = this.listeners.filter((l: UndoStackListener) => l !== listener);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoActionName(): string | undefined {
    return this.canUndo ? this.undoStack[this.undoStack.length - 1].undoActionName : undefined;
  }

  get redoActionName(): string | undefined {
    return this.canRedo ? this.redoStack[this.redoStack.length - 1].redoActionName : undefined;
  }

  async runCommand(command: UndoableCommand): Promise<void> {
    this.undoStack.push(command);
    this.redoStack = [];
    this.postChange();
    await command.perform();
  }

  pushUndoableCommand(command: UndoableCommand): void {
    this.undoStack.push(command);
    this.postChange();
  }

  async undo(): Promise<void> {
    const command: UndoableCommand | undefined = this.undoStack.pop();
    if (command === undefined) {
      return;
    }
    this.redoStack.push(command);
    this.postChange();
    await command.undo();
  }

  async redo(): Promise<void> {
    const command: UndoableCommand | undefined = this.redoStack.pop();
    if (command === undefined) {
      return;
    }
    this.undoStack.push(command);
    this.postChange();
    await command.perform();
  }

  /** Called when the timeline reloads and the article set changes. */
  clearUndoableCommands(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.postChange();
  }

  private postChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// MARK: - MarkCommandValidationStatus.swift

export enum MarkCommandValidationStatus {
  canMark = 'canMark',
  canUnmark = 'canUnmark',
  canDoNothing = 'canDoNothing'
}

export function markCommandValidationStatus(articles: Article[],
  canMarkTest: (articles: Article[]) => boolean): MarkCommandValidationStatus {
  if (articles.length === 0) {
    return MarkCommandValidationStatus.canDoNothing;
  }
  return canMarkTest(articles)
    ? MarkCommandValidationStatus.canMark : MarkCommandValidationStatus.canUnmark;
}

// MARK: - MarkStatusCommand.swift

/** Articles that already have the wanted status, or cannot be marked, are dropped. */
function filteredArticles(articles: Article[], statusKey: ArticleStatusKey,
  flag: boolean): Article[] {
  const out: Article[] = [];
  for (const article of articles) {
    if (article.status.boolStatus(statusKey) === flag) {
      continue;
    }
    if (statusKey !== ArticleStatusKey.read) {
      out.push(article);
      continue;
    }
    if (article.status.read && !isAvailableToMarkUnread(article)) {
      continue;
    }
    out.push(article);
  }
  return out;
}

function markActionName(statusKey: ArticleStatusKey, flag: boolean): string {
  if (statusKey === ArticleStatusKey.read) {
    return flag ? localized('mark_read', 'Mark Read') : localized('mark_unread', 'Mark Unread');
  }
  return flag
    ? localized('mark_starred', 'Mark Starred') : localized('mark_unstarred', 'Mark Unstarred');
}

export class MarkStatusCommand implements UndoableCommand {
  readonly undoActionName: string;
  readonly redoActionName: string;
  private readonly byAccountID: Map<string, string[]>;
  private readonly statusKey: ArticleStatusKey;
  private readonly flag: boolean;
  private completion?: () => void;

  private constructor(byAccountID: Map<string, string[]>, statusKey: ArticleStatusKey,
    flag: boolean, actionName: string, completion?: () => void) {
    this.byAccountID = byAccountID;
    this.statusKey = statusKey;
    this.flag = flag;
    this.undoActionName = actionName;
    this.redoActionName = actionName;
    this.completion = completion;
  }

  /** Returns undefined (and runs `completion`) when nothing is left to mark. */
  static create(initialArticles: Article[], statusKey: ArticleStatusKey, flag: boolean,
    completion?: () => void): MarkStatusCommand | undefined {
    const articlesToMark: Article[] = filteredArticles(initialArticles, statusKey, flag);
    if (articlesToMark.length === 0) {
      if (completion !== undefined) {
        completion();
      }
      return undefined;
    }
    return new MarkStatusCommand(articleIDsByAccountID(articlesToMark), statusKey, flag,
      markActionName(statusKey, flag), completion);
  }

  async perform(): Promise<void> {
    await this.mark(this.statusKey, this.flag);
  }

  async undo(): Promise<void> {
    await this.mark(this.statusKey, !this.flag);
  }

  private async mark(statusKey: ArticleStatusKey, flag: boolean): Promise<void> {
    await markArticleIDs(this.byAccountID, statusKey, flag);
    const completion: (() => void) | undefined = this.completion;
    this.completion = undefined;
    if (completion !== undefined) {
      completion();
    }
  }
}

// MARK: - DeleteCommand.swift

/**
 * Remembers where a feed or folder was, so undo can restore it to the same container.
 * The source's ContainerPath is (accountID, folder names) resolved at restore time.
 */
class SidebarItemSpecifier {
  private readonly account: AccountService;
  private readonly parentFolder?: Folder;
  private readonly folder?: Folder;
  private readonly feed?: Feed;
  private readonly folderPath: string[];

  private constructor(account: AccountService, folderPath: string[], parentFolder?: Folder,
    folder?: Folder, feed?: Feed) {
    this.account = account;
    this.folderPath = folderPath;
    this.parentFolder = parentFolder;
    this.folder = folder;
    this.feed = feed;
  }

  static create(node: Node): SidebarItemSpecifier | undefined {
    const obj: Object = node.representedObject;
    let account: AccountService | undefined = undefined;
    let feed: Feed | undefined = undefined;
    let folder: Folder | undefined = undefined;

    if (obj instanceof Feed) {
      feed = obj;
      account = AccountManager.shared.existingAccount(obj.accountID);
    } else if (obj instanceof Folder) {
      folder = obj;
      account = AccountManager.shared.existingAccount(obj.accountID);
    } else {
      return undefined;
    }
    if (account === undefined) {
      return undefined;
    }

    return new SidebarItemSpecifier(account, containingFolderNames(node),
      parentFolderOf(node), folder, feed);
  }

  private resolveContainer(): ContainerRef | undefined {
    if (this.folderPath.length === 0) {
      return this.account.containerRef;
    }
    const folder: Folder | undefined =
      this.account.existingFolderWithName(this.folderPath[this.folderPath.length - 1]);
    return folder === undefined
      ? this.account.containerRef : ContainerRef.forFolder(this.account, folder);
  }

  async delete(): Promise<void> {
    const feed: Feed | undefined = this.feed;
    if (feed !== undefined) {
      const container: ContainerRef | undefined = this.resolveContainer();
      if (container === undefined) {
        return;
      }
      await this.account.removeFeed(feed, container);
      return;
    }
    const folder: Folder | undefined = this.folder;
    if (folder !== undefined) {
      await this.account.removeFolder(folder);
    }
  }

  async restore(): Promise<void> {
    const feed: Feed | undefined = this.feed;
    if (feed !== undefined) {
      const container: ContainerRef | undefined = this.resolveContainer();
      if (container === undefined) {
        return;
      }
      await this.account.restoreFeed(feed, container);
      return;
    }
    const folder: Folder | undefined = this.folder;
    if (folder !== undefined) {
      await this.account.restoreFolder(folder);
    }
  }
}

function parentFolderOf(node: Node): Folder | undefined {
  const parent: Node | undefined = node.parent;
  if (parent === undefined || parent.isRoot) {
    return undefined;
  }
  return parent.representedObject instanceof Folder ? parent.representedObject : undefined;
}

function containingFolderNames(node: Node): string[] {
  const names: string[] = [];
  let nomad: Node | undefined = node.parent;
  while (nomad !== undefined) {
    const obj: Object = nomad.representedObject;
    if (obj instanceof Folder) {
      names.push(obj.name === undefined ? obj.nameForDisplay : obj.name);
    } else {
      break;
    }
    nomad = nomad.parent;
  }
  return names.reverse();
}

function deleteActionName(nodes: Node[]): string | undefined {
  let numberOfFeeds: number = 0;
  let numberOfFolders: number = 0;
  for (const node of nodes) {
    if (node.representedObject instanceof Feed) {
      numberOfFeeds += 1;
    } else if (node.representedObject instanceof Folder) {
      numberOfFolders += 1;
    } else {
      return undefined; // Delete only feeds and folders.
    }
  }
  if (numberOfFolders < 1) {
    return numberOfFeeds === 1
      ? localized('delete_feed', 'Delete Feed') : localized('delete_feeds', 'Delete Feeds');
  }
  if (numberOfFeeds < 1) {
    return numberOfFolders === 1
      ? localized('delete_folder', 'Delete Folder')
      : localized('delete_folders', 'Delete Folders');
  }
  return localized('delete_feeds_and_folders', 'Delete Feeds and Folders');
}

export type DeleteErrorHandler = (error: Error) => void;

export class DeleteCommand implements UndoableCommand {
  readonly undoActionName: string;
  get redoActionName(): string {
    return this.undoActionName;
  }

  private readonly itemSpecifiers: SidebarItemSpecifier[];
  private readonly errorHandler: DeleteErrorHandler;
  private readonly didChange: () => void;

  private constructor(itemSpecifiers: SidebarItemSpecifier[], actionName: string,
    errorHandler: DeleteErrorHandler, didChange: () => void) {
    this.itemSpecifiers = itemSpecifiers;
    this.undoActionName = actionName;
    this.errorHandler = errorHandler;
    this.didChange = didChange;
  }

  static canDelete(nodes: Node[]): boolean {
    if (nodes.length === 0) {
      return false;
    }
    for (const node of nodes) {
      if (!(node.representedObject instanceof Feed)
        && !(node.representedObject instanceof Folder)) {
        return false;
      }
    }
    return true;
  }

  static create(nodesToDelete: Node[], errorHandler: DeleteErrorHandler,
    didChange: () => void): DeleteCommand | undefined {
    if (!DeleteCommand.canDelete(nodesToDelete)) {
      return undefined;
    }
    const actionName: string | undefined = deleteActionName(nodesToDelete);
    if (actionName === undefined) {
      return undefined;
    }

    const itemSpecifiers: SidebarItemSpecifier[] = [];
    for (const node of nodesToDelete) {
      const specifier: SidebarItemSpecifier | undefined = SidebarItemSpecifier.create(node);
      if (specifier !== undefined) {
        itemSpecifiers.push(specifier);
      }
    }
    if (itemSpecifiers.length === 0) {
      return undefined;
    }
    return new DeleteCommand(itemSpecifiers, actionName, errorHandler, didChange);
  }

  async perform(): Promise<void> {
    for (const specifier of this.itemSpecifiers) {
      try {
        await specifier.delete();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'delete failed: %{public}s', (e as Error).message);
        this.errorHandler(e as Error);
      }
    }
    this.didChange();
  }

  async undo(): Promise<void> {
    for (const specifier of this.itemSpecifiers) {
      try {
        await specifier.restore();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'restore failed: %{public}s', (e as Error).message);
        this.errorHandler(e as Error);
      }
    }
    this.didChange();
  }
}
