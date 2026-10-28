import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { FabToolState } from '../../fab-layout';
import { computeFabYield, DEFAULT_YIELD_INPUT, scenarioStates, YIELD_SCENARIOS, type YieldInput } from '../../fab-yield';
import { ORIGINAL_TWIN_UI } from '../../original-twin-data';
import { useTwinDemoStore } from '../../state/twinDemoStore';
import { twinPageActions, useTwinPageStore } from '../../state/twinPageStore';
import { resolveScenario } from '../../twin-equipment';
import {
  BIN_COLORS, BIN_LABELS, WM811K_DEFECT_METADATA, generateWaferMap, stdfSummary, theoreticalYieldModels, waferMetrics,
  type BinCode, type DefectPattern, type WaferDie,
} from '../../wafer-map';
import { useTwinLocale } from './twin-i18n';
import { Modal, ModalTitle } from '../../components/modal';

interface YmsProjectionProps {
  /** Page-projected tool states; the yield waterfall reuses the same live/demo/replay source as the scene. */
  toolStates: readonly FabToolState[];
}

/**
 * Shared cascading-yield projection for the header pill and the YMS waterfall.
 * Subscribing to the yield inputs here (instead of the page) keeps YMS slider
 * and scenario changes out of TwinContent/FabViewport.
 */
function useFabYieldProjection(toolStates: readonly FabToolState[]) {
  const { yieldInput, yieldScenario } = useTwinPageStore(useShallow((state) => ({
    yieldInput: state.yms.yieldInput,
    yieldScenario: state.yms.yieldScenario,
  })));
  const { referenceLights, scenarioId, yieldJitter } = useTwinDemoStore(useShallow((state) => ({
    referenceLights: state.referenceLights,
    scenarioId: state.scenarioId,
    yieldJitter: state.yieldJitter,
  })));
  const yieldStates = useMemo(() => {
    if (yieldScenario === 'live') return toolStates;
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === yieldScenario);
    return scenario ? scenarioStates(scenario) : toolStates;
  }, [toolStates, yieldScenario]);
  const yieldDirectoryStates = useMemo(() => {
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === yieldScenario);
    const states: Record<string, FabToolState> = {};
    for (const row of ORIGINAL_TWIN_UI.equipment) {
      const override = scenario?.overrides[row.id];
      states[row.id] = override
        ? override.toLowerCase() as FabToolState
        : yieldScenario === 'live' ? (referenceLights[row.id] ?? 'running') : 'running';
    }
    return states;
  }, [yieldScenario, referenceLights]);
  const yieldUnresolved = useMemo(() => {
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === yieldScenario);
    return scenario ? resolveScenario(scenario).unresolvedIds : [];
  }, [yieldScenario]);
  const fabYield = useMemo(() => computeFabYield(yieldStates, yieldInput, {
    directoryStates: yieldDirectoryStates,
    scenarioId: yieldScenario === 'live' ? scenarioId : yieldScenario,
    jitter: yieldJitter,
  }), [yieldStates, yieldInput, yieldDirectoryStates, yieldScenario, scenarioId, yieldJitter]);
  return { fabYield, yieldInput, yieldScenario, yieldUnresolved };
}

/**
 * Header yield pill. The pill and the throughput value stay in the subbar DOM
 * (the components render a fragment), but their cascading-yield inputs are
 * subscribed here instead of through TwinContent.
 */
export function TwinYieldPill({ toolStates }: YmsProjectionProps) {
  const { t } = useTwinLocale();
  const { fabYield } = useFabYieldProjection(toolStates);
  return (
    <>
      <button id="header-yield-val" className="twin-yield-pill" type="button" title="Cascading Yield Model" onClick={() => { twinPageActions.ymsOpenSet(true); twinPageActions.ymsTabSet('yield'); }}>{(fabYield.totalYield * 100).toFixed(2)}%⌄</button>
      <span id="header-wpm-val" className="twin-throughput">{fabYield.wpm.toLocaleString('en-US')}<small>{t("片/月")}</small></span>
    </>
  );
}

/**
 * Static die grid. Hover/readout state lives one level up, so memoising this
 * keeps the ~460 rects and their event closures from being rebuilt on every
 * cross-die hover; the DOM is byte-for-byte the former inline markup.
 */
const WaferDieMap = memo(function WaferDieMap({ dies }: { dies: readonly WaferDie[] }) {
  return (
    <>
      {dies.map((die) => (
        <rect key={`${die.r}-${die.c}`} x={160 + die.dx - 5.15} y={160 + die.dy - 5.15} width={10.3} height={10.3} rx={1.5} fill={BIN_COLORS[die.bin]} stroke="#fff" strokeWidth={0.3} onMouseEnter={() => twinPageActions.ymsHoverDieSet({ r: die.r, c: die.c, bin: die.bin })} onMouseLeave={() => twinPageActions.ymsHoverDieSet(undefined)} />
      ))}
    </>
  );
});

/**
 * YMS wafer-map / yield-waterfall dialog. Every store branch this dialog renders
 * (map pattern, hover, die area, D0, alpha, yield inputs, scenario, STDF copied)
 * and the derived die-map/yield computations live inside this child, so a
 * cross-die hover rerenders only the readout instead of TwinContent and
 * FabViewport.
 */
export function TwinYmsPanel({ toolStates }: YmsProjectionProps) {
  const { t } = useTwinLocale();
  const { tab: ymsTab, pattern: waferPattern, seed: waferSeed, hoverDie, dieArea, defectD0, clusterAlpha, stdfCopied } = useTwinPageStore(useShallow((state) => ({
    tab: state.yms.tab,
    pattern: state.yms.pattern,
    seed: state.yms.seed,
    hoverDie: state.yms.hoverDie,
    dieArea: state.yms.dieArea,
    defectD0: state.yms.defectD0,
    clusterAlpha: state.yms.clusterAlpha,
    stdfCopied: state.yms.stdfCopied,
  })));
  const { fabYield, yieldInput, yieldScenario, yieldUnresolved } = useFabYieldProjection(toolStates);
  const waferDies = useMemo(() => generateWaferMap(waferPattern, waferSeed), [waferPattern, waferSeed]);
  const waferAnalytics = useMemo(() => waferMetrics(waferDies), [waferDies]);
  const yieldModels = useMemo(() => theoreticalYieldModels(dieArea, defectD0, clusterAlpha), [dieArea, defectD0, clusterAlpha]);
  const stdf = useMemo(() => stdfSummary(waferDies, waferPattern), [waferDies, waferPattern]);

  const selectWaferPattern = (value: DefectPattern) => twinPageActions.ymsRandomize(value);
  const setDieArea = (value: number) => twinPageActions.ymsDieAreaSet(value);
  const setDefectD0 = (value: number) => twinPageActions.ymsDefectD0Set(value);
  const setClusterAlpha = (value: number) => twinPageActions.ymsClusterAlphaSet(value);
  const setYieldInput = (value: YieldInput | ((current: YieldInput) => YieldInput)) => {
    if (typeof value === 'function') twinPageActions.ymsYieldInputSet(value(yieldInput));
    else twinPageActions.ymsYieldInputSet(value);
  };
  const setStdfCopied = (value: boolean) => twinPageActions.ymsStdfCopiedSet(value);
  function chooseYieldScenario(id: string): void {
    twinPageActions.ymsYieldScenarioSet(id);
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === id);
    twinPageActions.ymsYieldInputSet(scenario ? { purity: scenario.purity, health: scenario.health, lagTime: scenario.lagTime } : DEFAULT_YIELD_INPUT);
  }

  return (
    <Modal backdropClassName="twin-yms-backdrop" className="twin-yms" label="YMS yield management"
      onClose={() => twinPageActions.ymsOpenSet(false)}>
        <header className="twin-yms-head">
          <div><ModalTitle asChild><strong>YMS · YIELD MANAGEMENT</strong></ModalTitle><span>WM-811K SPATIAL CLASSIFIER · 8-STAGE CASCADING YIELD</span></div>
          <nav>
            <button type="button" className={ymsTab === 'map' ? 'active' : ''} onClick={() => twinPageActions.ymsTabSet('map')}>Wafer Map</button>
            <button type="button" className={ymsTab === 'yield' ? 'active' : ''} onClick={() => twinPageActions.ymsTabSet('yield')}>Yield Waterfall</button>
          </nav>
          <button type="button" className="twin-yms-close" aria-label={t("关闭 YMS")} onClick={() => twinPageActions.ymsOpenSet(false)}>×</button>
        </header>

        {ymsTab === 'map' ? (
          <div className="twin-yms-map">
            <aside className="twin-patterns">
              <span className="twin-yms-label">WM-811K PATTERNS</span>
              {(Object.keys(WM811K_DEFECT_METADATA) as DefectPattern[]).map((pattern) => (
                <button type="button" key={pattern} className={waferPattern === pattern ? 'active' : ''} onClick={() => selectWaferPattern(pattern)}>
                  <b>{WM811K_DEFECT_METADATA[pattern].name}</b>
                  <small>{WM811K_DEFECT_METADATA[pattern].confidence} confidence</small>
                </button>
              ))}
              <button type="button" className="twin-yms-random" onClick={() => { const patterns = Object.keys(WM811K_DEFECT_METADATA) as DefectPattern[]; selectWaferPattern(patterns[Math.floor(Math.random() * patterns.length)]); }}>{t("随机模式")}</button>
            </aside>
            <div className="twin-wafer-stage">
              <svg viewBox="0 0 320 320" role="img" aria-label="300mm wafer die map">
                <circle cx="160" cy="160" r="149" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="3" />
                <circle cx="160" cy="160" r="145" fill="#0f172a" stroke="#94a3b8" strokeWidth="1.5" />
                <circle cx="160" cy="160" r="139" fill="#1e293b" opacity="0.6" />
                <WaferDieMap dies={waferDies} />
                <path d="M152 305 Q160 295 168 305" fill="none" stroke="#64748b" strokeWidth="2" />
              </svg>
              <div className="twin-wafer-hover">{hoverDie ? `Die [R${hoverDie.r}, C${hoverDie.c}] · ${BIN_LABELS[hoverDie.bin]}` : `300 mm · ${waferAnalytics.total} dies · Notch 180°`}</div>
            </div>
            <aside className="twin-yms-analytics">
              <div className="twin-yms-pattern"><span>CLASSIFIED PATTERN</span><b>{WM811K_DEFECT_METADATA[waferPattern].name}</b><small>Confidence {WM811K_DEFECT_METADATA[waferPattern].confidence}</small></div>
              <p>{WM811K_DEFECT_METADATA[waferPattern].desc}</p>
              <div className="twin-yms-cause"><span>ROOT CAUSE</span>{WM811K_DEFECT_METADATA[waferPattern].rootCause}</div>
              <div className="twin-yms-yield-row"><div><span>GROSS YIELD</span><b>{waferAnalytics.yieldPct.toFixed(1)}%</b><small>{waferAnalytics.good} / {waferAnalytics.total} dies</small></div><div><span>MODEL LOSS</span><b>{WM811K_DEFECT_METADATA[waferPattern].lossPct.toFixed(1)}%</b><small>D0 {waferAnalytics.d0.toFixed(3)}/cm²</small></div></div>
              <div className="twin-bin-list">
                {([1, 2, 3, 4, 5] as BinCode[]).map((bin) => <div key={bin}><i style={{ background: BIN_COLORS[bin] }} /><span>{BIN_LABELS[bin]}</span><b>{waferAnalytics.bins[bin]} · {((waferAnalytics.bins[bin] / Math.max(1, waferAnalytics.total)) * 100).toFixed(1)}%</b></div>)}
              </div>
              <div className="twin-yield-models">
                <span className="twin-yms-label">THEORETICAL YIELD MODELS</span>
                <label>Die area <b>{dieArea} mm²</b><input type="range" min={25} max={300} step={5} value={dieArea} onChange={(event) => setDieArea(Number(event.target.value))} /></label>
                <label>Defect D0 <b>{defectD0.toFixed(2)} /cm²</b><input type="range" min={0.02} max={0.6} step={0.01} value={defectD0} onChange={(event) => setDefectD0(Number(event.target.value))} /></label>
                <label>Cluster α <b>{clusterAlpha.toFixed(2)}</b><input type="range" min={0.5} max={6} step={0.1} value={clusterAlpha} onChange={(event) => setClusterAlpha(Number(event.target.value))} /></label>
                <div className="twin-model-grid"><div><span>POISSON</span><b>{yieldModels.poisson.toFixed(1)}%</b></div><div><span>MURPHY</span><b>{yieldModels.murphy.toFixed(1)}%</b></div><div><span>SEEDS</span><b>{yieldModels.seeds.toFixed(1)}%</b></div></div>
              </div>
              <div className="twin-stdf-head"><span>STDF V4 PREVIEW</span><button type="button" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(stdf, null, 2)).then(() => { setStdfCopied(true); window.setTimeout(() => setStdfCopied(false), 1800); }).catch(() => {}); }}>{stdfCopied ? 'Copied' : 'Copy JSON'}</button></div>
              <pre className="twin-stdf">{`MIR: LotID="LOT-300-8842", TestCode="CP1", Fab="FAB-1", Tester="ADVANTEST-V93K"
WIR: WaferID="W-14", Diameter=300mm, Notch=180, TotalDies=${waferAnalytics.total}, Tested=${waferAnalytics.total}
PRR: PassCount=${waferAnalytics.good}, FailCount=${waferAnalytics.total - waferAnalytics.good}, GrossYield=${waferAnalytics.yieldPct.toFixed(2)}%, D0_Est=${waferAnalytics.d0.toFixed(3)}/cm²
BIN_SUMMARY: Bin1=${waferAnalytics.bins[1]}, Bin2=${waferAnalytics.bins[2]}, Bin3=${waferAnalytics.bins[3]}, Bin4=${waferAnalytics.bins[4]}, Bin5=${waferAnalytics.bins[5]}`}</pre>
            </aside>
          </div>
        ) : (
          <div className="twin-yield-view">
            <div className="twin-yield-summary">
              <div><span>OVERALL FAB YIELD</span><b>{(fabYield.totalYield * 100).toFixed(2)}%</b><small>Y_fab = ∏ Y_i</small></div>
              <div><span>EFFECTIVE CAPACITY</span><b>{fabYield.wpm.toLocaleString()}</b><small>wafers / month</small></div>
              <div><span>BOTTLENECK</span><b>{fabYield.bottleneck.short}</b><small>{fabYield.bottleneck.name}</small></div>
            </div>
            <div className="twin-yield-scenarios" aria-label="Yield scenarios">
              <button type="button" className={yieldScenario === 'live' ? 'active' : ''} onClick={() => chooseYieldScenario('live')}>LIVE</button>
              {YIELD_SCENARIOS.map((scenario) => <button type="button" key={scenario.id} className={yieldScenario === scenario.id ? 'active' : ''} onClick={() => chooseYieldScenario(scenario.id)}>{scenario.name}</button>)}
            </div>
            {yieldUnresolved.length > 0 && <p className="twin-data-note">{t("此原版场景的旧设备 ID 不在当前布局中，未施加类别级 DOWN：")}{yieldUnresolved.join(', ')}</p>}
            <div className="twin-yield-bars">
              {fabYield.modules.map((entry) => (
                <div key={entry.module.id} className={entry.bottleneck ? 'bottleneck' : ''}>
                  <span className="twin-yield-icon">{entry.module.icon}</span>
                  <span className="twin-yield-name">{entry.module.short} · {entry.module.name}</span>
                  <b className="twin-yield-step">{(entry.stepYield * 100).toFixed(2)}%</b>
                  <i><b style={{ width: `${Math.min(100, entry.cumulativeYield * 100)}%` }} /></i>
                  <em>{(entry.cumulativeYield * 100).toFixed(1)}%</em>
                  {entry.bottleneck && <strong>BOTTLENECK</strong>}
                </div>
              ))}
            </div>
            <div className="twin-yield-inputs">
              <label>Raw material purity <b>{yieldInput.purity.toFixed(1)}N</b><input type="range" min={4} max={6} step={0.1} value={yieldInput.purity} onChange={(event) => setYieldInput((current) => ({ ...current, purity: Number(event.target.value) }))} /></label>
              <label>Equipment health <b>{yieldInput.health.toFixed(1)}%</b><input type="range" min={70} max={100} step={0.1} value={yieldInput.health} onChange={(event) => setYieldInput((current) => ({ ...current, health: Number(event.target.value) }))} /></label>
              <label>Queue lag <b>{yieldInput.lagTime.toFixed(1)} h</b><input type="range" min={0} max={16} step={0.1} value={yieldInput.lagTime} onChange={(event) => setYieldInput((current) => ({ ...current, lagTime: Number(event.target.value) }))} /></label>
            </div>
          </div>
        )}
    </Modal>
  );
}
