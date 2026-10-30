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

const identity = { siteId: 'site-1', fabId: 'fab-a' };
const submitted = {
  commandId: 'cmd-1',
  siteId: 'site-1',
  fabId: 'fab-a',
  equipmentId: 'equipment-0',
  action: 'START' as const,
  revision: 1,
  outcome: 'accepted' as const,
  occurredAt: '2026-10-27T00:00:00.000Z',
};

/** Reservation fixture bound to the console's submit lifetime. */
function reservationFixture() {
  let state: 'reserved' | 'released' | 'committed' = 'reserved';
  return {
    siteId: 'site-1',
    fabId: 'fab-a',
    get state() { return state; },
    commit: vi.fn(() => { state = 'committed'; }),
    release: vi.fn(() => { state = 'released'; }),
  };
}

afterEach(() => { vi.resetAllMocks(); });

it('does not send HTTP when local admission is full', async () => {
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => { throw new Error('capacity reached'); } });
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });
  expect(fixtures.submit).not.toHaveBeenCalled();
  expect(result.current.error).toContain('capacity reached');
});

it('releases the reservation after HTTP 429 without registering an actor', async () => {
  const reservation = reservationFixture();
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => reservation });
  fixtures.submit.mockReturnValue(Effect.fail(new HttpFailure(429, 'capacity reached')));
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });
  await waitFor(() => expect(result.current.error).toContain('capacity reached'));
  expect(reservation.release).toHaveBeenCalledOnce();
  expect(fixtures.register).not.toHaveBeenCalled();
  expect(fixtures.recover).not.toHaveBeenCalled();
});

it('reads the runtime with the full composite identity', () => {
  fixtures.getRuntime.mockReturnValue(undefined);
  renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  expect(fixtures.getRuntime).toHaveBeenCalledWith(identity);
});

it('tracks a registered handoff and never releases the accepted reservation twice', async () => {
  const reservation = reservationFixture();
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => reservation });
  fixtures.submit.mockReturnValue(Effect.succeed(submitted));
  fixtures.register.mockReturnValue({ kind: 'registered' });
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });

  expect(fixtures.register).toHaveBeenCalledWith(identity, 'cmd-1', reservation);
  // The registry owns the accepted handoff; the console must not release it.
  expect(reservation.release).not.toHaveBeenCalled();
  expect(result.current.tracked).toEqual([{ ...identity, commandId: 'cmd-1', handoff: 'registered' }]);
  expect(result.current.error).toBe('');
});

it('keeps a recovery-pending accepted commandId tracked instead of dropping it', async () => {
  const reservation = reservationFixture();
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => reservation });
  fixtures.submit.mockReturnValue(Effect.succeed(submitted));
  fixtures.register.mockReturnValue({ kind: 'recovery-pending' });
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });

  expect(fixtures.register).toHaveBeenCalledWith(identity, 'cmd-1', reservation);
  // The registry released the stale reservation; the console must not release it again.
  expect(reservation.release).not.toHaveBeenCalled();
  // Both union kinds mean accepted: the row is retained with its handoff kind.
  expect(result.current.tracked).toEqual([{ ...identity, commandId: 'cmd-1', handoff: 'recovery-pending' }]);
  expect(result.current.error).toBe('');
  expect(result.current.busy).toBe(false);
});

it('requests authoritative recovery with the full identity after a retryable submit failure', async () => {
  const reservation = reservationFixture();
  fixtures.getRuntime.mockReturnValue({ reserveCommandAdmission: () => reservation });
  fixtures.submit.mockReturnValue(Effect.fail(new Error('network down')));
  const { result } = renderHook(() => useCommandConsole({ siteId: 'site-1', fabId: 'fab-a' }));
  await act(async () => { await result.current.submit(submitEvent); });

  await waitFor(() => expect(result.current.error).toContain('network down'));
  expect(reservation.release).toHaveBeenCalledOnce();
  expect(fixtures.recover).toHaveBeenCalledWith(identity);
  expect(fixtures.register).not.toHaveBeenCalled();
  expect(result.current.tracked).toEqual([]);
});
