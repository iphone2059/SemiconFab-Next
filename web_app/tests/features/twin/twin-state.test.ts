import { describe, expect, it } from 'vitest';
import { createTwinUiState, projectTwinSceneState, twinUiReducer, type SpatialMode } from '@/twin/twin-state';

const spatial: Exclude<SpatialMode, null>[] = ['aerodynamics', 'exploded', 'cut', 'xray'];
describe('single Twin UI state', () => {
  it('exclusively switches every spatial pair, and a repeated click turns the mode off', () => {
    for (const first of spatial) for (const second of spatial) {
      let state = twinUiReducer(createTwinUiState(), { type: 'spatial/toggle', mode: first });
      state = twinUiReducer(state, { type: 'spatial/toggle', mode: second });
      expect(state.spatialMode).toBe(first === second ? null : second);
      const projection = projectTwinSceneState(state);
      expect([projection.cut.active, projection.explodeFactor > 0, projection.xray !== null, projection.airflow].filter(Boolean)).toHaveLength(first === second ? 0 : 1);
    }
  });
  it('clears cut/ghost/explode/aero on level changes and restores a valid level', () => {
    let state = twinUiReducer(createTwinUiState(), { type: 'spatial/toggle', mode: 'exploded' });
    expect(state.level).toBe('EXPLODED');
    state = twinUiReducer(state, { type: 'level/set', level: 'B1' });
    expect(projectTwinSceneState(state)).toMatchObject({ basement: true, dual: false, explodeFactor: 0, xray: null, airflow: false, cut: { active: false } });
    state = twinUiReducer(state, { type: 'spatial/toggle', mode: 'cut' });
    expect(state.level).toBe('B1');
    expect(projectTwinSceneState(state).cut.active).toBe(true);
  });
  it('preserves user cut/filter/slider settings across exclusive mode changes', () => {
    let state = twinUiReducer(createTwinUiState(), { type: 'cut/set', axis: 'Y', positionM: -5, invert: true });
    state = twinUiReducer(state, { type: 'explode/set', percent: 50 });
    expect(projectTwinSceneState(state).explodeFactor).toBe(0.5);
    state = twinUiReducer(state, { type: 'xray/set', filter: 'gas' });
    expect(projectTwinSceneState(state)).toMatchObject({ xray: 'gas', explodeFactor: 0, cut: { active: false, axis: 'Y', positionM: -5, invert: true } });
    state = twinUiReducer(state, { type: 'spatial/toggle', mode: 'cut' });
    expect(projectTwinSceneState(state).xray).toBeNull();
  });
  it('keeps Tour scene navigation separate from the process lifecycle projection', () => {
    let state = { ...createTwinUiState('research'), wafer: { active: true, playing: true, speed: 1 as const } };
    state = twinUiReducer(state, { type: 'tour/scene-step', level: 'B1', view: 'iso' });
    expect(state).toMatchObject({ entryMode: 'visitor', level: 'B1', view: 'iso', wafer: { active: false, playing: false }, onboarding: { open: false }, research: { playing: false } });
    expect('tour' in state).toBe(false);
    state = twinUiReducer(state, { type: 'mode/set', mode: 'research' });
    expect(state.statusSource).toBe('research-replay');
    state = twinUiReducer(state, { type: 'research/play', playing: true });
    state = twinUiReducer(state, { type: 'wafer/open' });
    expect(state.entryMode).toBe('engineer');
    expect(state.research.playing).toBe(false);
    expect(state.wafer.active).toBe(true);
    state = twinUiReducer(state, { type: 'onboarding/open' });
    expect(state.wafer.active).toBe(false);
    expect(state.onboarding.open).toBe(true);
  });
  it('keeps Escape presentation-only; the Tour runtime owns its stop transition', () => {
    let state = twinUiReducer(createTwinUiState('visitor'), { type: 'tour/scene-step', level: 'B1' });
    state = twinUiReducer(state, { type: 'onboarding/open' });
    state = twinUiReducer(state, { type: 'escape' });
    expect(state).toMatchObject({ level: 'B1', onboarding: { open: false } });
    expect('tour' in state).toBe(false);
  });
  it('separates demo/live authority, restores it after replay, and stops a completed replay clock', () => {
    let state = twinUiReducer(createTwinUiState(), { type: 'source/set', source: 'demo' });
    state = twinUiReducer(state, { type: 'mode/set', mode: 'research' });
    state = twinUiReducer(state, { type: 'research/play', playing: true });
    state = twinUiReducer(state, { type: 'research/advance', deltaSec: 50, durationSec: 20 });
    expect(state.research).toMatchObject({ timeSec: 20, playing: false });
    state = twinUiReducer(state, { type: 'mode/set', mode: 'engineer' });
    expect(state.statusSource).toBe('demo');
  });
  it('only shows aero heatmap within Aero and suppresses L1 particles in B1', () => {
    let state = twinUiReducer(createTwinUiState(), { type: 'aero/heatmap' });
    expect(projectTwinSceneState(state)).toMatchObject({ airflow: true, heatmap: true });
    state = twinUiReducer(state, { type: 'spatial/toggle', mode: 'xray' });
    expect(projectTwinSceneState(state)).toMatchObject({ airflow: false, heatmap: false });
    state = twinUiReducer(state, { type: 'level/set', level: 'B1' });
    state = twinUiReducer(state, { type: 'spatial/toggle', mode: 'aerodynamics' });
    expect(projectTwinSceneState(state).airflow).toBe(false);
  });
});
