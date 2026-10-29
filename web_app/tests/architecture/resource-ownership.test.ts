import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Phase B resource ownership gate (ADR-006/ADR-007, INV-04).
 *
 * The gate is a semantic allowlist scan rather than a blanket "new Map" ban:
 * - exactly one module may create Atom cells and write AsyncResult snapshot states;
 * - the old resource API tokens, the mutable per-registry equipment gate and the
 *   module-level dynamic families must stay deleted (no compatibility shims);
 * - every remote resource module exports immutable definitions, never Atoms created
 *   at import time; modules of the resource graph stay acyclic.
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

/** ADR-006 §2.9: the removed public API must have exactly zero references in src. */
const FORBIDDEN_TOKENS: readonly { readonly token: RegExp; readonly why: string }[] = [
  { token: /\bresourceFamily\b/, why: 'module-level dynamic resource family map was deleted' },
  { token: /\bmakeResource\b/, why: 'resources are immutable ResourceDefinition values now' },
  { token: /\brefreshResource\b/, why: 'reads go through runtime.resources.refresh(handle)' },
  { token: /\bensureResource\b/, why: 'reads go through runtime.resources.ensure(handle)' },
  { token: /\bsetResourceValue\b/, why: 'writes go through the manager Publish | Ignore commit port' },
  { token: /\bresourceValue\b/, why: 'reads go through runtime.resources.value(handle)' },
  { token: /\binvalidateResource\b/, why: 'explicit refresh through the manager replaces global invalidation' },
  { token: /\bequipmentStatusGate\b/, why: 'the per-registry mutable equipment gate was deleted' },
  { token: /\bactivateEquipmentStatusScope\b/, why: 'ordering state lives only in the resource Atom' },
  { token: /\bresetEquipmentStatusGates\b/, why: 'there is no second gate-state cache to reset' },
  { token: /\bacceptEquipmentStatusSnapshot\b/, why: 'all equipment writers go through the manager commit port' },
  { token: /\bgatesByRegistry\b/, why: 'no per-registry high-water map exists' },
  { token: /\bnew WeakMap<s*Resource/, why: 'module-level in-flight WeakMap was deleted' },
];

it('the removed resource API and mutable gate tokens are absent from src', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const text = read(file);
    for (const { token, why } of FORBIDDEN_TOKENS) {
      if (token.test(text)) violations.push(rel(file) + ' still references ' + String(token) + ': ' + why);
    }
  }
  expect(violations).toEqual([]);
});

it('only the ResourceManager module creates resource Atom cells / AsyncResult snapshot states', () => {
  const allowed = new Set(['api/resource-manager.ts']);
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = rel(file);
    if (allowed.has(path)) continue;
    const text = read(file);
    if (/AsyncResult\.(?:success|failWithPrevious|fail|failureWithPrevious)\s*\(/.test(text)) {
      violations.push(path + ' writes an AsyncResult snapshot outside api/resource-manager.ts');
    }
    if (path.startsWith('api/') && /Atom\.writable\s*[(<]/.test(text)) {
      violations.push(path + ' creates a writable resource Atom outside api/resource-manager.ts');
    }
  }
  expect(violations).toEqual([]);
});

it('api modules keep no second snapshot cache (ordering metadata is allowlisted)', () => {
  const allowlistedMetadataCaches = new Set<string>([
    // static request-header deny list, not server data.
    'api/http.transport.ts',
    // the single resource manager owns the bounded entry/diagnostic/handle maps (control metadata only).
    'api/resource-manager.ts',
  ]);
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'api'))) {
    const path = rel(file);
    if (allowlistedMetadataCaches.has(path)) continue;
    const text = read(file);
    if (/new (?:Map|WeakMap)\s*[(<]/.test(text)) violations.push(path + ' constructs a Map/WeakMap in the api layer');
  }
  expect(violations).toEqual([]);
});

it('route files never fetch directly; they compose the AppRuntime resource manager', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(join(sourceRoot, 'routes'))) {
    const text = read(file);
    const path = rel(file);
    if (/\bfetch\s*\(|httpTransport|new EventSource|XMLHttpRequest/.test(text)) {
      violations.push(path + ' performs transport work instead of using the resource manager');
    }
  }
  expect(violations).toEqual([]);
  const routeData = read(join(sourceRoot, 'routes/route-data.ts'));
  expect(routeData).toContain('runtime.resources.ensure(runtime.resources.handle(sitesDefinition))');
});

it('every remote resource module exports an immutable typed ResourceDefinition and no import-time Atom', () => {
  const resourceFiles = readdirSync(join(sourceRoot, 'api'))
    .filter((name) => name.endsWith('.resource.ts'))
    .map((name) => 'api/' + name);
  const violations: string[] = [];
  for (const path of resourceFiles) {
    const text = read(join(sourceRoot, path));
    if (!/Definition\b/.test(text)) violations.push(path + ' exports no immutable ResourceDefinition');
    // ADR-013 §1.2: every definition carries a typed identity (kind + version + key).
    if (!/identity:\s*\{[^}]*kind:\s*'[^']+'[^}]*version:\s*\d+[^}]*key:/s.test(text)) {
      violations.push(path + ' definition is missing the typed identity { kind, version, key }');
    }
    if (!/RESOURCE_POLICIES\./.test(text)) violations.push(path + ' does not use the central resource policy table');
    if (/Atom\.(?:writable|make)\s*[(<]/.test(text)) violations.push(path + ' creates an Atom at module scope');
    if (/\bmakeResource\b|\bresourceFamily\b/.test(text)) violations.push(path + ' uses the removed resource factory API');
  }
  expect(violations).toEqual([]);
  expect(resourceFiles.length).toBeGreaterThanOrEqual(6);
});

it('the resource module graph stays acyclic (static + type-only edges)', () => {
  const files = [
    ...sourceFiles(join(sourceRoot, 'api')).map(rel),
    'app/app-runtime.ts',
  ];
  const specifierPattern = /(?:from\s+|import\s*\()['"]([^'"]+)['"]/g;
  const edges = new Map<string, string[]>();
  for (const path of files) {
    const text = read(join(sourceRoot, path));
    const targets: string[] = [];
    for (const match of text.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('@/')) continue;
      const target = specifier.slice(2).replace(/\.[jt]sx?$/, '') + '.ts';
      targets.push(target);
    }
    edges.set(path, targets);
  }
  // Modules that import each other must not form a cycle (break it with a type-only contract).
  const cycles: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    if (!edges.has(node)) return;
    if (visiting.has(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' -> '));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of edges.get(node) ?? []) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) visit(node);
  expect(cycles).toEqual([]);
});