export interface CoalescedDispatcher<T> {
  readonly push: (value: T) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

/**
 * Generic coalescing scheduler shared by the high-frequency twin paths: it
 * buffers values outside the state containers and emits only the latest value on
 * a fixed cadence.
 *
 * Consumers are the equipment-status projection, the viewport hover picking and
 * the page-level AMHS stats. This primitive is deliberately independent of the
 * telemetry transport: a render loop can write into it without causing a React
 * render for every frame (ARCH-11 transition).
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
