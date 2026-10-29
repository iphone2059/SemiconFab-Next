/**
 * Type-level contract: the Run ScopeToken is an abort/legacy-write guard for UI
 * submissions, never part of the device command identity or its idempotency input.
 */
import type { SubmitEquipmentCommandInput } from '@/api/command.schema';
import type { ScopeToken } from '@/runtime/scope-gate';

const input: SubmitEquipmentCommandInput = {
  siteId: 'site', fabId: 'fab', equipmentId: 'equipment', action: 'START', idempotencyKey: 'key',
};

// @ts-expect-error ScopeToken must not be mixed into the device command payload.
const withScope: SubmitEquipmentCommandInput = { ...input, scopeToken: {} as ScopeToken };

export { input, withScope };
