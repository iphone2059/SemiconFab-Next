import { RegistryContext } from '@effect/atom-react';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { render as reactRender, renderHook as reactRenderHook, type RenderOptions, type RenderHookOptions } from '@testing-library/react';
import type { ReactElement, PropsWithChildren } from 'react';
import { afterAll, beforeEach } from 'vitest';

/** Real registry and React context, isolated per test module and reset per case. */
export function createAtomTestScope() {
  const registry = AtomRegistry.make();
  beforeEach(() => registry.reset());
  afterAll(() => registry.dispose());
  function withRegistry(Wrapper?: RenderOptions['wrapper']) {
    return function AtomTestProvider({ children }: PropsWithChildren) {
      return <RegistryContext.Provider value={registry}>{Wrapper ? <Wrapper>{children}</Wrapper> : children}</RegistryContext.Provider>;
    };
  }
  function render(ui: ReactElement, options: RenderOptions = {}) {
    return reactRender(ui, { ...options, wrapper: withRegistry(options.wrapper) });
  }
  function renderHook<Result, Props>(callback: (props: Props) => Result, options: RenderHookOptions<Props> = {}) {
    return reactRenderHook(callback, { ...options, wrapper: withRegistry(options.wrapper) });
  }
  return { registry, render, renderHook };
}
