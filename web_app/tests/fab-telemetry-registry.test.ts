import { expect, it, vi } from 'vitest';
import { FabTelemetryRegistry } from '../src/realtime/telemetry/FabTelemetryRegistry';
import type { TelemetryRuntime } from '../src/realtime/telemetry/TelemetryRuntime';

function fakeRuntime(fabId: string): TelemetryRuntime & { stop: ReturnType<typeof vi.fn> } {
  return { fabId, stop: vi.fn() } as unknown as TelemetryRuntime & { stop: ReturnType<typeof vi.fn> };
}

it('keys runtimes by fabId so two FABs of one site never share a telemetry stream', () => {
  const fabA = fakeRuntime('fab-a');
  const fabB = fakeRuntime('fab-b');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', fabA], ['fab-b', fabB]]));
  expect(registry.size).toBe(2);
  expect(registry.fabIds).toEqual(['fab-a', 'fab-b']);
  expect(registry.get('fab-a')).toBe(fabA);
  expect(registry.get('missing')).toBeUndefined();
  expect(registry.get(undefined)).toBeUndefined();
});

it('stops replaced and disposed runtimes exactly once', () => {
  const first = fakeRuntime('fab-a');
  const second = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', first]]));
  registry.replaceAll(new Map([['fab-a', second]]));
  expect(first.stop).toHaveBeenCalledTimes(1);
  registry.disposeAll();
  expect(second.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(0);
  expect(registry.fabIds).toEqual([]);
});
