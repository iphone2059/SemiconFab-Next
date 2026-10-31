import { useImperativeHandle, useState, type Ref } from 'react';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from '@/domain/simulation-original-tour';
import { useTwinLocale } from '@/twin/twin-i18n';
import type { TourHudSnapshot } from '@/twin/twin-tour-runtime';

export interface TwinTourHudHandle {
  /** High-frequency tour frame values, pushed from the RAF loop without React state in TwinContent. */
  setHud(hud: TourHudSnapshot | null): void;
}

export interface TwinTourHudProps {
  readonly tourStep: number;
  /** Value pushed when startTour opens the HUD; later frames come through the ref handle. */
  readonly initialHud?: TourHudSnapshot | null;
  readonly onEnd: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** React 19 ref-as-prop (forwardRef removed): the tour controller pushes RAF frames through it. */
  readonly ref?: Ref<TwinTourHudHandle>;
}

/**
 * Cinematic-tour HUD. The dwell countdown/progress and active dot change every
 * RAF tick (~60 Hz); owning that state here keeps TwinContent/FabViewport idle
 * for the whole tour.
 */
export function TwinTourHud({ tourStep, initialHud, onEnd, onPrev, onNext, ref }: TwinTourHudProps) {
  const { t, language } = useTwinLocale();
  const [hud, setHud] = useState<TourHudSnapshot | null>(initialHud ?? null);
  useImperativeHandle(ref, () => ({
    setHud: (next) => setHud((previous) => previous && next
      && previous.tag === next.tag && previous.timerText === next.timerText
      && previous.progressWidth === next.progressWidth && previous.activeDot === next.activeDot
      ? previous
      : next),
  }), []);
  const stop = TOUR_STOPS[tourStep];
  const activeDot = hud?.activeDot ?? tourStep;
  return (
    <section id="cinematic-hud" className="twin-tour-card" aria-label="Cinematic Tour">
      <div className="twin-tour-head">
        <span id="tour-hud-tag">{hud?.tag ?? stop.tag}</span>
        <b id="tour-hud-timer" title={t("驻留计时")}>{hud?.timerText ?? ''}</b>
        <button type="button" onClick={onEnd} aria-label={t("关闭导览")}>{t("跳过")}</button>
      </div>
      <div id="tour-progress-bar" className="twin-tour-progress"><i style={{ width: hud?.progressWidth ?? '100%' }} /></div>
      <h3 id="tour-hud-title">{language === 'zh' ? stop.title : stop.titleEn}</h3>
      <p id="tour-hud-desc">{language === 'zh' ? stop.subtitle : stop.subtitleEn}</p>
      <div id="tour-dots-container" className="twin-tour-dots" role="tablist" aria-label={t("导览站点")}>
        {TOUR_STOPS.map((tourStop, index) => (
          <button id={`tour-dot-${index}`} type="button" role="tab" aria-selected={activeDot === index} key={tourStop.title} className={activeDot === index ? 'active' : ''} title={language === 'zh' ? tourStop.title : tourStop.titleEn} aria-label={language === 'zh' ? tourStop.title : tourStop.titleEn} />
        ))}
      </div>
      <div className="twin-tour-actions">
        <button type="button" onClick={onPrev} disabled={tourStep === 0}>{t("上一步")}</button>
        <button type="button" className="primary" onClick={onNext}>{tourStep === TOUR_STOPS.length - 1 ? t("完成") : t("下一站")}</button>
      </div>
    </section>
  );
}
