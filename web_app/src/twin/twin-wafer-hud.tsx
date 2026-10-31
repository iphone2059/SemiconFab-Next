import { useAtomValue } from '@effect/atom-react';
import { OriginalIcon } from '@/components/original-icons';
import { twinWaferAtom } from '@/twin/twin-wafer.atom';
import type { WaferProduct } from '@/domain/wafer-route';
import { useTwinLocale } from '@/twin/twin-i18n';

export interface TwinWaferHudProps {
  /** True once the A/B/C route data landed; the HUD rows need it. */
  routesReady: boolean;
  /** Localised route-load failure message (empty when there is no error). */
  error: string;
  onClose(): void;
  onProductChange(product: WaferProduct): void;
  onTogglePlay(): void;
  onSpeedChange(speed: 1 | 4 | 16): void;
  onFollowChange(follow: boolean): void;
  onReplay(): void;
}

/**
 * Wafer-follow HUD. It subscribes to discrete process projections and HUD
 * snapshots; position, trail and camera frames are applied directly to the scene.
 * Every id/class/label matches the former inline markup.
 */
export function TwinWaferHud({ routesReady, error, onClose, onProductChange, onTogglePlay, onSpeedChange, onFollowChange, onReplay }: TwinWaferHudProps) {

  const { t } = useTwinLocale();
  const product = useAtomValue(twinWaferAtom, (state) => state.product);
  const hud = useAtomValue(twinWaferAtom, (state) => state.hud);
  const completed = useAtomValue(twinWaferAtom, (state) => state.completed);
  const follow = useAtomValue(twinWaferAtom, (state) => state.follow);
  const playing = useAtomValue(twinWaferAtom, (state) => state.playing);
  const speed = useAtomValue(twinWaferAtom, (state) => state.speed);
  return (
    <section id="wafer-follow-panel" className="twin-wafer" aria-label="Wafer Follow">
      <div className="twin-wafer-head"><div><OriginalIcon name="wafer" /><strong>{t('跟随晶圆漫游')}</strong><span id="wafer-route-badge">{hud?.badge}</span></div><button type="button" onClick={onClose} aria-label={t("关闭晶圆跟随")}>×</button></div>
      {error && <p className="twin-wafer-error">{t("路线加载失败：")}{error}</p>}
      {!routesReady && !error && <p className="twin-wafer-error">{t("正在加载 A/B/C 路线…")}</p>}
      {routesReady && hud && (
        <>
          <div className="twin-wafer-row">
            <label>{t('产品:')}
              <select id="wafer-product-select" value={product} onChange={(event) => onProductChange(event.target.value as WaferProduct)} aria-label={t("晶圆产品")}>
                <option value="A">Product A (120 Steps)</option>
                <option value="B">Product B (104 Steps)</option>
                <option value="C">Product C (92 Steps)</option>
              </select>
            </label>
            <div className="twin-wafer-actions">
              <button id="wafer-play-btn" type="button" onClick={onTogglePlay} title="Play / Pause" aria-label={playing ? t('暂停') : t('播放')}><OriginalIcon name={playing ? 'pause' : 'play'} /></button>
              <div className="twin-wafer-speeds">{([1, 4, 16] as const).map((value) => <button id={`wafer-speed-${value}`} type="button" key={value} className={speed === value ? 'active' : ''} onClick={() => onSpeedChange(value)}>{value}x</button>)}</div>
              <button id="wafer-cam-toggle-btn" type="button" className={follow ? 'active' : ''} aria-pressed={follow} onClick={() => onFollowChange(!follow)}><span id="wafer-cam-text">{follow ? t('跟随视角') : t('自由视角')}</span></button>
              <button id="wafer-replay-btn" hidden={!completed} type="button" onClick={onReplay}>{t('重播')}</button>
            </div>
          </div>
          <div className="twin-wafer-readouts"><b id="wafer-step-readout">{hud.step}</b><span id="wafer-status-readout">{hud.status}</span></div>
          <div className="twin-wafer-progress"><div id="wafer-progress-bar" style={{ width: hud.width }} /></div>
          <div className="twin-wafer-step">
            <div><span>TOOL GROUP</span><strong id="wafer-tg-val">{hud.toolGroup}</strong></div>
            <div><span>RECIPE</span><strong id="wafer-recipe-val">{hud.recipe}</strong></div>
            <div><span>BAY LOCATION</span><strong id="wafer-bay-val">{hud.bay}</strong></div>
          </div>
          <p className="twin-wafer-disclosure">{t('示意：晶圆访问每类设备的代表性机台，不代表实际派工。')}</p>
        </>
      )}
    </section>
  );
}
