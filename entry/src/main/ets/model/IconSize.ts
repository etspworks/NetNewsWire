/**
 * IconSize — port of the enum in Modules/Images/Sources/Images/IconImage.swift
 */

export enum IconSize {
  small = 1,
  medium = 2,
  large = 3
}

/** Square icon dimension in vp: 24 / 36 / 48, matching the source's CGSize values. */
export function iconSizeDimension(size: IconSize): number {
  if (size === IconSize.small) {
    return 24;
  }
  if (size === IconSize.medium) {
    return 36;
  }
  return 48;
}
