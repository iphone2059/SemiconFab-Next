import { expect, it } from 'vitest';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import {
  FakeCommandEventSource,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
} from '../support/command-fakes.ts';

/**
 * Real Phase D wire contract integration: the browser gateway decodes the exact
 * CommandRecoveryListDto / CommandJournalPageDto JSON served by the backend
 * (fab_app) and the FabRuntime recovery paths (refresh / severe gap / overflow)
 * converge through it. No fake gateway object is used here: only fetch is
 * injected with backend-shaped bodies, exercising URL construction, Effect
 * Schema decoding, identity checks and HTTP error mapping end to end.
 */

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const recoveryRecord = (overrides: Record<string, unknown> = {}) => ({
  siteId: 'site-1',
  fabId: 'fab-a',
  commandId: 'cmd-7',
  revision: 1,
  outcome: 'executing',
  occurredAt: '2026-10-29T00:00:00Z',
  terminal: false,
  ...overrides,
});

const statusBody = (overrides: Record<string, unknown> = {}) => ({
  siteId: 'site-1',
  fabId: 'fab-a',
  equipmentId: 'equipment-0',
  action: 'START',
  commandId: 'cmd-7',
  revision: 2,
  outcome: 'succeeded',
  occurredAt: '2026-10-29T00:00:01Z',
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function createBackendFetch(routes: (request: RecordedRequest) => Response) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = { url: String(input), init };
    requests.push(request);
    return routes(request);
  };
  return { requests, fetchImpl };
}

it('recovers a refreshed page unconfirmed command from the durable FAB listing and authoritative status', async () => {
  const harness = createCommandTestRuntime();
  try {
    const { requests, fetchImpl } = createBackendFetch((request) => {
      const url = request.url;
      if (url.includes('/commands?status=active')) {
        return json({ epoch: 'epoch-1', latestSequence: 12, commands: [recoveryRecord()] });
      }
      if (url.includes('/api/v1/commands/cmd-7')) return json(statusBody());
      if (url.includes('/command-journal')) {
        return json({ epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 12, events: [] });
      }
      return new Response('not found', { status: 404 });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ runPromise: harness.host.runPromise, fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway, lazyCommandSubscription: true });
    runtime.start();

    await expect.poll(() => runtime.workflowCount, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 1_000 }).toBe('succeeded');
    expect(runtime.lastRecoveryList).toMatchObject({
      epoch: 'epoch-1',
      latestSequence: 12,
      commands: [{ commandId: 'cmd-7', revision: 1, terminal: false }],
    });
    // The exact backend endpoints and query parameters were used.
    expect(requests.some((request) => request.url === '/api/v1/sites/site-1/fabs/fab-a/commands?status=active')).toBe(true);
    expect(requests.some((request) => request.url === '/api/v1/commands/cmd-7')).toBe(true);
    // The recovered command was tracked by the runtime, not by an in-memory ledger.
    expect(runtime.getWorkflow('cmd-7')).toBeDefined();
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});

it('falls back from a journal page with hasGap to the FAB listing and reconciles the cursor break', async () => {
  const harness = createCommandTestRuntime();
  try {
    const { requests, fetchImpl } = createBackendFetch((request) => {
      const url = request.url;
      if (url.includes('/command-journal')) {
        return json({ epoch: 'epoch-2', hasGap: true, firstRetainedSequence: 20, latestSequence: 25, events: [] });
      }
      if (url.includes('/commands?status=active')) {
        return json({
          epoch: 'epoch-2',
          latestSequence: 25,
          commands: [recoveryRecord({ revision: 2, outcome: 'succeeded', terminal: true })],
        });
      }
      if (url.includes('/api/v1/commands/cmd-7')) return json(statusBody());
      return new Response('not found', { status: 404 });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ runPromise: harness.host.runPromise, fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-7');
    source.emitGap({ epoch: 'epoch-2', sequence: 19 });

    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 1_000 }).toBe('succeeded');
    expect(runtime.lastJournalPage).toMatchObject({ hasGap: true, epoch: 'epoch-2' });
    const journalRequest = requests.find((request) => request.url.includes('/command-journal'));
    expect(journalRequest?.url).toBe('/api/v1/sites/site-1/fabs/fab-a/command-journal?afterSequence=19&limit=256');
    expect(requests.some((request) => request.url.includes('/commands?status=active'))).toBe(true);
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});

it('replays an overflow cursor through the journal page and delivers authoritative revisions', async () => {
  const harness = createCommandTestRuntime();
  try {
    const { requests, fetchImpl } = createBackendFetch((request) => {
      const url = request.url;
      if (url.includes('/command-journal')) {
        return json({
          epoch: 'epoch-1',
          hasGap: false,
          firstRetainedSequence: 0,
          latestSequence: 9,
          events: [
            { sequence: 8, fabId: 'fab-a', commandId: 'cmd-7', revision: 1, outcome: 'executing', occurredAt: '2026-10-29T00:00:00Z' },
            { sequence: 9, fabId: 'fab-a', commandId: 'cmd-7', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-29T00:00:01Z' },
          ],
        });
      }
      if (url.includes('/api/v1/commands/cmd-7')) return new Response('', { status: 404 });
      return json({ epoch: 'epoch-1', latestSequence: 9, commands: [] });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ runPromise: harness.host.runPromise, fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-7');
    source.emitDirty({ reason: 'overflow', droppedCount: 3, epoch: 'epoch-1', sequence: 7 });

    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 1_000 }).toBe('succeeded');
    expect(runtime.lastDirtySignal).toMatchObject({ reason: 'overflow', droppedCount: 3 });
    expect(requests.some((request) => request.url.includes('/command-journal?afterSequence=7'))).toBe(true);
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});

it('contains a store-fault (503) recovery failure without taking the runtime down or inventing commands', async () => {
  const harness = createCommandTestRuntime();
  try {
    let listAttempts = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/commands?status=active')) {
        listAttempts += 1;
        return new Response('COMMAND_STORE_UNAVAILABLE', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    };
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ runPromise: harness.host.runPromise, fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway });
    runtime.start();
    await expect.poll(() => listAttempts, { timeout: 1_000 }).toBeGreaterThan(0);
    // The failure is contained (documented best-effort recovery); no command exists
    // locally because the authoritative list never succeeded.
    expect(runtime.running).toBe(true);
    expect(runtime.lastRecoveryList).toBeUndefined();
    expect(runtime.workflowCount).toBe(0);
    // A live SSE result still flows through the normal path; the single scheduler
    // stays authoritative (no fabricated local outcome).
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-7', revision: 1, outcome: 'executing' }));
    runtime.trackCommand('cmd-7');
    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 1_000 }).toBe('executing');
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});
