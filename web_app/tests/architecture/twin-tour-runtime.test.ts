import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (path: string): string => readFileSync(join(sourceRoot, path), 'utf8');
it('keeps the Tour actor, frame scheduler and finalizer in TwinTourRuntime', () => {
  const hook = read('twin/use-tour-controller.ts');
  const runtime = read('twin/twin-tour-runtime.ts');
  const machine = read('twin/twin-tour.machine.ts');
  expect(hook).not.toMatch(/requestAnimationFrame|cancelAnimationFrame|createTourTimeline|generationRef|lifecycleRef/);
  expect(runtime).toContain('createActor(twinTourMachine)');
  expect(runtime).toContain('Scope.addFinalizer');
  expect(runtime).toContain('Scope.close(this.scope');
  expect(runtime).toContain('requestFrame');
  expect(runtime).toContain('cancelFrame');
  expect(runtime).toContain('generation === session.generation');
  expect(machine).toContain("initial: 'idle'");
  expect(machine).toContain("running:");
});
it('keeps Tour lifecycle state outside TwinUiState and publishes only its Atom projection', () => {
  const state = read('twin/twin-state.ts');
  const atom = read('twin/twin-tour.atom.ts');
  const slices = read('twin/use-twin-slices.ts');
  expect(state).not.toContain('tour: { active:');
  expect(state).not.toContain("type: 'tour/step'");
  expect(atom).toContain('TwinTourProjection');
  expect(slices).toContain('twinTourAtom');
});
