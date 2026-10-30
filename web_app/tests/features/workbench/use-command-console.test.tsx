// @vitest-environment jsdom
import { Effect } from 'effect';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpFailure } from '@/api/http.transport';

const fixtures = vi.hoisted(() => ({ submit: vi.fn(), getRuntime: vi.fn(), register: vi.fn(), recover: vi.fn() }));
vi.mock('@/api/commands.mutation', () => ({ submitEquipmentCommand: fixtures.submit }));
vi.mock('@/app/app-runtime-provider', () => ({ useAppRuntime: () => ({ runPromise: Effect.runPromise }) }));
vi.mock('@/app/runtime-provider', () => ({ useFabRuntimeRegistry: () => ({ get: fixtures.getRuntime, registerAcceptedCommand: fixtures.register, requestAuthoritativeRecovery: fixtures.recover }) }));
import { useCommandConsole } from '@/workbench/use-command-console';

const submitEvent = { preventDefault() {} } as React.FormEvent<HTMLFormElement>;
afterEach(() => { vi.clearAllMocks(); });

it('does not send HTTP when local admission is full', async () => {
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => { throw new Error('capacity reached'); } });
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });
  expect(fixtures.submit).not.toHaveBeenCalled();
  expect(result.current.error).toContain('capacity reached');
});

it('releases the reservation after HTTP 429 without registering an actor', async () => {
  let state: 'reserved' | 'released' = 'reserved';
  const reservation = { get state() { return state; }, release: vi.fn(() => { state = 'released'; }) };
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => reservation });
  fixtures.submit.mockReturnValue(Effect.fail(new HttpFailure(429, 'capacity reached')));
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });
  await waitFor(() => expect(result.current.error).toContain('capacity reached'));
  expect(reservation.release).toHaveBeenCalledOnce();
  expect(fixtures.register).not.toHaveBeenCalled();
});
