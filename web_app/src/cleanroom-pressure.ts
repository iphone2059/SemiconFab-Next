/** Original getCleanroomPressureField. A schematic field, not a measured CFD solution. */
export function cleanroomPressureField(x: number, z: number) {
  const isLitho = x <= -16.5 && z <= 4.5;
  const lithoAirlock = x >= -18.5 && x <= -14.5 && z >= 1 && z <= 5;
  const mainAirlock = x >= 10 && x <= 14 && z >= 32 && z <= 36;
  let pressure = 15;
  let gradZ = 0;
  if (z > 36) pressure = 0;
  else if (isLitho) pressure = 30 + Math.sin(x * 0.15) * 0.2;
  else if (lithoAirlock) { pressure = 30 - 15 * Math.max(0, Math.min(1, (z - 1) / 4)); gradZ = -3.75; }
  else if (mainAirlock) { pressure = 15 - 15 * Math.max(0, Math.min(1, (z - 32) / 4)); gradZ = -3.75; }
  else pressure = 15 + Math.cos(z * 0.15) * 0.15;
  return { pressure, gradX: 0, gradZ, isLitho, isAirlock: lithoAirlock || mainAirlock };
}

export interface LaminarParticle { x: number; y: number; z: number; vy: number }
export interface LaminarObstacle { x: number; z: number; halfW: number; halfL: number; topY: number }

/** Original nominal-60Hz displacement, scaled by elapsed time to avoid frame-rate drift. */
export function advanceLaminarParticle(particle: LaminarParticle, deltaSec: number, obstacles: readonly LaminarObstacle[], random: () => number, blowing = false): void {
  const scale = Math.min(0.05, Math.max(0, deltaSec)) * 60;
  const field = cleanroomPressureField(particle.x, particle.z);
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
}
