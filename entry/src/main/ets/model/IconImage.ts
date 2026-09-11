/**
 * IconImage — port of Modules/Images/Sources/Images/IconImage.swift
 *
 * The Swift type wraps a decoded RSImage. ArkUI's Image renders straight from a URL or an
 * app resource, so the model carries the source instead of a decoded bitmap; luminance is
 * computed by the image service and cached on the instance exactly as the source caches it.
 */

export enum ImageLuminanceType {
  regular = 'regular',
  bright = 'bright',
  dark = 'dark'
}

/** 48pt at the largest screen scale — the ceiling the source downsamples icons to. */
export const maxIconPixelSize: number = 144;

export class IconImage {
  /** Remote icon/favicon/avatar URL, when the icon came from the network. */
  readonly sourceURL?: string;
  /** Bundled resource name (app.media.*), when the icon is one of the app's own. */
  readonly resourceName?: string;
  readonly isSymbol: boolean;
  readonly isBackgroundSuppressed: boolean;
  /** ARGB color, when the icon should be tinted. */
  readonly preferredColor?: number;
  /** Filled in by the image service; undefined until luminance has been computed. */
  luminanceType?: ImageLuminanceType;

  constructor(sourceURL?: string, resourceName?: string, isSymbol: boolean = false,
    isBackgroundSuppressed: boolean = false, preferredColor?: number) {
    this.sourceURL = sourceURL;
    this.resourceName = resourceName;
    this.isSymbol = isSymbol;
    this.isBackgroundSuppressed = isBackgroundSuppressed;
    this.preferredColor = preferredColor;
  }

  get isDark(): boolean {
    return this.luminanceType === ImageLuminanceType.dark;
  }

  get isBright(): boolean {
    return this.luminanceType === ImageLuminanceType.bright;
  }
}
