import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const read = (path: string) => readFileSync(fileURLToPath(new URL('../../src/twin/' + path, import.meta.url)), 'utf8');
it('keeps Research clocks, event indexing and lifecycle outside React and the generic UI atom', () => {
  const hook = read('use-research-playback.ts');
  const runtime = read('twin-research-runtime.ts');
  const machine = read('twin-research.machine.ts');
  const atom = read('twin-research.atom.ts');
  const page = read('twin-page.tsx');
  const hud = read('twin-research-hud.tsx');
  const ui = read('twin-state.ts');
  expect(hook).not.toMatch(/setInterval\(|clearInterval\(|ResearchReplay\.parse\(|projectReplayStates\(|performance\.now\(/);
  expect(runtime).toContain('Scope.addFinalizer');
  expect(runtime).toContain('ResearchReplay.parse');
  expect(runtime).toContain('projectReplayStates');
  expect(machine).toContain("initial: 'inactive'");
  expect(machine).not.toMatch(/timeSec|machineStates|replayProjection/);
  expect(atom).toContain('readonly scopeKey: string');
  expect(ui).not.toMatch(/research\/advance|research\/seek|research\/play|research\/speed/);
  expect(ui).not.toMatch(/research: \{/);
  expect(page).toContain('<TwinResearchHud');
  expect(page).not.toContain('useResearchPlayback(');
  expect(page).not.toContain('researchSnapshot');
  expect(hud).toContain('useResearchPlayback(');
  expect(runtime).toContain('lastReplayProjection');
  expect(runtime).not.toContain('setReplayBase(');
  expect(hook).not.toContain('setReplayBase(');
  expect(page).not.toContain('<span>
}););

});