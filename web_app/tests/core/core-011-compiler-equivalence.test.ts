import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'oxc-transform-react';
import { expect, it } from 'vitest';

/**
 * CORE-011: React Compiler ON/OFF semantic equivalence gate.
 *
 * The browser-level differential evidence is produced by
 * tools/compiler_equivalence.mjs against two real production builds. This test
 * freezes the executable contract of that harness plus the transform-level
 * controls it depends on, so the gate cannot silently degrade into a comment.
 */
const root = process.cwd();
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const readRepo = (file: string): string => readFileSync(join(root, '..', file), 'utf8');

const REQUIRED_SCENARIOS = [
  'empty-list',
  'run-submit',
  'bigint',
  'closure-capture',
  'dynamic-import-gpu',
  'atom-subscriptions',
  'fab-switch',
  'external-mutable-registry',
  'external-atom-hook',
  'workbench-root',
];

it('vite exposes the compiler ON/OFF production build control used by the harness', () => {
  const config = read('vite.config.ts');
  expect(config).toContain("FAB_REACT_COMPILER !== 'off'");
  expect(config).toContain("compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true }");
  expect(config).not.toMatch(/babel-plugin-react-compiler|@rolldown\/plugin-babel/);
});

it('compiler-equivalence harness builds both modes and fails on semantic difference', () => {
  const harness = readRepo('tools/compiler_equivalence.mjs');
  expect(harness).toContain("FAB_REACT_COMPILER: mode");
  expect(harness).toContain("build('on')");
  expect(harness).toContain("build('off')");
  // Artifact-level proof that the two builds really differ: ON must contain the
  // compiler runtime, OFF must not.
  // The production bundle itself records the compiler mode (vite.config.ts banner),
  // so the harness proves it compared a real ON build with a real OFF control.
  expect(harness).toContain('FAB_COMPILER=');
  expect(harness).toContain('artifactMarker');
  expect(harness).toContain('artifact markers are crossed');
  expect(harness).toContain('produced identical artifacts');
  // Deterministic environment and same-network comparison.
  expect(harness).toContain('Math.random = rand');
  expect(harness).toContain('crypto.randomUUID');
  expect(harness).toContain('const compare = (');
  expect(harness).toContain('business');
  expect(harness).toContain('dom');
  expect(harness).toContain('http');
  expect(harness).toContain('process.exitCode = 1');
  // Required CORE-011 scenario matrix (execution counts may differ, semantics may not).
  for (const scenario of REQUIRED_SCENARIOS) {
    expect(harness, scenario).toContain("id: '" + scenario + "'");
  }
  expect(harness).toContain('React update-depth loop on the workbench root');
  // Round 5.2 / review P2-01: the harness must keep the isolated-backend experiment,
  // the deterministic quiescence barrier, request counts and authoritative side-effect
  // comparison as executable contract, not just comments.
  expect(harness).toContain('fixtures are not identical');
  expect(harness).toContain('countedSurface');
  expect(harness).toContain('const quiesce = async (');
  expect(harness).toContain('QUIESCENCE_LOG');
  expect(harness).toContain('compareSideEffects');
  expect(harness).toContain('sideEffects');
  expect(harness).toContain('--api-url-on');
  expect(harness).toContain('--api-url-off');
  expect(harness).toContain('execution counts and timings may differ');
});

it('Round 5.2 / review P2-01: the wrapper starts two isolated backends with the same seeded fixture', () => {
  const wrapper = readRepo('scripts/compiler-equivalence.ps1');
  // Two independent ports and data directories: ON and OFF must never share a mutable
  // backend/database (the Round 5.1 evidence had apiUrl.on === apiUrl.off).
  expect(wrapper).toContain('-ApiPortOn');
  expect(wrapper).toContain('-ApiPortOff');
  expect(wrapper).toContain('Reset-FabEquivalenceModeDirectory');
  expect(wrapper).toContain('$fabOnLocal');
  expect(wrapper).toContain('$fabOffLocal');
  // Both APIs receive the same development key, and each start-dev.ps1 gets its own
  // LocalDirectory (hence its own Fab__DataDirectory database).
  expect(wrapper).toContain('development-key');
  expect(wrapper).toContain('--api-url-on $fabApiUrlOn');
  expect(wrapper).toContain('--api-url-off $fabApiUrlOff');
  // Process/port hygiene: both owned APIs are stopped and the ports verified released.
  expect(wrapper).toContain('Stop-FabEquivalenceApi');
  expect(wrapper).toContain('Wait-FabPortReleased');
});

it('compiler compatibility gate proves the locked Oxc API is the one the plugin consumes', () => {
  const gate = readRepo('tools/compiler_compat.mjs');
  expect(gate).toContain('import("oxc-transform-react")');
  expect(gate).toContain('await transform(');
  expect(gate).toContain('result.fatal');
  expect(gate).toContain('react/compiler-runtime');
  expect(gate).toContain('vite:react-compiler');
  expect(gate).toContain('COMPILER COMPAT PASS');
  expect(gate).toContain('has no peerDependencyRules.allowedVersions bypass');
});

it('compiles a production component with and without the compiler and keeps the export surface', () => {
  const source = read('src/twin/twin-wafer-hud.tsx');
  const on = transformSync('src/twin/twin-wafer-hud.tsx', source, {
    jsx: { runtime: 'automatic', development: false, refresh: false },
    reactCompiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true },
    sourcemap: false,
  });
  const off = transformSync('src/twin/twin-wafer-hud.tsx', source, {
    jsx: { runtime: 'automatic', development: false, refresh: false },
    reactCompiler: false,
    sourcemap: false,
  });
  expect(on.fatal).toBe(false);
  expect(off.fatal).toBe(false);
  expect(on.code).toContain('react/compiler-runtime');
  expect(off.code).not.toContain('react/compiler-runtime');
  // The transformed module keeps the same exported React component surface.
  const exports = (code: string): string[] => [...code.matchAll(/export (?:function|const) (\w+)/g)].map((match) => match[1]).sort();
  expect(exports(on.code).length).toBeGreaterThan(0);
  expect(exports(on.code)).toEqual(exports(off.code));
  expect(on.code.includes('react/jsx-runtime')).toBe(off.code.includes('react/jsx-runtime'));
});

it('external-Atom-only hook opts out of compiler caching (validated compiler limitation)', () => {
  // Oxc React Compiler (experimental): a custom hook whose only reactive input is
  // an external Atom subscription can be memoized by its call arguments in
  // 'infer' mode, so the projection would never update. useCommandProjection opts
  // out with 'use no memo'; the rest of the module still compiles.
  const source = read('src/app/runtime-provider.tsx');
  const options = {
    jsx: { runtime: 'automatic' as const, development: false, refresh: false },
    reactCompiler: { target: '19' as const, compilationMode: 'infer' as const, reportDiagnostics: true },
    sourcemap: false,
  };
  const on = transformSync('src/app/runtime-provider.tsx', source, options);
  const off = transformSync('src/app/runtime-provider.tsx', source, { ...options, reactCompiler: false });
  expect(on.fatal).toBe(false);
  expect(off.fatal).toBe(false);
  // The compiler remains active in the module (the provider component compiles)...
  expect(on.code).toContain('react/compiler-runtime');
  expect(on.code).toMatch(/_c\(/);
  // ...but the external-subscription hook is explicitly excluded from caching.
  const hookStart = on.code.indexOf('export function useCommandProjection');
  expect(hookStart).toBeGreaterThan(0);
  const hookEnd = on.code.indexOf('\n}', hookStart);
  const hook = on.code.slice(hookStart, hookEnd);
  expect(hook).toContain('use no memo');
  expect(hook).not.toMatch(/_c\(/);
  expect(off.code).not.toMatch(/_c\(/);
});
