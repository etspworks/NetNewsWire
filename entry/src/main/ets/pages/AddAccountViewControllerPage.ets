/**
 * AddAccountViewControllerPage
 * (source: iOS/Settings/AddAccountViewController.swift).
 *
 *
 * 🟥 ALL NINE AccountType rows ship, in the source's four sections
 * (Local / iCloud / Web / Self-hosted). The capture only ever exercised .onMyMac, so the
 * row set comes from AccountType — not from the pixels. Each row opens the credential
 * screen its handler names; Feedly has no screen of its own and opens the OAuth
 * authorization page, exactly as OAuthAccountAuthorizationOperation does in the source.
 *
 * This screen HOSTS the five credential sheets: it mounts the real child components
 * (present(navController) with .currentContext in the source) in one sheet slot, since the
 * source can only present one of them at a time.
 */

import common from '@ohos.app.ability.common';
import { router } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SheetChrome, sheetScrim } from '../components/SheetChrome';
import { AccountManager } from '../common/account/AccountManager';
import { FeedlyAccountDelegate } from '../common/account/FeedlyAccountDelegate';
import { BrowserService } from '../common/system/BrowserService';
import { AccountType, accountTypeDisplayName } from '../model/AccountType';
import { accountImageResource } from '../components/ImageHeaderView';
import { SettingsComboTableViewCell } from '../components/SettingsComboCell';
import { CloudKitAccountViewController } from './CloudKitAccountViewControllerPage';
import { FeedbinAccountViewController } from './FeedbinAccountViewControllerPage';
import { LocalAccountViewController } from './LocalAccountViewControllerPage';
import { NewsBlurAccountViewController } from './NewsBlurAccountViewControllerPage';
import { ReaderAPIAccountViewController } from './ReaderAPIAccountViewControllerPage';

const DOMAIN: number = 0x0001;
const TAG: string = 'AddAccountViewController';

/** One AddAccountSections.sectionContent entry. */
class AccountTypeRow {
  readonly type: AccountType;
  readonly displayName: string;
  readonly icon: Resource;
  readonly enabled: boolean;

  constructor(type: AccountType, icon: Resource, enabled: boolean) {
    this.type = type;
    this.displayName = accountTypeDisplayName(type);
    this.icon = icon;
    this.enabled = enabled;
  }
}

/** One AddAccountSections case: header, footer and its account types. */
class AddAccountSection {
  readonly key: string;
  readonly header: Resource;
  readonly footer: Resource;
  readonly rows: AccountTypeRow[];

  constructor(key: string, header: Resource, footer: Resource, rows: AccountTypeRow[]) {
    this.key = key;
    this.header = header;
    this.footer = footer;
    this.rows = rows;
  }
}

@Entry
@Component
struct AddAccountViewControllerPage {
  /** The iCloud row is disabled once an iCloud account exists (single-instance). */
  @State iCloudRowEnabled: boolean = true;
  /** The account types already created — they disable their single-instance rows. */
  @State existingTypes: AccountType[] = [];
  /** The four sections over AccountType — built from data, never a captured transcription. */
  @State sections: AddAccountSection[] = [];

  /** The one modal slot: the source presents exactly one account controller at a time. */
  @State sheetShown: boolean = false;
  @State activeSheet: string = '';
  /** The ReaderAPI variant the tapped row chose. */
  @State readerAccountType: AccountType = AccountType.freshRSS;
  @State errorMessage: ResourceStr = '';

  aboutToAppear(): void {
    this.reloadSections();
  }

  onPageShow(): void {
    this.reloadSections();
  }

  /**
   * cellForRowAt's `isUserInteractionEnabled = false` branch: iCloud is single-instance,
   * so its row is disabled once an iCloud account exists. The others may be added again.
   */
  private rowEnabled(type: AccountType): boolean {
    if (type === AccountType.cloudKit) {
      return !this.existingTypes.includes(AccountType.cloudKit);
    }
    return true;
  }

  /** numberOfRowsInSection / cellForRowAt over AddAccountSections.allCases. */
  private reloadSections(): void {
    const types: AccountType[] = [];
    for (const account of AccountManager.shared.accounts) {
      types.push(account.type);
    }
    this.existingTypes = types;
    this.iCloudRowEnabled = this.rowEnabled(AccountType.cloudKit);

    const webTypes: AccountType[] = [AccountType.bazQux, AccountType.feedbin,
      AccountType.feedly, AccountType.inoreader, AccountType.newsBlur,
      AccountType.theOldReader];
    const webRows: AccountTypeRow[] = [];
    for (const type of webTypes) {
      webRows.push(new AccountTypeRow(type, accountImageResource(type), this.rowEnabled(type)));
    }

    this.sections = [
      new AddAccountSection('local', $r('app.string.local'),
        $r('app.string.local_accounts_do_not_sync_your_feeds_across'),
        [new AccountTypeRow(AccountType.onMyMac, accountImageResource(AccountType.onMyMac),
          this.rowEnabled(AccountType.onMyMac))]),
      new AddAccountSection('icloud', $r('app.string.icloud'),
        $r('app.string.your_icloud_account_syncs_your_feeds_across'),
        [new AccountTypeRow(AccountType.cloudKit, accountImageResource(AccountType.cloudKit),
          this.iCloudRowEnabled)]),
      new AddAccountSection('web', $r('app.string.web'),
        $r('app.string.web_accounts_sync_your_feeds_across_all_your'), webRows),
      new AddAccountSection('selfhosted', $r('app.string.self_hosted'),
        $r('app.string.self_hosted_accounts_sync_your_feeds_across'),
        [new AccountTypeRow(AccountType.freshRSS, accountImageResource(AccountType.freshRSS),
          this.rowEnabled(AccountType.freshRSS))])
    ];
  }

  /** didSelectRowAt -> presentController(for:) — one branch per account type. */
  private selectRow(row: AccountTypeRow): void {
    if (!row.enabled) {
      return;
    }
    const type: AccountType = row.type;
    if (type === AccountType.onMyMac) {
      this.presentSheet('local');
    } else if (type === AccountType.cloudKit) {
      this.presentSheet('cloudKit');
    } else if (type === AccountType.feedbin) {
      this.presentSheet('feedbin');
    } else if (type === AccountType.newsBlur) {
      this.presentSheet('newsBlur');
    } else if (type === AccountType.feedly) {
      // No view controller of its own: the OAuth authorization page.
      this.startFeedlyAuthorization();
    } else {
      this.readerAccountType = type;
      this.presentSheet('reader');
    }
  }

  private presentSheet(name: string): void {
    this.activeSheet = name;
    this.sheetShown = true;
  }

  /**
   * OAuthAccountAuthorizationOperation(accountType: .feedly). The Feedly client ID/secret
   * were Xcode build-time secrets with no self-signed equivalent: when they are absent the
   * ported delegate throws a user-facing "not available in this build" message, shown as-is
   * rather than pretending the flow works.
   *
   * The consent page goes to the SYSTEM browser, not through BrowserService.openLink: that
   * honours "Open Links in NetNewsWire" and by default opens the in-app ArkWeb page, which
   * cannot hand `netnewswire://auth/feedly?code=…` back to the app. Only a real browser
   * turns the redirect into the browsable Want that EntryAbility.readOAuthRedirect closes
   * the loop on. (openInSystemBrowser still falls back to the in-app page on a device with
   * no browser at all — the consent page shows, but its redirect goes nowhere.)
   *
   * Nothing pops this screen afterwards: the browser outlives it, and the account is created
   * wherever the redirect lands — possibly in a freshly cold-started process.
   */
  private startFeedlyAuthorization(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    try {
      // Mints the OAuth `state` and remembers it for the redirect to be matched against.
      const authorizationURL: string = FeedlyAccountDelegate.beginOAuthAuthorization();
      BrowserService.shared.openInSystemBrowser(context, authorizationURL)
        .catch((e: Object): void => {
          hilog.error(DOMAIN, TAG, 'feedly authorization page failed: %{public}s', String(e));
        });
    } catch (e) {
      this.showError((e as Error).message);
    }
  }

  /** AddAccountDismissDelegate.dismiss(): pop this controller after a child adds an account. */
  private dismissAfterAdd(): void {
    this.sheetShown = false;
    this.reloadSections();
    router.back();
  }

  private showError(message: ResourceStr): void {
    this.errorMessage = message;
    AlertDialog.show({
      title: $r('app.string.error'),
      message: message,
      confirm: {
        value: 'OK',
        action: (): void => {
          this.errorMessage = '';
        }
      }
    });
  }

  /** The one presented sheet — the real child component, never an empty slot. */
  @Builder
  sheetBody() {
    if (this.activeSheet === 'local') {
      LocalAccountViewController({
        presented: $sheetShown,
        dismissHost: (): void => {
          this.dismissAfterAdd();
        }
      })
    } else if (this.activeSheet === 'cloudKit') {
      CloudKitAccountViewController({
        presented: $sheetShown,
        dismissHost: (): void => {
          this.dismissAfterAdd();
        }
      })
    } else if (this.activeSheet === 'feedbin') {
      FeedbinAccountViewController({
        presented: $sheetShown,
        dismissHost: (): void => {
          this.dismissAfterAdd();
        }
      })
    } else if (this.activeSheet === 'newsBlur') {
      NewsBlurAccountViewController({
        presented: $sheetShown,
        dismissHost: (): void => {
          this.dismissAfterAdd();
        }
      })
    } else if (this.activeSheet === 'reader') {
      ReaderAPIAccountViewController({
        presented: $sheetShown,
        accountType: this.readerAccountType,
        dismissHost: (): void => {
          this.dismissAfterAdd();
        }
      })
    }
  }

  // MARK: - Styling helpers (visual only — no structural decision lives here)

  /**
   * Only a section's first/last row rounds — a grouped section is ONE card, not one card
   * per row (capture: cards x16..374 with ~10pt corners, square joints between rows).
   */
  private rowCorners(index: number, count: number): BorderRadiuses {
    const radius: Resource = $r('sys.float.ohos_id_corner_radius_default_s');
    const first: boolean = index === 0;
    const last: boolean = index === count - 1;
    const corners: BorderRadiuses = {
      topLeft: first ? radius : 0,
      topRight: first ? radius : 0,
      bottomLeft: last ? radius : 0,
      bottomRight: last ? radius : 0
    };
    return corners;
  }

  /** cellForRowAt's `isUserInteractionEnabled = false` needs a visual cue, not just dead taps. */
  private rowOpacity(row: AccountTypeRow): number {
    return row.enabled ? 1 : 0.4;
  }

  /**
   * The pushed screen's inline nav bar: a CENTERED 17pt title with
   * the back affordance in the iOS 26 round glass bar button the capture shows.
   */
  @Builder
  navigationBar() {
    Row() {
      Row() {
        // The source's automatic back item NAMES its destination — chevron + "Settings",
        // the screen this was pushed from. The glass pill wraps both, so the whole
        // chevron+label is the tap target, as it is on iOS.
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
        .onClick((): void => {
          router.back();
        })
      }
      .width(112)
      .justifyContent(FlexAlign.Start)

      Text($r('app.string.add_account'))
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))

      Blank().width(112)
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
  accountRow(row: AccountTypeRow, index: number, count: number) {
    Column() {
      Row() {
        // The Add Account prototype cell has no accessory: icon + name only.
        SettingsComboTableViewCell({
          comboImage: row.icon,
          comboNameLabel: row.displayName,
          showsDisclosure: false,
          rowId: 'addaccount_itemroot',
          onTap: (): void => {
            this.selectRow(row);
          }
        })
      }
      .width('100%')
      .constraintSize({ minHeight: 49 })
      .alignItems(VerticalAlign.Center)
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })

      // The grouped-list hairline, inset 16 inside the card and dropped on its last row
      // (capture: x32..358 of a card spanning x16..374).
      if (index < count - 1) {
        Divider()
          .strokeWidth(0.5)
          .color($r('sys.color.ohos_id_color_list_separator'))
          .margin({
            left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
            right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
          })
      }
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .borderRadius(this.rowCorners(index, count))
    .clip(true)
    .enabled(row.enabled)
    .opacity(this.rowOpacity(row))
  }

  build() {
    // The source presents this screen as a SHEET: rounded top corners, inset below
    // the status bar, over the dimmed screen behind it. The scrim and the safe-area
    // expansion live on this root Column because an @Entry root must be a container.
    Column() {
      SheetChrome({ pageBackground: $r('sys.color.ohos_id_color_sub_background') }) {
    Column() {
      this.navigationBar()

      List() {
        ForEach(this.sections, (section: AddAccountSection) => {
          ListItemGroup({ header: this.sectionHeader(section.header),
            footer: this.sectionFooter(section.footer) }) {
            ForEach(section.rows, (row: AccountTypeRow, index: number) => {
              ListItem() {
                this.accountRow(row, index, section.rows.length)
              }
            }, (row: AccountTypeRow) => String(row.type))
          }
        }, (section: AddAccountSection) => section.key)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      // The 16pt grouped-list side inset — the cards are x16..374 in a 390pt capture.
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
    }
    .id('AddAccountViewController')
    .width('100%')
    .height('100%')
    // systemGroupedBackground — the grouped page the section cards sit on.
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .bindSheet($$this.sheetShown, this.sheetBody(),
      { height: SheetSize.LARGE, dragBar: true, showClose: false })
    }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(sheetScrim)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }

  /**
   * A grouped section header: indented to the cards' CONTENT edge (16pt list inset + the
   * card's own 16pt padding = x32 in the capture), on the bare grouped background.
   */
  @Builder
  sectionHeader(text: Resource) {
    Text(text)
      .width('100%')
      .fontSize($r('sys.float.ohos_id_text_size_sub_title1'))
      .fontWeight(FontWeight.Bold)
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        bottom: 6
      })
  }

  @Builder
  sectionFooter(text: Resource) {
    Text(text)
      .width('100%')
      .fontSize($r('sys.float.ohos_id_text_size_body3'))
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .padding({
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        top: $r('sys.float.ohos_id_elements_margin_horizontal_m'),
        bottom: $r('sys.float.ohos_id_elements_margin_horizontal_l')
      })
  }
}
