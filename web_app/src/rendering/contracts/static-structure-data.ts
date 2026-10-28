/**
 * Hand-written data contract for the frozen lite static structure.
 *
 * Ownership: this module is the single source of truth for the shape of the packed
 * static-structure payload. tools/pack_static_structure.mjs emits
 * web_app/src/generated/static-structure-packed.ts against these types (a single type-only
 * import, erased at emit), and the lite renderer imports the same types from here. The
 * generated artifact therefore never imports a rendering consumer, so the type graph stays
 * acyclic (enforced by R1/R5 in tests/architecture-import-graph.test.ts).
 *
 * This file is hand-written and runtime-free: keep it type-only so generated data can never
 * pull implementation code into the module graph. Change a shape here first, then update the
 * generator (which validates the contract exports) and regenerate the artifact.
 */

export type StaticLayer = 'shell' | 'ffu' | 'b1';

/** Frozen PBR/Standard/line material inputs replayed by the lite scene. */
export interface StaticSurfaceDefinition {
  kind: 'pbr' | 'standard' | 'line'; color: number[]; alpha: number;
  metallic?: number; roughness?: number; emissive?: number[]; specular?: number[]; power?: number;
  doubleSided?: boolean; depthWrite?: boolean; zOffset?: number;
  refraction?: { intensity: number; ior: number } | null;
  texture?: { width: number; height: number; uScale: number; vScale: number; gammaSpace: boolean;
    operations: unknown[][] };
}

/** Decoded vertex buffers for one frozen geometry id. */
export interface PackedGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly lines: boolean;
}

/** One frozen scene entity from the committed source asset. */
export interface PackedSourceEntity {
  name: string;
  layer: StaticLayer;
  geometry: string;
  material: string;
  matrix: number[];
  caster: boolean | null;
  receiveShadows: boolean;
}

/** One frozen point light from the committed source asset. */
export interface PackedLightDefinition {
  name: string;
  position: [number, number, number];
  color: [number, number, number];
  specular: [number, number, number];
  intensity: number;
  range: number;
  legacyDecay: number;
}

/** Decoded payload of the generated static-structure-packed module. */
export interface PackedStaticStructure {
  readonly geometries: Record<string, PackedGeometry>;
  readonly materials: Record<string, StaticSurfaceDefinition>;
  readonly entities: PackedSourceEntity[];
  readonly lights: PackedLightDefinition[];
}
