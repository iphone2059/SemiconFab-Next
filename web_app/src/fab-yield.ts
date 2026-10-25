import { FAB_LAYOUT, type FabToolState } from './fab-layout';
import { resolveScenario, type ScenarioOverrides } from './twin-equipment';
import { ORIGINAL_TWIN_UI } from './original-twin-data';

export interface ProcessModule {
  id: string;
  name: string;
  short: string;
  icon: string;
  baseYield: number;
  categories: readonly string[];
  /** Original FAB_EQUIPMENT category names used by calculateFabYieldAndCapa. */
  sourceBays: readonly string[];
  unit: string;
  paramName: string;
}
export interface FabYieldOptions {
  /** Source 18-row directory lights. When present, down counts use FAB_EQUIPMENT, not the 121 layout. */
  directoryStates?: Readonly<Record<string, FabToolState>>;
  scenarioId?: string;
  /** Per-module source jitter, sampled once by the DEMO clock, before clamping. */
  jitter?: readonly number[];
}

export const CORE_PROCESS_MODULES: readonly ProcessModule[] = [
  { id: 'oxi', name: 'Thermal Oxidation / Diffusion', short: 'OXI', icon: '🔥', baseYield: 0.994, categories: ['thermal_processing'], sourceBays: ['imp_therm'], unit: 'nm', paramName: 'Oxide Uniformity' },
  { id: 'litho', name: 'High-NA EUV Lithography', short: 'LITHO', icon: '💡', baseYield: 0.985, categories: ['lithography'], sourceBays: ['litho'], unit: 'nm', paramName: 'Overlay Alignment Error' },
  { id: 'etch', name: 'HAR Plasma & Atomic Etch', short: 'ETCH', icon: '⚡', baseYield: 0.988, categories: ['dry_etch'], sourceBays: ['etch'], unit: '°', paramName: 'Sidewall Verticality' },
  { id: 'cvd', name: 'Conformal CVD/ALD Thin Film', short: 'CVD', icon: '🌡️', baseYield: 0.991, categories: ['thin_film_deposition'], sourceBays: ['depo'], unit: '%', paramName: 'Step Coverage Ratio' },
  { id: 'imp', name: 'High-Current Ion Implant', short: 'IMP', icon: '⚛️', baseYield: 0.993, categories: ['ion_implantation'], sourceBays: ['imp_therm'], unit: '%', paramName: 'Dopant Uniformity' },
  { id: 'cmp', name: 'CMP Planarization', short: 'CMP', icon: '💎', baseYield: 0.989, categories: ['cmp', 'wet_clean'], sourceBays: ['wet_cmp'], unit: 'ea', paramName: 'Micro-Scratch Count' },
  { id: 'pvd', name: 'Subtractive Ru/Cu Metallization', short: 'PVD', icon: '✨', baseYield: 0.992, categories: ['thin_film_deposition'], sourceBays: ['depo'], unit: '%', paramName: 'Via Fill Percentage' },
  { id: 'anl', name: 'Rapid Thermal Millisecond Anneal', short: 'ANL', icon: '🌀', baseYield: 0.996, categories: ['thermal_processing'], sourceBays: ['imp_therm'], unit: '%', paramName: 'Dopant Activation Rate' },
];

export interface YieldInput {
  purity: number;
  health: number;
  lagTime: number;
}

export const DEFAULT_YIELD_INPUT: YieldInput = { purity: 5.5, health: 96.8, lagTime: 0.8 };

export interface YieldScenario extends YieldInput, ScenarioOverrides {
  id: string;
  name: string;
}

export const YIELD_SCENARIOS: readonly YieldScenario[] = [
  {
    "id": "baseline",
    "name": "Nominal Baseline (HVM)",
    "purity": 5.5,
    "health": 96.8,
    "lagTime": 0.8,
    "overrides": {
      "fe.litho.euv.1": "RUNNING",
      "fe.litho.euv.2": "RUNNING",
      "fe.etch.ccp.2": "RUNNING",
      "fe.clean.batch.1": "IDLE",
      "be.pkg.dicing.2": "MAINT"
    }
  },
  {
    "id": "litho_drift",
    "name": "Litho Overlay Drift",
    "purity": 5.0,
    "health": 90.5,
    "lagTime": 1.8,
    "overrides": {
      "fe.litho.euv.2": "DOWN",
      "fe.litho.duv.arfi.1": "IDLE",
      "fe.metro.overlay.1": "RUNNING"
    }
  },
  {
    "id": "etch_down",
    "name": "Etch Chamber RF Alarm",
    "purity": 5.0,
    "health": 85.2,
    "lagTime": 12.0,
    "overrides": {
      "fe.etch.ccp.2": "DOWN",
      "fe.etch.icp.1": "IDLE",
      "fe.clean.single.1": "IDLE"
    }
  },
  {
    "id": "pm_cycle",
    "name": "Cleanroom Preventive Maintenance",
    "purity": 5.5,
    "health": 94.6,
    "lagTime": 3.5,
    "overrides": {
      "fe.litho.euv.1": "MAINT",
      "fe.cmp.1": "MAINT",
      "fe.therm.furnace.1": "MAINT"
    }
  },
  {
    "id": "multi_fail",
    "name": "Cascade Equipment Bottleneck",
    "purity": 4.0,
    "health": 72.8,
    "lagTime": 18.0,
    "overrides": {
      "fe.litho.euv.2": "DOWN",
      "fe.etch.icp.2": "DOWN",
      "fe.cmp.2": "DOWN",
      "fe.depo.cvd.1": "IDLE",
      "fe.therm.furnace.2": "IDLE"
    }
  },
  {
    "id": "apc_upgrade",
    "name": "AI-APC Yield Optimization Sprint",
    "purity": 6.0,
    "health": 99.4,
    "lagTime": 0.2,
    "overrides": {}
  }
];

export function scenarioStates(scenario: YieldScenario): string[] {
  return resolveScenario(scenario).states;
}

export interface ModuleYield {
  module: ProcessModule;
  downCount: number;
  stepYield: number;
  cumulativeYield: number;
  bottleneck: boolean;
}

export interface FabYield {
  totalYield: number;
  wpm: number;
  modules: ModuleYield[];
  bottleneck: ProcessModule;
  factors: { purity: number; health: number; lag: number };
}

export function computeFabYield(states: readonly string[], input: YieldInput = DEFAULT_YIELD_INPUT, options: FabYieldOptions = {}): FabYield {
  const purityFactor = input.purity >= 5.5 ? 1.002 : input.purity >= 5.0 ? 1.0 : input.purity >= 4.5 ? 0.96 : input.purity >= 4.0 ? 0.88 : 0.72;
  const healthFactor = 0.75 + 0.25 * (input.health / 100);
  const lagFactor = input.lagTime <= 1 ? 1.0 : input.lagTime <= 4 ? 0.985 : input.lagTime <= 8 ? 0.95 : input.lagTime <= 16 ? 0.88 : 0.78;
  const directoryStates = options.directoryStates;
  const layoutDownByCategory = new Map<string, number>();
  FAB_LAYOUT.forEach((tool, index) => {
    if (states[index] === 'down') layoutDownByCategory.set(tool.category, (layoutDownByCategory.get(tool.category) ?? 0) + 1);
  });
  let cumulative = 1;
  let bottleneck: ProcessModule = CORE_PROCESS_MODULES[0];
  let minimum = 1;
  const modules: ModuleYield[] = CORE_PROCESS_MODULES.map((module, index) => {
    // The source KPI counts DOWN rows in the final FAB_EQUIPMENT directory and
    // compares against its bay ids, even though the rendered layout has 121
    // draft instances. Keep that boundary explicit instead of substituting a
    // convenient but different 121-instance projection.
    const downCount = directoryStates
      ? ORIGINAL_TWIN_UI.equipment.filter((row) => module.sourceBays.includes(row.category) && directoryStates[row.id] === 'down').length
      : module.categories.reduce((sum, category) => sum + (layoutDownByCategory.get(category) ?? 0), 0);
    const downPenalty = downCount > 0 ? 1 - 0.08 * downCount : 1;
    const stepYield = Math.max(0.6, Math.min(0.999, module.baseYield * purityFactor * healthFactor * lagFactor * downPenalty + (options.jitter?.[index] ?? 0)));
    cumulative *= stepYield;
    if (stepYield < minimum) {
      minimum = stepYield;
      bottleneck = module;
    }
    return { module, downCount, stepYield, cumulativeYield: cumulative, bottleneck: false };
  });
  for (const module of modules) module.bottleneck = module.module.id === bottleneck.id;
  const totalYield = Math.max(0.4, Math.min(0.985, cumulative));
  // calculateFabYieldAndCapa adds 1.8 to the bottleneck cycle for etch_down.
  const bottleneckCycle = Math.max(2.0, 2.0 + input.lagTime * 0.4 + (options.scenarioId === 'etch_down' ? 1.8 : 0));
  const wpm = Math.round(50000 * totalYield * (24 / (bottleneckCycle * 10)));
  return { totalYield, wpm, modules, bottleneck, factors: { purity: purityFactor, health: healthFactor, lag: lagFactor } };
}
