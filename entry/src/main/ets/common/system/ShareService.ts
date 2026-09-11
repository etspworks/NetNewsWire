/**
 * ShareService — the UIActivityViewController replacement.
 *
 * UIActivityViewController -> `@kit.ShareKit` systemShare (see
 * the HarmonyOS self-signed capability limits). Every entry point has a clipboard +
 * toast fallback so a share action never silently no-ops when the share panel is
 * unavailable.
 *
 * Call sites in the source: the article toolbar (article URL), the timeline row context
 * menu, the image viewer (image URL) and the CloudKit stats screen (stats text).
 */

import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { pasteboard } from '@kit.BasicServicesKit';
import { promptAction } from '@kit.ArkUI';
import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Article } from '../../model/Article';
import { preferredLink, truncatedTitle } from '../article/ArticleText';
import { localized } from './Localized';

const DOMAIN: number = 0x0001;
const TAG: string = 'ShareService';

export class ShareService {
  static readonly shared: ShareService = new ShareService();

  /** Shares an article's link, titled with the article title. */
  async shareArticle(context: common.UIAbilityContext, article: Article): Promise<void> {
    const link: string | undefined = preferredLink(article);
    if (link === undefined) {
      return;
    }
    await this.shareURL(context, link, truncatedTitle(article));
  }

  async shareURL(context: common.UIAbilityContext, urlString: string,
    title?: string): Promise<void> {
    const record: systemShare.SharedRecord = {
      utd: utd.UniformDataType.HYPERLINK,
      content: urlString,
      title: title
    };
    await this.show(context, record, urlString);
  }

  /** The CloudKit stats screen shares plain text. */
  async shareText(context: common.UIAbilityContext, text: string, title?: string): Promise<void> {
    const record: systemShare.SharedRecord = {
      utd: utd.UniformDataType.PLAIN_TEXT,
      content: text,
      title: title
    };
    await this.show(context, record, text);
  }

  /** The image viewer shares the image by its URL. */
  async shareImage(context: common.UIAbilityContext, imageURL: string,
    title?: string): Promise<void> {
    const record: systemShare.SharedRecord = {
      utd: utd.UniformDataType.IMAGE,
      uri: imageURL,
      title: title
    };
    await this.show(context, record, imageURL);
  }

  private async show(context: common.UIAbilityContext, record: systemShare.SharedRecord,
    fallbackText: string): Promise<void> {
    try {
      const data: systemShare.SharedData = new systemShare.SharedData(record);
      const controller: systemShare.ShareController = new systemShare.ShareController(data);
      const options: systemShare.ShareControllerOptions = {
        selectionMode: systemShare.SelectionMode.SINGLE
      };
      await controller.show(context, options);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'system share unavailable, falling back to the clipboard');
      ShareService.copyToClipboard(fallbackText);
    }
  }

  /** The fallback path — and the source's own "Copy Link" command. */
  static copyToClipboard(text: string): void {
    try {
      const data: pasteboard.PasteData =
        pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      pasteboard.getSystemPasteboard().setDataSync(data);
      promptAction.showToast({ message: localized('copied', 'Copied') });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'could not write to the clipboard');
    }
  }
}
