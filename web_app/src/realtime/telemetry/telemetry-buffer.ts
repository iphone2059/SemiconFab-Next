export interface CoalescedDispatcher<T> {
  readonly push: (value: T) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

/**
 * Buffers high-frequency telemetry outside the state containers and emits only
 * the latest value on a fixed cadence. The render loop can write into this
 * buffer without causing a React render for every frame (ARCH-11 transition).
 */
export function createCoalescedDispatcher<T>(
  dispatch: (value: T) => void,
  delayMs = 100,
): CoalescedDispatcher<T> {
  let pending: T | undefined;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    if (!hasPending) return;
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    dispatch(value);
  };
  const push = (value: T): void => {
    pending = value;
    hasPending = true;
    if (timer === undefined) timer = setTimeout(flush, delayMs);
  };
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
    hasPending = false;
  };
  return { push, flush, cancel };
}
