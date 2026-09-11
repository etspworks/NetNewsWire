/**
 * TickMarkSlider.
 * Source: iOS/Settings/TickMarkSlider.swift + iOS/Settings/TimelineCustomizerCell.swift.
 *
 * A discrete slider that snaps to whole tick values. The source draws its own tick views
 * and rounds the value in continueTracking/endTracking; ArkUI's Slider does both natively
 * with `step: 1` + `.showSteps(true)`, so the port keeps only the snapping contract:
 * the bound value is always an integer between minValue and maxValue.
 */

@Component
export struct TickMarkSlider {
  /** Two-way: the owning screen's preference value. */
  @Link value: number;
  @Prop minValue: number = 1;
  @Prop maxValue: number = 3;
  /** The owning screen's control slug — one slider instance per slug. */
  sliderId: string = '';
  /** Fired with the rounded value on every change — the source's sliderValueChanges. */
  onValueChanged?: (value: number) => void;

  private commit(raw: number): void {
    const rounded: number = Math.round(raw);
    const clamped: number =
      Math.min(this.maxValue, Math.max(this.minValue, rounded));
    if (clamped !== this.value) {
      this.value = clamped;
    }
    const handler: ((value: number) => void) | undefined = this.onValueChanged;
    if (handler !== undefined) {
      handler(clamped);
    }
  }

  build() {
    Row() {
      // the capture's iOS 26 slider — an accent-filled leading track and knob over a
      // light neutral track, with the tick marks the source's addTickMarks() draws.
      Slider({
        value: this.value,
        min: this.minValue,
        max: this.maxValue,
        step: 1,
        style: SliderStyle.OutSet
      })
        .showSteps(true)
        .trackThickness(6)
        .trackColor($r('sys.color.ohos_id_color_component_normal'))
        .selectedColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .blockColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .layoutWeight(1)
        .id(this.sliderId)
        .onChange((value: number, mode: SliderChangeMode) => {
          if (mode === SliderChangeMode.End || mode === SliderChangeMode.Moving
            || mode === SliderChangeMode.Click) {
            this.commit(value);
          }
        })
    }
    .width('100%')
  }
}
