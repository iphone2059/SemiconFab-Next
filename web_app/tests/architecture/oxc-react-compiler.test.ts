import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'oxc-transform-react';
import { expect, it } from 'vitest';

/**
 * Task 7 Rust/Oxc React Compiler gate.
 *
 * A Vite config string is not evidence that compilation happened. This fixture
 * compiles a real TSX component through the exact locked oxc-transform-react
 * version and proves the React 19 compiler runtime output is produced. The
 * second block freezes the integration choice: one @vitejs/plugin-react instance
 * with the compiler option, no Babel compiler pipeline, and no router plugin.
 */
const root = process.cwd();
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

const FIXTURE = `
import { useState } from 'react';

export function CompilerFixture({ step }: { step: number }) {
  const [count, setCount] = useState(0);
  const next = count + step;
  return <button onClick={() => setCount(next)}>{next}</button>;
}
`;

it('oxc-transform-react compiles a TSX fixture to React 19 compiler-runtime output', () => {
  const result = transformSync('compiler-fixture.tsx', FIXTURE, {
    reactCompiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true },
  });
  expect(result.fatal).toBe(false);
  expect(result.code).toContain('react/compiler-runtime');
  expect(result.code).toMatch(/\b_c\(/);
  expect(result.code).toContain('react/jsx-runtime');
  expect(result.code).not.toContain('babel');
  // The compiler hook is present regardless of the cache variable suffix.
  expect(result.code).toMatch(/import \{[^}]*\bc as _c[^}]*\} from "react\/compiler-runtime"/);
});

it('Vite uses exactly one Oxc-backed React Compiler pipeline with the required options', () => {
  const config = read('vite.config.ts');
  expect(config).toContain("compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true }");
  expect(config).toContain('plugins: [react(');
  expect(config).not.toMatch(/tanstackRouter|routerPlugin|reactCompilerPreset|@rolldown\/plugin-babel/);
  expect(config).not.toMatch(/compiler\s*:\s*true/);
});

it('manifest/lockfile use oxc-transform-react and never a Babel React Compiler pipeline', () => {
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
  const config = read('vite.config.ts');
  expect(config).not.toContain('babel-plugin-react-compiler');
  expect(config).not.toContain('@rolldown/plugin-babel');
});

it('exposes a single Oxlint correctness gate for React rules', () => {
  const oxlint = JSON.parse(read('.oxlintrc.json')) as { plugins?: string[]; categories?: Record<string, string> };
  expect(oxlint.plugins).toEqual(['react']);
  expect(oxlint.categories?.correctness).toBe('error');
});
