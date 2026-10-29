import { Effect, Fiber, Stream } from 'effect';

/**
 * Adapter boundary for the command runtime (which owns plain TS lifecycle rather
 * than an Effect Scope): runs a typed Stream on the global Effect runtime and
 * returns an idempotent cancel function. Stream finalizers close EventSource
 * listeners when the owning FabRuntime stops; no RxJS Subscription remains.
 */
export function runCommandStream<A>(stream: Stream.Stream<A>, onValue: (value: A) => void): () => void {
  const fiber = Effect.runFork(Stream.runForEach(stream, (value) => Effect.sync(() => onValue(value))));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {
      /* interrupted fibers are the expected shutdown path */
    });
  };
}
