export type DefectPattern = 'clean' | 'center' | 'ring' | 'scratch' | 'donut' | 'random' | 'edge_local';
export type BinCode = 1 | 2 | 3 | 4 | 5;

export interface WaferDie {
  r: number;
  c: number;
  dx: number;
  dy: number;
  dist: number;
  bin: BinCode;
}

export interface DefectMetadata {
  name: string;
  desc: string;
  confidence: string;
  rootCause: string;
  lossPct: number;
}

export const WM811K_DEFECT_METADATA: Record<DefectPattern, DefectMetadata> = {
  clean: { name: 'Clean Nominal Baseline', desc: 'Uniform high-yield wafer without spatial clustering', confidence: '99.4%', rootCause: 'Baseline fab operations nominal. Excursion risk minimal.', lossPct: 1.5 },
  center: { name: 'Center Cluster Defect', desc: 'Radial concentration of fails around wafer center', confidence: '98.1%', rootCause: 'CMP slurry distribution bias / Photoresist spin-coating chuck vacuum unevenness', lossPct: 15.8 },
  ring: { name: 'Edge-Ring Excursion', desc: 'Concentric ring of defects along the outer 15mm perimeter', confidence: '97.6%', rootCause: 'Plasma etch edge-ring sheath breakdown / Gas boundary layer detachment (LAM Kiyo)', lossPct: 23.5 },
  scratch: { name: 'Mechanical Scratch', desc: 'Linear contiguous line of damaged dies across wafer', confidence: '99.1%', rootCause: 'EFEM transfer robot vacuum wand slippage / Slurry grit contamination', lossPct: 31.2 },
  donut: { name: 'Donut Annular Ring', desc: 'Intermediate ring with clean center and edge', confidence: '96.8%', rootCause: 'LPCVD furnace quartz tube radial thermal gradient during ramp-down (TEL INDY)', lossPct: 28.7 },
  random: { name: 'Random Defect Contamination', desc: 'Poisson distributed defect density across entire surface', confidence: '94.2%', rootCause: 'Chamber flaking particles / UHP specialty gas filter breakthrough', lossPct: 18.0 },
  edge_local: { name: 'Edge-Local Sector Cluster', desc: 'Localized cluster at wafer perimeter edge', confidence: '95.5%', rootCause: 'Edge Bead Removal (EBR) solvent nozzle drip / Wafer bevel clamp shadow', lossPct: 20.6 },
};

export const BIN_LABELS: Record<BinCode, string> = {
  1: 'Pass (Prime Die)',
  2: 'Bin 2: Parametric Fail',
  3: 'Bin 3: Functional Hard Fail',
  4: 'Bin 4: Optical Particle Defect',
  5: 'Bin 5: Interconnect Short/Open',
};

export const BIN_COLORS: Record<BinCode, string> = {
  1: '#10b981', 2: '#f59e0b', 3: '#ef4444', 4: '#a855f7', 5: '#0ea5e9',
};

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function generateWaferMap(pattern: DefectPattern, seed: number | (() => number) = 811): WaferDie[] {
  const random = typeof seed === 'function' ? seed : seeded(seed + pattern.length * 977);
  const gridSize = 26;
  const step = 11.5;
  const waferRadius = 145;
  const dies: WaferDie[] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const dx = (c - gridSize / 2 + 0.5) * step;
      const dy = (r - gridSize / 2 + 0.5) * step;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > waferRadius - 6) continue;
      let pDefect = 0.012;
      if (pattern === 'center') {
        if (dist < 65) pDefect = 0.88 * Math.exp(-(dist * dist) / (2 * 25 * 25));
      } else if (pattern === 'ring') {
        if (dist > 105) pDefect = Math.min(0.95, 0.25 + ((dist - 105) / 35) ** 2);
      } else if (pattern === 'scratch') {
        const lineDist = Math.abs(dy - 0.65 * dx + 15) / Math.sqrt(1 + 0.65 * 0.65);
        if (lineDist < 7.5 && Math.abs(dx) < 100) pDefect = 0.9;
      } else if (pattern === 'donut') {
        if (dist >= 50 && dist <= 90) pDefect = 0.84;
      } else if (pattern === 'random') {
        pDefect = 0.18;
      } else if (pattern === 'edge_local') {
        const angle = Math.atan2(dy, dx);
        if (dist > 95 && Math.abs(angle - 0.75) < 0.45) pDefect = 0.88;
      }
      const isDefect = random() < pDefect;
      let bin: BinCode = 1;
      if (isDefect) {
        const binRandom = random();
        bin = binRandom < 0.35 ? 3 : binRandom < 0.65 ? 2 : binRandom < 0.85 ? 4 : 5;
      }
      dies.push({ r, c, dx, dy, dist, bin });
    }
  }
  return dies;
}

export interface WaferMetrics {
  total: number;
  good: number;
  yieldPct: number;
  bins: Record<BinCode, number>;
  d0: number;
}

export function waferMetrics(dies: readonly WaferDie[]): WaferMetrics {
  const bins: Record<BinCode, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const die of dies) bins[die.bin]++;
  const total = dies.length;
  const good = bins[1];
  const yieldPct = total ? (good / total) * 100 : 0;
  return { total, good, bins, yieldPct, d0: ((100 - yieldPct) / 100) * 0.15 };
}

export interface YieldModels {
  poisson: number;
  murphy: number;
  seeds: number;
}

export function theoreticalYieldModels(areaMm2: number, d0: number, alpha: number): YieldModels {
  const areaCm2 = areaMm2 / 100;
  const ad0 = areaCm2 * d0;
  const poisson = Math.exp(-ad0) * 100;
  const murphy = (ad0 > 0 ? ((1 - Math.exp(-ad0)) / ad0) ** 2 : 1) * 100;
  const seeds = (1 + ad0 / alpha) ** -alpha * 100;
  return { poisson, murphy, seeds };
}

export function stdfSummary(dies: readonly WaferDie[], pattern: DefectPattern): Record<string, unknown> {
  const metrics = waferMetrics(dies);
  return {
    record_type: 'STDF_V4_SUMMARY',
    mir: { lot_id: 'LOT-300-8842', test_code: 'CP1', tester: 'ADVANTEST-V93000', fab: 'FAB-300MM-CLN1' },
    wir: { wafer_id: 'W-14', diameter_mm: 300, notch_deg: 180, total_dies: metrics.total },
    prr: { tested: metrics.total, passed: metrics.good, failed: metrics.total - metrics.good, gross_yield_pct: Number(metrics.yieldPct.toFixed(2)), spatial_pattern: pattern },
    bin_counts: { bin1_pass: metrics.bins[1], bin2_param: metrics.bins[2], bin3_func: metrics.bins[3], bin4_particle: metrics.bins[4], bin5_short: metrics.bins[5] },
  };
}
