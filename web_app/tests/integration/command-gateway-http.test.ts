import { expect, it } from 'vitest';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import {
  FakeCommandEventSource,
  createCommandTestRuntime,
  createFabRuntime,
} from '../support/command-fakes.ts';

/**
 * Round 2 (ADR-010/ADR-011): the HTTP gateway returns native Effects and never
 * runs them; FabRuntime executes recovery through the composition-root runner.
 * The exact Phase D wire DTOs are decoded end to end (URL construction, Schema
 * decoding, identity checks, epoch-aware journal cursor and HTTP error mapping)
 * with only fetch injected.
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
        return json({ epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 12, events: [], nextAfterSequence: 0 });
      }
      return new Response('not found', { status: 404 });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway, lazyCommandSubscription: true });
    runtime.start();

    await expect.poll(() => runtime.workflowCount, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 1_000 }).toBe('succeeded');
    expect(runtime.lastRecoveryList).toMatchObject({
      epoch: 'epoch-1',
      latestSequence: 12,
      commands: [{ commandId: 'cmd-7', revision: 1, terminal: false }],
    });
    expect(requests.some((request) => request.url === '/api/v1/sites/site-1/fabs/fab-a/commands?status=active')).toBe(true);
    expect(requests.some((request) => request.url === '/api/v1/commands/cmd-7')).toBe(true);
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
        return json({ epoch: 'epoch-2', hasGap: true, firstRetainedSequence: 20, latestSequence: 25, events: [], nextAfterSequence: 0 });
      }
      if (url.includes('/commands?status=active')) {
        return json({
          epoch: 'epoch-2',
          latestSequence: 25,
          commands: [recoveryRecord({ revision: 2, outcome: 'executing' })],
        });
      }
      if (url.includes('/api/v1/commands/cmd-7')) return json(statusBody());
      return new Response('not found', { status: 404 });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-7');
    // Let the startup refresh list settle before injecting the cursor break.
    await new Promise((resolve) => setTimeout(resolve, 25));
    source.emitGap({ epoch: 'epoch-2', sequence: 19 });

    // The active record is applied first (executing) and the post-recovery unified
    // scheduler pass then converges on the authoritative status (succeeded).
    await expect.poll(() => runtime.getProjection('cmd-7')?.outcome, { timeout: 2_000 }).toBe('succeeded');
    expect(runtime.getProjection('cmd-7')?.revision).toBe(2);
    expect(runtime.lastJournalPage).toMatchObject({ hasGap: true, epoch: 'epoch-2' });
    const journalRequest = requests.find((request) => request.url.includes('/command-journal'));
    expect(journalRequest?.url).toBe(
      '/api/v1/sites/site-1/fabs/fab-a/command-journal?epoch=epoch-2&afterSequence=19&limit=256',
    );
    expect(requests.some((request) => request.url.includes('/commands?status=active'))).toBe(true);
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});

it('replays an overflow cursor through paginated journal requests and delivers authoritative revisions', async () => {
  const harness = createCommandTestRuntime();
  try {
    const requestedAfterSequences: number[] = [];
    const { requests, fetchImpl } = createBackendFetch((request) => {
      const url = request.url;
      if (url.includes('/command-journal')) {
        const parsed = new URL(url, 'http://localhost');
        const after = Number(parsed.searchParams.get('afterSequence') ?? 0);
        requestedAfterSequences.push(after);
        if (after < 8) {
          return json({
            epoch: 'epoch-1',
            hasGap: false,
            firstRetainedSequence: 0,
            latestSequence: 10,
            events: [
              { sequence: after + 1, fabId: 'fab-a', commandId: 'cmd-7', revision: after + 1, outcome: 'executing', occurredAt: '2026-10-29T00:00:00Z' },
              { sequence: after + 2, fabId: 'fab-a', commandId: 'cmd-7', revision: after + 2, outcome: 'executing', occurredAt: '2026-10-29T00:00:00Z' },
            ],
            nextAfterSequence: after + 2,
          });
        }
        return json({
          epoch: 'epoch-1',
          hasGap: false,
          firstRetainedSequence: 0,
          latestSequence: 10,
          events: [
            { sequence: after + 1, fabId: 'fab-a', commandId: 'cmd-7', revision: after + 1, outcome: 'succeeded', occurredAt: '2026-10-29T00:00:01Z' },
          ],
          nextAfterSequence: 10,
        });
      }
      if (url.includes('/api/v1/commands/cmd-7')) return new Response('', { status: 404 });
      return json({ epoch: 'epoch-1', latestSequence: 9, commands: [] });
    });
    const source = new FakeCommandEventSource();
    const gateway = createHttpCommandGateway({ fetchImpl });
    const runtime = createFabRuntime(harness, { source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-7');
    // Let the startup refresh list settle before injecting the overflow cursor.
    await new Promise((resolve) => setTimeout(resolve, 25));
    source.emitDirty({
      reason: 'overflow',
      droppedCount: 3,
      delivered: { epoch: 'epoch-1', sequence: 7 },
      gapStart: 8,
    });

    await expect.poll(() => runtime.getProjection('cmd-7')?.revision, { timeout: 2_000 }).toBe(10);
    expect(runtime.getProjection('cmd-7')?.outcome).toBe('succeeded');
    expect(requestedAfterSequences[0]).toBe(7);
    expect(requestedAfterSequences.length).toBeGreaterThanOrEqual(2);
    expect(requests.some((request) => request.url.includes('epoch=epoch-1'))).toBe(true);
    expect(runtime.recoveryState.phase).toBe('Healthy');
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});

it('contains a store-fault (503) recovery failure, keeps Dirty and eventually becomes Unrecoverable', async () => {
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
    const gateway = createHttpCommandGateway({ fetchImpl });
    const runtime = createFabRuntime(harness, {
      source,
      gateway,
      recovery: { backoffMs: [1, 1, 1], maxAttempts: 3 },
    });
    runtime.start();
    await expect.poll(() => listAttempts, { timeout: 2_000 }).toBeGreaterThan(0);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(runtime.recoveryState.lastError).toBeDefined();
    expect(runtime.running).toBe(true);
    expect(runtime.lastRecoveryList).toBeUndefined();
    expect(runtime.workflowCount).toBe(0);
    runtime.dispose();
  } finally {
    await harness.dispose();
  }
});
