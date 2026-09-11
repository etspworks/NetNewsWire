/**
 * AboutCreditView — port of iOS/Settings/AboutCreditView.swift
 *
 * One credit group: the credit-type label plus the tappable contributor names, each of
 * which opens that person's URL (UIApplication.shared.open -> BrowserService).
 *
 * the source's two-column form — the credit type trailing-aligned and secondary, the
 * names leading-aligned on `.link` (the accent). Tokens come from the style baseline.
 */

import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AboutContributor } from '../model/AboutContributor';
import { BrowserService } from '../common/system/BrowserService';

const DOMAIN: number = 0x0001;
const TAG: string = 'AboutCreditView';

@Component
export struct AboutCreditView {
  /** The credit-type label ("App Icon", "Feedly Syncing", …). */
  @Prop contributorType: string = '';
  /** The people credited under it. Assigned once by the parent. */
  contributors: AboutContributor[] = [];

  private openContributor(contributor: AboutContributor): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, contributor.url)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open %{public}s: %{public}s',
          contributor.url, String(e));
      });
  }

  build() {
    // HStack(alignment: .top) { Spacer, type (trailing), VStack of names (leading), Spacer }
    Row({ space: $r('sys.float.ohos_id_elements_margin_horizontal_m') }) {
      Text(this.contributorType)
        .layoutWeight(1)
        .maxLines(3)
        .textAlign(TextAlign.End)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))

      Column() {
        ForEach(this.contributors, (item: AboutContributor) => {
          Text(item.name)
            .width('100%')
            .maxLines(2)
            .textAlign(TextAlign.Start)
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            // .foregroundStyle(.link) — the capture's blue contributor names.
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .id('about_contributor_itemroot')
            .onClick(() => {
              this.openContributor(item);
            })
        }, (item: AboutContributor) => item.url)
      }
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }
}
