/**
 * ArticleViewControllerPage (source: iOS/Article/ArticleViewController.swift).
 *
 * The article reader AND the carrier of the migrated WebViewController: the body is
 * the article web view component (ArticleWebView), the reader-view button is
 * the article extractor button component, the find bar is the article search bar component, the long-press
 * preview card is the context menu preview component, and the tapped-image viewer
 * (the image viewer screen) is mounted here as a full-screen overlay.
 *
 * Everything rendered comes from data: the body is HTML built by ArticleRenderer from
 * the migrated Article and ArticleThemesManager' current theme; the read/star icons reflect
 * and write ArticlesDatabase through SceneCoordinator (which runs the marks through the
 * undo stack); prev/next/next-unread move through the coordinator's timeline article set.
 */

import { router } from '@kit.ArkUI';
import { KeyCode } from '@kit.InputKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import common from '@ohos.app.ability.common';
import intl from '@ohos.intl';
import { Article } from '../model/Article';
import { ArticleTheme } from '../model/ArticleTheme';
import { Author } from '../model/Author';
import { ExtractedArticle } from '../model/ExtractedArticle';
import { Feed } from '../model/Feed';
import { IconImage } from '../model/IconImage';
import { SceneCoordinator, CoordinatorChangeListener } from '../common/SceneCoordinator';
import {
  ArticleRenderer,
  Rendering,
  setArticleBodyFontSize
} from '../common/article/ArticleRenderer';
import {
  ArticleExtractor,
  ArticleExtractorDelegate,
  ArticleExtractorState
} from '../common/article/ArticleExtractor';
import { ArticleThemesManager, ArticleThemesChangeListener } from '../common/article/ArticleThemesManager';
import {
  articleFeed,
  isAvailableToMarkUnread,
  logicalDatePublished,
  preferredLink
} from '../common/article/ArticleText';
import { IconImageCache, ImageAvailableListener, ImageDownloader } from '../common/images/IconImageCache';
import { AppDefaults } from '../common/prefs/AppDefaults';
import { ShareService } from '../common/system/ShareService';
import { BrowserService } from '../common/system/BrowserService';
import {
  ArticleExtractorButton,
  ArticleExtractorButtonState
} from '../components/ArticleExtractorButton';
import { ArticleSearchBar } from '../components/ArticleSearchBar';
import {
  ArticleWebView,
  ArticleWebViewBridge,
  FindInArticleState,
  ImageClickMessage
} from '../components/ArticleWebView';
import { ContextMenuPreviewViewController } from '../components/ContextMenuPreview';
import { RootSplitViewController, SplitColumn } from '../components/RootSplitHost';
import { ImageViewController, clickedImageTitleKey, clickedImageURLKey } from './ImageViewControllerPage';

const DOMAIN: number = 0x0001;
const TAG: string = 'ArticleViewControllerPage';

/** The route params showFeedInspector(for:) carries — `resolveFeed()` reads `feedID` first. */
interface FeedInspectorRouteParams {
  feedID: string;
}

/** iOS body text style at the default Dynamic Type size — ArticleRenderer's rem base. */
const bodyTextStyleSize: number = 17;

/**
 * ArticleExtractorDelegate cannot be implemented by a struct, so the page owns this small
 * adapter — the same two callbacks WebViewController implements.
 */
class PageExtractorDelegate implements ArticleExtractorDelegate {
  onFail?: (error: Error) => void;
  onComplete?: (extractedArticle: ExtractedArticle) => void;

  articleExtractionDidFail(error: Error): void {
    const handler: ((error: Error) => void) | undefined = this.onFail;
    if (handler !== undefined) {
      handler(error);
    }
  }

  articleExtractionDidComplete(extractedArticle: ExtractedArticle): void {
    const handler: ((extractedArticle: ExtractedArticle) => void) | undefined = this.onComplete;
    if (handler !== undefined) {
      handler(extractedArticle);
    }
  }
}

@Entry
@Component
struct ArticleViewControllerPage {
  /**
   * The selected article, resolved through SceneCoordinator. AppStorage carries the
   * selected articleID (SceneCoordinator.publish -> SelectionKeys.selectedArticleID), so the
   * timeline's selection drives this page exactly as coordinator.selectArticle does.
   */
  @StorageLink('nnwSelectedArticleID') currentArticle: string = '';
  /** The complete document from ArticleRenderer (article / reader / loading / none). */
  @State articleHTML: string = '';
  /** ArticleExtractor.state, as the button renders it. */
  @State extractorState: ArticleExtractorButtonState = ArticleExtractorButtonState.off;
  /** article.status.read — read from and written back to ArticlesDatabase. */
  @State isRead: boolean = false;
  /** article.status.starred. */
  @State isStarred: boolean = false;
  /** The decoded FindInArticleState behind the "n of m" counter. */
  @State findState: FindInArticleState = new FindInArticleState(0, 0);
  /** AppDefaults.logicalArticleFullscreenEnabled. */
  @State barsHidden: boolean = false;

  @State private articleBaseURL: string = '';
  @State private avatarURL: string = '';
  @State private findVisible: boolean = false;
  @State private findText: string = '';
  @State private selectedResult: number = 1;
  @State private imageViewerShown: boolean = false;
  @State private isPrevAvailable: boolean = false;
  @State private isNextAvailable: boolean = false;
  @State private isNextUnreadAvailable: boolean = false;
  @State private canToggleRead: boolean = false;
  @State private hasPermalink: boolean = false;

  private webViewBridge: ArticleWebViewBridge = new ArticleWebViewBridge();
  private extractor?: ArticleExtractor;
  private extractedArticle?: ExtractedArticle;
  private isShowingExtractedArticle: boolean = false;
  private extractorDelegate: PageExtractorDelegate = new PageExtractorDelegate();

  /** The article the page last rendered — the source's `article` didSet guard. */
  private renderedArticleID: string = '';

  private coordinatorListener: CoordinatorChangeListener = () => {
    // SceneCoordinator.publish() fires this on every selection change, which is where the
    // source's `article didSet` runs.
    const article: Article | undefined = SceneCoordinator.shared.currentArticle;
    const articleID: string = article === undefined ? '' : article.articleID;
    if (articleID !== this.renderedArticleID) {
      this.renderedArticleID = articleID;
      this.onSelectedArticleChanged();
      return;
    }
    this.updateUI();
  };
  private themeListener: ArticleThemesChangeListener = () => {
    this.renderPage();
  };
  private imageListener: ImageAvailableListener = (url: string) => {
    // The feed icon usually is NOT cached when the article first renders, so avatarURL is
    // empty then — gating on `url === this.avatarURL` could never match and the header kept
    // the placeholder for the whole session. Re-resolve against IconImageCache instead: this
    // is the source's `feedIconDidBecomeAvailable -> reloadArticleImage` path.
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return;
    }
    const resolved: string = this.resolveAvatarURL(article);
    if (resolved.length === 0 || resolved === this.avatarURL) {
      return;
    }
    this.avatarURL = resolved;
    const reload: ((imageSrc: string) => void) | undefined =
      this.webViewBridge.reloadArticleImage;
    if (reload !== undefined) {
      reload(resolved);
    }
  };

  aboutToAppear(): void {
    this.extractorDelegate.onFail = (error: Error): void => {
      this.articleExtractionDidFail(error);
    };
    this.extractorDelegate.onComplete = (extractedArticle: ExtractedArticle): void => {
      this.articleExtractionDidComplete(extractedArticle);
    };

    ArticleThemesManager.shared.start();
    ArticleThemesManager.shared.addCurrentThemeListener(this.themeListener);
    SceneCoordinator.shared.addListener(this.coordinatorListener);
    ImageDownloader.shared.addListener(this.imageListener);

    this.applyDynamicTypeSize();
    this.barsHidden = AppDefaults.articleFullscreenEnabled;
    const article: Article | undefined = SceneCoordinator.shared.currentArticle;
    this.renderedArticleID = article === undefined ? '' : article.articleID;
    this.startArticleExtractorIfAlwaysOn();
    this.updateUI();
    this.renderPage();
  }

  aboutToDisappear(): void {
    ArticleThemesManager.shared.removeCurrentThemeListener(this.themeListener);
    SceneCoordinator.shared.removeListener(this.coordinatorListener);
    ImageDownloader.shared.removeListener(this.imageListener);
    this.stopArticleExtractor();
  }

  onPageShow(): void {
    // viewWillAppear: the source hides or shows the bars from the stored preference.
    this.barsHidden = AppDefaults.articleFullscreenEnabled;
    this.updateUI();
  }

  onPageHide(): void {
    if (this.findVisible) {
      this.endFind();
    }
  }

  /**
   * The source substitutes UIFont.preferredFont(forTextStyle: .body).pointSize into the
   * theme CSS. The system font scale lives on the UIAbility's Configuration, which the
   * renderer (a .ts service) cannot reach, so the page pushes it down.
   */
  private applyDynamicTypeSize(): void {
    try {
      const context: common.UIAbilityContext =
        this.getUIContext().getHostContext() as common.UIAbilityContext;
      const scale: number | undefined = context.config.fontSizeScale;
      setArticleBodyFontSize(bodyTextStyleSize * (scale === undefined ? 1 : scale));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'the Dynamic Type scale is not available yet');
    }
  }

  private article(): Article | undefined {
    const selected: Article | undefined = SceneCoordinator.shared.currentArticle;
    if (selected !== undefined) {
      return selected;
    }
    if (this.currentArticle.length === 0) {
      return undefined;
    }
    return SceneCoordinator.shared.articleFor(this.currentArticle);
  }

  /** article didSet: drop the extractor, re-render, refresh the toolbar. */
  private onSelectedArticleChanged(): void {
    this.stopArticleExtractor();
    this.extractedArticle = undefined;
    this.isShowingExtractedArticle = false;
    this.extractorState = ArticleExtractorButtonState.off;
    this.startArticleExtractorIfAlwaysOn();
    this.updateUI();
    this.renderPage();
  }

  /**
   * setArticle(_:updateView:): the source opens the article in Reader View up front when
   * its feed has readerViewAlwaysEnabled, without the user tapping the extractor button
   * (WebViewController.swift:162). Both entry points need it — aboutToAppear renders the
   * pushed selection directly and never runs onSelectedArticleChanged.
   */
  private startArticleExtractorIfAlwaysOn(): void {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return;
    }
    const feed: Feed | undefined = articleFeed(article);
    if (feed === undefined || !feed.readerViewAlwaysEnabled) {
      return;
    }
    this.startArticleExtractor();
  }

  /** The source's updateUI(): every toolbar item is disabled with no article. */
  private updateUI(): void {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      this.isRead = false;
      this.isStarred = false;
      this.canToggleRead = false;
      this.hasPermalink = false;
      this.isPrevAvailable = false;
      this.isNextAvailable = false;
      this.isNextUnreadAvailable = false;
      this.avatarURL = '';
      return;
    }
    this.isRead = article.status.read;
    this.isStarred = article.status.starred;
    // Read stays enabled while unread; once read it needs isAvailableToMarkUnread.
    this.canToggleRead = !article.status.read || isAvailableToMarkUnread(article);
    this.hasPermalink = preferredLink(article) !== undefined;
    this.isPrevAvailable = SceneCoordinator.shared.isPrevArticleAvailable;
    this.isNextAvailable = SceneCoordinator.shared.isNextArticleAvailable;
    this.isNextUnreadAvailable = SceneCoordinator.shared.isNextUnreadAvailable;
    this.avatarURL = this.resolveAvatarURL(article);
  }

  /** The `nnwImageIcon:` avatar the template asks for, resolved through IconImageCache. */
  private resolveAvatarURL(article: Article): string {
    const feed: Feed | undefined = articleFeed(article);
    if (feed === undefined) {
      return '';
    }
    const icon: IconImage | undefined = IconImageCache.shared.imageForFeed(feed);
    if (icon === undefined || icon.sourceURL === undefined) {
      return '';
    }
    return icon.sourceURL;
  }

  // MARK: - Rendering (the source's WebViewController.renderPage)

  private renderPage(): void {
    const theme: ArticleTheme = ArticleThemesManager.shared.currentTheme;
    const article: Article | undefined = this.article();
    const extractor: ArticleExtractor | undefined = this.extractor;
    const extracted: ExtractedArticle | undefined = this.extractedArticle;

    let rendering: Rendering;
    if (extractor !== undefined && extractor.state === ArticleExtractorState.processing) {
      rendering = ArticleRenderer.loadingHTML(theme);
    } else if (extractor !== undefined && extractor.state === ArticleExtractorState.failedToParse
      && article !== undefined) {
      rendering = ArticleRenderer.articleHTML(article, theme);
    } else if (article !== undefined && extracted !== undefined) {
      rendering = this.isShowingExtractedArticle
        ? ArticleRenderer.articleHTML(article, theme, extracted)
        : ArticleRenderer.articleHTML(article, theme);
    } else if (article !== undefined) {
      rendering = ArticleRenderer.articleHTML(article, theme);
    } else {
      rendering = ArticleRenderer.noSelectionHTML(theme);
    }

    this.articleBaseURL = rendering.baseURL;
    this.articleHTML = ArticleRenderer.pageHTML(rendering, AppDefaults.articleWindowScrollY,
      'Get Feed Info');
  }

  // MARK: - Reader View (the source's toggleArticleExtractor)

  private toggleArticleExtractor(): void {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return;
    }
    const extractor: ArticleExtractor | undefined = this.extractor;
    if (extractor !== undefined && extractor.state === ArticleExtractorState.processing) {
      this.stopArticleExtractor();
      this.renderPage();
      return;
    }
    if (this.isShowingExtractedArticle) {
      this.isShowingExtractedArticle = false;
      AppDefaults.isShowingExtractedArticle = false;
      this.renderPage();
      this.extractorState = ArticleExtractorButtonState.off;
      return;
    }
    if (extractor !== undefined) {
      if (preferredLink(article) === extractor.articleLink) {
        this.isShowingExtractedArticle = true;
        AppDefaults.isShowingExtractedArticle = true;
        this.renderPage();
        this.extractorState = ArticleExtractorButtonState.on;
      }
      return;
    }
    this.startArticleExtractor();
  }

  private startArticleExtractor(): void {
    if (this.extractor !== undefined) {
      return;
    }
    const article: Article | undefined = this.article();
    const link: string | undefined = article === undefined ? undefined : preferredLink(article);
    if (link === undefined) {
      return;
    }
    const extractor: ArticleExtractor | undefined =
      ArticleExtractor.create(link, this.extractorDelegate);
    if (extractor === undefined) {
      // Reader View is not configured (no Mercury credentials) — surface the error state
      // rather than leaving the button doing nothing.
      this.extractorState = ArticleExtractorButtonState.error;
      return;
    }
    this.extractor = extractor;
    this.extractorState = ArticleExtractorButtonState.animated;
    this.renderPage();
    extractor.process()
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'Reader View failed: %{public}s', err.message);
      });
  }

  private stopArticleExtractor(): void {
    const extractor: ArticleExtractor | undefined = this.extractor;
    if (extractor !== undefined) {
      extractor.cancel();
    }
    this.extractor = undefined;
    this.isShowingExtractedArticle = false;
    this.extractorState = ArticleExtractorButtonState.off;
  }

  /** The extractor never leaves a blank page: it re-renders the ORIGINAL article body. */
  private articleExtractionDidFail(error: Error): void {
    hilog.warn(DOMAIN, TAG, 'article extraction failed: %{public}s', error.message);
    this.stopArticleExtractor();
    this.extractorState = ArticleExtractorButtonState.error;
    this.renderPage();
  }

  private articleExtractionDidComplete(extractedArticle: ExtractedArticle): void {
    this.extractedArticle = extractedArticle;
    this.isShowingExtractedArticle = true;
    AppDefaults.isShowingExtractedArticle = true;
    this.renderPage();
    this.extractorState = ArticleExtractorButtonState.on;
  }

  // MARK: - Toolbar actions

  private toggleRead(): void {
    SceneCoordinator.shared.toggleReadForCurrentArticle()
      .then(() => {
        this.updateUI();
      })
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'toggle read failed: %{public}s', err.message);
      });
  }

  private toggleStar(): void {
    SceneCoordinator.shared.toggleStarredForCurrentArticle()
      .then(() => {
        this.updateUI();
      })
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'toggle starred failed: %{public}s', err.message);
      });
  }

  private nextUnread(): void {
    SceneCoordinator.shared.selectNextUnread()
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'next unread failed: %{public}s', err.message);
      });
  }

  private nextArticle(): void {
    SceneCoordinator.shared.selectNextArticle()
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'next article failed: %{public}s', err.message);
      });
  }

  private prevArticle(): void {
    SceneCoordinator.shared.selectPrevArticle()
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'previous article failed: %{public}s', err.message);
      });
  }

  /** showActivityDialog: the system share panel carrying the article URL. */
  private showActivityDialog(): void {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return;
    }
    const context: common.UIAbilityContext =
      this.getUIContext().getHostContext() as common.UIAbilityContext;
    ShareService.shared.shareArticle(context, article)
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'the article could not be shared: %{public}s', err.message);
      });
  }

  /** The OpenInBrowserActivity the share sheet carries. */
  private openInAppBrowser(): void {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return;
    }
    const context: common.UIAbilityContext =
      this.getUIContext().getHostContext() as common.UIAbilityContext;
    BrowserService.shared.openArticle(context, article)
      .catch((err: Error) => {
        hilog.warn(DOMAIN, TAG, 'the article could not be opened: %{public}s', err.message);
      });
  }

  // MARK: - Full screen

  private hideBars(): void {
    if (!AppDefaults.articleFullscreenAvailable) {
      return;
    }
    AppDefaults.articleFullscreenEnabled = true;
    this.barsHidden = true;
  }

  private showBars(): void {
    AppDefaults.articleFullscreenEnabled = false;
    this.barsHidden = false;
  }

  // MARK: - Find in article

  private beginFind(): void {
    this.findVisible = true;
  }

  private endFind(): void {
    this.findVisible = false;
    this.findText = '';
    this.findState = new FindInArticleState(0, 0);
    this.selectedResult = 1;
    const end: (() => void) | undefined = this.webViewBridge.endFind;
    if (end !== undefined) {
      end();
    }
  }

  private searchTextChanged(text: string): void {
    const update: ((text: string) => void) | undefined = this.webViewBridge.updateFind;
    if (update !== undefined) {
      update(text);
    }
  }

  private findStateChanged(state: FindInArticleState): void {
    this.findState = state;
    this.selectedResult = state.count === 0 ? 1 : state.index + 1;
  }

  private nextResult(): void {
    if (this.selectedResult < this.findState.count) {
      const next: (() => void) | undefined = this.webViewBridge.selectNextResult;
      if (next !== undefined) {
        next();
      }
      this.selectedResult = this.selectedResult + 1;
    }
  }

  private previousResult(): void {
    if (this.selectedResult > 1) {
      const previous: (() => void) | undefined = this.webViewBridge.selectPreviousResult;
      if (previous !== undefined) {
        previous();
      }
      this.selectedResult = this.selectedResult - 1;
    }
  }

  // MARK: - The web view's bridge callbacks

  /** imageWasClicked: show the tapped image full screen, over the article. */
  private showFullScreenImage(message: ImageClickMessage): void {
    AppStorage.setOrCreate<string>(clickedImageURLKey, message.imageURL);
    AppStorage.setOrCreate<string>(clickedImageTitleKey, message.imageTitle);
    const hide: (() => void) | undefined = this.webViewBridge.hideClickedImage;
    if (hide !== undefined) {
      hide();
    }
    this.imageViewerShown = true;
  }

  /** The reverse transition puts the in-article image back. */
  private dismissFullScreenImage(): void {
    this.imageViewerShown = false;
    const show: (() => void) | undefined = this.webViewBridge.showClickedImage;
    if (show !== undefined) {
      show();
    }
  }

  // MARK: - Navigation

  /** the article screen -> the feed inspector screen (the showFeedInspector bridge message) */
  goToFeedInspectorViewController(): void {
    // `showFeedInspector()` -> `timelineFeed as? Feed ?? currentArticle?.feed`, then
    // `feedInspectorController.feed = feed`. With no route param the inspector fell back to
    // the first feed of the first account.
    const article: Article | undefined = this.article();
    const feed: Feed | undefined = article === undefined ? undefined : articleFeed(article);
    if (feed === undefined) {
      return;
    }
    const params: FeedInspectorRouteParams = { feedID: feed.feedID };
    router.pushUrl({ url: 'pages/FeedInspectorViewControllerPage', params: params })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/FeedInspectorViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the article screen -> the image viewer screen (route form, for replay) */
  goToImageViewController(): void {
    router.pushUrl({ url: 'pages/ImageViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/ImageViewControllerPage failed: %{public}s', err.message);
      });
  }

  /** the article screen -> the main timeline screen (the navigateToTimeline key command) */
  goToMainTimelineModernViewController(): void {
    router.pushUrl({ url: 'pages/MainTimelineModernViewControllerPage' })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'push pages/MainTimelineModernViewControllerPage failed: %{public}s', err.message);
      });
  }

  // MARK: - The long-press preview card's labels (the source reads them off the article)

  private previewFeedName(): string {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return '';
    }
    const feed: Feed | undefined = articleFeed(article);
    return feed === undefined ? '' : feed.nameForDisplay;
  }

  private previewByline(): string {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return '';
    }
    const authors: Author[] | undefined = article.authors;
    if (authors === undefined || authors.length === 0) {
      return '';
    }
    const name: string | undefined = authors[0].name;
    return name === undefined ? '' : name;
  }

  private previewTitle(): string {
    const article: Article | undefined = this.article();
    if (article === undefined || article.title === undefined) {
      return '';
    }
    return article.title;
  }

  private previewDateTime(): string {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return '';
    }
    const options: intl.DateTimeOptions = { dateStyle: 'long', timeStyle: 'medium' };
    return new intl.DateTimeFormat([], options).format(logicalDatePublished(article));
  }

  private previewIconSymbol(): string {
    const article: Article | undefined = this.article();
    if (article === undefined) {
      return '';
    }
    const feed: Feed | undefined = articleFeed(article);
    if (feed === undefined) {
      return '';
    }
    const icon: IconImage | undefined = IconImageCache.shared.imageForFeed(feed);
    if (icon === undefined || icon.resourceName === undefined) {
      return '';
    }
    return icon.resourceName;
  }

  // MARK: - Builders

  @Builder
  imageViewerOverlay() {
    ImageViewController({
      onClose: () => {
        this.dismissFullScreenImage();
      }
    })
  }

  /** The long-press preview card above the article menu. */
  @Builder
  menuPreview() {
    ContextMenuPreviewViewController({
      feedName: this.previewFeedName(),
      byline: this.previewByline(),
      articleTitle: this.previewTitle(),
      dateTime: this.previewDateTime(),
      iconURL: this.avatarURL,
      iconSymbol: this.previewIconSymbol()
    })
  }

  /** The article context menu (WebViewController's UIMenu), full screen only. */
  @Builder
  articleMenu() {
    Menu() {
      if (this.isPrevAvailable) {
        MenuItem({ content: 'Previous Article' })
          .accessibilityText('Previous Article')
          .onClick(() => {
            this.prevArticle();
          })
      }
      if (this.isNextAvailable) {
        MenuItem({ content: 'Next Article' })
          .accessibilityText('Next Article')
          .onClick(() => {
            this.nextArticle();
          })
      }
      if (this.canToggleRead) {
        MenuItem({ content: this.isRead ? 'Mark as Unread' : 'Mark as Read' })
          .accessibilityText(this.isRead ? 'Mark as Unread' : 'Mark as Read')
          .onClick(() => {
            this.toggleRead();
          })
      }
      MenuItem({ content: this.isStarred ? 'Mark as Unstarred' : 'Mark as Starred' })
        .accessibilityText(this.isStarred ? 'Mark as Unstarred' : 'Mark as Starred')
        .onClick(() => {
          this.toggleStar();
        })
      if (this.isNextUnreadAvailable) {
        MenuItem({ content: 'Next Unread Article' })
          .accessibilityText('Next Unread Article')
          .onClick(() => {
            this.nextUnread();
          })
      }
      MenuItem({
        content: this.extractorState === ArticleExtractorButtonState.on
          ? 'Show Feed Article' : 'Show Reader View'
      })
        .onClick(() => {
          this.toggleArticleExtractor();
        })
      MenuItem({ content: 'Share' })
        .onClick(() => {
          this.showActivityDialog();
        })
      MenuItem({ content: 'Open in Browser' })
        .onClick(() => {
          this.openInAppBrowser();
        })
      MenuItem({ content: 'Find in Article' })
        .onClick(() => {
          this.beginFind();
        })
    }
  }

  @Builder
  navigationBar() {
    Row() {
      // The UINavigationController back item — an iOS system default that exists only in the
      // capture: a 44pt round glass button holding a chevron.left.
      Button() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
      }
      .type(ButtonType.Circle)
      .width(44)
      .height(44)
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .id('BackButton')
      .onClick(() => {
        router.back();
      })

      // The source's 150x44 titleView tap zone: tapping it enters full screen.
      Column()
        .width(150)
        .height(44)
        .margin({ left: $r('sys.float.ohos_id_elements_margin_horizontal_m') })
        .id('article_title_tap')
        .onClick(() => {
          this.hideBars();
        })

      Blank()

      // Previous / Next share ONE glass lozenge (capture: x268..378, y51..87).
      Row({ space: 12 }) {
        Button() {
          SymbolGlyph($r('sys.symbol.chevron_up'))
            .fontSize(22)
            .fontColor([$r('sys.color.ohos_id_color_text_primary')])
        }
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .width(36)
        .height(36)
        .accessibilityText('Previous Article (nav bar)')
        .enabled(this.isPrevAvailable)
        .id('article_previous')
        .onClick(() => {
          this.prevArticle();
        })

        Button() {
          SymbolGlyph($r('sys.symbol.chevron_down'))
            .fontSize(22)
            .fontColor([$r('sys.color.ohos_id_color_text_primary')])
        }
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .width(36)
        .height(36)
        .accessibilityText('Next Article (nav bar)')
        .enabled(this.isNextAvailable)
        .id('article_next')
        .onClick(() => {
          this.nextArticle();
        })
      }
      .padding({ left: 14, right: 14 })
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
    }
    .width('100%')
    .height(54)
    .alignItems(VerticalAlign.Center)
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
  }

  @Builder
  articleToolbar() {
    Row() {
      // Mark read + Star in one glass lozenge (capture: x28..138, y768..816).
      Row({ space: 10 }) {
        Button() {
          // updateUI(): read -> circleOpen (`circle`), unread -> circleClosed
          // (`largecircle.fill.circle`) — the source's own two assets.
          if (this.isRead) {
            SymbolGlyph($r('sys.symbol.circle'))
              .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
              .fontColor([$r('sys.color.ohos_id_color_text_primary')])
          } else {
            Image($r('app.media.ic_sf_largecircle_fill_circle'))
              .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
              .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
              .objectFit(ImageFit.Contain)
          }
        }
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .width(44)
        .height(44)
        .accessibilityText('Toggle Read')
        .enabled(this.canToggleRead)
        .id('article_toggle_read')
        .onClick(() => {
          this.toggleRead();
        })

        Button() {
          SymbolGlyph(this.isStarred ? $r('sys.symbol.star_fill') : $r('sys.symbol.star'))
            .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .fontColor([$r('sys.color.ohos_id_color_text_primary')])
        }
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .width(44)
        .height(44)
        .accessibilityText('Toggle Starred')
        .enabled(this.hasArticle())
        .id('article_toggle_star')
        .onClick(() => {
          this.toggleStar();
        })
      }
      .padding({ left: 4, right: 4, top: 2, bottom: 2 })
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_button'))

      // Next Unread stands alone in its own round glass button (capture: x171..219).
      Button() {
        SymbolGlyph($r('sys.symbol.chevron_down_circle'))
          .fontSize($r('sys.float.ohos_id_toolbar_item_icon_size'))
          .fontColor([$r('sys.color.ohos_id_color_text_primary')])
      }
      .type(ButtonType.Circle)
      .width(48)
      .height(48)
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .accessibilityText('Next Unread')
      .enabled(this.isNextUnreadAvailable)
      .id('article_next_unread')
      .onClick(() => {
        this.nextUnread();
      })

      // Reader View + Share in the trailing lozenge (capture: x253..362).
      Row({ space: 10 }) {
        ArticleExtractorButton({
          buttonState: this.extractorState,
          isEnabled: this.hasPermalink,
          onTap: () => {
            this.toggleArticleExtractor();
          }
        })
        Button() {
          Image($r('app.media.ic_sf_square_and_arrow_up'))
            .width($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .height($r('sys.float.ohos_id_toolbar_item_icon_size'))
            .objectFit(ImageFit.Contain)
        }
        .type(ButtonType.Normal)
        .backgroundColor(Color.Transparent)
        .width(44)
        .height(44)
        .accessibilityText('Share')
        .enabled(this.hasPermalink)
        .id('article_share')
        .onClick(() => {
          this.showActivityDialog();
        })
      }
      .padding({ left: 4, right: 4, top: 2, bottom: 2 })
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
    }
    .width('100%')
    .height($r('sys.float.titlebar_default_height'))
    .alignItems(VerticalAlign.Center)
    // Capture: the three groups sit at x28..362 with equal air between them.
    .padding({ left: 28, right: 28 })
    .justifyContent(FlexAlign.SpaceBetween)
  }

  private hasArticle(): boolean {
    return this.article() !== undefined;
  }

  /** The article body, nav bar, find bar and toolbar — the split view's secondary column. */
  @Builder
  articleColumn() {
    Column() {
      if (!this.barsHidden) {
        this.navigationBar()
      }

      Stack() {
        ArticleWebView({
          html: this.articleHTML,
          baseURL: this.articleBaseURL,
          articleID: this.currentArticle,
          avatarURL: this.avatarURL,
          barsHidden: $barsHidden,
          bridge: this.webViewBridge,
          onShowBars: () => {
            this.showBars();
          },
          onImageClicked: (message: ImageClickMessage) => {
            this.showFullScreenImage(message);
          },
          onShowFeedInspector: () => {
            this.goToFeedInspectorViewController();
          },
          onFindStateChanged: (state: FindInArticleState) => {
            this.findStateChanged(state);
          }
        })
      }
      .layoutWeight(1)
      .width('100%')
      .id('article_pager')
      // The UIPageViewController swipe: left goes to the next article, right to the previous.
      .gesture(
        PanGesture({ direction: PanDirection.Horizontal, distance: 40 })
          .onActionEnd((event: GestureEvent) => {
            if (event.offsetX < 0) {
              this.nextArticle();
            } else if (event.offsetX > 0) {
              this.prevArticle();
            }
          })
      )
      .bindContextMenu(this.articleMenu, ResponseType.LongPress,
        { preview: this.menuPreview } as ContextMenuOptions)

      if (this.findVisible) {
        ArticleSearchBar({
          searchText: $findText,
          resultsCount: this.findState.count,
          selectedResult: this.selectedResult,
          onTextChanged: (text: string) => {
            this.searchTextChanged(text);
          },
          onNext: () => {
            this.nextResult();
          },
          onPrevious: () => {
            this.previousResult();
          },
          onDone: () => {
            this.endFind();
          }
        })
      }

      if (!this.barsHidden && !this.findVisible) {
        this.articleToolbar()
      }
    }
    .width('100%')
    .height('100%')
    // systemBackground — the article body and both bars are one white surface in the capture.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  build() {
    Column() {
      // The article is the split view's secondary column; RootSplitViewController carries
      // the shared KeyboardManager commands, exactly as it does for the other two columns.
      RootSplitViewController({ column: SplitColumn.secondary }) {
        this.articleColumn()
      }
    }
    .id('ArticleViewController')
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .bindContentCover($$this.imageViewerShown, this.imageViewerOverlay(),
      { modalTransition: ModalTransition.DEFAULT })
    .onKeyEvent((event: KeyEvent) => {
      // KeyboardManager's navigateToTimeline.
      if (event.type === KeyType.Down && event.keyCode === KeyCode.KEYCODE_ESCAPE) {
        this.goToMainTimelineModernViewController();
      }
    })
  }
}
