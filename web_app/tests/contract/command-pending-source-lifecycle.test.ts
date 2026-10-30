import { Duration, Effect, Option, Stream } from 'effect';
import { expect, it } from 'vitest';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
it('keeps all pending-source stream consumers alive until scope interruption', async () => {
  const source = createPendingCommandEventSource();
  // The pending source always provides these optional contract channels (single-factory
  // type); non-null assertions keep the test focused on lifecycle, not optionality.
  const streams: Array<Stream.Stream<unknown, never, never>> = [
    source.commandResults,
    source.reconnected!,
    source.gaps!,
    source.transportFailures!,
    source.dirty!,
  ];
  const results = await Promise.all(streams.map((stream) => Effect.runPromise(Stream.runDrain(stream).pipe(Effect.timeoutOption(Duration.millis(30))))));
  expect(results.every(Option.isNone)).toBe(true);
});
it('publishes failed once and does not end the connection-status stream', async () => {
  const source = createPendingCommandEventSource();
  const values: string[] = [];
  const result = await Effect.runPromise(Stream.runForEach(source.connectionStatus, (value) => Effect.sync(() => { values.push(value); })).pipe(Effect.timeoutOption(Duration.millis(30))));
  expect(Option.isNone(result)).toBe(true);
  expect(values).toEqual(['failed']);
  expect(source.availability).toBe('unavailable');
  expect(source.cursors.pendingAcknowledgements).toBe(0);
});
