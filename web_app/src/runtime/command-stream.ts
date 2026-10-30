import { Effect, Fiber, Stream } from 'effect';
import type { Exit, Scope } from 'effect';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

/**
 * Fork one command Stream consumer into an owner Scope. The Scope is the single
 * owner (ADR-007 §2): closing it, or the stream ending, interrupts the fiber and
 * runs its finalizers. Business runtime code never calls a global Effect runner.
 */
export function runCommandStream<A>(
  runtime: RuntimeHost,
  scope: Scope.Scope,
  stream: Stream.Stream<A>,
  onValue: (value: A) => void,
  onExit?: (exit: Exit.Exit<void, never>) => void,
): Fiber.Fiber<void, never> {
  const fiber = runtime.runSync(
    Effect.forkIn(
      Stream.runForEach(stream, (value) => Effect.sync(() => onValue(value))),
      scope,
    ),
  );
  if (onExit) {
    runtime.runSync(
      Effect.forkIn(
        Fiber.await(fiber).pipe(Effect.flatMap((exit) => Effect.sync(() => onExit(exit)))),
        scope,
      ),
    );
  }
  return fiber;
}

/** Stop one scoped stream fiber synchronously (the Scope still owns the finalizers). */
export function stopCommandStream(runtime: RuntimeHost, fiber: Fiber.Fiber<void, never>): void {
  runtime.runSync(Fiber.interrupt(fiber));
}
