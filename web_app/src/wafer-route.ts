import { FAB_LAYOUT, type FabLayoutTool } from './fab-layout';

export type WaferProduct = 'A' | 'B' | 'C';

export interface WaferRouteStep {
  step: number;
  tool_group: string;
  recipe?: string;
}

export interface WaferWaypoint {
  step: number;
  toolGroup: string;
  recipe?: string;
  category: string;
  x: number;
  y: number;
  z: number;
  tool?: FabLayoutTool;
}

const GROUP_CATEGORY: Record<string, string> = {
  TG01_LITHO: 'lithography',
  TG02_TRACK: 'resist_track',
  TG03_ETCH: 'dry_etch',
  TG04_STRIP: 'dry_etch',
  TG05_CVD: 'thin_film_deposition',
  TG06_PVD: 'thin_film_deposition',
  TG07_FURN_DIFF: 'thermal_processing',
  TG08_FURN_LPCVD: 'thin_film_deposition',
  TG09_IMPL_MED: 'ion_implantation',
  TG10_IMPL_HIGH: 'ion_implantation',
  TG11_CMP_OX: 'cmp',
  TG12_CMP_MET: 'cmp',
  TG13_WET_BENCH: 'wet_clean',
  TG14_WET_SINGLE: 'wet_clean',
  TG15_RTP: 'thermal_processing',
  TG16_MET_CD: 'metrology',
  TG17_MET_THICK: 'metrology',
  TG18_INSPECT: 'inspection',
};

const walk = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>).products;
};

export function parseWaferRoutes(value: unknown): Record<WaferProduct, WaferRouteStep[]> {
  const products = walk(value);
  if (!products || typeof products !== 'object') throw new Error('路线数据缺少 products');
  const result = {} as Record<WaferProduct, WaferRouteStep[]>;
  for (const product of ['A', 'B', 'C'] as const) {
    const item = (products as Record<string, unknown>)[product];
    const route = item && typeof item === 'object' ? (item as Record<string, unknown>).route : undefined;
    if (!Array.isArray(route)) throw new Error(`Product ${product} 缺少 route`);
    result[product] = route.map((row, index) => {
      if (!row || typeof row !== 'object') throw new Error(`Product ${product} route 第 ${index + 1} 行无效`);
      const entry = row as Record<string, unknown>;
      const toolGroup = typeof entry.tool_group === 'string' ? entry.tool_group : entry.tg;
      if (typeof toolGroup !== 'string') throw new Error(`Product ${product} route 第 ${index + 1} 行缺少 tool_group`);
      return {
        step: typeof entry.step === 'number' ? entry.step : index + 1,
        tool_group: toolGroup,
        recipe: typeof entry.recipe === 'string' ? entry.recipe : undefined,
      };
    });
  }
  return result;
}

/** Mirrors the original round-robin projection onto the 121-tool layout. */
function catmull(p0: WaferWaypoint, p1: WaferWaypoint, p2: WaferWaypoint, p3: WaferWaypoint, t: number): { x: number; z: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

/** Segment position at progress 0..1, matching the original 75% transit / 25% dwell split. */
export function waferTransitPoint(waypoints: readonly WaferWaypoint[], index: number, progress: number): { x: number; y: number; z: number } {
  if (waypoints.length === 0) return { x: 0, y: 2.5, z: 0 };
  const k = Math.max(0, Math.min(index, waypoints.length - 1));
  const p2 = waypoints[k];
  if (k === 0 || progress >= 0.75) return { x: p2.x, y: 2.5, z: p2.z };
  const p0 = waypoints[Math.max(0, k - 2)];
  const p1 = waypoints[k - 1];
  const p3 = waypoints[Math.min(waypoints.length - 1, k + 1)];
  const point = catmull(p0, p1, p2, p3, Math.max(0, progress) / 0.75);
  return { x: point.x, y: 2.5, z: point.z };
}

export function buildWaferWaypoints(route: readonly WaferRouteStep[], layout: readonly FabLayoutTool[] = FAB_LAYOUT): WaferWaypoint[] {
  const byCategory = new Map<string, FabLayoutTool[]>();
  for (const tool of layout) {
    const list = byCategory.get(tool.category) ?? [];
    list.push(tool);
    byCategory.set(tool.category, list);
  }
  const cursor = new Map<string, number>();
  return route.map((step) => {
    const category = GROUP_CATEGORY[step.tool_group] ?? 'other';
    const tools = byCategory.get(category) ?? [];
    const index = cursor.get(category) ?? 0;
    cursor.set(category, index + 1);
    const tool = tools[index % Math.max(1, tools.length)];
    return {
      step: step.step,
      toolGroup: step.tool_group,
      recipe: step.recipe,
      category,
      x: tool?.x ?? 0,
      y: 2.5,
      z: tool?.z ?? 0,
      tool,
    };
  });
}
