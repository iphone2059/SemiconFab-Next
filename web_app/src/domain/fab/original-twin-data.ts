import reference from '../../../assets/original-twin-ui.json';
import { FAB_LAYOUT, type FabToolState } from './fab-layout';
import { originalLayoutRenderOrder, TWIN_LAYOUT_IDENTITIES } from './layout-identities';

/**
 * Key of the frozen reference dataset's localized columns ("zh"/"en").
 *
 * This is a pure data vocabulary of the raw reference rows, deliberately not the
 * UI TwinLanguage: domain reference data must not depend on browser locale state.
 * Features pass their UI language value, which is structurally the same union.
 */
export type ReferenceLanguage = 'zh' | 'en';

export interface OriginalEquipment {
  id: string; name: string; brand: string; model: string; category: string; categoryName: string;
  level: 'L1' | 'B1'; bay: string; color: string; svgType: string;
  dimensions: { width: number; length: number; height: number };
  position: { x: number; y: number; z: number; rotY?: number };
  brandCountry?: string; desc?: string; locationDesc?: string; weight?: string;
  processNode?: string; waferSize?: string; sourceUrl?: string; sourceTier?: string;
  specs?: Readonly<Record<string, string>>; connectedTool?: string; subfabTools?: readonly string[];
  conformance_level?: string; catalogRecord?: Readonly<Record<string, unknown>>;
}
export interface OriginalOem {
  id: string; vendor: string; model: string; segment: string; country: string;
  process_node: string; wafer_size: string; dimensions: string; weight: string;
  key_specs: string; notes: string; source_url: string; source_tier: string;
  inFabId?: string; substitute_brand?: string; substitute_model?: string; isCustomApproved?: boolean;
}
interface OriginalTwinUi {
  equipment: readonly OriginalEquipment[]; oem: readonly OriginalOem[];
  localized: readonly { id: string; zh: OriginalEquipment; en: OriginalEquipment }[];
  signalKeys: readonly string[]; bootstrapEquipmentCount: number; layoutCount: number;
}
export const ORIGINAL_TWIN_UI = reference as unknown as OriginalTwinUi;
export type TwinSelection = { kind: 'layout'; index: number } | { kind: 'reference'; id: string } | { kind: 'oem'; id: string };

export function localizedEquipment(id: string, language: ReferenceLanguage): OriginalEquipment | undefined {
  return ORIGINAL_TWIN_UI.localized.find(row => row.id === id)?.[language];
}
export function filterReferenceEquipment(filter: {
  query: string; category: string; state: string; language: ReferenceLanguage; states: Readonly<Record<string, FabToolState>>;
}): OriginalEquipment[] {
  const query = filter.query.trim().toLowerCase();
  return ORIGINAL_TWIN_UI.equipment.filter(row => {
    const localized = localizedEquipment(row.id, filter.language) ?? row;
    return (filter.category === 'ALL' || row.category === filter.category)
      && (filter.state === 'ALL' || (filter.states[row.id] ?? 'running') === filter.state.toLowerCase())
      && (!query || [row.name, row.brand, row.model, row.categoryName, localized.name, localized.brand, localized.model, localized.categoryName, localized.desc ?? ''].some(text => text.toLowerCase().includes(query)));
  });
}
export function filterOriginalOem(query: string, segment: string): OriginalOem[] {
  const value = query.trim().toLowerCase();
  return ORIGINAL_TWIN_UI.oem.filter(row => (segment === 'ALL' || row.segment === segment)
    && (!value || [row.vendor, row.model, row.segment, row.key_specs, row.process_node].some(text => text.toLowerCase().includes(value))));
}

export interface OriginalSignalTarget { referenceId?: string; layoutIndex?: number }
/** Source Map order: B1 towers, catalog UUID/alias pairs, then draft families.
 * Replacing an existing key changes its target without changing its order.
 * Airlock indicators belong to their own animation, not this Andon Map.
 */
export function buildOriginalSignalRegistry(): Map<string, OriginalSignalTarget> {
  const registry = new Map<string, OriginalSignalTarget>();
  for (const row of ORIGINAL_TWIN_UI.equipment) if (row.level === 'B1') registry.set(row.id, { referenceId: row.id });
  for (const index of originalLayoutRenderOrder()) {
    const identity = TWIN_LAYOUT_IDENTITIES[index];
    const target = { layoutIndex: index, ...(FAB_LAYOUT[index].originalKind === 'catalog' ? { referenceId: identity.recordId } : {}) };
    registry.set(identity.recordId, target);
    registry.set(identity.machineId, target);
  }
  return registry;
}
