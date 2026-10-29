import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Task 5/6 resource ownership gate (04 §2.4). Remote snapshots have exactly one
 * owner: the Resource Atom facade. This gate is a semantic allowlist scan rather
 * than a blanket "new Map" ban: ordering gates may keep epoch/sequence metadata,
 * but no api module may copy a full snapshot into a second cache.
 */
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
const rel = (file: string) => relative(sourceRoot, file).replaceAll('\\', '/');
const read = (file: string) => readFileSync(file, 'utf8');

it('only the Resource facade writes AsyncResult snapshot states', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = rel(file);
    if (path === 'api/resource.ts') continue;
    if (/AsyncResult\.(?:success|failWithPrevious)\s*\(/.test(read(file))) {
      violations.push(path + ' writes an AsyncResult snapshot outside api/resource.ts');
    }
  }
  expect(violations).toEqual([]);
});

it('api modules keep no second snapshot cache (ordering metadata is allowlisted)', () => {
  const allowlistedMetadataCaches = new Set([
    // epoch/sequence high-water only; never a snapshot copy.
    'api/equipment.resource.ts',
    // static request-header deny list, not server data.
    'api/http.transport.ts',
  ]);
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'api'))) {
    const path = rel(file);
    if (allowlistedMetadataCaches.has(path)) continue;
    const text = read(file);
    if (/new (?:Map|WeakMap)\s*\(/.test(text)) violations.push(path + ' constructs a Map/WeakMap in the api layer');
  }
  expect(violations).toEqual([]);
});

it('route files never fetch directly; they compose the AppRuntime resource facade', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'routes'))) {
    const text = read(file);
    const path = rel(file);
    if (/\bfetch\s*\(|httpTransport|new EventSource|XMLHttpRequest/.test(text)) {
      violations.push(path + ' performs transport work instead of using the resource facade');
    }
  }
  expect(violations).toEqual([]);
  expect(read(join(sourceRoot, 'routes/route-data.ts'))).toContain('ensureResource');
});

it('every remote resource definition goes through makeResource/resourceFamily', () => {
  const resourceFiles = readdirSync(join(sourceRoot, 'api'))
    .filter((name) => name.endsWith('.resource.ts'))
    .map((name) => 'api/' + name);
  const violations: string[] = [];
  for (const path of resourceFiles) {
    const text = read(join(sourceRoot, path));
    if (!/makeResource\(|resourceFamily\(/.test(text)) violations.push(path + ' does not declare a Resource Atom');
    if (!/RESOURCE_POLICIES\./.test(text)) violations.push(path + ' does not use the central resource policy table');
  }
  expect(violations).toEqual([]);
  expect(resourceFiles.length).toBeGreaterThanOrEqual(6);
});
