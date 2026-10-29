import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useCallback, useEffect } from 'react';
import type { AppRuntime } from '@/app/app-runtime';
import { ensureResource, refreshResource, type Resource } from '@/api/resource';

export interface ResourceView<A, E> {
  readonly result: AsyncResult.AsyncResult<A, E>;
  readonly data: A | undefined;
  readonly error: E | undefined;
  readonly isInitial: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly refresh: () => void;
}

export interface UseResourceOptions {
  readonly enabled?: boolean;
}

/**
 * React binding for one resource Atom. Mounting a consumer checks freshness and
 * joins the shared in-flight read; polling (when configured) lives exactly as
 * long as this component's subscription. Window focus never triggers a refresh.
 */
export function useResource<A, E>(
  runtime: AppRuntime<never>,
  resource: Resource<A, E>,
  options: UseResourceOptions = {},
): ResourceView<A, E> {
  const enabled = options.enabled ?? true;
  const result = useAtomValue(resource.atom);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void refreshResource(runtime, resource).catch(() => {
      /* typed error is kept in the Atom and displayed by the consumer */
    });
  }, [enabled, resource, runtime]);

  useEffect(() => {
    if (!enabled) return;
    void ensureResource(runtime, resource).catch(() => {
      /* typed error is kept in the Atom; the view renders the retained value */
    });
  }, [enabled, resource, runtime]);

  useEffect(() => {
    const pollMs = resource.policy.pollMs;
    if (!enabled || pollMs === undefined) return;
    const timer = setInterval(() => {
      void refreshResource(runtime, resource).catch(() => {});
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, resource, runtime]);

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
