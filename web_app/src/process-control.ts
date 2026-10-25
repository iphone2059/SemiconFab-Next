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

export interface ProcessEquipment {
  id: string;
  category: string;
  name: string;
  position: { x: number };
}

function stableNumber(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

export function createMesJob(tool: FabLayoutTool, index: number, now = Date.now()): MesJob {
  return createProcessMesJob({ id: tool.recordId || String(index), category: tool.category, name: tool.model, position: { x: tool.x } }, now);
}

export function createProcessMesJob(equipment: ProcessEquipment, now = Date.now()): MesJob {
  const lotNum = ((equipment.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) * 17) % 8000) + 1000;
  const foupNum = (lotNum % 24) + 1;
  const category = (equipment.category || 'PROC').toUpperCase().slice(0, 4);
  return {
    lotId: `LOT-300-${lotNum}`,
    carrierId: `FOUP-AMHS-${String(foupNum).padStart(2, '0')}`,
    recipeId: `RCP-${category}-2NM-V${(lotNum % 5) + 1}.0`,
    state: 'TRACKED_IN',
    stepName: equipment.name,
    waferSlot: 14,
    updatedAt: now,
  };
}

export function applyMesAction(job: MesJob, action: MesAction, _now = Date.now()): MesJob {
  // Source actions retain the initialization timestamp.
  if (action === 'track-in') return { ...job, state: 'TRACKED_IN' };
  if (action === 'track-out') return { ...job, state: 'TRACKED_OUT', waferSlot: (job.waferSlot % 25) + 1 };
  return { ...job, state: 'HOLD_MRB' };
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
  primaryName: string;
  primaryUnit: string;
  baseVal: number;
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

function processProfile(equipment: ProcessEquipment) {
  const { id, category } = equipment;
  let sensors = SENSOR_SETS[category] ?? SENSOR_SETS.other;
  let baseVal = sensors[0].value;
  let primaryName = sensors[0].name;
  let primaryUnit = sensors[0].unit;
  if (category === 'subfab') {
    primaryName = 'Subfab Operating Telemetry';
    primaryUnit = id.includes('laser') ? 'kW' : id.includes('pump') ? 'm³/h' : id.includes('scrubber') ? '°C' : 'MΩ·cm';
    baseVal = id.includes('laser') ? 32.5 : id.includes('pump') ? 4500 : id.includes('scrubber') ? 1200 : 18.2;
    sensors = [
      { name: 'Primary Output', value: baseVal, unit: primaryUnit, min: baseVal * 0.95, max: baseVal * 1.05 },
      { name: 'Cooling Water Flow', value: 240, unit: 'L/min', min: 230, max: 250 },
      { name: 'Utility Header Pressure', value: 6.2, unit: 'bar', min: 6, max: 6.5 },
      { name: 'Abatement Efficiency', value: 99.99, unit: '%', min: 99.95, max: 100 },
    ];
  } else if (category === 'imp_therm') {
    primaryName = 'Beam Current / Tube Temp';
    primaryUnit = id.includes('furnace') ? '°C' : 'keV';
    baseVal = id.includes('furnace') ? 1050 : 40;
    sensors = sensors.map((sensor, index) => index === 0 ? { ...sensor, value: baseVal, unit: primaryUnit, min: baseVal * 0.98, max: baseVal * 1.02 } : sensor);
  } else if (category === 'metro') {
    primaryName = 'E-Beam HV';
  } else if (category === 'amhs') {
    primaryName = 'AMHS Transfer Efficiency'; primaryUnit = 's'; baseVal = 12.5;
    sensors = [
      { name: 'Handshake Transfer Time', value: 12.5, unit: 's', min: 11, max: 14 },
      { name: 'Buffered FOUP Count', value: 246, unit: 'ea', min: 200, max: 300 },
      { name: 'Main Track Network Load', value: 42, unit: '%', min: 35, max: 55 },
      { name: 'OHT Dispatch Latency', value: 1.8, unit: 'ms', min: 1.2, max: 2.5 },
    ];
  } else if (category === 'facility' || id.startsWith('fac.airshower')) {
    primaryName = 'Nozzle Air Velocity'; primaryUnit = 'm/s'; baseVal = 28.5;
    sensors = [
      { name: 'Nozzle Jet Velocity', value: 28.5, unit: 'm/s', min: 25, max: 30 },
      { name: 'Chamber Differential Pressure', value: 18.5, unit: 'Pa', min: 15, max: 22 },
      { name: 'ULPA Filter Efficiency', value: 99.999, unit: '%', min: 99.998, max: 100 },
      { name: 'Blower Motor RPM', value: 2850, unit: 'RPM', min: 2800, max: 2900 },
    ];
  } else if (!['litho', 'etch', 'depo', 'wet_cmp'].includes(category)) {
    // The original history starts at bond load, even though sensor 0 is spindle RPM.
    primaryName = 'Dicing / Bond Load'; primaryUnit = 'N'; baseVal = 15.2;
  }
  return { sensors, baseVal, primaryName, primaryUnit };
}

export function createProcessTelemetry(equipment: ProcessEquipment, random: () => number): Telemetry {
  const { sensors, baseVal, primaryName, primaryUnit } = processProfile(equipment);
  const history = Array.from({ length: 20 }, () => baseVal + (random() - 0.5) * (baseVal * 0.04));
  return { soh: Number((96 + random() * 3.5).toFixed(1)), lotId: `LOT-300-${Math.floor(8800 + random() * 200)}`,
    waferIdx: Math.floor(1 + random() * 24), primaryName, primaryUnit, baseVal,
    sensors: sensors.map(sensor => ({ ...sensor })), history };
}

export function advanceProcessTelemetry(telemetry: Telemetry, equipment: ProcessEquipment, cycle: number, down: boolean, random: () => number): Telemetry {
  const { id, category } = equipment;
  const phase = (cycle + equipment.position.x * 3) % 20;
  const sensors = telemetry.sensors.map((sensor, index) => {
    let target = sensor.value;
    if ((category === 'etch' || id.includes('etch')) && index === 0) {
      target = phase < 3 ? sensor.min * 0.2 : phase === 3 ? sensor.max * 1.06 : phase < 14 ? (sensor.min + sensor.max) * 0.52 : phase < 18 ? sensor.min * 0.45 : sensor.min * 0.15;
    } else if ((category === 'litho' || id.includes('euv') || id.includes('arfi')) && index === 1) {
      target = 0.95 + Math.sin(cycle * 0.25 + index) * 0.22;
    } else if ((category === 'wet_cmp' || id.includes('cmp')) && index === 0) {
      target = phase > 4 && phase < 16 ? 3.45 : 0.2;
    } else if (id.includes('furnace') && index === 0) {
      target = 1050 + Math.sin(cycle * 0.08) * 1.5;
    }
    const noise = (random() - 0.5) * ((sensor.max - sensor.min) * 0.025);
    return { ...sensor, value: Math.max(0.001, (target + noise) * (down ? 0.52 : 1)) };
  });
  return { ...telemetry, sensors, history: [...telemetry.history, sensors[0].value].slice(-25) };
}

export function buildTelemetry(tool: FabLayoutTool, index: number): Telemetry {
  const seed = stableNumber(tool.recordId || String(index));
  let state = seed || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const category = ({ lithography: 'litho', resist_track: 'litho', dry_etch: 'etch', thin_film_deposition: 'depo',
    ion_implantation: 'imp_therm', thermal_processing: 'imp_therm', cmp: 'wet_cmp', wet_clean: 'wet_cmp', metrology: 'metro', inspection: 'metro' } as Record<string, string>)[tool.category] ?? 'other';
  return createProcessTelemetry({ id: tool.recordId || String(index), category, name: tool.model, position: { x: tool.x } }, random);
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
