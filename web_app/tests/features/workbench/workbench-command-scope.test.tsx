// @vitest-environment jsdom
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import * as Atom from 'effect/reactivity/Atom';
import { RuntimeProvider } from '@/app/runtime-provider';
import { CommandConsole } from '@/workbench/command-console';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import type { SubmitEquipmentCommandInput, SubmittedEquipmentCommand } from '@/api/commands.mutation';
import { createTestRuntime, ResourceTestProviders } from '../../support/resource-test-runtime.tsx';

// The HTTP boundary is deferred so each case can decide when (and for which
// console lifetime) a submission resolves.
const mutation = vi.hoisted(() => ({ submitEquipmentCommand: vi.fn() }));
vi.mock('@/api/commands.mutation', () => ({ submitEquipmentCommand: mutation.submitEquipmentCommand }));
const submit = mutation.submitEquipmentCommand;

interface FakeRuntime {
  trackCommand: ReturnType<typeof vi.fn>;
  /** The only projection read path of the new contract: a bounded per-runtime Atom. */
  projectionAtom: ReturnType<typeof vi.fn>;
}

interface RegistryFixture {
  registry: FabRuntimeRegistry;
  runtime: FakeRuntime;
}

function createRegistry(): RegistryFixture {
  const atoms = new Map<string, Atom.Writable<CommandWorkflowProjection | undefined, CommandWorkflowProjection | undefined>>();
  const atomFor = (commandId: string) => {
    const existing = atoms.get(commandId);
    if (existing) return existing;
    const atom = Atom.make<CommandWorkflowProjection | undefined>(undefined);
    atoms.set(commandId, atom);
    return atom;
  };
  const createRuntime = (): FakeRuntime => ({
    trackCommand: vi.fn(),
    projectionAtom: vi.fn((commandId: string) => atomFor(commandId)),
  });
  const runtime = createRuntime();
  const registry = { get: (fabId: string) => fabId === 'fab-a' ? runtime : undefined } as unknown as FabRuntimeRegistry;
  return { registry, runtime };
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
  const appRuntime = createTestRuntime();
  const tree = (props: { siteId: string; fabId: string }) =>
    createElement(ResourceTestProviders, { runtime: appRuntime, children: createElement(RuntimeProvider, { registry, children: createElement(CommandConsole, props) }) });
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

it('ignores a previous site-scope completion after rebinding the same FAB in place', async () => {
  const { registry, runtime } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(Effect.promise(() => pending.promise));
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const request = submit.mock.calls[0][0] as SubmitEquipmentCommandInput;
  expect(request).toMatchObject({ siteId: 'site-a', fabId: 'fab-a', equipmentId: 'equipment-0', action: 'START' });
  expect(console.text()).toContain('提交中…');

  // Rebind the same FAB's composite scope before the request resolves.
  console.rerender({ siteId: 'site-b', fabId: 'fab-a' });
  // The new scope starts clean: no tracked rows, no error, no busy lock.
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

  // Nothing from the previous scope may enter the new console lifetime.
  expect(runtime.trackCommand).not.toHaveBeenCalled();
  expect(console.text()).not.toContain('cmd-a-1'.slice(0, 8));
  expect(console.text()).not.toContain('等待 SSE 事件…');
  expect(console.alert()).toBeNull();
  expect(console.button().disabled).toBe(false);
});

it('ignores a previous site-scope failure after rebinding the same FAB in place', async () => {
  const { registry, runtime } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(Effect.promise(() => pending.promise));
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

  console.rerender({ siteId: 'site-b', fabId: 'fab-a' });
  await act(async () => {
    pending.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // The new scope keeps a clean error/busy surface and never tracks the request.
  expect(console.alert()).toBeNull();
  expect(console.text()).not.toContain('late failure');
  expect(console.button().disabled).toBe(false);
  expect(console.button().textContent).toBe('下发命令');
  expect(runtime.trackCommand).not.toHaveBeenCalled();
});

it('drops a completion whose console lifetime ended (keyed remount)', async () => {
  const { registry, runtime } = createRegistry();
  const pending = deferred<SubmittedEquipmentCommand>();
  submit.mockReturnValueOnce(Effect.promise(() => pending.promise));
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

  // Unmounting ends this console's lifetime for the configured FAB.
  console.view.unmount();
  await act(async () => {
    pending.resolve(accepted('cmd-a-1'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // An unmounted console must not mutate a runtime or observable state.
  expect(runtime.trackCommand).not.toHaveBeenCalled();
});

it('reuses the idempotency key only while retrying the same command identity', async () => {
  const { registry } = createRegistry();
  submit.mockReturnValue(Effect.fail(new Error('submit failed')));
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

  // Rebinding the site's scope gives the same FAB a new logical command identity.
  console.rerender({ siteId: 'site-b', fabId: 'fab-a' });
  fireEvent.submit(console.form());
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(5));
  const afterScope = submit.mock.calls[4][0] as SubmitEquipmentCommandInput;
  expect(afterScope).toMatchObject({ siteId: 'site-b', fabId: 'fab-a' });
  expect(afterScope.idempotencyKey).not.toBe(afterAction.idempotencyKey);
});

it('tracks a submission on the configured FAB and drops its row when the site scope changes', async () => {
  const { registry, runtime } = createRegistry();
  submit.mockReturnValueOnce(Effect.succeed(accepted('cmd-a-1')));
  const console = renderConsole(registry, 'site-a', 'fab-a');
  fireEvent.submit(console.form());

  await waitFor(() => expect(runtime.trackCommand).toHaveBeenCalledWith('cmd-a-1'));
  await waitFor(() => expect(console.text()).toContain('cmd-a-1'.slice(0, 8)));
  // The projection row reads the Atom of the FAB that submitted the command, and
  // no value was published by this fake runtime -> the row shows the waiting state.
  await waitFor(() => expect(runtime.projectionAtom).toHaveBeenCalledWith('cmd-a-1'));
  expect(console.text()).toContain('等待 SSE 事件…');
  runtime.projectionAtom.mockClear();

  console.rerender({ siteId: 'site-b', fabId: 'fab-a' });
  expect(console.text()).not.toContain('cmd-a-1'.slice(0, 8));
  expect(console.text()).toContain('还没有命令');
  // The old scope's row cannot query the runtime after the console resets.
  expect(runtime.projectionAtom).not.toHaveBeenCalled();
  expect(runtime.trackCommand).toHaveBeenCalledTimes(1);
});
