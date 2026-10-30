import { FAB_LAYOUT, type FabLayoutTool } from '@/domain/fab-layout';

export interface LayoutIdentity {
  instanceId: string;
  recordId: string;
  machineId: string;
  replayTarget: boolean;
}

// Original CATEGORY_BAYS + buildDraftGhosts insertion order. Packaging/Test aliases
// intentionally collide with Litho/Metrology: preserve the source Map's actual winner.
const MIMAC_GROUP: Record<string, string> = {
  lithography: 'TG01_LITHO', resist_track: 'TG02_TRACK', dry_etch: 'TG03_ETCH',
  thin_film_deposition: 'TG05_CVD', thermal_processing: 'TG07_FURN_DIFF',
  ion_implantation: 'TG09_IMPL_MED', cmp: 'TG11_CMP_OX', wet_clean: 'TG13_WET_BENCH',
  metrology: 'TG16_MET_CD', inspection: 'TG18_INSPECT', packaging: 'TG01_LITHO',
  test: 'TG16_MET_CD', other: 'TG14_WET_SINGLE',
};
const FAMILY_ORDER: Record<string, number> = {
  lithography: 0, resist_track: 0, thermal_processing: 1, cmp: 2, wet_clean: 2,
  thin_film_deposition: 3, dry_etch: 4, ion_implantation: 5,
  metrology: 6, inspection: 6, other: 6, packaging: 7, test: 7,
};

/**
 * R3-10: instance identities are FAB-scoped. The default keeps the historical FAB-01 prefix
 * for the frozen single-FAB fixtures, while product scenes/UI must pass the selected FAB code
 * so that FAB-01..FAB-32 never share the same equipment instance ids.
 */
export function buildLayoutIdentities(
  layout: readonly FabLayoutTool[] = FAB_LAYOUT,
  fabCode = 'FAB-01',
): LayoutIdentity[] {
  const instancePrefix = (fabCode.trim() === '' ? 'FAB-01' : fabCode.trim()) + '/tool-';
  const bayCounts = new Map<string, number>();
  const rows = layout.map((tool, index) => {
    const ordinal = (bayCounts.get(tool.category) ?? 0) + 1;
    bayCounts.set(tool.category, ordinal);
    return { instanceId: `${instancePrefix}${String(index + 1).padStart(3, '0')}`, recordId: tool.recordId,
      machineId: `${MIMAC_GROUP[tool.category]}_${String(ordinal).padStart(2, '0')}`, replayTarget: false };
  });
  const order = originalLayoutRenderOrder(layout).map(index => ({ index }));
  const winners = new Map<string, number>();
  for (const { index } of order) winners.set(rows[index].machineId, index);
  for (const row of rows) row.replayTarget = rows[winners.get(row.machineId)!] === row;
  return rows;
}

export const TWIN_LAYOUT_IDENTITIES = buildLayoutIdentities();

/** Per-FAB layout identities for multi-FAB product scenes/UI (FAB-01..FAB-32 isolation). */
export const layoutIdentitiesForFab = (fabCode: string): LayoutIdentity[] =>
  buildLayoutIdentities(FAB_LAYOUT, fabCode);


export function originalLayoutRenderOrder(layout: readonly FabLayoutTool[] = FAB_LAYOUT): number[] {
  const order = layout.map((tool, index) => ({ index,
    rank: tool.originalKind === 'catalog' ? -1 : FAMILY_ORDER[tool.category] ?? 6 }));
  order.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return order.map(row => row.index);
}
