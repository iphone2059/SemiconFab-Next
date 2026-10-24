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
