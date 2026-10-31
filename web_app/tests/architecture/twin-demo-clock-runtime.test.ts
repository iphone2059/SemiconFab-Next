import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const read = (name: string) => readFileSync(fileURLToPath(new URL('../../src/twin/' + name, import.meta.url)), 'utf8');
it('owns the DEMO clock in the Effect scope, not React or the generic UI reducer', () => {
  const hook = read('use-twin-demo-clock.ts');
  const runtime = read('twin-demo-clock-runtime.ts');
  const atom = read('twin-demo.atom.ts');
  expect(hook).not.toMatch(/setInterval\(|clearInterval\(/);
  expect(runtime).toContain('Scope.addFinalizer');
  expect(runtime).toContain('DEMO_TICK_MS');
  expect(runtime).toContain('this.generation !== generation');
  expect(atom).toContain('demoReducer');
});
