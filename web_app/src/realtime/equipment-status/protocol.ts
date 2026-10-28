/**
 * Wire protocol of the FAB-scoped equipment status feed.
 *
 * This is the one authority for the snapshot shape and the composite Site/FAB
 * scope identity: the SSE stream (stream.ts) and the ordered gate (gate.ts) both
 * validate through this module, so REST and SSE can never disagree about which
 * site/FAB a frame belongs to or what a well-formed payload looks like.
 *
 * Ordering across server generations (epoch) and within a generation (sequence)
 * lives in gate.ts and nowhere else.
 */

export type EquipmentStateCode = 'running' | 'idle' | 'down' | 'maint';

const EQUIPMENT_STATE_CODES: ReadonlySet<string> = new Set(['running', 'idle', 'down', 'maint']);

export interface EquipmentStatusItem {
  readonly state: string;
}

export interface EquipmentStatusSnapshot {
  readonly siteId: string;
  /** Required FAB identity: every current backend status frame is FAB-scoped. */
  readonly fabId: string;
  /**
   * Display time only. Ordering uses (epoch, sequence); a newer server
   * generation may legitimately report an older `generatedAt` first.
   */
  readonly generatedAt: string;
  /** Monotonic per-FAB sequence, required on the wire. */
  readonly sequence: number;
  /** Required generation counter; a restart must advance it. */

  readonly epoch: number;
  readonly tools: EquipmentStatusItem[];
}

/** Composite identity for FAB-scoped equipment status: REST + SSE must agree. */
export interface EquipmentStatusScope {
  readonly siteId: string;
  readonly fabId: string;
}

/** Scope identity is exact; no site-only legacy fallback. */
export function isInScope(value: Partial<EquipmentStatusSnapshot>, scope: EquipmentStatusScope): boolean {
  return value.siteId === scope.siteId && value.fabId === scope.fabId;
}

export function isEquipmentStateCode(value: unknown): value is EquipmentStateCode {
  return typeof value === 'string' && EQUIPMENT_STATE_CODES.has(value);
}

/** Sequence/epoch counters must be non-negative safe integers. */
export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate one candidate snapshot against the scope and payload contract.
 *
 * - `expectedToolCount === undefined` is the SSE decode rule: a frame must carry
 *   at least one well-formed tool entry (the exact FAB layout count is enforced
 *   by the ordered gate, which knows the layout).
 * - a number requires exactly that many tool entries (REST + gate contract).
 *
 * Ordering fields are only type-checked here; sequence/epoch ordering is gate.ts.
 */
export function isValidEquipmentStatusSnapshot(
  value: unknown,
  scope: EquipmentStatusScope,
  expectedToolCount: number | undefined,
): value is EquipmentStatusSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<EquipmentStatusSnapshot>;
  if (!isInScope(snapshot, scope) || typeof snapshot.generatedAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.generatedAt))) return false;
  if (!isSafeCount(snapshot.sequence) || !isSafeCount(snapshot.epoch)) return false;
  const tools = snapshot.tools;
  if (!Array.isArray(tools)) return false;
  if (expectedToolCount === undefined ? tools.length === 0 : tools.length !== expectedToolCount) return false;
  return tools.every(tool =>
    tool !== null && typeof tool === 'object' && isEquipmentStateCode((tool as Partial<EquipmentStatusItem>).state));
}

/**
 * Protocol decode of one SSE `data` payload. Structural validation only: a
 * well-formed frame that is merely late is still decoded here and rejected by
 * the ordered gate, so an out-of-order frame never marks the stream stale.
 *
 * Throws when the payload is not JSON or violates the scope/payload contract.
 */
export function decodeEquipmentStatusFrame(data: string, scope: EquipmentStatusScope): EquipmentStatusSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error('Invalid equipment status frame: not JSON');
  }
  if (!isValidEquipmentStatusSnapshot(value, scope, undefined)) {
    throw new Error('Invalid equipment status scope or payload');
  }
  return value;
}
