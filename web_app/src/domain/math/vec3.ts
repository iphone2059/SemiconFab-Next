import { round } from './round';

/** Shared 3D vector primitives for the frozen Tour/Wafer timelines. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function roundVec(vec: Vec3): Vec3 {
  return { x: round(vec.x), y: round(vec.y), z: round(vec.z) };
}

export function cloneVec(vec: Vec3): Vec3 {
  return { x: vec.x, y: vec.y, z: vec.z };
}


