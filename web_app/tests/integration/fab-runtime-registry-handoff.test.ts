import { afterEach, expect, it, vi } from 'vitest';
import { type FabIdentity } from '@/domain/fab-identity';
import type { CommandAdmissionReservation } from '@/runtime/fab-runtime';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import {
  commandResult,
  createTestFab,
  fakeCommandGateway,
  type TestFab,
  type TestFabOptions,
} from '../support/command-fakes.ts';

/**
 * R5.4-02: accepted-command handoff across FabRuntime generations.
 *
 * The registry is exercised through its public contract only (no internal Map
 * access): cases A-E from docs/architecture/round5.4-interface-freeze.md §3.
 */

const identity: FabIdentity = { siteId: 'site-1', fabId: 'fab-a' };
const otherIdentity: FabIdentity = { siteId: 'site-2', fabId: 'fab-a' };

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function makeFab(scope: FabIdentity = identity, options: TestFabOptions = {}): TestFab {
  const fab = createTestFab({ siteId: scope.siteId, fabId: scope.fabId, ...options });
  fabs.push(fab);
  return fab;
}

interface ReservationProbe {
  readonly reservation: CommandAdmissionReservation;
  readonly commit: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
}

/** Reservation fixture whose state/commit/release calls are observable. */
function probeReservation(
  state: 'reserved' | 'committed' | 'released' = 'released',
  scope: FabIdentity = identity,
): ReservationProbe {
  let current: 'reserved' | 'committed' | 'released' = state;
  const commit = vi.fn();
  const release = vi.fn();
  const reservation: CommandAdmissionReservation = {
    siteId: scope.siteId,
    fabId: scope.fabId,
    get state() { return current; },
    commit: (commandId: string) => { commit(commandId); current = 'committed'; },
    release: () => { release(); current = 'released'; },
  };
  return { reservation, commit, release };
}

/** A real runtime reservation that was already released (e.g. its generation was disposed). */
let reservationSequence = 0;
function releasedRealReservation(scope: FabIdentity = identity): CommandAdmissionReservation {
  const fab = makeFab(scope);
  const reservation = fab.runtime.reserveCommandAdmission('idem-' + String(++reservationSequence));
  reservation.release();
  return reservation;
}

it('T01: a 202 after the runtime was removed becomes recovery-pending, commandId retained', () => {
  const registry = new FabRuntimeRegistry();
  const oldFab = makeFab();
  oldFab.runtime.start();
  registry.register(oldFab.runtime);
  const reservation = oldFab.runtime.reserveCommandAdmission('idem-t01');
  registry.remove(identity);
  expect(registry.size).toBe(0);
  // remove() disposed the runtime, which released the reservation exactly once.
  expect(reservation.state).toBe('released');

  // registerAcceptedCommand must not release again (a second release() throws).
  const registration = registry.registerAcceptedCommand(identity, 'cmd-t01', reservation);
  expect(registration).toEqual({ kind: 'recovery-pending' });
  expect(registry.pendingHandoffCount).toBe(1);
  expect(registry.get(identity)).toBeUndefined();
  // Case C: never commit, never create a detached workflow on the old generation.
  expect(oldFab.runtime.workflowCount).toBe(0);
});

it('T02: a late 202 with an already-released reservation never commits and never releases twice', () => {
  const registry = new FabRuntimeRegistry();
  const released = probeReservation('released');
  expect(registry.registerAcceptedCommand(identity, 'cmd-t02', released.reservation)).toEqual({ kind: 'recovery-pending' });
  expect(released.commit).not.toHaveBeenCalled();
  expect(released.release).not.toHaveBeenCalled();
  expect(registry.pendingHandoffCount).toBe(1);

  // With a current runtime the id is adopted and the stale reservation is untouched.
  const current = makeFab();
  registry.register(current.runtime);
  expect(registry.pendingHandoffCount, 'register() flushes the pending id').toBe(0);
  const late = probeReservation('released');
  expect(registry.registerAcceptedCommand(identity, 'cmd-t02-late', late.reservation)).toEqual({ kind: 'registered' });
  expect(late.commit).not.toHaveBeenCalled();
  expect(late.release).not.toHaveBeenCalled();
  expect(current.runtime.workflowCount).toBe(2);
});

it('T03: a new runtime registration flushes pending accepted commands and clears pending state', () => {
  const registry = new FabRuntimeRegistry();
  expect(registry.registerAcceptedCommand(identity, 'cmd-t03-a', releasedRealReservation())).toEqual({ kind: 'recovery-pending' });
  expect(registry.registerAcceptedCommand(identity, 'cmd-t03-b', releasedRealReservation())).toEqual({ kind: 'recovery-pending' });
  expect(registry.pendingHandoffCount).toBe(2);

  const next = makeFab();
  registry.register(next.runtime);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(next.runtime.workflowCount).toBe(2);
  expect(next.runtime.getWorkflow('cmd-t03-a')).toBeDefined();
  expect(next.runtime.getWorkflow('cmd-t03-b')).toBeDefined();
  expect(next.runtime.lifecycleCounts.created).toBe(2);
});

it('T04: a terminal command converges after handoff through the command-id authoritative query', async () => {
  const registry = new FabRuntimeRegistry();
  const oldFab = makeFab();
  oldFab.runtime.start();
  registry.register(oldFab.runtime);
  const reservation = oldFab.runtime.reserveCommandAdmission('idem-t04');
  registry.remove(identity);
  expect(registry.registerAcceptedCommand(identity, 'cmd-t04', reservation)).toEqual({ kind: 'recovery-pending' });

  const gateway = fakeCommandGateway({
    getCommandStatus: (fabId, commandId) => Promise.resolve(
      commandId === 'cmd-t04'
        ? commandResult({ fabId, commandId, revision: 1, outcome: 'succeeded' })
        : null,
    ),
  });
  const next = makeFab(identity, { gateway });
  registry.register(next.runtime);
  next.runtime.start();

  await vi.waitFor(() => {
    expect(
      next.runtime.getProjection('cmd-t04')?.outcome,
      'the handed-off command must converge from the single-command getCommandStatus query',
    ).toBe('succeeded');
  });
  expect(next.runtime.getProjection('cmd-t04')).toMatchObject({
    state: 'succeeded',
    revision: 1,
    recoveryDisposition: 'tracked',
  });
  // The convergence path is the command-id authoritative query, not an active-only list.
  expect(gateway.statusCalls).toContainEqual({ fabId: identity.fabId, commandId: 'cmd-t04' });
});

it('T05: multiple accepted commands of one identity are all retained and the recovery request is coalesced', async () => {
  const registry = new FabRuntimeRegistry();
  registry.registerAcceptedCommand(identity, 'cmd-t05-a', releasedRealReservation());
  registry.registerAcceptedCommand(identity, 'cmd-t05-b', releasedRealReservation());
  expect(registry.pendingHandoffCount).toBe(2);
  // Two explicit recovery intents for the same identity must coalesce into one.
  registry.requestAuthoritativeRecovery(identity);
  registry.requestAuthoritativeRecovery(identity);

  const gateway = fakeCommandGateway();
  const next = makeFab(identity, { gateway });
  const recoveryRequest = vi.spyOn(next.runtime, 'requestAuthoritativeRecovery');
  registry.register(next.runtime);
  expect(next.runtime.workflowCount).toBe(2);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(recoveryRequest).toHaveBeenCalledTimes(1);
  // Recorded but not executed before start(); the observable state proves the intent.
  expect(next.runtime.recoveryState.phase).toBe('Dirty');
  expect(next.runtime.recoveryState.recoveryPending).toBe(true);
  expect(gateway.listCalls).toHaveLength(0);

  next.runtime.start();
  await vi.waitFor(() => expect(next.runtime.recoveryState.recovering).toBe(false));
  expect(gateway.listCalls, 'one coalesced authoritative pass, not one per command').toHaveLength(1);
  expect(gateway.listCalls[0]).toMatchObject({ siteId: identity.siteId, fabId: identity.fabId });
  expect(next.runtime.workflowCount).toBe(2);
});

it('T06: a new runtime that already exists adopts the commandId; the old reservation is released exactly once', () => {
  const registry = new FabRuntimeRegistry();
  const oldFab = makeFab();
  oldFab.runtime.start();
  const oldReservation = oldFab.runtime.reserveCommandAdmission('idem-t06');
  let releases = 0;
  let commits = 0;
  const wrapped: CommandAdmissionReservation = {
    siteId: identity.siteId,
    fabId: identity.fabId,
    get state() { return oldReservation.state; },
    commit: (commandId: string) => { commits += 1; oldReservation.commit(commandId); },
    release: () => { releases += 1; oldReservation.release(); },
  };

  const current = makeFab();
  registry.register(current.runtime);
  const registration = registry.registerAcceptedCommand(identity, 'cmd-t06', wrapped);
  expect(registration).toEqual({ kind: 'registered' });
  expect(commits, 'a replaced reservation is never committed').toBe(0);
  expect(releases, 'the old reservation is released exactly once').toBe(1);
  expect(oldReservation.state).toBe('released');
  expect(oldFab.runtime.workflowCount, 'the old generation must not track the command').toBe(0);
  expect(current.runtime.getWorkflow('cmd-t06')).toBeDefined();
  expect(current.runtime.workflowCount).toBe(1);
  expect(registry.pendingHandoffCount).toBe(0);
});

it('T07: pending handoff state survives disposeAll and a new generation accepts it', () => {
  const registry = new FabRuntimeRegistry();
  // Generation 1 exists but refuses accepted commands; the id stays pending.
  const rejecting = makeFab(identity, {
    createWorkflow: () => { throw new Error('generation 1 cannot accept commands'); },
  });
  registry.register(rejecting.runtime);
  expect(registry.registerAcceptedCommand(identity, 'cmd-t07', releasedRealReservation())).toEqual({ kind: 'recovery-pending' });
  expect(registry.pendingHandoffCount).toBe(1);
  expect(rejecting.runtime.workflowCount).toBe(0);

  registry.disposeAll();
  expect(registry.size).toBe(0);
  expect(registry.pendingHandoffCount, 'disposeAll() must retain pending handoff state').toBe(1);

  const next = makeFab();
  registry.register(next.runtime);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(next.runtime.workflowCount).toBe(1);
  expect(next.runtime.getWorkflow('cmd-t07')).toBeDefined();
});

it('T08: duplicate handoff of the same commandId never creates a duplicate workflow', () => {
  const registry = new FabRuntimeRegistry();
  registry.registerAcceptedCommand(identity, 'cmd-t08', releasedRealReservation());
  registry.registerAcceptedCommand(identity, 'cmd-t08', releasedRealReservation());
  expect(registry.pendingHandoffCount, 'duplicate pending handoff is idempotent').toBe(1);

  const next = makeFab();
  registry.register(next.runtime);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(next.runtime.workflowCount).toBe(1);
  expect(next.runtime.lifecycleCounts.created).toBe(1);
  const workflow = next.runtime.getWorkflow('cmd-t08');
  expect(workflow).toBeDefined();

  // A late duplicate 202 for the same id must hand the id to the SAME workflow.
  expect(registry.registerAcceptedCommand(identity, 'cmd-t08', releasedRealReservation())).toEqual({ kind: 'registered' });
  expect(next.runtime.getWorkflow('cmd-t08')).toBe(workflow);
  expect(next.runtime.workflowCount).toBe(1);
  expect(next.runtime.lifecycleCounts.created).toBe(1);
});

it('T09: requestAuthoritativeRecovery without a runtime records one intent and executes it on registration', async () => {
  const registry = new FabRuntimeRegistry();
  registry.requestAuthoritativeRecovery(identity);
  registry.requestAuthoritativeRecovery(identity);
  expect(registry.size).toBe(0);

  const gateway = fakeCommandGateway();
  const next = makeFab(identity, { gateway });
  const recoveryRequest = vi.spyOn(next.runtime, 'requestAuthoritativeRecovery');
  registry.register(next.runtime);
  expect(recoveryRequest, 'the retained intent is coalesced into one request').toHaveBeenCalledTimes(1);
  expect(next.runtime.recoveryState.phase).toBe('Dirty');
  expect(next.runtime.recoveryState.recoveryPending).toBe(true);

  next.runtime.start();
  await vi.waitFor(() => expect(next.runtime.recoveryState.recovering).toBe(false));
  expect(gateway.listCalls).toHaveLength(1);
  expect(gateway.listCalls[0]).toMatchObject({ siteId: identity.siteId, fabId: identity.fabId });
});

it('case A: a current runtime reservation is committed once with a single workflow', () => {
  const registry = new FabRuntimeRegistry();
  const fab = makeFab();
  registry.register(fab.runtime);
  const reservation = fab.runtime.reserveCommandAdmission('idem-case-a');
  expect(registry.registerAcceptedCommand(identity, 'cmd-a', reservation)).toEqual({ kind: 'registered' });
  expect(reservation.state).toBe('committed');
  expect(fab.runtime.workflowCount).toBe(1);
  expect(fab.runtime.lifecycleCounts.created).toBe(1);
  expect(registry.pendingHandoffCount).toBe(0);
});

it('keys runtimes and pending handoffs by composite identity: the same fabId in two sites never collides', () => {
  const registry = new FabRuntimeRegistry();
  registry.registerAcceptedCommand(otherIdentity, 'cmd-site-2', probeReservation('released', otherIdentity).reservation);
  expect(registry.pendingHandoffCount).toBe(1);

  const siteOne = makeFab();
  registry.register(siteOne.runtime);
  expect(registry.get(identity)).toBe(siteOne.runtime);
  expect(registry.get(otherIdentity)).toBeUndefined();
  expect(registry.pendingHandoffCount, 'a different site identity is not flushed').toBe(1);

  const siteTwo = makeFab(otherIdentity);
  registry.register(siteTwo.runtime);
  expect(registry.size).toBe(2);
  expect(registry.get(otherIdentity)).toBe(siteTwo.runtime);
  expect(registry.fabIdentities).toEqual([identity, otherIdentity]);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(siteTwo.runtime.getWorkflow('cmd-site-2')).toBeDefined();
  expect(siteOne.runtime.workflowCount).toBe(0);

  const duplicate = makeFab();
  expect(() => registry.register(duplicate.runtime)).toThrow(/already registered/);
  expect(() => registry.register(makeFab().runtime)).toThrow(/already registered/);
  registry.remove(otherIdentity);
  expect(registry.size).toBe(1);
  expect(registry.get(identity)).toBe(siteOne.runtime);
  expect(registry.remove(otherIdentity)).toBeUndefined();
});

it('validates that the reservation identity matches the accepted command identity', () => {
  const registry = new FabRuntimeRegistry();
  const mismatched = probeReservation('released', otherIdentity);
  expect(() => registry.registerAcceptedCommand(identity, 'cmd-mismatch', mismatched.reservation)).toThrow(/identity mismatch/);
  expect(registry.pendingHandoffCount).toBe(0);
  expect(mismatched.release).not.toHaveBeenCalled();
});

it('keeps independent pending command sets for two identities', () => {
  const registry = new FabRuntimeRegistry();
  registry.registerAcceptedCommand(identity, 'cmd-one', releasedRealReservation(identity));
  registry.registerAcceptedCommand(otherIdentity, 'cmd-two', releasedRealReservation(otherIdentity));
  expect(registry.pendingHandoffCount).toBe(2);
  const siteTwo = makeFab(otherIdentity);
  registry.register(siteTwo.runtime);
  expect(siteTwo.runtime.getWorkflow('cmd-two')).toBeDefined();
  expect(siteTwo.runtime.getWorkflow('cmd-one')).toBeUndefined();
  expect(registry.pendingHandoffCount).toBe(1);
});
