import type { FabLayoutTool } from './fab-layout';

export interface MesJob {
  lotId: string;
  carrierId: string;
  recipeId: string;
  state: 'TRACKED_IN' | 'TRACKED_OUT' | 'HOLD_MRB';
  stepName: string;
  waferSlot: number;
  updatedAt: number;
}

export type MesAction = 'track-in' | 'track-out' | 'hold';

function stableNumber(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

export function createMesJob(tool: FabLayoutTool, index: number, now = Date.now()): MesJob {
  const lotNum = ((stableNumber(tool.recordId || String(index)) * 17) % 8000) + 1000;
  const foupNum = (lotNum % 24) + 1;
  const category = tool.category.toUpperCase().slice(0, 4);
  return {
    lotId: `LOT-300-${lotNum}`,
    carrierId: `FOUP-AMHS-${String(foupNum).padStart(2, '0')}`,
    recipeId: `RCP-${category}-2NM-V${(lotNum % 5) + 1}.0`,
    state: 'TRACKED_IN',
    stepName: tool.model,
    waferSlot: 14,
    updatedAt: now,
  };
}

export function applyMesAction(job: MesJob, action: MesAction, now = Date.now()): MesJob {
  if (action === 'track-in') return { ...job, state: 'TRACKED_IN', updatedAt: now };
  if (action === 'track-out') return { ...job, state: 'TRACKED_OUT', waferSlot: (job.waferSlot % 25) + 1, updatedAt: now };
  return { ...job, state: 'HOLD_MRB', updatedAt: now };
}

export interface SensorDefinition {
  name: string;
  unit: string;
  value: number;
  min: number;
  max: number;
}

export interface Telemetry {
  soh: number;
  lotId: string;
  waferIdx: number;
  sensors: SensorDefinition[];
  history: number[];
}

const SENSOR_SETS: Record<string, SensorDefinition[]> = {
  litho: [
    { name: 'Exposure Dose', unit: 'mJ/cm²', value: 22.2, min: 21.5, max: 23.0 },
    { name: 'Overlay Align Error', unit: 'nm', value: 0.9, min: 0.5, max: 1.4 },
    { name: 'Wafer Stage Temp', unit: '°C', value: 21.0, min: 20.95, max: 21.05 },
    { name: 'Chamber Vacuum', unit: 'mbar', value: 1.2e-6, min: 1.0e-6, max: 1.5e-6 },
  ],
  etch: [
    { name: 'RF Source Power', unit: 'W', value: 850, min: 830, max: 870 },
    { name: 'RF Bias Power', unit: 'W', value: 320, min: 310, max: 330 },
    { name: 'Chamber Vacuum', unit: 'mTorr', value: 30.2, min: 29.0, max: 31.5 },
    { name: 'CF4 Gas Flow', unit: 'sccm', value: 48.5, min: 46.0, max: 51.0 },
  ],
  depo: [
    { name: 'Precursor Gas Flow', unit: 'sccm', value: 200, min: 195, max: 205 },
    { name: 'Reaction Chamber Pressure', unit: 'Torr', value: 2.4, min: 2.2, max: 2.6 },
    { name: 'Susceptor Heater Temp', unit: '°C', value: 450.0, min: 448.0, max: 452.0 },
    { name: 'Thin Film Depo Rate', unit: 'nm/min', value: 14.8, min: 14.0, max: 15.5 },
  ],
  imp_therm: [
    { name: 'Thermal / Beam Energy', unit: 'keV', value: 40, min: 39.2, max: 40.8 },
    { name: 'Current / Temp Drift', unit: '%', value: 0.2, min: 0.1, max: 0.5 },
    { name: 'N2 Inert Gas Flow', unit: 'slm', value: 10.2, min: 9.8, max: 10.6 },
    { name: 'Chamber Leak Rate', unit: 'mTorr/m', value: 0.05, min: 0.02, max: 0.08 },
  ],
  wet_cmp: [
    { name: 'Platen Downforce', unit: 'psi', value: 3.45, min: 3.3, max: 3.6 },
    { name: 'Platen Rotational Speed', unit: 'rpm', value: 60.0, min: 58.0, max: 62.0 },
    { name: 'Slurry Flow Rate', unit: 'ml/min', value: 250, min: 240, max: 260 },
    { name: 'Polishing Pad SOH', unit: '%', value: 86.4, min: 70, max: 99 },
  ],
  metro: [
    { name: 'Electron Beam High Voltage', unit: 'kV', value: 1.2, min: 1.18, max: 1.22 },
    { name: 'Scan Magnification', unit: 'kX', value: 180, min: 175, max: 185 },
    { name: 'Defect Density', unit: 'ea/cm²', value: 2.4, min: 1.0, max: 4.0 },
    { name: 'FOV Repeatability', unit: 'nm', value: 0.12, min: 0.08, max: 0.18 },
  ],
  other: [
    { name: 'Spindle Motor Speed', unit: 'rpm', value: 30000, min: 29800, max: 30200 },
    { name: 'Thermo-Compression Force', unit: 'N', value: 15.2, min: 14.8, max: 15.6 },
    { name: 'Probe Contact Impedance', unit: 'Ω', value: 0.42, min: 0.38, max: 0.46 },
    { name: 'ATE Test Throughput', unit: 'uph', value: 1850, min: 1800, max: 1900 },
  ],
};

function sensorSetFor(tool: FabLayoutTool): SensorDefinition[] {
  if (tool.category === 'lithography' || tool.category === 'resist_track') return SENSOR_SETS.litho;
  if (tool.category === 'dry_etch') return SENSOR_SETS.etch;
  if (tool.category === 'thin_film_deposition') return SENSOR_SETS.depo;
  if (tool.category === 'ion_implantation') return SENSOR_SETS.imp_therm;
  if (tool.category === 'thermal_processing') {
    return SENSOR_SETS.imp_therm.map((sensor, index) => index === 0
      ? { ...sensor, name: 'Furnace Thermal Energy', unit: '°C', value: 1050, min: 1029, max: 1071 }
      : { ...sensor });
  }
  if (tool.category === 'cmp' || tool.category === 'wet_clean') return SENSOR_SETS.wet_cmp;
  if (tool.category === 'metrology' || tool.category === 'inspection') return SENSOR_SETS.metro;
  return SENSOR_SETS.other;
}

export function buildTelemetry(tool: FabLayoutTool, index: number): Telemetry {
  const sensors = sensorSetFor(tool).map((sensor) => ({ ...sensor }));
  const primary = sensors[0];
  const seed = stableNumber(tool.recordId || String(index));
  let state = seed || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const history = Array.from({ length: 20 }, () => primary.value + (random() - 0.5) * primary.value * 0.04);
  return {
    soh: 96 + random() * 3.5,
    lotId: `LOT-300-${Math.floor(8800 + random() * 200)}`,
    waferIdx: Math.floor(1 + random() * 24),
    sensors,
    history,
  };
}

export interface SpcResult {
  cp: number;
  cpk: number;
  sigma: number;
  status: 'WORLD CLASS (5σ)' | 'IN CONTROL' | 'ALARM EXCURSION';
  rule: string;
}

export function computeSpc(history: readonly number[], sensor: SensorDefinition, isDown = false): SpcResult {
  if (history.length < 5) return { cp: 1.75, cpk: 1.64, sigma: 4.92, status: 'IN CONTROL', rule: 'PASS: Nelson 8 Rules In-Spec' };
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (history.length - 1);
  const std = Math.sqrt(variance) || 0.001;
  const target = (sensor.max + sensor.min) / 2;
  const tolerance = (sensor.max - sensor.min) * 0.45;
  const usl = target + tolerance;
  const lsl = target - tolerance;
  const cp = (usl - lsl) / (6 * std);
  const cpu = (usl - mean) / (3 * std);
  const cpl = (mean - lsl) / (3 * std);
  const cpk = Math.max(0.2, Math.min(cpu, cpl));
  const sigma = cpk * 3;
  let rule = 'PASS: Nelson 8 Rules In-Spec';
  if (isDown) {
    rule = 'Rule 1: Point Outside 3σ Upper/Lower Limit';
  } else if (history.some((value) => Math.abs(value - mean) > 3 * std)) {
    rule = 'Rule 1: Point Beyond 3σ Limit';
  } else if (history.length >= 9) {
    const last9 = history.slice(-9);
    if (last9.every((value) => value > mean) || last9.every((value) => value < mean)) rule = 'Rule 2: 9 Points on Same Side (Mean Shift)';
  }
  if (rule.startsWith('PASS') && history.length >= 6) {
    const last6 = history.slice(-6);
    let increasing = true;
    let decreasing = true;
    for (let index = 1; index < 6; index++) {
      if (last6[index] <= last6[index - 1]) increasing = false;
      if (last6[index] >= last6[index - 1]) decreasing = false;
    }
    if (increasing || decreasing) rule = 'Rule 3: 6 Points Trending (Chamber Drift)';
  }
  const status = rule.startsWith('Rule') ? 'ALARM EXCURSION' : cpk >= 1.67 ? 'WORLD CLASS (5σ)' : 'IN CONTROL';
  return { cp, cpk, sigma, status, rule };
}
