// Geometry literals from the frozen original; preserve source attribution in docs/attribution.md.
import type { FabLayoutTool } from './fab-layout';

type Triple = readonly [number, number, number];
export interface OriginalToolPart { shape: 'box' | 'cylinder'; size: Triple; at: Triple; color: Triple; segments?: number; alpha?: number; metallic?: number; roughness?: number; status?: boolean }
const base: Triple = [0.22, 0.25, 0.3], white: Triple = [0.93, 0.94, 0.96], port: Triple = [0.32, 0.36, 0.42];
const b = (size: Triple, at: Triple, color: Triple): OriginalToolPart => ({ shape: 'box', size, at, color });
const c = (radius: number, height: number, at: Triple, color: Triple, segments = 16): OriginalToolPart => ({ shape: 'cylinder', size: [radius, height, radius], at, color, segments });
const color = (hex: number): Triple => [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];

export const ORIGINAL_CATEGORY_ACCENTS = {
  lithography: 0xd99e3d, resist_track: 0xd99e3d, dry_etch: 0xd15c6b, thin_film_deposition: 0x527ab8,
  thermal_processing: 0xc77a4d, ion_implantation: 0x946bbd, cmp: 0x479eb3, wet_clean: 0x479eb3,
  metrology: 0x619485, inspection: 0x619485, packaging: 0xc26b94, test: 0xc26b94, other: 0x619485,
} as const;

/** Literal port of the original getSilhouetteFamilyGeometries, in metres. No model-derived guesses. */
export function originalToolTemplate(tool: FabLayoutTool): { family: string; height: number; parts: OriginalToolPart[] } {
  const category = tool.category;
  if (category === 'lithography' || category === 'resist_track') return { family: 'litho', height: 3.4, parts: [
    b([2.4, 0.25, 3.4], [0, 0.125, 0], base), b([2.2, 2.4, 2.4], [0, 1.45, -0.4], white),
    b([2.24, 0.12, 2.44], [0, 2.05, -0.4], [0.85, 0.62, 0.24]),
    b([1.6, 0.75, 1.6], [0, 3.025, -0.5], [0.88, 0.9, 0.93]), b([1.8, 1, 0.8], [0, 0.75, 1.2], port),
  ] };
  if (category === 'thermal_processing') return { family: 'thermal', height: 3.1, parts: [
    b([2.2, 0.2, 2.6], [0, 0.1, 0], base), b([2.2, 1, 2.6], [0, 0.7, 0], white),
    b([2.24, 0.1, 2.64], [0, 1.15, 0], [0.78, 0.48, 0.3]),
    c(0.36, 1.8, [-0.55, 2.1, -0.4], [0.72, 0.74, 0.78]), c(0.36, 1.8, [0.55, 2.1, -0.4], [0.72, 0.74, 0.78]),
    b([1.6, 1.4, 0.8], [0, 1.9, 0.8], port),
  ] };
  if (category === 'cmp' || category === 'wet_clean') return { family: 'bench', height: 1.9, parts: [
    b([2.2, 0.2, 3.8], [0, 0.1, 0], base), b([2.2, 1.1, 3.8], [0, 0.75, 0], white),
    b([2.24, 0.1, 3.84], [0, 1.05, 0], [0.28, 0.62, 0.7]),
    b([1.8, 0.6, 2.6], [0, 1.6, -0.4], [0.82, 0.85, 0.89]), b([1.6, 0.9, 0.9], [0, 0.45, 1.4], port),
  ] };
  if (category === 'dry_etch' || category === 'thin_film_deposition' || category === 'ion_implantation') {
    const accent: Triple = category === 'dry_etch' ? [0.82, 0.36, 0.42] : category === 'thin_film_deposition' ? [0.32, 0.48, 0.72] : [0.58, 0.42, 0.74];
    return { family: category === 'dry_etch' ? 'cluster_etch' : category === 'thin_film_deposition' ? 'cluster_depo' : 'cluster_implant', height: 2.3, parts: [
      b([2, 0.2, 2.2], [0, 0.1, -0.2], base), b([2, 1.6, 2.2], [0, 1, -0.2], white), b([2.04, 0.1, 2.24], [0, 1.4, -0.2], accent),
      b([0.6, 1, 1.2], [-1.2, 0.9, -0.2], [0.9, 0.92, 0.94]), b([0.6, 1, 1.2], [1.2, 0.9, -0.2], [0.9, 0.92, 0.94]),
      c(0.65, 0.45, [0, 2.025, -0.2], [0.55, 0.58, 0.64]), b([1.8, 1.1, 0.8], [0, 0.55, 1.1], port),
    ] };
  }
  const packaging = category === 'packaging' || category === 'test';
  return { family: packaging ? 'neutral_pkg' : 'neutral_metro', height: 2.55, parts: [
    b([2.2, 0.2, 2.8], [0, 0.1, -0.2], base), b([2.2, 2, 2.8], [0, 1.2, -0.2], white),
    b([2.24, 0.1, 2.84], [0, 1.7, -0.2], packaging ? [0.76, 0.42, 0.58] : [0.38, 0.58, 0.52]),
    b([1.8, 0.35, 2], [0, 2.375, -0.2], [0.8, 0.83, 0.88]), b([1.8, 0.95, 0.75], [0, 0.475, 1.2], port),
  ] };
}

/** Catalog path: the original createCatalogToolMesh uses these five parts, plus inferred wire overlay. */
export function catalogParts(tool: FabLayoutTool): OriginalToolPart[] {
  const w = tool.width, l = tool.depth, h = tool.height;
  const solid = ['vendor_confirmed', 'independent_verified', 'community_corroborated'].includes(tool.dimensionTier);
  return [
    { ...b([w + 0.3, 0.12, l + 0.3], [0, 0.06, 0], color(0x0f172a)), metallic: 0, roughness: 0.8 },
    { ...b([w, h, l], [0, 0.12 + h / 2, 0], color(solid ? 0xf1f5f9 : 0xf59e0b)), metallic: solid ? 0.35 : 0.2, roughness: solid ? 0.35 : 0.4, alpha: solid ? 1 : 0.45 },
    { ...b([w + 0.04, 0.12, l + 0.04], [0, 0.12 + h * 0.68, 0], color(ORIGINAL_CATEGORY_ACCENTS[tool.category])), metallic: 0.22, roughness: 0.38 },
    { ...b([w * 0.85, h * 0.65, l * 0.22], [0, 0.12 + h * 0.65 / 2, l / 2 + l * 0.22 / 2], color(0x334155)), metallic: 0.5, roughness: 0.35, alpha: solid ? 1 : 0.65 },
    { ...c(0.06, 0.45, [w * 0.4, 0.12 + h + 0.25, -l * 0.35], color(0x10b981), 12), metallic: 0, roughness: 1, status: true },
  ];
}

/** Render parts shared by both native compositions; no engine objects or transforms. */
export function originalEquipmentParts(tool: FabLayoutTool): OriginalToolPart[] {
  if (tool.originalKind === 'catalog') return catalogParts(tool);
  const template = originalToolTemplate(tool);
  return [...template.parts,
    { ...c(0.02, 0.28, [0.85, template.height + 0.14, -0.75], color(0x334155), 8), metallic: 0.7, roughness: 0.3 },
    { ...c(0.045, 0.18, [0.85, template.height + 0.37, -0.75], color(0x10b981), 12), metallic: 0, roughness: 0.2, status: true },
  ];
}
