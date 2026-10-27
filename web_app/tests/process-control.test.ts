import { describe, expect, it } from 'vitest';
import { applyMesAction, buildTelemetry, computeSpc, createMesJob } from '../src/process-control';
import { FAB_LAYOUT } from '../src/fab-layout';

describe('MES job execution', () => {
  it('creates a deterministic SEMI E40/E87/E94 job and applies all three actions', () => {
    const job = createMesJob(FAB_LAYOUT[0], 0, 100);
    expect(job).toMatchObject({ state: 'TRACKED_IN', waferSlot: 14, updatedAt: 100 });
    expect(job.carrierId).toMatch(/^FOUP-AMHS-\d{2}$/);
    expect(job.recipeId).toMatch(/^RCP-LITH-2NM-V[1-5]\.0$/);
    const again = createMesJob(FAB_LAYOUT[0], 0, 999);
    expect({ ...again, updatedAt: 100 }).toEqual(job);
    const out = applyMesAction(job, 'track-out');
    expect(out.state).toBe('TRACKED_OUT');
    expect(out.waferSlot).toBe(15);
    expect(applyMesAction(out, 'hold').state).toBe('HOLD_MRB');
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
