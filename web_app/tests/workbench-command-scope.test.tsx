// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { RuntimeProvider } from '../src/app/providers/RuntimeProvider';
import { CommandConsole } from '../src/features/workbench/command-console';
import type { FabRuntimeRegistry } from '../src/runtime/FabRuntimeRegistry';
import type { SubmitEquipmentCommandInput, SubmittedEquipmentCommand } from '../src/api/mutations/commands.mutations';

// The HTTP boundary is deferred so each case can decide when (and for which
// console lifetime) a submission resolves.
const mutation = vi.hoisted(() => ({ submitEquipmentCommand: vi.fn() }));
vi.mock('../src/api/mutations/commands.mutations', () => ({ submitEquipmentCommand: mutation.submitEquipmentCommand }));
const submit = mutation.submitEquipmentCommand;

interface FakeRuntime {
  trackCommand: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getProjection: ReturnType<typeof vi.fn>;
}

interface RegistryFixture {
  registry: FabRuntimeRegistry;
  runtimes: Record<'fab-a' | 'fab-b', FakeRuntime>;
}

function createRegistry(): RegistryFixture {
  const createRuntime = (): FakeRuntime => ({
    trackCommand: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getProjection: vi.fn(() => undefined),
  });
  const runtimes = { 'fab-a': createRuntime(), 'fab-b': createRuntime() };
  const registry = { get: (fabId: string) => runtimes[fabId as keyof typeof runtimes] } as unknown as FabRuntimeRegistry;
  return { registry, runtimes };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const accepted = (commandId: string, fabId = 'fab-a'): SubmittedEquipmentCommand => ({
  commandId, siteId: 'site-a', fabId, equipmentId: 'equipment-0', action: 'START',
  revision: 1, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z',
});

function renderConsole(registry: FabRuntimeRegistry, siteId: string, fabId: string) {
  const tree = (props: { siteId: string; fabId: string }) =>
    createElement(RuntimeProvider, { registry, children: createElement(CommandConsole, props) });
  const view = render(tree({ siteId, fabId }));
  return {
    view,
    rerender: (next: { siteId: string; fabId: string }) => view.rerender(tree(next)),
    form: () => view.container.querySelector('form') as HTMLFormElement,
    equipmentSelect: () => view.container.querySelectorAll('form select')[0] as HTMLSelectElement,
    actionSelect: () => view.container.querySelectorAll('form select')[1] as HTMLSelectElement,
    button: () => view.container.querySelector('form button') as HTMLButtonElement,
    alert: () => view.container.querySelector('[role="alert"]'),
    text: () => view.container.textContent ?? '',
  };
}

beforeEach(() => {
  submit.mockReset();
  // Deterministic keys make "same identity reuses the key" observable; the
  // console is the only consumer of randomUUID in this file.
  let counter = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `idem-${++counter}` });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('ignores a previous FAB completion after an in-place scope switch', async () => {
  const { registry, runtimes } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(pending.promise);
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const request = submit.mock.calls[0][0] as SubmitEquipmentCommandInput;
  expect(request).toMatchObject({ siteId: 'site-a', fabId: 'fab-a', equipmentId: 'equipment-0', action: 'START' });
  expect(console.text()).toContain('提交中…');

  // In-place FAB switch (no unmount of the page) before the request resolves.
  console.rerender({ siteId: 'site-a', fabId: 'fab-b' });
  // The new FAB starts clean: no tracked rows, no error, no busy lock.
  expect(console.alert()).toBeNull();
  expect(console.button().disabled).toBe(false);
  expect(console.button().textContent).toBe('下发命令');
  expect(console.text()).not.toContain('提交中…');
  expect(console.text()).toContain('还没有命令');

  await act(async () => {
    pending.resolve(accepted('cmd-a-1'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // Nothing from FAB-A may enter FAB-B: no history row, no runtime tracking.
  expect(runtimes['fab-a'].trackCommand).not.toHaveBeenCalled();
  expect(runtimes['fab-b'].trackCommand).not.toHaveBeenCalled();
  expect(console.text()).not.toContain('cmd-a-1'.slice(0, 8));
  expect(console.text()).not.toContain('等待 SSE 事件…');
  expect(console.alert()).toBeNull();
  expect(console.button().disabled).toBe(false);
});

it('ignores a previous FAB failure after an in-place scope switch', async () => {
  const { registry, runtimes } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(pending.promise);
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

  console.rerender({ siteId: 'site-a', fabId: 'fab-b' });
  await act(async () => {
    pending.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // The new FAB keeps a clean error/busy surface and never tracked the request.
  expect(console.alert()).toBeNull();
  expect(console.text()).not.toContain('late failure');
  expect(console.button().disabled).toBe(false);
  expect(console.button().textContent).toBe('下发命令');
  expect(runtimes['fab-a'].trackCommand).not.toHaveBeenCalled();
  expect(runtimes['fab-b'].trackCommand).not.toHaveBeenCalled();
});

it('drops a completion whose console lifetime ended (keyed remount)', async () => {
  const { registry, runtimes } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(pending.promise);
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

  // The Workbench keys the console by (siteId, fabId); a FAB switch unmounts it.
  console.view.unmount();
  await act(async () => {
    pending.resolve(accepted('cmd-a-1'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // An unmounted console must not mutate a runtime or observable state.
  expect(runtimes['fab-a'].trackCommand).not.toHaveBeenCalled();
  expect(runtimes['fab-b'].trackCommand).not.toHaveBeenCalled();
});

it('reuses the idempotency key only while retrying the same command identity', async () => {
  const { registry } = createRegistry();
  submit.mockRejectedValue(new Error('submit failed'));
  const console = renderConsole(registry, 'site-a', 'fab-a');

  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(console.alert()?.textContent).toContain('submit failed'));

  // Same scope, equipment and action: a retry must reuse the pending key.
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  const keys = submit.mock.calls.map((call) => (call[0] as SubmitEquipmentCommandInput).idempotencyKey);
  expect(keys[1]).toBe(keys[0]);

  // Equipment change: new logical command, new key.
  fireEvent.change(console.equipmentSelect(), { target: { value: 'equipment-1' } });
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
  const afterEquipment = submit.mock.calls[2][0] as SubmitEquipmentCommandInput;
  expect(afterEquipment.equipmentId).toBe('equipment-1');
  expect(afterEquipment.idempotencyKey).not.toBe(keys[0]);

  // Action change: new logical command, new key.
  fireEvent.change(console.actionSelect(), { target: { value: 'STOP' } });
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(4));
  const afterAction = submit.mock.calls[3][0] as SubmitEquipmentCommandInput;
  expect(afterAction.action).toBe('STOP');
  expect(afterAction.idempotencyKey).not.toBe(afterEquipment.idempotencyKey);

  // Scope change: the old FAB's pending key must never cross into the new one.
  console.rerender({ siteId: 'site-a', fabId: 'fab-b' });
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(5));
  const afterScope = submit.mock.calls[4][0] as SubmitEquipmentCommandInput;
  expect(afterScope.fabId).toBe('fab-b');
  expect(afterScope.idempotencyKey).not.toBe(afterAction.idempotencyKey);
});

it('tracks a submission on the FAB that submitted it and drops the row on switch', async () => {
  const { registry, runtimes } = createRegistry();
  submit.mockResolvedValueOnce(accepted('cmd-a-1'));
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());

  await waitFor(() => expect(runtimes['fab-a'].trackCommand).toHaveBeenCalledWith('cmd-a-1'));
  await waitFor(() => expect(console.text()).toContain('cmd-a-1'.slice(0, 8)));
  // The projection row queries the runtime of the FAB that submitted the command.
  await waitFor(() => expect(runtimes['fab-a'].getProjection).toHaveBeenCalledWith('cmd-a-1'));
  expect(runtimes['fab-b'].getProjection).not.toHaveBeenCalled();
  expect(runtimes['fab-b'].trackCommand).not.toHaveBeenCalled();

  console.rerender({ siteId: 'site-a', fabId: 'fab-b' });
  expect(console.text()).not.toContain('cmd-a-1'.slice(0, 8));
  expect(console.text()).toContain('还没有命令');
  // No projection row was ever queried against FAB-B's runtime for FAB-A's id.
  expect(runtimes['fab-b'].getProjection).not.toHaveBeenCalled();
});
