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
    const out = applyMesAction(job, 'track-out', 200);
    expect(out.state).toBe('TRACKED_OUT');
    expect(out.waferSlot).toBe(15);
    expect(applyMesAction(out, 'hold', 300).state).toBe('HOLD_MRB');
  });
});

describe('SPC capability', () => {
  it('builds four original FDC sensors and computes Cp/Cpk/sigma and Nelson rules', () => {
    const telemetry = buildTelemetry(FAB_LAYOUT[42], 42);
    expect(telemetry.sensors).toHaveLength(4);
    expect(telemetry.history).toHaveLength(20);
    const result = computeSpc(telemetry.history, telemetry.sensors[0]);
    expect(result.cp).toBeGreaterThan(0);
    expect(result.cpk).toBeGreaterThanOrEqual(0.2);
    expect(result.sigma).toBeCloseTo(result.cpk * 3);
    expect(['WORLD CLASS (5σ)', 'IN CONTROL', 'ALARM EXCURSION']).toContain(result.status);
    const trend = Array.from({ length: 6 }, (_, index) => 10 + index);
    const trendSensor = { name: 'x', unit: 'u', value: 10, min: 0, max: 20 };
    expect(computeSpc(trend, trendSensor).rule).toContain('Rule 3');
  });
});
