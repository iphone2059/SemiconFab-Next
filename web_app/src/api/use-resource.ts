import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useEffect } from 'react';
import type { AppRuntime } from '@/app/app-runtime';
import type { ResourceDefinition, ResourceReadTimeoutError } from '@/api/resource';

export interface ResourceView<A, E> {
  readonly result: AsyncResult.AsyncResult<A, E | ResourceReadTimeoutError>;
  readonly data: A | undefined;
  readonly error: E | ResourceReadTimeoutError | undefined;
  readonly isInitial: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly refresh: () => void;
}

export interface UseResourceOptions {
  /** When false: no retain/ensure/poll, but the retained Atom value stays readable. */
  readonly enabled?: boolean;
}

/**
 * React binding for one resource definition (ADR-006 §2.10).
 *
 * The component never owns a timer: it resolves the manager handle for the
 * canonical key, subscribes to the Atom through the shared registry, retains the
 * resource while mounted (the manager owns the single poll fiber and the
 * ResourceScope) and ensures freshness once on mount/navigation. `enabled ===
 * false` skips retain/ensure/poll entirely while keeping the Atom readable.
 */
export function useResource<A, E>(
  runtime: AppRuntime<never>,
  definition: ResourceDefinition<A, E>,
  options: UseResourceOptions = {},
): ResourceView<A, E> {
  const enabled = options.enabled ?? true;
  const handle = runtime.resources.handle(definition);
  const result = useAtomValue(handle.atom);
  const manager = runtime.resources;

  useEffect(() => {
    if (!enabled) return;
    const release = manager.retain(handle);
    void manager.ensure(handle).catch(() => {
      /* typed error is kept in the Atom and rendered by the consumer */
    });
    return release;
  }, [enabled, handle, manager]);

  const refresh = (): void => {
    if (!enabled) return;
    void manager.refresh(handle).catch(() => {
      /* typed error is kept in the Atom and rendered by the consumer */
    });
  };

  const data = Option.getOrUndefined(AsyncResult.value(result));
  const error = Option.getOrUndefined(AsyncResult.error(result));
  return {
    result,
    data,
    error,
    isInitial: AsyncResult.isInitial(result),
    isFetching: result.waiting,
    isError: AsyncResult.isFailure(result),
    refresh,
  };
}
