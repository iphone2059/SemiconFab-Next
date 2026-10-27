/** Cheap region classification for the airflow hot path. Trig-free: only cleanroomPressureField evaluates sin/cos. */
export interface CleanroomPressureClassification {
  /** Inside the lithography bay footprint (x <= -16.5 && z <= 4.5); pressure is 30 ± 0.2 Pa. */
  isLitho: boolean;
  /** Inside either airlock ramp footprint (litho or main). */
  isAirlock: boolean;
  /** The litho airlock branch supplies the field (it yields to the litho branch where the regions overlap). */
  lithoAirlock: boolean;
  /** The main airlock branch supplies the field. */
  mainAirlock: boolean;
  /** d(pressure)/dz of the selected branch: -3.75 on an active ramp, otherwise 0. */
  gradZ: number;
  /**
   * Exactly `cleanroomPressureField(x, z).pressure >= 26` for finite coordinates, without
   * trigonometry: litho pressure (30 ± 0.2) is always high, bay pressure (15 ± 0.15) and the
   * main airlock ramp (<= 15) never are, and the litho airlock ramp `30 - 15 * t` is evaluated
   * with the same arithmetic as the field, so the real-valued t = 4/15 boundary cannot diverge
   * because of double rounding.
   */
  highPressure: boolean;
}

/** Airlock ramp fraction shared by the field and the classifier. */
function airlockRamp(z: number, z0: number): number {
  return Math.max(0, Math.min(1, (z - z0) / 4));
}

/**
 * Trig-free classification of the schematic pressure field, mirroring the region branches of
 * {@link cleanroomPressureField}. Used by the airflow hot path (1500 particles x 2 samples per
 * frame) so that only the cold-path field still pays for sin/cos.
 */
export function classifyCleanroomPressure(x: number, z: number): CleanroomPressureClassification {
  const isLitho = x <= -16.5 && z <= 4.5;
  const lithoAirlock = x >= -18.5 && x <= -14.5 && z >= 1 && z <= 5;
  const mainAirlock = x >= 10 && x <= 14 && z >= 32 && z <= 36;
  let gradZ = 0;
  let highPressure = false;
  // Branch order and thresholds mirror cleanroomPressureField exactly.
  if (z > 36) {
    // Exhaust side: pressure is 0.
  } else if (isLitho) {
    // 30 + sin(x * 0.15) * 0.2, i.e. 30 ± 0.2 Pa: always above the 26 Pa threshold.
    highPressure = true;
  } else if (lithoAirlock) {
    // 30 - 15 * t: high while the ramp has not dropped to 26 Pa (t = 4/15).
    highPressure = 30 - 15 * airlockRamp(z, 1) >= 26;
    gradZ = -3.75;
  } else if (mainAirlock) {
    // 15 - 15 * t, i.e. at most 15 Pa: never high; the ramp still advects particles.
    gradZ = -3.75;
  }
  // Otherwise the bay branch: 15 + cos(z * 0.15) * 0.15, i.e. 15 ± 0.15 Pa: never high.
  return { isLitho, isAirlock: lithoAirlock || mainAirlock, lithoAirlock, mainAirlock, gradZ, highPressure };
}

/** Original getCleanroomPressureField. A schematic field, not a measured CFD solution. */
export function cleanroomPressureField(x: number, z: number) {
  const region = classifyCleanroomPressure(x, z);
  let pressure = 15;
  if (z > 36) pressure = 0;
  else if (region.isLitho) pressure = 30 + Math.sin(x * 0.15) * 0.2;
  else if (region.lithoAirlock) pressure = 30 - 15 * airlockRamp(z, 1);
  else if (region.mainAirlock) pressure = 15 - 15 * airlockRamp(z, 32);
  else pressure = 15 + Math.cos(z * 0.15) * 0.15;
  return { pressure, gradX: 0, gradZ: region.gradZ, isLitho: region.isLitho, isAirlock: region.isAirlock };
}

export interface LaminarParticle { x: number; y: number; z: number; vy: number }
export interface LaminarObstacle { x: number; z: number; halfW: number; halfL: number; topY: number }

/**
 * Original nominal-60Hz displacement, scaled by elapsed time to avoid frame-rate drift.
 *
 * Returns the trig-free classification of the entry position (before the move/respawn) for
 * callers that only need the displacement band. It is NOT the post-move classification: the
 * airflow colour must classify `particle.x`/`particle.z` again after this call to preserve the
 * original post-move pressure-band semantics.
 */
export function advanceLaminarParticle(particle: LaminarParticle, deltaSec: number, obstacles: readonly LaminarObstacle[], random: () => number, blowing = false): CleanroomPressureClassification {
  const scale = Math.min(0.05, Math.max(0, deltaSec)) * 60;
  const field = classifyCleanroomPressure(particle.x, particle.z);
  const vy = field.isLitho ? 0.046 : field.isAirlock ? blowing ? 0.095 : 0.04 : particle.vy;
  particle.y -= vy * scale;
  if (Math.abs(field.gradZ) > 0.1) particle.z -= field.gradZ * 0.009 * scale;
  if (particle.y < 4.2 && particle.y > 0.2) {
    for (const obstacle of obstacles) {
      const rx = particle.x - obstacle.x;
      const rz = particle.z - obstacle.z;
      if (particle.y < obstacle.topY + 0.35 && Math.abs(rx) < obstacle.halfW && Math.abs(rz) < obstacle.halfL) {
        particle.x += (rx >= 0 ? 0.025 : -0.025) * scale;
        particle.z += (rz >= 0 ? 0.025 : -0.025) * scale;
        break;
      }
    }
  }
  if (particle.y <= 0.05) {
    particle.y = 7.9 - random() * 0.3;
    particle.x = -46 + random() * 92;
    particle.z = -34 + random() * 68;
  }
  return field;
}
