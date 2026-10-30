import { Effect, Exit, Fiber, Stream } from 'effect';
import type { Scope } from 'effect';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

/**
 * Exit/defect observation for one command Stream consumer (R4-05).
 *
 * A consumer fiber is owned by a Scope, but ownership is not observation: without
 * these callbacks a handler defect silently kills the fiber and the owner keeps
 * reporting running=true. Owners pass a bounded onDefect (diagnostic + Dirty) and
 * an onExit that distinguishes an expected stop (Scope close / stop()) from an
 * unexpected termination (restart or explicit Unrecoverable).
 */
export interface CommandStreamObserver {
  /** Stable, payload-free label for bounded diagnostics. */
  readonly label: string;
  /** Handler defect: reported to the owner, the consumer itself keeps running. */
  readonly onDefect?: (label: string, cause: unknown) => void;
  /** Exactly once when the consumer fiber terminates (interrupt/success/defect). */
  readonly onExit?: (label: string, exit: Exit.Exit<void, never>) => void;
}

/**
 * Fork one command Stream consumer into an owner Scope. The Scope is the single
 * owner (ADR-007 §2): closing it, or the stream ending, interrupts the fiber and
 * runs its finalizers. Business runtime code never calls a global Effect runner.
 *
 * R4-05: the per-value handler runs inside Effect.suspend so a throwing handler is
 * captured as a bounded defect callback instead of killing the fiber with an
 * unobserved defect; onExit is registered on the consumer itself (it observes the
 * real fiber's termination, including interruption).
 */
export function runCommandStream<A>(
  runtime: RuntimeHost,
  scope: Scope.Scope,
  stream: Stream.Stream<A>,
  onValue: (value: A) => void,
  observer?: CommandStreamObserver,
): Fiber.Fiber<void, never> {
  const label = observer?.label ?? 'command-stream';
  const consume = Stream.runForEach(stream, (value) =>
    Effect.suspend((): Effect.Effect<void> => {
      try {
        onValue(value);
      } catch (cause) {
        try {
          observer?.onDefect?.(label, cause);
        } catch {
          // A diagnostic callback must never escalate into a second defect.
        }
      }
      return Effect.void;
    }),
  );
  const observed = observer?.onExit === undefined
    ? consume
    : consume.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            try {
              observer.onExit?.(label, exit);
            } catch {
              // Same rule: observer failures must not leak as unhandled defects.
            }
          }),
        ),
      );
  return runtime.runSync(Effect.forkIn(observed, scope));
}

/** Stop one scoped stream fiber synchronously (the Scope still owns the finalizers). */
export function stopCommandStream(runtime: RuntimeHost, fiber: Fiber.Fiber<void, never>): void {
  runtime.runSync(Fiber.interrupt(fiber));
}
