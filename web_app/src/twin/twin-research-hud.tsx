import { useAtomValue } from '@effect/atom-react';
import type { FabToolState } from '@/domain/fab-layout';
import { researchClock } from '@/domain/simulation-research-replay';
import { AmhsResearchBadge } from '@/twin/twin-amhs-hud';
import { twinResearchAtom } from '@/twin/twin-research.atom';
import { useResearchPlayback, type TwinResearchPlaybackParams } from '@/twin/use-research-playback';
export interface TwinResearchHudProps {
  readonly scopeKey: string;
  readonly replayBase: readonly FabToolState[];
  readonly showResearchUtil: boolean;
  readonly onToggleResearchUtil: () => void;
  readonly t: TwinResearchPlaybackParams['t'];
}
export function TwinResearchHud({ scopeKey, replayBase, showResearchUtil, onToggleResearchUtil, t }: TwinResearchHudProps) {
  const { research, researchTime, researchPlaying, researchSpeed, loading, error, parseError, snapshot, replayProjection, setResearchPlaying, setResearchTime, setResearchSpeed } = useResearchPlayback({ mode: 'research', replayBase, scopeKey, t });
  return (
    <section id="research-hud" className="twin-research-hud" aria-label="Research Replay">
      <div className="twin-research-head">
        <span className="technical">RESEARCH REPLAY · JSONL</span>
        <span>{research ? `${research.eventCount.toLocaleString('en-US')} rows` : 'display projection'}</span>
      </div>
      {loading && <p className="twin-research-status">{t('正在载入 27,263 行展示事件…')}</p>}
      {error && <p className="twin-research-status error-text">{t('回放加载失败：')}{error}</p>}
      {parseError && <p className="twin-research-status twin-research-parse-error error-text">{t('回放数据解析失败：')}{parseError}</p>}
      {research && snapshot && (
        <>
          <div className="twin-research-clock">
            <strong id="research-time-clock">{researchClock(researchTime)}</strong>
            <span>{researchTime.toFixed(0)} s / {research.durationSec.toFixed(0)} s</span>
          </div>
          <input id="research-scrubber" className="twin-research-scrubber" type="range" min={0} max={Math.max(1, research.durationSec)} step={1} value={researchTime} onChange={event => { setResearchPlaying(false); setResearchTime(Number(event.target.value)); }} aria-label={t('回放时间轴')} />
          <div className="twin-research-controls">
            <button id="research-play-btn" type="button" onClick={() => { if (researchTime >= research.durationSec) setResearchTime(0); setResearchPlaying(!researchPlaying); }}>{researchPlaying ? t('暂停') : t('播放')}</button>
            {([1, 10, 100, 500] as const).map(speed => (
              <button type="button" key={speed} className={researchSpeed === speed ? 'active' : ''} onClick={() => setResearchSpeed(speed)}>{speed}×</button>
            ))}
          </div>
          <div className="twin-research-stats">
            <div><span>WIP</span><strong id="research-wip-val">{snapshot.wip} lots</strong><small>{snapshot.wip * 25} wafers</small></div>
            <div><span>ACTIVE</span><strong>{snapshot.activeTools}</strong><small>tools</small></div>
            <div><span>TOP UTIL</span><strong>{(snapshot.utilization[0]?.utilization ?? 0).toFixed(1)}%</strong><small>{snapshot.utilization[0]?.toolGroup ?? '—'}</small></div>
          </div>
          <button id="btn-toggle-util-overlay" type="button" className="twin-research-util-toggle" aria-pressed={showResearchUtil} onClick={onToggleResearchUtil}>{t('利用率热力图')}</button>
          {showResearchUtil && <div id="research-utilization-overlay" className="twin-research-util">
            {snapshot.utilization.slice(0, 4).map(group => (
              <div key={group.toolGroup}>
                <span>{group.toolGroup}</span>
                <i><b style={{ width: `${Math.min(100, group.utilization)}%` }} /></i>
                <em>{group.busy}/{group.total}</em>
              </div>
            ))}
          </div>}
          <AmhsResearchBadge />
          <p className="twin-research-footnote">{t('只读展示事件流，不是 Checkpoint/WAL。原版别名命中')}{replayProjection?.mappedCount ?? 0}{t('/121 台；未映射设备保留进入回放前的状态。217 台仿真设备与布局不是一一对应。AMHS 为独立动画时钟，JSONL 无运输事件。')}</p>
        </>
      )}
    </section>
  );
}
export function TwinResearchFooter({ scopeKey }: { readonly scopeKey: string }) {
  const snapshot = useAtomValue(twinResearchAtom, value => value.scopeKey === scopeKey ? value.snapshot : undefined);
  return <span>REPLAY · WIP {snapshot?.wip ?? 0} · ACTIVE {snapshot?.activeTools ?? 0}</span>;
}