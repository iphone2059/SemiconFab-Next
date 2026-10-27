import { expect, it, vi } from 'vitest';
import { advanceLaminarParticle, classifyCleanroomPressure, cleanroomPressureField } from '../src/cleanroom-pressure';

it('preserves the original pressure regions, airlock gradient and branch precedence', () => {
  expect(cleanroomPressureField(0, 0)).toMatchObject({ pressure: 15.15, gradZ: 0, isLitho: false });
  expect(cleanroomPressureField(-30, -12).pressure).toBeCloseTo(30.19550602353302, 10);
  expect(cleanroomPressureField(-15, 3)).toMatchObject({ pressure: 22.5, gradZ: -3.75, isAirlock: true });
  expect(cleanroomPressureField(12, 34)).toMatchObject({ pressure: 7.5, gradZ: -3.75, isAirlock: true });
  expect(cleanroomPressureField(0, 37).pressure).toBe(0);
  // The original tests Litho before Airlock in this overlapping region.
  expect(cleanroomPressureField(-17, 3).pressure).toBeCloseTo(29.888463256521717, 10);
});

it('advects under pressure and obstacles and respawns at the FFU ceiling deterministically', () => {
  const particle = { x: -15, y: 2, z: 3, vy: 0.036 };
  advanceLaminarParticle(particle, 1 / 60, [], () => 0.5);
  expect(particle.y).toBeCloseTo(1.96);
  expect(particle.z).toBeCloseTo(3.03375);
  const obstacle = { x: 0, z: 0, halfW: 2, halfL: 2, topY: 3 };
  const inside = { x: 0.1, y: 2, z: 0.1, vy: 0.036 };
  advanceLaminarParticle(inside, 1 / 60, [obstacle], () => 0.5);
  expect(inside.x).toBeCloseTo(0.125);
  const bottom = { x: 0, y: 0.051, z: 0, vy: 0.036 };
  advanceLaminarParticle(bottom, 1 / 60, [], () => 0.5);
  expect(bottom).toMatchObject({ x: 0, y: 7.75, z: 0 });
});

it('classifies every field branch exactly, including region boundaries', () => {
  const xs = [-60, -18.500000000000004, -18.5, -18.499999999999996, -17, -16.500000000000004, -16.5,
    -16.499999999999996, -14.5, -14.499999999999998, 0, 9.999999999999998, 10, 12, 14, 14.000000000000002, 30];
  const zs = [-50, 0, 1, 2.0666666666666664, 2.0666666666666669, 3, 4.5, 4.500000000000001, 5, 5.000000000000001,
    32, 34, 36, 36.00000000000001, 37, 40];
  for (const x of xs) for (const z of zs) {
    const field = cleanroomPressureField(x, z), region = classifyCleanroomPressure(x, z);
    expect([x, z, region.isLitho, region.isAirlock, region.gradZ, region.highPressure])
      .toEqual([x, z, field.isLitho, field.isAirlock, field.gradZ, field.pressure >= 26]);
  }
});

it('matches the field over a seeded random grid', () => {
  let seed = 0x9e3779b9;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let index = 0; index < 20000; index++) {
    const x = -60 + random() * 120, z = -50 + random() * 100;
    const field = cleanroomPressureField(x, z), region = classifyCleanroomPressure(x, z);
    expect([x, z, region.isLitho, region.isAirlock, region.gradZ, region.highPressure])
      .toEqual([x, z, field.isLitho, field.isAirlock, field.gradZ, field.pressure >= 26]);
  }
});

it('marks exactly the 26 Pa band at the airlock ramp threshold t = 4/15', () => {
  const threshold = 4 / 15;
  for (const x of [-15, -16]) { // inside the litho airlock footprint but not the litho bay
    expect(classifyCleanroomPressure(x, 1)).toMatchObject({ lithoAirlock: true, isLitho: false, gradZ: -3.75, highPressure: true });
    expect(classifyCleanroomPressure(x, 1 + 4 * threshold)).toMatchObject({ highPressure: true, gradZ: -3.75 });
    expect(classifyCleanroomPressure(x, 1 + 4 * threshold - 1e-9).highPressure).toBe(true);
    expect(classifyCleanroomPressure(x, 1 + 4 * threshold + 1e-9).highPressure).toBe(false);
    expect(classifyCleanroomPressure(x, 5)).toMatchObject({ lithoAirlock: true, highPressure: false, gradZ: -3.75 });
    for (let step = 0; step <= 2000; step++) {
      const z = 1 + 4 * (step / 2000);
      const field = cleanroomPressureField(x, z);
      // The threshold is real-valued; the classifier evaluates the same subtraction the
      // field does so both agree bit-for-bit at the t = 4/15 rounding boundary.
      expect(classifyCleanroomPressure(x, z).highPressure).toBe(field.pressure >= 26);
    }
  }
  // The main airlock ramp drops from 15 Pa and therefore never reaches the 26 Pa band.
  for (let step = 0; step <= 200; step++) {
    const z = 32 + 4 * (step / 200), field = cleanroomPressureField(12, z), region = classifyCleanroomPressure(12, z);
    expect(region).toMatchObject({ mainAirlock: true, isAirlock: true, gradZ: -3.75, highPressure: false });
    expect(region.highPressure).toBe(field.pressure >= 26);
  }
  // The bay plateau (15 ± 0.15 Pa) is never high.
  for (let step = 0; step <= 100; step++) {
    const z = -34 + (step / 100) * 68;
    const region = classifyCleanroomPressure(0, z);
    expect(region.highPressure).toBe(cleanroomPressureField(0, z).pressure >= 26);
    expect(region.highPressure).toBe(false);
  }
  // The litho bay (30 ± 0.2 Pa) is always high.
  for (let step = 0; step <= 100; step++) {
    const z = -34 + (step / 100) * 38;
    const region = classifyCleanroomPressure(-20, z);
    expect(region.highPressure).toBe(cleanroomPressureField(-20, z).pressure >= 26);
    expect(region.highPressure).toBe(true);
  }
});

it('keeps the original litho-over-airlock precedence and boundary fallbacks', () => {
  // x = -17 is inside both footprints; the field picks the litho branch, so no airlock gradient.
  expect(classifyCleanroomPressure(-17, 3)).toEqual({ isLitho: true, isAirlock: true, lithoAirlock: true,
    mainAirlock: false, gradZ: 0, highPressure: true });
  expect(cleanroomPressureField(-17, 3)).toMatchObject({ gradZ: 0, isAirlock: true });
  expect(classifyCleanroomPressure(-16.5, 3)).toMatchObject({ isLitho: true, gradZ: 0 });
  expect(classifyCleanroomPressure(-16.499999999999998, 3)).toMatchObject({ isLitho: false, lithoAirlock: true, gradZ: -3.75 });
  expect(classifyCleanroomPressure(0, 36)).toMatchObject({ mainAirlock: false, isAirlock: false, gradZ: 0 });
  expect(classifyCleanroomPressure(12, 36)).toMatchObject({ mainAirlock: true, isAirlock: true, gradZ: -3.75, highPressure: false });
  expect(classifyCleanroomPressure(12, 36.00000000000001)).toMatchObject({ mainAirlock: false, isAirlock: false, gradZ: 0, highPressure: false });
  expect(classifyCleanroomPressure(0, 37)).toMatchObject({ isLitho: false, isAirlock: false, gradZ: 0, highPressure: false });
  expect(cleanroomPressureField(0, 37).pressure).toBe(0);
});

it('returns the entry-position classification from advanceLaminarParticle without changing displacement', () => {
  const particle = { x: -15, y: 2, z: 3, vy: 0.036 };
  const region = advanceLaminarParticle(particle, 1 / 60, [], () => 0.5);
  expect(region).toEqual(classifyCleanroomPressure(-15, 3));
  // z = 3 sits halfway down the litho airlock ramp: 22.5 Pa, below the 26 Pa band.
  expect(region).toMatchObject({ isLitho: false, isAirlock: true, highPressure: false, gradZ: -3.75 });
  expect(particle.y).toBeCloseTo(1.96);
  expect(particle.z).toBeCloseTo(3.03375);
  const high = { x: -15, y: 2, z: 2, vy: 0.036 };
  expect(advanceLaminarParticle(high, 1 / 60, [], () => 0.5))
    .toMatchObject({ isLitho: false, isAirlock: true, highPressure: true, gradZ: -3.75 });
  // In the litho/airlock overlap the litho branch wins: vy 0.046 and no z advection.
  const overlap = { x: -17, y: 2, z: 3, vy: 0.036 };
  expect(advanceLaminarParticle(overlap, 1 / 60, [], () => 0.5))
    .toMatchObject({ isLitho: true, isAirlock: true, highPressure: true, gradZ: 0 });
  expect(overlap.y).toBeCloseTo(2 - 0.046);
  expect(overlap.z).toBe(3);
  // The entry classification can go stale while the particle advects along the airlock ramp:
  // z = 2.05 is still in the 26+ Pa band, but z advection moves it out of the band this frame.
  // Callers that need the old post-move colour semantics (environment.ts) must re-classify.
  const crossing = { x: -15, y: 2, z: 2.05, vy: 0.036 };
  expect(advanceLaminarParticle(crossing, 1 / 60, [], () => 0.5).highPressure).toBe(true);
  expect(crossing.z).toBeGreaterThan(2.0666666666666664);
  expect(classifyCleanroomPressure(crossing.x, crossing.z).highPressure).toBe(false);
});

it('runs the airflow hot path without trigonometry', () => {
  const sin = vi.spyOn(Math, 'sin'), cos = vi.spyOn(Math, 'cos');
  try {
    for (let index = 0; index < 2000; index++) {
      const x = -60 + (index % 120) + 0.5, z = -50 + (index % 100) + 0.25;
      classifyCleanroomPressure(x, z);
      advanceLaminarParticle({ x, y: 3, z, vy: 0.036 }, 1 / 60, [], () => 0.5);
    }
    expect(sin).not.toHaveBeenCalled();
    expect(cos).not.toHaveBeenCalled();
  } finally {
    sin.mockRestore(); cos.mockRestore();
  }
});
