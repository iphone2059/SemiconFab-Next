import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Legacy dependency gate. Task 3 removes Zod; later tasks flip the remaining
 * entries (Zustand Task 4, TanStack Query Task 5, RxJS Task 6). Keeping the
 * list here lets each task turn a rule on without rewriting the gate.
 */
interface LegacyDependencyRule {
  readonly dependency: string;
  readonly bareSpecifier: RegExp;
  readonly active: boolean;
  readonly task: string;
}

const RULES: readonly LegacyDependencyRule[] = [
  { dependency: 'zod', bareSpecifier: /^(?:zod|@zod\/)/, active: true, task: 'Task 3' },
  { dependency: 'zustand', bareSpecifier: /^zustand$/, active: true, task: 'Task 4' },
  { dependency: '@tanstack/react-query', bareSpecifier: /^@tanstack\/(?:react-query|query-core)$/, active: false, task: 'Task 5' },
  { dependency: 'rxjs', bareSpecifier: /^rxjs(?:\/|$)/, active: false, task: 'Task 6' },
];

const webAppRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = join(webAppRoot, 'src');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

it('production source never imports an active legacy dependency', () => {
  const active = RULES.filter((rule) => rule.active);
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = relative(sourceRoot, file).replaceAll('\\', '/');
    for (const specifier of importSpecifiers(file)) {
      const rule = active.find((entry) => entry.bareSpecifier.test(specifier));
      if (rule) violations.push(path + " imports '" + specifier + "' (" + rule.task + ')');
    }
  }
  expect(violations).toEqual([]);
});

it('manifest/lockfile no longer contain an active legacy dependency', () => {
  const active = RULES.filter((rule) => rule.active);
  const packageJson = JSON.parse(readFileSync(join(webAppRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const rule of active) expect(declared[rule.dependency], rule.dependency).toBeUndefined();
  const lockfile = readFileSync(join(webAppRoot, 'pnpm-lock.yaml'), 'utf8');
  for (const rule of active) {
    const escaped = rule.dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(new RegExp('^  ' + escaped + '@', 'm').test(lockfile), rule.dependency + ' must not resolve in the lockfile').toBe(false);
  }
});
