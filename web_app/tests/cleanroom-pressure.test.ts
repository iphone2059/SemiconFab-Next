import { expect, it } from 'vitest';
import { cleanroomPressureField, advanceLaminarParticle } from '../src/cleanroom-pressure';

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
