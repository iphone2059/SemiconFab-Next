import { describe, expect, it } from 'vitest';
import { applyMesAction, buildTelemetry, computeSpc, createMesJob, createProcessMesJob } from '../src/domain/fab/process-control';
import { FAB_LAYOUT } from '../src/domain/fab/fab-layout';

describe('MES job execution', () => {
  /** Caller-owned authoritative epoch-ms time: the domain never reads Date.now(). */
  const FIXED_MES_TIME = 1_700_000_000_000;
  const jobTool = FAB_LAYOUT[0];
  const equipment = { id: jobTool.recordId || '0', category: jobTool.category, name: jobTool.model, position: { x: jobTool.x } };

  it('creates a deterministic SEMI E40/E87/E94 job and applies all three actions', () => {
    const job = createMesJob(jobTool, 0, FIXED_MES_TIME);
    expect(job).toMatchObject({ state: 'TRACKED_IN', waferSlot: 14, updatedAt: FIXED_MES_TIME });
    expect(job.carrierId).toMatch(/^FOUP-AMHS-\d{2}$/);
    expect(job.recipeId).toMatch(/^RCP-LITH-2NM-V[1-5]\.0$/);
    const again = createMesJob(jobTool, 0, FIXED_MES_TIME + 999);
    expect({ ...again, updatedAt: FIXED_MES_TIME }).toEqual(job);
    const out = applyMesAction(job, 'track-out');
    expect(out.state).toBe('TRACKED_OUT');
    expect(out.waferSlot).toBe(15);
    expect(applyMesAction(out, 'hold').state).toBe('HOLD_MRB');
    // Source actions retain the initialization timestamp; they never advance the clock.
    for (const action of ['track-in', 'track-out', 'hold'] as const) {
      expect(applyMesAction(job, action).updatedAt).toBe(FIXED_MES_TIME);
    }
  });

  it.each([
    ['simulated clock origin', 0],
    ['small integer milliseconds', 100],
    ['epoch milliseconds (2023-11-14T22:13:20Z)', 1_700_000_000_000],
    ['maximum safe integer milliseconds', Number.MAX_SAFE_INTEGER],
  ])('stores a valid caller time verbatim in updatedAt: %s', (_label, nowMs) => {
    expect(createMesJob(jobTool, 0, nowMs).updatedAt).toBe(nowMs);
  });

  it('keeps identity fields independent of the caller timestamp', () => {
    const early = createMesJob(jobTool, 0, 0);
    const late = createMesJob(jobTool, 0, FIXED_MES_TIME);
    expect(late.updatedAt).toBe(FIXED_MES_TIME);
    expect(early.updatedAt).toBe(0);
    expect({ ...late, updatedAt: early.updatedAt }).toEqual(early);
  });

  it('derives the same job identity from a layout tool and its process-equipment projection', () => {
    expect(createProcessMesJob(equipment, FIXED_MES_TIME)).toEqual(createMesJob(jobTool, 0, FIXED_MES_TIME));
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative epoch milliseconds', -1],
    ['fractional milliseconds (no rounding)', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid caller time: %s', (_label, invalid) => {
    expect(() => createMesJob(jobTool, 0, invalid)).toThrow(RangeError);
    expect(() => createProcessMesJob(equipment, invalid)).toThrow(RangeError);
  });

  it('requires an explicit timestamp instead of falling back to Date.now()', () => {
    // @ts-expect-error -- the implicit `now = Date.now()` default was removed: time is mandatory.
    expect(() => createMesJob(jobTool, 0)).toThrow(RangeError);
    // @ts-expect-error -- same required caller-owned time on the process-equipment overload.
    expect(() => createProcessMesJob(equipment)).toThrow(RangeError);
  });
});

describe('SPC capability', () => {
  const sensor = { name: 'x', unit: 'u', value: 10, min: 9, max: 11 };
  const spec = { usl: 10.9, lsl: 9.1, std: 0.001 };

  it('builds four original FDC sensors and computes finite Cp/Cpk with separated statuses', () => {
    const telemetry = buildTelemetry(FAB_LAYOUT[42], 42);
    expect(telemetry.sensors).toHaveLength(4);
    expect(telemetry.history).toHaveLength(20);
    const result = computeSpc(telemetry.history, telemetry.sensors[0]);
    expect(Number.isFinite(result.cp)).toBe(true);
    expect(Number.isFinite(result.cpk)).toBe(true);
    expect(result.sigma).toBeCloseTo(result.cpk * 3);
    expect(['WORLD CLASS (5σ)', 'IN CONTROL', 'ALARM EXCURSION']).toContain(result.status);
    expect(['IN CONTROL', 'ALARM EXCURSION']).toContain(result.controlStatus);
    expect(['IN SPEC', 'OUT OF SPEC']).toContain(result.specStatus);
    expect(result.insufficientData).toBe(false);
    expect(result.rule).not.toContain('Nelson 8 Rules In-Spec');
  });

  it('keeps the real Cp/Cpk (no artificial Cpk floor) and does not report spec PASS for a stable off-spec process', () => {
    // 25 identical samples far above the sensor spec: statistically in control, but not capable.
    const result = computeSpc(Array.from({ length: 25 }, () => 100), sensor);
    expect(result.cp).toBeCloseTo((spec.usl - spec.lsl) / (6 * spec.std), 6);
    const cpu = (spec.usl - 100) / (3 * spec.std);
    const cpl = (100 - spec.lsl) / (3 * spec.std);
    expect(result.cpk).toBeCloseTo(Math.min(cpu, cpl), 6);
    expect(result.cpk).toBeLessThan(0);
    expect(result.cpk).not.toBe(0.2);
    expect(result.controlStatus).toBe('IN CONTROL');
    expect(result.specStatus).toBe('OUT OF SPEC');
    expect(result.status).not.toBe('WORLD CLASS (5σ)');
  });

  it('reports an explicit insufficient-data state instead of fabricated healthy metrics', () => {
    const result = computeSpc([100, 100, 100, 100], sensor);
    expect(result.insufficientData).toBe(true);
    expect(result.controlStatus).toBe('INSUFFICIENT DATA');
    expect(result.specStatus).toBe('INSUFFICIENT DATA');
    expect(result.cp).toBe(0);
    expect(result.cpk).toBe(0);
    expect(result.rule).toContain('Insufficient data');
    expect(result.rule).not.toContain('PASS');
  });

  it('separates IN CONTROL from IN SPEC for a capable, stable dataset', () => {
    const tolerance = (sensor.max - sensor.min) * 0.45;
    const values = Array.from({ length: 25 }, (_, index) => 10 + (index % 2 === 0 ? -1 : 1) * tolerance * 0.1);
    const result = computeSpc(values, sensor);
    expect(result.controlStatus).toBe('IN CONTROL');
    expect(result.specStatus).toBe('IN SPEC');
    expect(result.cpk).toBeGreaterThan(1.33);
  });

  it('keeps the three implemented Nelson rule classes and never claims all eight', () => {
    const trend = Array.from({ length: 6 }, (_, index) => 10 + index);
    const wideSensor = { name: 'x', unit: 'u', value: 10, min: 0, max: 20 };
    const alarm = computeSpc(trend, wideSensor);
    expect(alarm.rule).toContain('Rule 3');
    expect(alarm.controlStatus).toBe('ALARM EXCURSION');
    expect(alarm.status).toBe('ALARM EXCURSION');
    const steady = computeSpc(Array.from({ length: 25 }, (_, index) => 10 + (index % 2 === 0 ? -0.1 : 0.1)), wideSensor);
    expect(steady.controlStatus).toBe('IN CONTROL');
    expect(steady.rule).toContain('Rule 1–3 of Nelson 8 monitored');
    expect(steady.rule).not.toContain('PASS');
  });

  it('reports a down tool as a control alarm without inventing a capability pass', () => {
    const result = computeSpc(Array.from({ length: 25 }, () => 10), sensor, true);
    expect(result.controlStatus).toBe('ALARM EXCURSION');
    expect(result.rule).toContain('Rule 1');
  });
});
