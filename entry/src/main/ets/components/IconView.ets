/**
 * IconView.
 * Source: iOS/IconView.swift, Shared/Extensions/IconImageView.swift.
 *
 * Renders one sidebar/timeline icon. The source's IconView takes an `IconImage` and draws
 * either the downloaded bitmap or the bundled/symbol image, falling back to the
 * faviconTemplateImage placeholder. The migrated IconImage carries a `sourceURL` (network
 * icon) OR a `resourceName` (bundled/symbol name), so this component takes those two as
 * plain strings — the owning page reads them off IconImageCache and hands them down, exactly
 * as the source view controller assigns `cell.iconImage`.
 */

import common from '@ohos.app.ability.common';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import EnvironmentCallback from '@ohos.app.ability.EnvironmentCallback';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import { UIContext } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AccountType } from '../model/AccountType';
import { AppContext } from '../common/util/AppContext';

/**
 * A bitmap glyph tinted to `color`.
 *
 * The SF-symbol exports the assets pass bundled are black-on-alpha templates, and ArkUI's
 * `Image.fillColor` "applies only to SVG images" (SDK image.d.ts), so a PNG glyph can only
 * be recoloured with a colour matrix: discard RGB, keep alpha, add the target colour as the
 * row offsets. Used for every source `preferredColor` / tint that lands on a bundled PNG.
 */
export function templateTint(color: number): ColorFilter {
  const red: number = ((color >> 16) & 0xFF) / 255;
  const green: number = ((color >> 8) & 0xFF) / 255;
  const blue: number = (color & 0xFF) / 255;
  return new ColorFilter([
    0, 0, 0, 0, red,
    0, 0, 0, 0, green,
    0, 0, 0, 0, blue,
    0, 0, 0, 1, 0
  ]);
}

/**
 * Why the tint is chosen in ArkTS and NOT by the resource qualifier.
 *
 * The two earlier fixes both handed a `$r('app.color.…')` token to `getColorSync()` and
 * trusted the `resources/dark/` qualifier to swap the value. the glyph measured RGB(0,0,0) both
 * times. The reason the first two rounds could not see their own failure: the only tokens
 * that appeared to WORK on this path — `primary_accent_color` (#086AEE / #2D80F1) and
 * `secondary_accent_color` (#086AEE / #5E9EF4) — are BLUE IN BOTH PALETTES. "The gear is
 * blue, so getColorSync is colour-mode aware" is not an observation, it is a coincidence:
 * both candidate values are blue, so the measurement cannot tell the light value from the
 * dark one. `label_color` (#000000 / #FFFFFF) is the only token on this path whose two
 * values differ visibly, and it renders its LIGHT value — which is the actual evidence.
 *
 * So the qualifier layer is not trusted here at all. `light` and `dark` are two SEPARATE,
 * BASE-ONLY tokens (deliberately absent from `resources/dark/element/color.json`), and this
 * function — not the resource manager — decides which one is read. That makes the tint
 * correct whether the failure was `getColorSync` ignoring the in-app `setColorMode()`
 * override or `resources/dark/` never reaching the build: neither can affect a token that
 * exists in exactly one qualifier directory.
 *
 * A ColorFilter still has to be built from plain channel numbers — ArkUI's `Image.fillColor`
 * "applies only to SVG images" (SDK image.d.ts:1072) and these three glyphs are PNGs, so the
 * mode-aware `$r(...)` rendering paths are not available to them.
 */
function templateTintDynamic(light: Resource, dark: Resource, isDarkMode: boolean): ColorFilter {
  return templateTint(AppContext.get().resourceManager.getColorSync(isDarkMode ? dark : light));
}

/** `UIColor.label` — black in light, WHITE in dark (MainFeedCollectionViewController.swift:113). */
export function labelTint(isDarkMode: boolean): ColorFilter {
  return templateTintDynamic($r('app.color.label_color_light'), $r('app.color.label_color_dark'),
    isDarkMode);
}

/** `Assets.Colors.primaryAccent` — the primaryAccentColor colorset (Shared/Assets.swift). */
export function primaryAccentTint(isDarkMode: boolean): ColorFilter {
  return templateTintDynamic($r('app.color.primary_accent_color_light'),
    $r('app.color.primary_accent_color_dark'), isDarkMode);
}

/** Set to true while the app draws in the dark palette. Read with `@StorageProp('nnwDarkMode')`. */
const DARK_MODE_KEY: string = 'nnwDarkMode';

/** The `on('environment', …)` registration is process-wide, so it is made exactly once. */
let colorModeWatchStarted: boolean = false;

/**
 * The app's EFFECTIVE colour mode.
 *
 * `ApplicationContext.setColorMode()` — what Settings > Appearance > Color Palette calls —
 * writes the ability's Configuration, so `context.config.colorMode` is the authoritative
 * answer for an explicit Light/Dark choice. 'Automatic' sets COLOR_MODE_NOT_SET (-1), which
 * means "follow the system"; that one is answered by ArkUI's own media query, the same layer
 * that already paints the text on these screens white.
 *
 * (ConfigurationConstant.ColorMode is DARK = 0, LIGHT = 1, NOT_SET = -1 — note that this is
 * NOT the ArkUI `ColorMode` enum, where LIGHT = 0. The two were being conflated before.)
 */
function readIsDarkMode(uiContext: UIContext): boolean {
  try {
    const context: common.UIAbilityContext =
      uiContext.getHostContext() as common.UIAbilityContext;
    const mode: ConfigurationConstant.ColorMode | undefined = context.config.colorMode;
    if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
      return true;
    }
    if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT) {
      return false;
    }
  } catch (e) {
    // Fall through to the media query below.
  }
  try {
    return uiContext.getMediaQuery().matchMediaSync('(dark-mode: true)').matches;
  } catch (e) {
    return false;
  }
}

/**
 * Publishes the effective colour mode into AppStorage under `nnwDarkMode`.
 *
 * Idempotent, and it re-reads the mode on EVERY call: a page calls it from `aboutToAppear`
 * AND `onPageShow`, because returning from the Color Palette screen is a `router.back()`,
 * which fires `onPageShow` only. The `on('environment', …)` subscription covers the case the
 * navigation callbacks cannot — the palette changing while this page stays on screen (the
 * system flipping to dark while the app is set to 'Automatic').
 */
export function startColorModeWatch(uiContext: UIContext): void {
  AppStorage.setOrCreate(DARK_MODE_KEY, readIsDarkMode(uiContext));
  if (colorModeWatchStarted) {
    return;
  }
  try {
    const context: common.UIAbilityContext =
      uiContext.getHostContext() as common.UIAbilityContext;
    const callback: EnvironmentCallback = {
      onConfigurationUpdated: (config: Configuration): void => {
        AppStorage.setOrCreate(DARK_MODE_KEY, readIsDarkMode(uiContext));
      },
      onMemoryLevel: (level: AbilityConstant.MemoryLevel): void => {
        // EnvironmentCallback requires both members; this watcher only cares about the
        // colour mode. Nothing here caches memory, so the honest response is to record
        // the pressure rather than invent a release the source never performs.
        hilog.info(0x0001, 'IconView', 'memory level %{public}d', level);
      }
    };
    context.getApplicationContext().on('environment', callback);
    colorModeWatchStarted = true;
  } catch (e) {
    // No ability context (preview / test host): the per-navigation refresh above still runs.
  }
}

/** SmallIconProvider.smallIcon for an Account — the per-service image the source bundles. */
export function accountIconName(type: AccountType): string {
  if (type === AccountType.cloudKit) {
    return 'ic_account_cloud_kit';
  }
  if (type === AccountType.feedly) {
    return 'ic_account_feedly';
  }
  if (type === AccountType.feedbin) {
    return 'ic_account_feedbin';
  }
  if (type === AccountType.newsBlur) {
    return 'ic_account_news_blur';
  }
  if (type === AccountType.freshRSS) {
    return 'ic_account_fresh_rss';
  }
  if (type === AccountType.inoreader) {
    return 'ic_account_inoreader';
  }
  if (type === AccountType.bazQux) {
    return 'ic_account_baz_qux';
  }
  if (type === AccountType.theOldReader) {
    return 'ic_account_the_old_reader';
  }
  return 'ic_account_local_phone';
}

@Component
export struct IconView {
  /** IconImage.sourceURL — a downloaded favicon / feed icon / avatar. */
  @Prop iconURL: string = '';
  /** IconImage.resourceName — a bundled image or an SF-symbol name. */
  @Prop symbolName: string = '';
  /** Square edge in vp. `size` is a reserved ArkUI attribute name, hence `dimension`. */
  @Prop dimension: number = 24;
  /**
   * Optional tint role for the indicator glyphs. The timeline draws the unread dot in
   * Assets.Colors.secondaryAccent and the star in Assets.Colors.star, and a SymbolGlyph's
   * colour can only be set on the glyph itself — `foregroundColor` on the caller does not
   * cascade into it. '' keeps the default, which is what the sidebar wants.
   */
  @Prop tintName: string = '';
  /**
   * IconImage.preferredColor — the tint the SOURCE attaches to the icon itself (the smart
   * feeds' orange sun / blue ring / yellow star, Shared/Assets.swift). 0 = none.
   */
  @Prop tintColor: number = 0;
  /** Published by `startColorModeWatch` — see the note on `templateTintDynamic`. */
  @StorageProp('nnwDarkMode') private isDarkMode: boolean = false;

  /** The tint role resolved to a colour, or the default text colour when no role is set. */
  private tintColors(): ResourceColor[] {
    if (this.tintColor !== 0) {
      return [this.tintColor];
    }
    if (this.tintName === 'accent') {
      return [$r('app.color.secondary_accent_color')];
    }
    if (this.tintName === 'star') {
      return [$r('app.color.star_color')];
    }
    return [$r('sys.color.ohos_id_color_text_primary')];
  }

  /**
   * The bundled half of the source's IconImage. Every name here comes from the migrated
   * model (SmartFeed.smallIcon, IconImageCache's branded-feed icon, the folder icon) and
   * resolves through the icon map.
   */
  @Builder
  bundledIcon() {
    if (this.symbolName === 'star.fill') {
      SymbolGlyph($r('sys.symbol.star_fill')).fontSize(this.dimension).fontColor(this.tintColors())
    } else if (this.symbolName === 'sun.max.fill') {
      SymbolGlyph($r('sys.symbol.sun_max_fill'))
        .fontSize(this.dimension)
        .fontColor(this.tintColors())
    } else if (this.symbolName === 'largecircle.fill.circle') {
      Image($r('app.media.ic_sf_largecircle_fill_circle'))
        .width(this.dimension)
        .height(this.dimension)
        .objectFit(ImageFit.Contain)
        .colorFilter(templateTint(this.tintColor === 0 ? 0x182431 : this.tintColor))
    } else if (this.symbolName === 'folder') {
      // Assets.swift:123 — the iOS `mainFolder` is the folder symbol with
      // `preferredColor: Assets.Colors.secondaryAccent`, a colorset with its own dark
      // value. That tint was dropped in the port, so the glyph fell back to the SymbolGlyph
      // default black and stayed black in dark mode. app.color has the same two
      // values, so the token carries the palette by itself.
      SymbolGlyph($r('sys.symbol.folder'))
        .fontSize(this.dimension)
        .fontColor([$r('app.color.secondary_accent_color')])
    } else if (this.symbolName === 'circle.fill') {
      SymbolGlyph($r('sys.symbol.circle_fill')).fontSize(this.dimension).fontColor(this.tintColors())
    } else if (this.symbolName === 'circle') {
      SymbolGlyph($r('sys.symbol.circle')).fontSize(this.dimension).fontColor(this.tintColors())
    } else if (this.symbolName === 'checkmark.circle.fill') {
      SymbolGlyph($r('sys.symbol.checkmark_circle_fill')).fontSize(this.dimension)
    } else if (this.symbolName === 'xmark.circle.fill') {
      SymbolGlyph($r('sys.symbol.xmark_circle_fill')).fontSize(this.dimension)
    } else if (this.symbolName === 'star') {
      SymbolGlyph($r('sys.symbol.star')).fontSize(this.dimension).fontColor(this.tintColors())
    } else if (this.symbolName === 'app_icon') {
      Image($r('app.media.ic_nnw_feed_icon'))
        .width(this.dimension)
        .height(this.dimension)
        .objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_local_phone') {
      Image($r('app.media.ic_account_local_phone'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_cloud_kit') {
      Image($r('app.media.ic_account_cloud_kit'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_feedbin') {
      Image($r('app.media.ic_account_feedbin'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_feedly') {
      Image($r('app.media.ic_account_feedly'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_news_blur') {
      Image($r('app.media.ic_account_news_blur'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_fresh_rss') {
      Image($r('app.media.ic_account_fresh_rss'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_inoreader') {
      Image($r('app.media.ic_account_inoreader'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_baz_qux') {
      Image($r('app.media.ic_account_baz_qux'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else if (this.symbolName === 'ic_account_the_old_reader') {
      Image($r('app.media.ic_account_the_old_reader'))
        .width(this.dimension).height(this.dimension).objectFit(ImageFit.Contain)
    } else {
      // The faviconTemplateImage placeholder every feed row falls back to (iOS/IconView.swift:38).
      // It was drawn untinted, i.e. in the SVG's own black — invisible on the dark feed list
      // (the whole glyph measured RGB(0,0,0)). It is the same `.label` role as the
      // toolbar glyphs, so it follows the same rule; unlike them this one IS an SVG, so
      // `fillColor` works directly and no ColorFilter is needed. The token pair is still picked
      // in ArkTS rather than by qualifier, for the reason documented on `templateTintDynamic`.
      Image($r('app.media.ic_favicon_template_image'))
        .width(this.dimension)
        .height(this.dimension)
        .objectFit(ImageFit.Contain)
        .fillColor(this.isDarkMode
          ? $r('app.color.label_color_dark')
          : $r('app.color.label_color_light'))
    }
  }

  build() {
    // the two radii are hardcoded by the source (iOS/IconView.swift:41 imageView
    // cornerRadius 2.0, :85 the view's own cornerRadius 4) — copied verbatim, not tokenised.
    // `.alt` is the loading/failed visual: the source's faviconTemplateImage placeholder.
    Stack() {
      if (this.iconURL.length > 0) {
        Image(this.iconURL)
          .width(this.dimension)
          .height(this.dimension)
          .objectFit(ImageFit.Contain)
          .borderRadius(2)
          .alt($r('app.media.ic_favicon_template_image'))
      } else {
        this.bundledIcon()
      }
    }
    .width(this.dimension)
    .height(this.dimension)
    .borderRadius(4)
    .clip(true)
  }
}
