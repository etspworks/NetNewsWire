/**
 * AboutViewPage (source: iOS/Settings/AboutView.swift).
 *
 * Static credits page: icon, title, byline, the
 * netnewswire.com link, eight credit groups, Thanks, Dedication and the copyright line.
 * This screen has no data bindings — it is pure static chrome, so its text is
 * resources (About/Thanks/Dedication ship as rawfile .txt) and its only behaviour is the
 * links, which go through BrowserService.
 *
 * Styled from the iOS reference capture of AboutView with
 * the tokens in the style baseline. This screen is `.background(.systemBackground)`
 * — a PLAIN white page, not a grouped-gray one — and every text is centred
 * (`.multilineTextAlignment(.center)` on the ScrollView), except the two credit columns.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';
import { AboutContributor, contributors } from '../model/AboutContributor';
import { BrowserService } from '../common/system/BrowserService';
import { AboutCreditView } from '../components/AboutCreditView';

const DOMAIN: number = 0x0001;
const TAG: string = 'AboutViewPage';

/** One `AboutCreditView(contributorType:contributors:)` call in the source. */
class CreditGroup {
  readonly contributorType: string;
  readonly members: AboutContributor[];

  constructor(contributorType: string, indexes: number[]) {
    this.contributorType = contributorType;
    const members: AboutContributor[] = [];
    for (const index of indexes) {
      if (index >= 0 && index < contributors.length) {
        members.push(contributors[index]);
      }
    }
    this.members = members;
  }
}

/** The source's eight groups, in order, over Contributors.allCases. */
const creditGroups: CreditGroup[] = [
  new CreditGroup('Contributing Developers', [0, 1]),
  new CreditGroup('App Icon', [2]),
  new CreditGroup('Feedly Syncing', [3]),
  new CreditGroup('NewsBlur Syncing', [4]),
  new CreditGroup('Under-the-hood magic & CSS', [5]),
  new CreditGroup('Newsfoot (JS footnote displayer)', [6]),
  new CreditGroup('Help Book', [12]),
  new CreditGroup('Featuring additional contributions from', [7, 8, 9, 10, 11, 13])
];

const siteURL: string = 'https://netnewswire.com/';

@Entry
@Component
struct AboutViewPage {
  /** about.txt line 1 — "By Brent Simmons and the Ranchero Software team". */
  @State byline: string = '';
  /** about.txt line 2 — the netnewswire.com link text. */
  @State siteLinkText: string = '';
  @State thanksText: string = '';
  @State dedicationText: string = '';

  private readonly groups: CreditGroup[] = creditGroups;

  aboutToAppear(): void {
    const about: string[] = this.rawfileLines('about/about.txt');
    this.byline = about.length > 0 ? about[0] : '';
    this.siteLinkText = about.length > 1 ? about[1] : 'netnewswire.com';
    this.thanksText = this.rawfileText('about/thanks.txt');
    this.dedicationText = this.rawfileText('about/dedication.txt');
  }

  /** The converted About/Thanks/Dedication resources (the source's RTF files). */
  private rawfileText(path: string): string {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    try {
      const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(path);
      const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
      return decoder.decodeToString(bytes).trim();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'could not read %{public}s: %{public}s', path, String(e));
      return '';
    }
  }

  private rawfileLines(path: string): string[] {
    const text: string = this.rawfileText(path);
    return text.length === 0 ? [] : text.split('\n');
  }

  private openSite(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    BrowserService.shared.openLink(context, siteURL)
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, 'could not open the site link: %{public}s', String(e));
      });
  }

  build() {
    // The source presents this screen as a SHEET: rounded top corners, inset below
    // the status bar, over the dimmed screen behind it. The scrim and the safe-area
    // expansion live on this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_background') }) {
    Column() {
      // AboutView.swift:78 .navigationTitle("About NetNewsWire"), pushed from Settings —
      // the inline nav bar: the automatic back item plus the title.
      // The source capture is the geometry contract (390pt wide):
      // NavigationBar [0,63][390,117], back item [16,63][60,107],
      // title [114,74][275,95] — the title's centre is 194.5pt against a screen centre of
      // 195pt. UIKit pins an inline title to the centre of the BAR and shrinks the title when
      // it will not fit; it never slides it over beside the back item. So this is the same
      // Stack the other Settings sub-pages use (ColorPaletteTableViewControllerPage.ets:143,
      // TimelineCustomizerCollectionViewControllerPage.ets:196): back item pinned leading,
      // title centred over the whole bar.
      // "About NetNewsWire" is the longest of those titles, so it is the one that can reach
      // the back item. SYMMETRIC padding — the back control's own width plus a
      // clearance — keeps the title box centred on the bar while making the overlap
      // geometrically impossible, and the adaptive font size shrinks the title into what is
      // left instead of ellipsising it (UIKit's own nav-title behaviour).
      Stack() {
        Text($r('app.string.about_netnewswire'))
          .width('100%')
          // 96vp ≈ the 89vp "< Settings" control + 7vp clearance, mirrored on the right so
          // the remaining box stays centred on the bar.
          .padding({ left: 96, right: 96 })
          .textAlign(TextAlign.Center)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .minFontSize(14)
          .maxFontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .heightAdaptivePolicy(TextHeightAdaptivePolicy.MAX_LINES_FIRST)
          .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary'))

        Row() {
          // Chevron + label as ONE control, so the press outline covers "< Settings" whole.
          Row({ space: 2 }) {
            SymbolGlyph($r('sys.symbol.chevron_left'))
              .fontSize(22)
              .fontColor([$r('sys.color.ohos_id_color_text_primary_activated')])

            Text('Settings')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          }
          .padding({ left: 6, right: 10, top: 6, bottom: 6 })
          .borderRadius($r('sys.float.ohos_id_corner_radius_button'))
          .accessibilityText('Settings')
          .id('BackButton')
          .onClick(() => {
            router.back();
          })

          Blank()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(54)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      Scroll() {
        // VStack(alignment: .center, spacing: 12) { … }.scenePadding(.horizontal)
        Column({ space: 12 }) {
          Image($r('app.media.ic_nnw_feed_icon'))
            .width(100)
            .height(100)
            // AboutView.swift:29 clipShape(RoundedRectangle(cornerRadius: 20)) — source-hardcoded.
            .borderRadius(20)

          Text('NetNewsWire')
            .fontSize($r('sys.float.ohos_id_text_size_headline6'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .textAlign(TextAlign.Center)
          Text(this.byline)
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.Center)
          Text(this.siteLinkText)
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_body1'))
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .textAlign(TextAlign.Center)
            .id('about_site_link')
            .onClick(() => {
              this.openSite();
            })

          Column({ space: 6 }) {
            Text('Credits')
              .width('100%')
              .padding({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontWeight(FontWeight.Bold)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .textAlign(TextAlign.Center)
            ForEach(this.groups, (group: CreditGroup) => {
              AboutCreditView({ contributorType: group.contributorType, contributors: group.members })
            }, (group: CreditGroup) => group.contributorType)
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('Thanks')
              .width('100%')
              .padding({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontWeight(FontWeight.Bold)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .textAlign(TextAlign.Center)
            Text(this.thanksText)
              .width('100%')
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .textAlign(TextAlign.Center)
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('Dedication')
              .width('100%')
              .padding({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontWeight(FontWeight.Bold)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .textAlign(TextAlign.Center)
            Text(this.dedicationText)
              .width('100%')
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .textAlign(TextAlign.Center)
          }
          .width('100%')

          Text('Copyright © 2002-2026 Brent Simmons')
            .width('100%')
            .fontSize($r('sys.float.ohos_id_text_size_caption'))
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({
          left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
          bottom: $r('sys.float.ohos_id_elements_margin_horizontal_l')
        })
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .id('AboutView')
    .width('100%')
    .height('100%')
    // AboutView.swift:77 — .background(Color(uiColor: .systemBackground)), the plain white page.
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
