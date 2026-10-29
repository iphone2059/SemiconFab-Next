import { expect, it } from 'vitest';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { compareEquipmentStatusSnapshot } from '@/realtime/equipment-status.gate';
import {
  decodeEquipmentStatusFrame,
  isEquipmentStateCode,
  isInScope,
  isValidEquipmentStatusSnapshot,
  type EquipmentStatusSnapshot,
} from '@/realtime/equipment-status.protocol';

/**
 * Wire protocol of the FAB-scoped status feed. protocol.ts is the only place
 * that knows the Site/FAB scope rule and the snapshot shape; the SSE stream
 * decodes through it and the ordered gate validates through it.
 */

const scope = { siteId: 'site-1', fabId: 'fab-a' };
const tools = (count = 2, state = 'running') => Array.from({ length: count }, () => ({ state }));
const frame = (patch: Partial<EquipmentStatusSnapshot> = {}): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId: 'fab-a',
  generatedAt: '2026-10-27T00:00:00Z',
  sequence: 1,
  epoch: 1,
  tools: tools(),
  ...patch,
});
const decode = (value: unknown): EquipmentStatusSnapshot => decodeEquipmentStatusFrame(JSON.stringify(value), scope);

it('decodes only complete FAB-scoped frames', () => {
  expect(decode(frame())).toEqual(frame());
  expect(() => decode({ ...frame(), fabId: undefined })).toThrow(/scope or payload/);
});

it('decodes a large frame without truncating its tool list', () => {
  const large = frame({ tools: tools(4_096, 'idle') });
  const decoded = decode(large);
  expect(decoded.tools).toHaveLength(4_096);
  expect(decoded.tools[4_095]).toEqual({ state: 'idle' });
});

it('the ordered comparison (not the decoder) owns the exact FAB tool count', () => {
  // Structural decode accepts any positive tool count; the commit comparison knows the layout.
  expect(() => decode(frame({ tools: tools(FAB_LAYOUT.length + 1) }))).not.toThrow();
  expect(compareEquipmentStatusSnapshot(scope, FAB_LAYOUT.length, undefined, frame({ tools: tools(FAB_LAYOUT.length) }))._tag).toBe('Accept');
  expect(compareEquipmentStatusSnapshot(scope, FAB_LAYOUT.length, undefined, frame({ tools: tools(FAB_LAYOUT.length + 1) }))).toEqual({ _tag: 'Reject', reason: 'invalid' });
  expect(compareEquipmentStatusSnapshot(scope, FAB_LAYOUT.length, undefined, frame({ tools: tools(FAB_LAYOUT.length - 1) }))).toEqual({ _tag: 'Reject', reason: 'invalid' });
});

it('rejects malformed JSON and non-object payloads', () => {
  expect(() => decodeEquipmentStatusFrame('{not json', scope)).toThrow(/not JSON/);
  for (const value of [null, 'frame', 7, [], true]) {
    expect(() => decode(value), JSON.stringify(value)).toThrow(/scope or payload/);
  }
});

it('rejects frames belonging to another site or FAB', () => {
  expect(() => decode(frame({ siteId: 'other-site' }))).toThrow(/scope or payload/);
  expect(() => decode(frame({ fabId: 'fab-b' }))).toThrow(/scope or payload/);
  // A payload with neither identity cannot be scoped at all.
  expect(() => decode({ fabId: 'fab-a', generatedAt: '2026-10-27T00:00:00Z', tools: tools() })).toThrow(/scope or payload/);
});

it('rejects missing or malformed fields', () => {
  const valid = frame();
  // Raw wire payloads: invalid fixtures are written as unknowns instead of
  // forcing mistyped values through the typed snapshot helper.
  const invalid: unknown[] = [
    // Missing identity/display fields.
    { siteId: valid.siteId, fabId: valid.fabId, tools: tools() },
    { ...valid, generatedAt: 42 },
    { ...valid, generatedAt: 'not-a-timestamp' },
    // Missing or malformed tools.
    { ...valid, tools: [] },
    { ...valid, tools: null },
    { ...valid, tools: 'none' },
    { ...valid, tools: [{ state: 'unknown' }] },
    { ...valid, tools: [null] },
    { ...valid, tools: [{}] },
    // Ordering counters are wire numbers: no string/numeric coercion is allowed.
    { ...valid, sequence: -1 },
    { ...valid, sequence: 1.5 },
    { ...valid, sequence: '2' },
    { ...valid, epoch: -1 },
    { ...valid, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, epoch: null },
    { ...valid, epoch: undefined },
    { ...valid, sequence: undefined },
    { ...valid, fabId: undefined },
  ];
  for (const value of invalid) {
    expect(() => decode(value), JSON.stringify(value)).toThrow(/scope or payload/);
  }
});

it('isInScope requires both Site and FAB identities', () => {
  expect(isInScope({ siteId: 'site-1' }, scope)).toBe(false);
  expect(isInScope({ siteId: 'site-1', fabId: 'fab-a' }, scope)).toBe(true);
  expect(isInScope({ siteId: 'site-1', fabId: 'fab-b' }, scope)).toBe(false);
  expect(isInScope({ siteId: 'other-site', fabId: 'fab-a' }, scope)).toBe(false);
});

it('the shared snapshot validator drives both the decoder and the ordered comparison', () => {
  expect(isValidEquipmentStatusSnapshot(frame(), scope, 2)).toBe(true);
  expect(isValidEquipmentStatusSnapshot(frame(), scope, 3)).toBe(false);
  // undefined count = structural SSE rule: at least one well-formed tool.
  expect(isValidEquipmentStatusSnapshot(frame({ tools: tools(0) }), scope, undefined)).toBe(false);
  expect(isValidEquipmentStatusSnapshot(frame({ tools: tools(1) }), scope, undefined)).toBe(true);
  expect(isEquipmentStateCode('maint')).toBe(true);
  expect(isEquipmentStateCode('MAINT')).toBe(false);
});

it('decode never orders frames: a well-formed late frame reaches the ordered comparison', () => {
  const first = decode(frame({ sequence: 5 }));
  expect(compareEquipmentStatusSnapshot(scope, 2, undefined, first)._tag).toBe('Accept');
  // A duplicate/late frame is well-formed, so the SSE transport must not mark the
  // stream stale for it; the comparison rejects it as stale (ordering, not invalid data).
  const late = decode(frame({ sequence: 4 }));
  expect(late.sequence).toBe(4);
  expect(compareEquipmentStatusSnapshot(scope, 2, { epoch: first.epoch, sequence: first.sequence }, late)).toEqual({ _tag: 'Reject', reason: 'stale' });
});