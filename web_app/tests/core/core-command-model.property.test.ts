import { it } from 'vitest';
import type { CommandOutcome } from '@/contracts/command-events.contract';
import { FakeCommandEventSource, commandResult, createTestFab } from '../support/command-fakes.ts';
import {
  type SplitMix64,
  arrayShrinks,
  describeExample,
  forEachSeedAsync,
  minimizeAsync,
} from '../support/property.ts';

const TERMINAL: ReadonlySet<CommandOutcome> = new Set(['succeeded', 'failed', 'cancelled']);
const FAB_ID = 'fab-a';
const COMMAND_IDS = ['cmd-0', 'cmd-1', 'cmd-2'] as const;
const OUTCOMES: readonly CommandOutcome[] = ['accepted', 'executing', 'succeeded', 'failed', 'cancelled'];

type Op =
  | { readonly kind: 'result'; readonly commandId: (typeof COMMAND_IDS)[number]; readonly revision: number; readonly outcome: CommandOutcome }
  | { readonly kind: 'gap' }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'reconcileAll' };

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function generateOps(random: SplitMix64): Op[] {
  const count = 18 + random.nextInt(30);
  return Array.from({ length: count }, (): Op => {
    const roll = random.nextInt(100);
    if (roll < 78) {
      return {
        kind: 'result',
        commandId: COMMAND_IDS[random.nextInt(COMMAND_IDS.length)],
        revision: random.nextInt(5),
        outcome: OUTCOMES[random.nextInt(OUTCOMES.length)],
      };
    }
    if (roll < 84) return { kind: 'gap' };
    if (roll < 90) return { kind: 'reconnect' };
    if (roll < 96) return { kind: 'dirty' };
    return { kind: 'reconcileAll' };
  });
}

interface ModelState {
  revision: number;
  outcome: CommandOutcome | 'pending';
}

/** Replay one generated sequence on a fresh runtime and compare to the ordering model. */
async function replay(ops: readonly Op[]): Promise<string | undefined> {
  const source = new FakeCommandEventSource();
  const fab = createTestFab({ source });
  const runtime = fab.runtime;
  try {
    runtime.start();
    for (const commandId of COMMAND_IDS) runtime.trackCommand(commandId);
    const model = new Map<string, ModelState>(
      COMMAND_IDS.map((commandId) => [commandId, { revision: -1, outcome: 'pending' }]),
    );
    for (const op of ops) {
      switch (op.kind) {
        case 'result': {
          source.emit(commandResult({ fabId: FAB_ID, commandId: op.commandId, revision: op.revision, outcome: op.outcome }));
          const current = model.get(op.commandId);
          if (!current || TERMINAL.has(current.outcome as CommandOutcome)) break;
          // Monotonic revision only: stale/duplicate revisions are ignored, and a
          // terminal outcome can never be overwritten by a later revision.
          if (op.revision > current.revision) model.set(op.commandId, { revision: op.revision, outcome: op.outcome });
          break;
        }
        case 'gap':
          source.emitGap({ epoch: 'epoch-1', sequence: 3 });
          break;
        case 'reconnect':
          source.reconnect();
          break;
        case 'dirty':
          source.emitDirty({ reason: 'overflow', droppedCount: 1 });
          break;
        case 'reconcileAll':
          void runtime.reconcileAll();
          break;
      }
    }
    await flush();
    for (const commandId of COMMAND_IDS) {
      const expected = model.get(commandId)!;
      const actual = runtime.getProjection(commandId);
      const actualRevision = actual?.revision ?? -1;
      const actualOutcome = actual?.outcome ?? 'pending';
      if (actualRevision !== expected.revision || actualOutcome !== expected.outcome) {
        return commandId + ': expected revision ' + expected.revision + '/' + expected.outcome +
          ', got ' + actualRevision + '/' + actualOutcome + ' after ' + describeExample(ops);
      }
    }
    return undefined;
  } finally {
    runtime.dispose();
    await fab.harness.dispose();
  }
}

it('command event ordering model holds for deterministic interleavings with seeds and minimal counterexamples', async () => {
  const shrinkOps = (ops: Op[]): readonly Op[][] => arrayShrinks(ops).map((candidate) => [...candidate]);
  await forEachSeedAsync({ label: 'command-event-model', seeds: 16, baseSeed: 0x5eed }, async (random, seed) => {
    const ops = generateOps(random);
    const failure = await replay(ops);
    if (failure === undefined) return;
    const minimal = await minimizeAsync(ops, shrinkOps, async (candidate) => (await replay(candidate)) !== undefined);
    const minimalFailure = await replay(minimal);
    throw new Error(
      'ordering model mismatch: ' + failure +
      '; minimal counterexample (seed ' + seed + '): ' + describeExample(minimal) +
      ' => ' + minimalFailure,
    );
  });
});
