import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'oxc-transform-react';
import { expect, it } from 'vitest';

/**
 * CORE-011 / G15 Rust/Oxc React Compiler gate.
 *
 * A Vite config string is not evidence that compilation happened. This suite
 * compiles a real fixture and then every production TSX file through the exact
 * locked oxc-transform-react version, and freezes the peer-compatibility plan:
 * no peerDependencyRules bypass, a maintained compatibility patch, and an explicit
 * compiler ON/OFF build control for the production equivalence harness.
 */
const root = process.cwd();
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const COMPILER_OPTIONS = { target: '19' as const, compilationMode: 'infer' as const, reportDiagnostics: true };
const PLUGIN_OPTIONS = { jsx: { runtime: 'automatic' as const, development: false, refresh: false }, reactCompiler: COMPILER_OPTIONS, sourcemap: false };

const FIXTURE = [
  "import { useState } from 'react';",
  '',
  'export function CompilerFixture({ step }: { step: number }) {',
  '  const [count, setCount] = useState(0);',
  '  const next = count + step;',
  '  return <button onClick={() => setCount(next)}>{next}</button>;',
  '}',
].join('\n');

function productionTsxFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (absolute.endsWith('.tsx')) out.push(absolute);
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

it('oxc-transform-react compiles a TSX fixture to React 19 compiler-runtime output', () => {
  const result = transformSync('compiler-fixture.tsx', FIXTURE, { reactCompiler: COMPILER_OPTIONS });
  expect(result.fatal).toBe(false);
  expect(result.code).toContain('react/compiler-runtime');
  expect(result.code).toMatch(/\b_c\(/);
  expect(result.code).toContain('react/jsx-runtime');
  expect(result.code).not.toContain('babel');
  // The compiler hook is present regardless of the cache variable suffix.
  expect(result.code).toMatch(/import \{[^}]*\bc as _c[^}]*\} from "react\/compiler-runtime"/);
});

it('compiles every real production TSX source through the locked Oxc compiler', () => {
  const files = productionTsxFiles();
  expect(files.length).toBeGreaterThanOrEqual(40);
  const failures: string[] = [];
  let compilerRuntime = 0;
  let jsxRuntime = 0;
  for (const file of files) {
    const result = transformSync(file, readFileSync(file, 'utf8'), PLUGIN_OPTIONS);
    if (result.fatal) {
      failures.push(relativePath(file) + ': ' + result.errors.map((error) => error.message).join('; '));
      continue;
    }
    if (result.code.includes('react/compiler-runtime')) compilerRuntime += 1;
    if (result.code.includes('react/jsx-runtime')) jsxRuntime += 1;
  }
  expect(failures).toEqual([]);
  // Not every TSX module contains a compilable component (some export data views),
  // but the production tree must actually be optimized, not merely transpiled.
  expect(compilerRuntime).toBeGreaterThanOrEqual(40);
  expect(jsxRuntime).toBeGreaterThanOrEqual(40);
});

function relativePath(absolute: string): string {
  return absolute.slice(root.length + 1).replaceAll('\\', '/');
}

it('Vite uses exactly one Oxc-backed React Compiler pipeline with an explicit OFF control', () => {
  const config = read('vite.config.ts');
  expect(config).toContain("compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true }");
  expect(config).toContain('plugins: [react(');
  // CORE-011: the equivalence harness builds the same tree with and without the compiler.
  expect(config).toContain("FAB_REACT_COMPILER !== 'off'");
  expect(config).not.toMatch(/tanstackRouter|routerPlugin|reactCompilerPreset|@rolldown\/plugin-babel/);
  expect(config).not.toMatch(/compiler\s*:\s*true/);
  // Production preview must proxy /api exactly like dev for the browser gates.
  expect(config).toMatch(/preview:\s*\{/);
  expect(config).toContain('proxy');
});

it('manifest/lockfile use oxc-transform-react, a maintained compatibility patch, and no peer bypass', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
  expect(declared['oxc-transform-react']).toBe('0.156.0');
  expect(declared.oxlint).toBe('1.90.0');
  for (const forbidden of ['babel-plugin-react-compiler', '@rolldown/plugin-babel', '@babel/core', '@types/babel__core', '@tanstack/router-plugin']) {
    expect(declared[forbidden], forbidden).toBeUndefined();
  }
  expect(packageJson.scripts?.lint).toBe('oxlint src');
  const lockfile = read('pnpm-lock.yaml');
  // Optional peer *metadata* of @vitejs/plugin-react mentions Babel compiler package
  // names, so assert they are not resolved/installed package keys or imports.
  const lockLines = lockfile.split('\n');
  for (const forbidden of ['babel-plugin-react-compiler', '@rolldown/plugin-babel', '@tanstack/router-plugin']) {
    const installed = lockLines.some((line) => line.startsWith("  '" + forbidden + '@') || line.startsWith('  ' + forbidden + '@'));
    expect(installed, forbidden + ' must not resolve').toBe(false);
  }
  expect(lockfile).toContain('  oxc-transform-react@0.156.0:');

  // G15: compatibility is a maintained patch with executable evidence, never a
  // peerDependencyRules.allowedVersions bypass.
  const workspace = read('pnpm-workspace.yaml');
  const settingsLines = workspace.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  expect(settingsLines.some((line) => /^\s*peerDependencyRules:/.test(line))).toBe(false);
  expect(settingsLines.some((line) => /^\s*allowedVersions:/.test(line))).toBe(false);
  expect(workspace).toContain("'@vitejs/plugin-react@6.1.2': patches/@vitejs__plugin-react@6.1.2.patch");
  expect(lockfile).toContain('patchedDependencies:');
  const patch = read('patches/@vitejs__plugin-react@6.1.2.patch');
  expect(patch).toContain('+    "oxc-transform-react": ">=0.152.0 <0.157.0",');
  const installedPlugin = JSON.parse(readFileSync(join(root, 'node_modules/@vitejs/plugin-react/package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>;
  };
  expect(installedPlugin.peerDependencies?.['oxc-transform-react']).toBe('>=0.152.0 <0.157.0');

  // The executable API-compatibility gate must exist and stay wired to CI scripts.
  const compatTool = readFileSync(join(root, '../tools/compiler_compat.mjs'), 'utf8');
  expect(compatTool).toContain('COMPILER COMPAT PASS');
  expect(compatTool).toContain("await import(pathToFileURL(oxcEntry).href)");
  const config = read('vite.config.ts');
  expect(config).not.toContain('babel-plugin-react-compiler');
  expect(config).not.toContain('@rolldown/plugin-babel');
});

it('exposes a single Oxlint correctness gate for React rules', () => {
  const oxlint = JSON.parse(read('.oxlintrc.json')) as { plugins?: string[]; categories?: Record<string, string> };
  expect(oxlint.plugins).toEqual(['react']);
  expect(oxlint.categories?.correctness).toBe('error');
});
