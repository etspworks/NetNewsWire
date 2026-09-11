/**
 * VibrantCell — port of the iOS "vibrant" table-cell family:
 *   iOS/UIKit Extensions/VibrantTableViewCell.swift (VibrantTableViewCell,
 *   VibrantBasicTableViewCell), VibrantLabel.swift, VibrantButton.swift.
 *
 * One styling substrate behind nearly every static table row and action button in the
 * settings / account family. The UIKit originals invert their label + image tint while
 * highlighted; that tint work is visual finish. What lives here is the
 * STRUCTURE those cells provide: a tappable row, a row with a detail label, a row with a
 * switch, a label and a button.
 *
 * the inset-grouped-table finish, measured off the captured settings/inspector states
 * (390x844pt): a row is 51pt tall with a 16pt inner inset on each side, its label is the
 * .body role and its trailing value/chevron the .secondaryLabel role. The CARD (white
 * background + corner radius + the hairlines between rows) is composed by the OWNING page —
 * a section is one card, not one card per row — so nothing here paints a background.
 *
 * Owned by the account inspector screen; imported by the settings screen, the feed inspector screen,
 * the account notification inspector screen and the account-credential screens.
 */

/**
 * The row height the captured grouped tables lay out against (the Settings capture cells are
 * [16,172][374,224]/[16,280][374,329]…, the inspectors' [16,205][374,256] — 51pt with the
 * 0.5 hairline). iOS sizes it from content, so no HarmonyOS token expresses it.
 */
export const vibrantRowMinHeight: number = 51;

/** VibrantLabel — a plain label that participates in the cell's vibrancy. */
@Component
export struct VibrantLabel {
  @Prop text: string = '';
  @Prop secondary: boolean = false;
  @Prop maxLines: number = 1;

  build() {
    Text(this.text)
      .maxLines(this.maxLines)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .layoutWeight(1)
      .fontSize($r('sys.float.ohos_id_text_size_body1'))
      .fontColor(this.secondary
        ? $r('sys.color.ohos_id_color_text_secondary')
        : $r('sys.color.ohos_id_color_text_primary'))
  }
}

/**
 * VibrantTableViewCell — the bare tappable row. Callers supply the content through
 * `cellContent`; this struct owns the tap target, so `.onClick` sits on the OUTERMOST
 * container of the row rather than on an inner child.
 */
@Component
export struct VibrantTableViewCell {
  rowId: string = '';
  onTap?: () => void;
  @BuilderParam cellContent: () => void;

  build() {
    Row() {
      this.cellContent()
    }
    .width('100%')
    .constraintSize({ minHeight: vibrantRowMinHeight })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .alignItems(VerticalAlign.Center)
    .id(this.rowId)
    .onClick(() => {
      const handler: (() => void) | undefined = this.onTap;
      if (handler !== undefined) {
        handler();
      }
    })
  }
}

/**
 * VibrantBasicTableViewCell — label + optional detail label + optional leading icon +
 * optional trailing accessory + optional disclosure indicator. This is the row shape almost
 * every static settings row uses. A row with no `onTap` is display-only and gets no tap
 * target at all.
 */
@Component
export struct VibrantBasicTableViewCell {
  /** ResourceStr so a localized row title can pass $r('app.string.…') straight through. */
  @Prop label: ResourceStr = '';
  /** Right-hand detail label (Theme -> theme name, Color Palette -> palette name). */
  @Prop detail: string = '';
  /** Leading icon, when the row has one. Static per row, so a plain member. */
  icon?: Resource;
  /**
   * Trailing accessory glyph — the feed inspector's Home Page row carries the tinted
   * `safari` glyph at [329,428][354,451] in its capture. Static per row.
   */
  trailingIcon?: Resource;
  @Prop showsDisclosure: boolean = false;
  @Prop labelMaxLines: number = 1;
  rowId: string = '';
  onTap?: () => void;

  @Builder
  rowBody() {
    Row({ space: 8 }) {
      if (this.icon !== undefined) {
        Image(this.icon)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
      }
      Text(this.label)
        .maxLines(this.labelMaxLines)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      if (this.detail.length > 0) {
        Text(this.detail)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      if (this.trailingIcon !== undefined) {
        Image(this.trailingIcon)
          .width(24)
          .height(24)
          .objectFit(ImageFit.Contain)
          // The SF exports are single-colour PNGs; template rendering is how the asset map
          // says to tint them (the asset map). The source draws it tinted.
          .renderMode(ImageRenderMode.Template)
          .fillColor($r('sys.color.ohos_id_color_text_primary_activated'))
      }
      if (this.showsDisclosure) {
        // Capture: the chevron is 11x14 at the row's trailing edge, .tertiaryLabel grey.
        // The assets pass exported iOS's `chevron.right` as a FILLED triangle, so every
        // settings row drew a solid play-style arrowhead where the source draws a thin
        // stroked chevron. The system symbol is the right glyph and matches the chevron_up /
        // chevron_down already used elsewhere in this app.
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([$r('sys.color.ohos_id_color_text_tertiary')])
      }
    }
    .width('100%')
    .constraintSize({ minHeight: vibrantRowMinHeight })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .alignItems(VerticalAlign.Center)
  }

  build() {
    if (this.onTap !== undefined) {
      Row() {
        this.rowBody()
      }
      .width('100%')
      .id(this.rowId)
      .onClick(() => {
        const handler: (() => void) | undefined = this.onTap;
        if (handler !== undefined) {
          handler();
        }
      })
    } else if (this.rowId.length > 0) {
      // Display-only, but still addressable (the feed inspector's Feed URL row).
      Row() {
        this.rowBody()
      }
      .width('100%')
      .id(this.rowId)
    } else {
      Row() {
        this.rowBody()
      }
      .width('100%')
    }
  }
}

/**
 * A settings row whose trailing control is a switch. `isOn` is a @Prop so a parent that
 * re-reads the preference (or reverts a rejected change) pushes the new value back down.
 */
@Component
export struct VibrantSwitchTableViewCell {
  @Prop label: string = '';
  @Prop isOn: boolean = false;
  @Prop labelMaxLines: number = 1;
  switchId: string = '';
  onSwitchChange?: (value: boolean) => void;

  build() {
    Row({ space: 8 }) {
      Text(this.label)
        .maxLines(this.labelMaxLines)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      // Capture: 63x28 accessibility frame around the 51x31pt UISwitch.
      Toggle({ type: ToggleType.Switch, isOn: this.isOn })
        .width(51)
        .height(31)
        .selectedColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .id(this.switchId)
        .onChange((value: boolean) => {
          const handler: ((v: boolean) => void) | undefined = this.onSwitchChange;
          if (handler !== undefined) {
            handler(value);
          }
        })
    }
    .width('100%')
    .constraintSize({ minHeight: vibrantRowMinHeight })
    .padding({
      left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
      right: $r('sys.float.ohos_id_elements_margin_horizontal_l')
    })
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * VibrantButton — the accent-tinted action button (Credentials, Remove Account, ...).
 *
 * Three visual forms, all one Button:
 *  - default: a centred tinted label filling a card row (the source's table-cell button);
 *  - `compact`: a nav-bar button — the capture's 36pt-tall glass chip at [334,67][370,103];
 *  - `prominent`: a filled accent capsule (the notification inspector's Open Settings,
 *    captured at [128,775][261,810]).
 */
@Component
export struct VibrantButton {
  @Prop title: string = '';
  @Prop destructive: boolean = false;
  @Prop buttonEnabled: boolean = true;
  /** Nav-bar form: a 36pt glass chip. */
  @Prop compact: boolean = false;
  /** Filled-accent capsule form. */
  @Prop prominent: boolean = false;
  buttonId: string = '';
  onTap?: () => void;

  private backgroundFill(): ResourceColor {
    if (this.prominent) {
      return $r('sys.color.ohos_id_color_text_primary_activated');
    }
    if (this.compact) {
      return $r('sys.color.ohos_id_color_component_normal');
    }
    return Color.Transparent;
  }

  private labelColor(): ResourceColor {
    if (this.prominent) {
      return $r('sys.color.ohos_id_color_foreground_contrary');
    }
    if (this.destructive) {
      return $r('sys.color.ohos_id_color_warning');
    }
    return $r('sys.color.ohos_id_color_text_primary_activated');
  }

  private buttonHeight(): Length {
    return this.compact || this.prominent ? 36 : vibrantRowMinHeight;
  }

  private buttonRadius(): Length {
    return this.compact || this.prominent
      ? $r('sys.float.ohos_id_corner_radius_button') : 0;
  }

  build() {
    Button(this.title)
      .type(ButtonType.Normal)
      .width('100%')
      .height(this.buttonHeight())
      .backgroundColor(this.backgroundFill())
      .borderRadius(this.buttonRadius())
      .fontSize($r('sys.float.ohos_id_text_size_body1'))
      .fontColor(this.labelColor())
      .fontWeight(this.prominent ? FontWeight.Medium : FontWeight.Regular)
      .enabled(this.buttonEnabled)
      // .enabled() alone gives no visual cue — a dead-looking control reads as a defect.
      .opacity(this.buttonEnabled ? 1 : 0.4)
      .id(this.buttonId)
      .onClick(() => {
        const handler: (() => void) | undefined = this.onTap;
        if (handler !== undefined) {
          handler();
        }
      })
  }
}

/**
 * A grouped-table section header (`headerTitle` in the storyboards).
 *
 * Capture: a 38pt band on the bare grouped background with ~18pt of air above it, the title
 * inset to x=32 (the card inset plus the row's own inset) in .secondaryLabel grey at the
 * row's own text size — this app does NOT use the small uppercase footnote header, so the
 * baseline's `sectionHeader` footnote variant would under-size it.
 */
@Component
export struct VibrantSectionHeader {
  /** ResourceStr so a localized header can pass $r('app.string.…') straight through. */
  @Prop title: ResourceStr = '';

  build() {
    Row() {
      Text(this.title)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .fontSize($r('sys.float.ohos_id_text_size_body1'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    }
    .width('100%')
    .height(38)
    .alignItems(VerticalAlign.Center)
    .padding({ left: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
    .margin({ top: $r('sys.float.ohos_id_elements_margin_horizontal_l') })
  }
}
