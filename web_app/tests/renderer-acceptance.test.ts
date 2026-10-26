import { expect, it } from 'vitest';
import { runManagedClockAcceptance, waitForManagedRenderer } from './remaining-state.browser';

it('rejects a working HUD when the renderer reports a caught module-load failure', async () => {
  const statusLocator = {
    click: async () => {},
    getByRole: () => statusLocator,
    getAttribute: async () => 'Failed to fetch dynamically imported module: /src/lite-backend.ts',
  };
  const linkLocator = {
    first: () => linkLocator,
    getAttribute: async () => '/fabs/FAB-01/3d',
  };
  const tab = { url: async () => 'http://localhost:5173/', goto: async () => {},
    playwright: {
      locator: (selector: string) => (selector.includes('/3d') ? linkLocator : statusLocator),
      getByRole: () => statusLocator,
    } };
  await expect(runManagedClockAcceptance(tab)).rejects.toThrow('Failed to fetch dynamically imported module');
});

it('allows a cold renderer to become ready after a bounded transport wait', async () => {
  const statuses = ['正在初始化 WebGPU…', 'WebGPU · 程序化 FAB · 121 台设备'];
  let waits = 0;
  const tab = { playwright: { locator: () => ({
    getAttribute: async () => statuses.shift(),
    waitFor: async () => { waits++; throw new Error('selector deadline exceeded'); },
  }) } };
  await expect(waitForManagedRenderer(tab)).resolves.toBe('WebGPU · 程序化 FAB · 121 台设备');
  expect(waits).toBe(1);
});
