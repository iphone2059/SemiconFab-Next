import { Effect, PubSub, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommandConnectionStatus,
  CommandEventSource,
  CommandSourceAvailability,
} from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { FabRuntime } from '@/runtime/fab-runtime';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
import {
  type FakeCommandGateway,
  type TestFab,
  type TestFabOptions,
  FakeCommandEventSource,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

/**
 * R5.4-01 acceptance contract (terminal-state protection).
 *
 * FabRuntime.setPhase() is the ONE phase transition entry:
 * - terminal 'Unrecoverable' and no-authority 'Unavailable' are invariant under
 *   realtime availability (an unavailable/uninstantiable SSE transport may never
 *   downgrade them to Degraded);
 * - only non-terminal phases may map to Degraded while the realtime source is
 *   unavailable;
 * - only a NEW external dirty input (source.dirty, source.gaps/replay-gap,
 *   explicit requestAuthoritativeRecovery()) may re-arm Unrecoverable: attempts
 *   reset for a new bounded episode;
 * - connection-status transitions, transport failures, pending-source finite
 *   stream exits, stop()/start() remounts, internal defects and ordinary timers
 *   are internal and must leave phase + attempt budget untouched;
 * - completeRecoverySuccess() remains the only Healthy entry and with unavailable
 *   realtime may only reach Degraded.
 *
 * The local doubles model a runtime whose HTTP recovery authority exists while the
 * SSE transport is permanently unavailable (pending EventSource composition).
 */
const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fab(options: TestFabOptions): TestFab {
  const created = createTestFab(options);
  fabs.push(created);
  return created;
}

const FAST_RECOVERY = { backoffMs: [1], maxAttempts: 2 } as const;

/** Ready-event machinery fake whose transport capability is 'unavailable'. */
class UnavailableCommandSource extends FakeCommandEventSource {
  override readonly availability: CommandSourceAvailability = 'unavailable';
}

/**
 * Pending-source double whose connectionStatus stream is FINITE: it replays
 * 'failed' once and ends when endConnectionStatus() shuts the signal bus. This is
 * the R4-05 "pending-source finite stream exit" internal path.
 */
class FiniteStatusUnavailableCommandSource extends FakeCommandEventSource {
  override readonly availability: CommandSourceAvailability = 'unavailable';
  private readonly finiteStatusBus = Effect.runSync(PubSub.unbounded<CommandConnectionStatus>());
  override readonly connectionStatus = Stream.concat(
    Stream.succeed<CommandConnectionStatus>('failed'),
    Stream.fromPubSub(this.finiteStatusBus),
  );

  endConnectionStatus(): void {
    Effect.runSync(PubSub.shutdown(this.finiteStatusBus));
  }
}

function failingListGateway(): FakeCommandGateway {
  return fakeCommandGateway({
    listFabCommands: async () => {
      throw new Error('HTTP 503 transient');
    },
  });
}

async function reachUnrecoverable(
  source: CommandEventSource,
  options: { readonly gateway?: CommandGateway; readonly maxAttempts?: number } = {},
): Promise<TestFab> {
  const created = fab({
    source,
    gateway: options.gateway ?? failingListGateway(),
    connectionStatus: 'failed',
    recovery: { backoffMs: [1], maxAttempts: options.maxAttempts ?? FAST_RECOVERY.maxAttempts },
  });
  created.runtime.start();
  await expect.poll(() => created.runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
  return created;
}

/** Sample phase/attempts across ticks+timer windows: terminal state must not drift. */
async function expectTerminalStable(runtime: FabRuntime, attempts: number, ticks = 10, delayMs = 5): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    const state = runtime.recoveryState;
    expect(state.phase).toBe('Unrecoverable');
    expect(state.attempts).toBe(attempts);
    await flush(delayMs);
  }
}

describe('R5.4-01: display-only composition remains Unavailable', () => {
  it('T00: no gateway => Unavailable (never Degraded) and stays terminal across lifecycle churn', async () => {
    const created = fab({
      source: createPendingCommandEventSource(),
      gateway: undefined,
      connectionStatus: 'failed',
    });
    const runtime = created.runtime;
    runtime.start();
    expect(runtime.recoveryState).toMatchObject({ phase: 'Unavailable', availability: 'unavailable' });
    for (let index = 0; index < 8; index += 1) {
      expect(runtime.recoveryState.phase).toBe('Unavailable');
      await flush(5);
    }
    runtime.stop();
    runtime.start();
    await flush(20);
    expect(runtime.recoveryState.phase).toBe('Unavailable');
    expect(runtime.recoveryState.availability).toBe('unavailable');
  });
});

describe('R5.4-01: terminal Unrecoverable while the realtime source is unavailable', () => {
  it('T01: pending source + available HTTP gateway + failing List requests => Unrecoverable after maxAttempts', async () => {
    let listCalls = 0;
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        listCalls += 1;
        throw new Error('HTTP 503 transient');
      },
    });
    const created = fab({ source: createPendingCommandEventSource(), gateway, recovery: FAST_RECOVERY });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(runtime.recoveryState.attempts).toBe(FAST_RECOVERY.maxAttempts);
    expect(listCalls).toBe(FAST_RECOVERY.maxAttempts);
    // The recovery authority exists; only the realtime transport does not.
    expect(runtime.recoveryState.availability).toBe('available');
    expect(runtime.recoveryState.realtimeAvailability).toBe('unavailable');
  });

  it('T02: connection-status/transport churn keeps Unrecoverable and preserves the attempt budget', async () => {
    const source = new UnavailableCommandSource();
    const created = await reachUnrecoverable(source);
    const runtime = created.runtime;
    const attempts = runtime.recoveryState.attempts;
    expect(attempts).toBe(FAST_RECOVERY.maxAttempts);

    source.setConnectionStatus('reconnecting');
    source.failTransport({ message: 'SSE interrupted' });
    source.setConnectionStatus('open');
    source.reconnect();
    source.setConnectionStatus('closed');
    source.setConnectionStatus('failed');

    await expectTerminalStable(runtime, attempts);
    expect(runtime.connectionState).toBe('failed');
  });

  it('T03: stop()/start() remount of a terminal runtime keeps Unrecoverable and the attempt budget', async () => {
    const source = new UnavailableCommandSource();
    const created = await reachUnrecoverable(source);
    const runtime = created.runtime;
    const attempts = runtime.recoveryState.attempts;

    runtime.stop();
    expect(runtime.recoveryState.phase).toBe('Unrecoverable');
    expect(runtime.recoveryState.attempts).toBe(attempts);

    runtime.start();
    await expectTerminalStable(runtime, attempts, 12, 5);

    // A second remount is still inert: start()/refresh cannot open a new episode.
    runtime.stop();
    runtime.start();
    await expectTerminalStable(runtime, attempts, 8, 5);
  });

  it('T03b: a pending-source finite connectionStatus stream exit cannot clear Unrecoverable', async () => {
    const source = new FiniteStatusUnavailableCommandSource();
    const created = await reachUnrecoverable(source);
    const runtime = created.runtime;
    const attempts = runtime.recoveryState.attempts;

    source.endConnectionStatus();
    await flush(20);
    await expectTerminalStable(runtime, attempts);
    // The consumer exit is an internal diagnostic only, never a new episode.
    expect(runtime.recoveryHistory.some((entry) => entry.cause === 'protocol-error')).toBe(true);
  });
});

describe('R5.4-01: only a NEW external dirty input re-arms Unrecoverable', () => {
  const externalInputs: ReadonlyArray<
    readonly [string, (runtime: FabRuntime, source: UnavailableCommandSource) => void]
  > = [
    ['source.dirty stream', (_runtime, source) => source.emitDirty({ reason: 'overflow', droppedCount: 1 })],
    ['source.gaps replay-gap stream', (_runtime, source) => source.emitGap()],
    ['explicit requestAuthoritativeRecovery()', (runtime) => runtime.requestAuthoritativeRecovery()],
  ];

  for (const [label, invoke] of externalInputs) {
    it(`T04: ${label} opens a NEW bounded episode (attempts reset, recovery runs again)`, async () => {
      let listCalls = 0;
      const gateway = fakeCommandGateway({
        listFabCommands: async () => {
          listCalls += 1;
          throw new Error('HTTP 503 transient');
        },
      });
      const source = new UnavailableCommandSource();
      const created = fab({ source, gateway, connectionStatus: 'open', recovery: FAST_RECOVERY });
      const runtime = created.runtime;
      runtime.start();

      await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
      expect(runtime.recoveryState.attempts).toBe(FAST_RECOVERY.maxAttempts);
      const callsAtTerminal = listCalls;
      await expect.poll(() => runtime.connectionState, { timeout: 2_000 }).toBe('open');

      invoke(runtime, source);

      // A fresh bounded episode must run: exactly maxAttempts new authoritative
      // requests, then Unrecoverable again with attempts === maxAttempts (never
      // maxAttempts+1, which would prove the terminal budget was NOT reset).
      await expect.poll(() => listCalls, { timeout: 2_000 }).toBeGreaterThanOrEqual(callsAtTerminal + FAST_RECOVERY.maxAttempts);
      await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
      expect(listCalls).toBe(callsAtTerminal + FAST_RECOVERY.maxAttempts);
      expect(runtime.recoveryState.attempts).toBe(FAST_RECOVERY.maxAttempts);
    });
  }

  it('T04: explicit requestAuthoritativeRecovery() with a healthy HTTP authority leaves the terminal state', async () => {
    let failing = true;
    let listCalls = 0;
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        listCalls += 1;
        if (failing) throw new Error('HTTP 503 transient');
        return emptyRecoveryList();
      },
    });
    // Connection open but transport capability unavailable: the authoritative List
    // converges, the Healthy barrier correctly refuses and the runtime reports
    // Degraded - never the terminal phase and never Healthy.
    const source = new UnavailableCommandSource();
    const created = fab({ source, gateway, connectionStatus: 'open', recovery: FAST_RECOVERY });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    const callsAtTerminal = listCalls;
    failing = false;
    runtime.requestAuthoritativeRecovery();

    await expect.poll(() => listCalls, { timeout: 2_000 }).toBeGreaterThan(callsAtTerminal);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).not.toBe('Unrecoverable');
    expect(runtime.recoveryState.phase).toBe('Degraded');
    // The re-armed authoritative pass really applied a snapshot (not just a retry).
    await expect.poll(() => runtime.recoveryState.authoritativeWatermark, { timeout: 2_000 }).toBeDefined();
  });
});

describe('R5.4-01: Degraded vs Healthy under realtime availability', () => {
  it('T05: pending source + successful authoritative recovery => Degraded, never Healthy', async () => {
    const gateway = fakeCommandGateway({ listFabCommands: async () => emptyRecoveryList() });
    const created = fab({ source: createPendingCommandEventSource(), gateway });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => gateway.listCalls.length, { timeout: 2_000 }).toBeGreaterThan(0);
    await flush(20);
    const observed = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      observed.add(runtime.recoveryState.phase);
      await flush(5);
    }
    expect(observed.has('Healthy')).toBe(false);
    expect(runtime.recoveryState.phase).toBe('Degraded');
    expect(runtime.recoveryState.realtimeAvailability).toBe('unavailable');
  });

  it('T05b: authoritative recovery success with unavailable realtime is held at Degraded (never Healthy)', async () => {
    const gateway = fakeCommandGateway({ listFabCommands: async () => emptyRecoveryList() });
    const source = new UnavailableCommandSource();
    const created = fab({ source, gateway, connectionStatus: 'open' });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => runtime.connectionState, { timeout: 2_000 }).toBe('open');
    // Insurance: request one authoritative pass while the connection is provably
    // open so the pass certainly runs with a live connection value.
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });

    // The pass applies the authoritative snapshot (watermark recorded) but the
    // Healthy barrier rejects the unavailable realtime capability: Degraded only.
    await expect.poll(() => runtime.recoveryState.authoritativeWatermark, { timeout: 2_000 }).toBeDefined();
    expect(runtime.recoveryState.phase).toBe('Degraded');
    expect(runtime.recoveryHistory.some(
      (entry) => entry.cause === 'protocol-error' && (entry.message ?? '').includes('Healthy barrier rejected'),
    )).toBe(true);
    const observed = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      observed.add(runtime.recoveryState.phase);
      await flush(5);
    }
    expect(observed.has('Healthy')).toBe(false);
  });

  it('T06: ready/open SSE + authoritative recovery success => Healthy', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({ listFabCommands: async () => emptyRecoveryList() });
    const created = fab({ source, gateway });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => runtime.connectionState, { timeout: 2_000 }).toBe('open');
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.recoveryState.attempts).toBe(0);
    expect(runtime.recoveryState.realtimeAvailability).toBe('ready');
  });
});

describe('R5.4-01: terminal diagnostics evidence', () => {
  it('T07: diagnostics snapshot after maxAttempts proves Unrecoverable + terminal error', async () => {
    let listCalls = 0;
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        listCalls += 1;
        throw new Error('HTTP 503 transient');
      },
    });
    const created = fab({
      source: createPendingCommandEventSource(),
      gateway,
      recovery: { backoffMs: [1], maxAttempts: 3 },
    });
    const runtime = created.runtime;
    runtime.start();

    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    const state = runtime.recoveryState;
    expect(state.phase).toBe('Unrecoverable');
    expect(state.lastError).toBeDefined();
    expect(state.lastError).toMatch(/503|transient/i);
    expect(state.attempts).toBeGreaterThanOrEqual(state.maxAttempts);
    expect(state.attempts).toBeGreaterThanOrEqual(3);
    expect(listCalls).toBeGreaterThanOrEqual(3);
    expect(state.availability).toBe('available');
    expect(state.realtimeAvailability).toBe('unavailable');

    const terminalDiagnostics = runtime.recoveryHistory.filter(
      (entry) => entry.phase === 'Unrecoverable' && entry.cause === 'error',
    );
    expect(terminalDiagnostics.length).toBeGreaterThanOrEqual(1);
    expect(terminalDiagnostics.some((entry) => (entry.message ?? '').includes('recovery stopped after'))).toBe(true);
  });
});
