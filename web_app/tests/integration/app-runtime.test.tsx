// @vitest-environment jsdom
import { StrictMode, useContext } from 'react';
import { render, screen } from '@testing-library/react';
import { Effect, Layer } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { RegistryContext } from '@effect/atom-react';
import { describe, expect, it } from 'vitest';
import { AppProviders } from '@/app/app-providers';
import { DEFAULT_IDLE_TTL_MS, applicationRuntime, createApplicationRuntime } from '@/app/app-runtime';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { router } from '@/routes/router';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AppRuntime', () => {
  it('creates one isolated registry per runtime and shares the router/React instance', () => {
    const first = createApplicationRuntime({ layer: Layer.empty });
    const second = createApplicationRuntime({ layer: Layer.empty });
    const atom = Atom.make(0);

    first.registry.set(atom, 7);
    expect(first.registry.get(atom)).toBe(7);
    expect(second.registry.get(atom)).toBe(0);
    expect(first.registry).not.toBe(second.registry);

    expect(router.options.context.appRuntime).toBe(applicationRuntime);
    expect(router.options.context.appRuntime.registry).toBe(applicationRuntime.registry);

    void first.dispose();
    void second.dispose();
  });

  it('builds the shared application layer exactly once and releases it on dispose', async () => {
    let builds = 0;
    let releases = 0;
    const layer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => { builds += 1; }),
        () => Effect.sync(() => { releases += 1; }),
      ),
    );
    const runtime = createApplicationRuntime({ layer });

    await Promise.all([runtime.runPromise(Effect.succeed(1)), runtime.runPromise(Effect.succeed(2))]);
    await runtime.runPromise(Effect.succeed(3));
    expect(builds).toBe(1);

    await runtime.dispose();
    await runtime.dispose();
    expect(releases).toBe(1);
    await expect(runtime.runPromise(Effect.succeed(4))).rejects.toBeDefined();
  });

  it('interrupts runtime-owned fibers and runs their finalizers on dispose', async () => {
    const runtime = createApplicationRuntime({ layer: Layer.empty });
    let interrupted = 0;
    runtime.runFork(Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted += 1; }))));
    await delay(10);
    await runtime.dispose();
    expect(interrupted).toBe(1);
  });

  it('applies the explicit idle TTL and disposes idle atoms after it expires', async () => {
    expect(DEFAULT_IDLE_TTL_MS).toBe(300_000);
    const runtime = createApplicationRuntime({ layer: Layer.empty, defaultIdleTTL: 25 });
    const atom = Atom.make('value');
    const release = runtime.registry.mount(atom);
    expect(runtime.registry.get(atom)).toBe('value');
    release();

    await delay(5);
    expect(runtime.registry.getNodes().has(atom), 'atom survives while inside the idle TTL').toBe(true);
    await delay(80);
    expect(runtime.registry.getNodes().has(atom), 'atom is reclaimed after the idle TTL').toBe(false);
    await runtime.dispose();
  });

  it('supplies the same runtime/registry to React (StrictMode) and never disposes it on unmount', async () => {
    const runtime = createApplicationRuntime({ layer: Layer.empty });
    function Probe() {
      const fromContext = useAppRuntime();
      const registry = useContext(RegistryContext);
      return <span data-testid="probe">{fromContext === runtime && registry === runtime.registry ? 'same' : 'different'}</span>;
    }
    const view = render(
      <StrictMode>
        <AppProviders runtime={runtime}>
          <Probe />
        </AppProviders>
      </StrictMode>,
    );
    expect((await screen.findByTestId('probe')).textContent).toBe('same');
    view.unmount();
    // Application lifetime owns disposal; a React unmount must not close the runtime.
    await expect(runtime.runPromise(Effect.succeed(1))).resolves.toBe(1);
    await runtime.dispose();
  });
});
