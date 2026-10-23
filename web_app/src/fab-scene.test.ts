import { describe, expect, it } from 'vitest';
import { SceneFacade, type SceneBackend } from './fab-scene';

describe('renderer lifecycle', () => {
  it('disposes resources that finish loading after unmount', async () => {
    let resolve: (() => void) | undefined;
    let disposed = 0;
    const backend: SceneBackend = { mount: () => new Promise<void>(done => { resolve = done; }), dispose: () => { disposed++; } };
    const facade = new SceneFacade(backend);
    const pending = facade.mount({} as HTMLCanvasElement, [], () => {});
    facade.dispose();
    resolve?.();
    await pending;
    expect(disposed).toBeGreaterThan(0);
  });
  it('suppresses late status notifications and releases resources on initialization failure', async () => {
    let notify: ((status: string) => void) | undefined;
    let disposed = 0;
    const updates: string[] = [];
    const facade = new SceneFacade({ mount: async (_canvas, _fabs, _signal, onStatus) => { notify = onStatus; throw new Error('device init failed'); }, dispose: () => { disposed++; } });
    await facade.mount({} as HTMLCanvasElement, [], status => updates.push(status));
    expect(updates).toEqual(['device init failed']);
    expect(disposed).toBe(1);
    facade.dispose(); notify?.('late device lost');
    expect(updates).toEqual(['device init failed']);
  });
});
