/**
 * ImageHeaderView — port of Modules/RSCore/Sources/RSCore/UIKit/ImageHeaderView.swift.
 *
 * The account screens replace section 0's table header at runtime with this view, showing
 * the account-type icon centred at 48x48 inside an 88pt-tall header.
 *
 * Owned by the account inspector screen; also used by the local account screen,
 * the feedbin account screen, the newsblur account screen, the readerapi account screen and
 * the cloudkit account screen.
 */

import deviceInfo from '@ohos.deviceInfo';
import { AccountType } from '../model/AccountType';

/** ImageHeaderView.rowHeight in the source. */
export const imageHeaderRowHeight: number = 88;
/** The icon frame the source lays out inside that header. */
export const imageHeaderIconSize: number = 48;

/**
 * Assets.accountImage(_:) — the account-type icon. `onMyMac` is idiom-dependent in the
 * source (pad vs phone artwork); everything else is a single asset.
 */
export function accountImageResource(type: AccountType): Resource {
  if (type === AccountType.onMyMac) {
    return deviceInfo.deviceType === 'tablet'
      ? $r('app.media.ic_account_local_pad')
      : $r('app.media.ic_account_local_phone');
  }
  if (type === AccountType.cloudKit) {
    return $r('app.media.ic_account_cloud_kit');
  }
  if (type === AccountType.bazQux) {
    return $r('app.media.ic_account_baz_qux');
  }
  if (type === AccountType.feedbin) {
    return $r('app.media.ic_account_feedbin');
  }
  if (type === AccountType.feedly) {
    return $r('app.media.ic_account_feedly');
  }
  if (type === AccountType.freshRSS) {
    return $r('app.media.ic_account_fresh_rss');
  }
  if (type === AccountType.inoreader) {
    return $r('app.media.ic_account_inoreader');
  }
  if (type === AccountType.newsBlur) {
    return $r('app.media.ic_account_news_blur');
  }
  return $r('app.media.ic_account_the_old_reader');
}

@Component
export struct ImageHeaderView {
  /**
   * The account type whose icon this header shows. A number rather than the enum type so
   * a caller holding the raw stored value can pass it straight through; it changes when
   * the inspected account changes, so it is a @Prop.
   */
  @Prop accountType: number = AccountType.onMyMac as number;
  /** Explicit override for callers that already resolved the image themselves. */
  image?: Resource;

  build() {
    Column() {
      Image(this.image !== undefined
        ? this.image
        : accountImageResource(this.accountType as AccountType))
        .width(imageHeaderIconSize)
        .height(imageHeaderIconSize)
        .objectFit(ImageFit.Contain)
    }
    .width('100%')
    .height(imageHeaderRowHeight)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}
