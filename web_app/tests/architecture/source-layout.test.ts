import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Task 1 hard constraint: production source under web_app/src is exactly
 * src/<module>/<file>. The positive scan runs on the real tree; the negative
 * fixture proves a nested src/api/queries/example.ts is rejected.
 */
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/source-layout/src/', import.meta.url));

const ALLOWED_MODULES = new Set([
  'app', 'api', 'assets', 'catalog', 'components', 'contracts', 'domain', 'generated', 'lib',
  'localization', 'realtime', 'rendering', 'routes', 'runtime', 'state', 'twin', 'workbench',
]);
const KEBAB_FILE = /^[a-z0-9][a-z0-9.-]*\.(?:ts|tsx)$/;

interface LayoutViolation {
  readonly rule: string;
  readonly path: string;
  readonly message: string;
}

function scanLayout(root: string): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  const rootFiles = readdirSync(root, { withFileTypes: true });
  for (const entry of rootFiles) {
    if (entry.isFile()) {
      if (entry.name !== 'main.tsx') {
        violations.push({ rule: 'LAYOUT-01', path: entry.name, message: 'src root may only contain main.tsx' });
      }
      continue;
    }
    if (!ALLOWED_MODULES.has(entry.name)) {
      violations.push({ rule: 'LAYOUT-02', path: entry.name + '/', message: 'module directory is not in the approved flat layout list' });
    }
    const modulePath = join(root, entry.name);
    for (const child of readdirSync(modulePath, { withFileTypes: true })) {
      const childPath = relative(root, join(modulePath, child.name)).split('\\').join('/');
      if (child.isDirectory()) {
        violations.push({ rule: 'LAYOUT-03', path: childPath + '/', message: 'nested directories are forbidden under src/<module>/' });
        continue;
      }
      if (!KEBAB_FILE.test(child.name)) {
        violations.push({ rule: 'LAYOUT-04', path: childPath, message: 'files must be lowercase kebab-case .ts/.tsx' });
      }
      if (/^(?:index|utils|helpers|common)\.(?:ts|tsx)$/.test(child.name)) {
        violations.push({ rule: 'LAYOUT-05', path: childPath, message: 'ambiguous barrel/utility filenames are forbidden' });
      }
      const text = readFileSync(join(modulePath, child.name), 'utf8');
      if (text.includes('@ts-nocheck')) {
        violations.push({ rule: 'LAYOUT-06', path: childPath, message: 'production source may not suppress type checking' });
      }
      if (!/\.tsx?$/.test(child.name)) continue;
      if (!statSync(join(modulePath, child.name)).isFile()) {
        violations.push({ rule: 'LAYOUT-07', path: childPath, message: 'source entries must be regular files' });
      }
    }
  }
  return violations;
}

function format(violations: readonly LayoutViolation[]): string[] {
  return violations.map((violation) => '[' + violation.rule + '] ' + violation.path + ': ' + violation.message);
}

it('enforces the strict flat src layout on the production tree', () => {
  const violations = scanLayout(sourceRoot);
  expect(format(violations), 'src must stay src/<module>/<file> with kebab-case files and no @ts-nocheck').toEqual([]);
});

it('rejects a nested src/api/queries/example.ts fixture', () => {
  const violations = scanLayout(fixtureRoot);
  expect(format(violations).some((violation) => violation.includes('api/queries') && violation.includes('LAYOUT-03'))).toBe(true);
  expect(format(violations).some((violation) => violation.includes('layers'))).toBe(false);
});
