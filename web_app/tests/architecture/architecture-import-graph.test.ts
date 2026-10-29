/**
 * Real import-graph architecture gate (review section 6).
 *
 * Unlike the regex checks in architecture-boundaries.test.ts, this test parses every
 * source file with the TypeScript compiler and resolves module specifiers on disk.
 *
 * Compiler API note: the project pins TypeScript 7, whose public programmatic API is
 * the native compiler exposed through 'typescript/unstable/sync' (program/AST) plus
 * 'typescript/unstable/ast' (SyntaxKind/type guards). The classic
 * 'import ts from "typescript"' entry only exposes the package version since TS 7.
 * No dependency is added: both entry points ship inside the existing "typescript"
 * devDependency, and the same native binary already backs 'tsc --noEmit'.
 *
 * The graph covers static imports, 'export ... from' re-exports and dynamic import().
 * Relative specifiers are resolved here (specifier, +'.ts', +'.tsx', '/index.ts',
 * '/index.tsx'); non-TS assets (json/txt/...) are non-graph leaves; bare package
 * specifiers are leaves that stay visible for layer rules.
 *
 * Enforced rules (failures always name the rule id, the relative file path and the
 * offending specifier/module):
 *   R0  every relative import resolves (otherwise lenient resolution would hide edges)
 *   R1  the module graph is acyclic, value and type-only edges included (cycle path is reported)
 *   R2  generic router utilities (non-assembly files under routes/) never import feature modules
 *   R3  domain purity: domain/** only depends on domain/**, contracts, assets and no packages
 *   R4  top-level catalog/, twin/ and workbench/ never import each other
 *   R5  generated artifacts are registered, self-describing and data-only
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';
import { API, type Snapshot } from 'typescript/unstable/sync';

const webAppRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = join(webAppRoot, 'src');
const tsconfigPath = join(webAppRoot, 'tsconfig.json');

/**
 * Cross-feature imports need a deliberate, reviewed entry. Features may compose
 * shared layers (domain/, state/, components/, api/, app/) but must not reach
 * into a sibling feature; add the exact resolved target below only when the edge
 * is an intentionally published contract. The healthy default is empty.
 * Format: '<owner>-><dependency>#<resolved target relative to src>'.
 */
const APPROVED_CROSS_FEATURE_IMPORTS: readonly string[] = [];

const toPosix = (value: string): string => value.replaceAll('\\', '/');
const relativeToWebApp = (file: string): string => toPosix(relative(webAppRoot, file));
const relativeToSource = (file: string): string => toPosix(relative(sourceRoot, file));
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

type ReferenceKind = 'static' | 're-export' | 'dynamic';

interface RawReference {
  readonly specifier: string;
  readonly kind: ReferenceKind;
  /** True when the whole edge is erased at emit (import type / export type). */
  readonly typeOnly: boolean;
}

function collectReferences(sourceFile: SourceFile): RawReference[] {
  const references: RawReference[] = [];
  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      if (isStringLiteral(node.moduleSpecifier)) {
        references.push({
          specifier: node.moduleSpecifier.text,
          kind: 'static',
          typeOnly: node.importClause?.phaseModifier === SyntaxKind.TypeKeyword,
        });
      }
    } else if (isExportDeclaration(node)) {
      if (node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
        references.push({
          specifier: node.moduleSpecifier.text,
          kind: 're-export',
          typeOnly: node.isTypeOnly,
        });
      }
    } else if (isCallExpression(node)) {
      const argument = node.arguments[0];
      if (node.expression.kind === SyntaxKind.ImportKeyword && argument && isStringLiteral(argument)) {
        references.push({ specifier: argument.text, kind: 'dynamic', typeOnly: false });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return references;
}

interface GraphReference extends RawReference {
  /** Posix path relative to web_app/src. */
  readonly from: string;
  /** Bare package specifier: a graph leaf that is still visible to layer rules. */
  readonly external: boolean;
  /** Resolved in-src module (posix path relative to web_app/src). */
  readonly target?: string;
  /** Resolved non-TS asset (posix path relative to web_app). */
  readonly asset?: string;
  readonly unresolved: boolean;
}

interface Graph {
  readonly references: readonly GraphReference[];
  /** Every .ts/.tsx file under src, posix paths relative to src. */
  readonly sourceFiles: readonly string[];
  /** Raw file text, used by the generated-artifact inventory. */
  readonly text: ReadonlyMap<string, string>;
}

function resolveReference(from: string, specifier: string): Pick<GraphReference, 'external' | 'target' | 'asset' | 'unresolved'> {
  const isRelative = specifier.startsWith('.');
  const isAlias = specifier.startsWith('@/');
  if (!isRelative && !isAlias) return { external: true, unresolved: false };
  const absolute = isAlias
    ? resolve(sourceRoot, specifier.slice(2).replace(/[?#].*$/, ''))
    : resolve(dirname(join(sourceRoot, from)), specifier.replace(/[?#].*$/, ''));
  const candidates = [absolute, absolute + '.ts', absolute + '.tsx', join(absolute, 'index.ts'), join(absolute, 'index.tsx')];
  const found = candidates.find(isFile);
  if (!found) return { external: false, unresolved: true };
  if (/\.(?:ts|tsx)$/.test(found)) {
    return { external: false, unresolved: false, target: relativeToSource(found) };
  }
  return { external: false, unresolved: false, asset: relativeToWebApp(found) };
}

function buildGraph(snapshot: Snapshot): Graph {
  const project = snapshot.getProjects()[0];
  if (!project) throw new Error('[graph] tsconfig.json produced no project; the gate cannot build the import graph.');
  const program = project.program;
  const programFiles = new Map(program.getSourceFileNames().map((name) => [toPosix(name).toLowerCase(), name]));

  const sourceFiles = collectSourceFiles(sourceRoot).map(relativeToSource);
  const references: GraphReference[] = [];
  const text = new Map<string, string>();
  const missing: string[] = [];

  for (const from of sourceFiles) {
    const programFile = programFiles.get(toPosix(join(sourceRoot, from)).toLowerCase());
    const sourceFile = programFile ? program.getSourceFile(programFile) : undefined;
    if (!sourceFile) {
      missing.push(from);
      continue;
    }
    text.set(from, readFileSync(join(sourceRoot, from), 'utf8'));
    for (const reference of collectReferences(sourceFile)) {
      references.push({ ...reference, from, ...resolveReference(from, reference.specifier) });
    }
  }

  if (missing.length > 0) {
    throw new Error('[graph] source file(s) missing from the tsconfig program: ' + missing.join(', '));
  }
  return { references, sourceFiles, text };
}

let graph: Graph;

beforeAll(() => {
  const api = new API({ cwd: webAppRoot });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
    try {
      graph = buildGraph(snapshot);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}, 120_000);

function formatViolations(rule: string, violations: readonly string[]): string[] {
  return violations.map((violation) => '[' + rule + '] ' + violation);
}

function expectNoViolations(rule: string, summary: string, violations: readonly string[]): void {
  expect(formatViolations(rule, violations), rule + ': ' + summary).toEqual([]);
}

function findCycles(references: readonly GraphReference[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const reference of references) {
    if (reference.external || reference.unresolved || !reference.target) continue;
    const targets = adjacency.get(reference.from) ?? [];
    targets.push(reference.target);
    adjacency.set(reference.from, targets);
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (module: string): void => {
    visited.add(module);
    active.add(module);
    stack.push(module);
    for (const target of adjacency.get(module) ?? []) {
      if (active.has(target)) {
        const cycle = [...stack.slice(stack.indexOf(target)), target];
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!visited.has(target)) {
        visit(target);
      }
    }
    stack.pop();
    active.delete(module);
  };
  for (const module of adjacency.keys()) {
    if (!visited.has(module)) visit(module);
  }
  return cycles.sort((left, right) => left.join('>').localeCompare(right.join('>')));
}

describe('architecture: real import graph', () => {
  it('parses every .ts/.tsx under src and resolves every relative import', () => {
    expect(graph.sourceFiles.length, 'the gate must see the whole src tree').toBeGreaterThan(0);
    expect(graph.references.length, 'the gate must extract module references').toBeGreaterThan(0);
    const unresolved = graph.references
      .filter((reference) => reference.unresolved)
      .map((reference) => reference.from + " -> '" + reference.specifier + "' (" + reference.kind + ')');
    expectNoViolations('R0', 'every relative import must resolve to a source module or a known asset', unresolved);
  });

  it('R0b: the only project alias is @/ -> src and the graph resolver must resolve it', () => {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: unknown };
    };
    expect(tsconfig.compilerOptions?.paths, 'R0b: declare the single @/ alias in tsconfig paths').toEqual({ '@/*': ['./src/*'] });
    expect(tsconfig.compilerOptions?.baseUrl, 'R0b: TS 7 removed baseUrl; paths are tsconfig-relative').toBeUndefined();
    const aliasReferences = graph.references.filter((reference) => reference.specifier.startsWith('@/'));
    expect(aliasReferences.length, 'R0b: alias imports must be visible to the graph resolver').toBeGreaterThan(0);
    const unresolvedAliases = aliasReferences.filter((reference) => reference.unresolved).map((reference) => reference.from + " -> '" + reference.specifier + "'");
    expectNoViolations('R0b', 'every @/ alias must resolve to a src module', unresolvedAliases);
  });

  it('R1: the module graph is acyclic, type-only edges included', () => {
    // The packed static-structure payload used to import its entity type from the lite renderer
    // (generated/static-structure-packed.generated.ts -> rendering/lite/geometry/static-structure.ts), a
    // type-level cycle that 'import type' hid from a value-only check. It now imports the
    // hand-written data contract (rendering/contracts/static-structure-data.ts), which is a leaf.
    // Check every edge so a new back-reference cannot hide behind 'import type' again.
    const cycles = findCycles(graph.references);
    expect(cycles.map((cycle) => cycle.join(' -> ')), 'R1: break the cycle by extracting a shared module').toEqual([]);
  });

  it('R2: generic router utilities must not import feature modules (route assembly files are exempt)', () => {
    const violations: string[] = [];
    const isRouteAssembly = (file: string): boolean => /^routes\/[^/]+\.route\.tsx$/.test(file);
    for (const reference of graph.references) {
      if (!reference.from.startsWith('routes/') || isRouteAssembly(reference.from)) continue;
      if (reference.target && /^(catalog|twin|workbench)\//.test(reference.target)) {
        violations.push(
          reference.from + " imports '" + reference.specifier + "' -> " + reference.target + ' (' + reference.kind + ')',
        );
      }
    }
    expectNoViolations('R2', 'router utilities must stay feature-agnostic; only *.route.tsx assembly may import pages', violations);
  });

  it('R3: domain purity (no packages, no app/features/state/rendering/realtime/runtime/application/components/api imports)', () => {
    const isAllowedDomainTarget = (target: string): boolean =>
      target.startsWith('domain/') || target.startsWith('contracts/') || target === 'generated/contracts.generated.ts';
    const violations: string[] = [];
    let domainReferenceCount = 0;
    for (const reference of graph.references) {
      if (!reference.from.startsWith('domain/')) continue;
      domainReferenceCount += 1;
      const edge = reference.from + " imports '" + reference.specifier + "' (" + reference.kind + ')';
      if (reference.external) {
        violations.push(edge + ': package imports are forbidden in domain modules');
      } else if (reference.unresolved) {
        violations.push(edge + ': no resolvable target');
      } else if (reference.asset) {
        if (!reference.asset.startsWith('assets/')) {
          violations.push(edge + ": only web_app/assets data is allowed, resolved to '" + reference.asset + "'");
        }
      } else if (reference.target && !isAllowedDomainTarget(reference.target)) {
        violations.push(
          edge + ": resolved to '" + reference.target + "'; domain may only use domain/**, contracts and web_app/assets data",
        );
      }
    }
    expect(graph.sourceFiles.filter((file) => file.startsWith('domain/')).length, 'the gate must cover the domain layer').toBeGreaterThan(0);
    expect(domainReferenceCount, 'domain modules must have at least one dependency edge').toBeGreaterThan(0);
    expectNoViolations('R3', 'domain must stay a framework-free leaf layer', violations);
  });

  it('R4: features stay isolated unless a cross-feature contract is explicitly approved', () => {
    const featureOf = (file: string): string | undefined => /^(catalog|twin|workbench)\//.exec(file)?.[1];
    const violations: string[] = [];
    for (const reference of graph.references) {
      const owner = featureOf(reference.from);
      const dependency = reference.target ? featureOf(reference.target) : undefined;
      if (!owner || !dependency || owner === dependency) continue;
      const edgeKey = owner + '->' + dependency + '#' + reference.target;
      if (APPROVED_CROSS_FEATURE_IMPORTS.includes(edgeKey)) continue;
      violations.push(
        reference.from + " imports '" + reference.specifier + "' -> " + reference.target + ' (' + reference.kind + '); ' +
          "cross-feature edges must be listed in APPROVED_CROSS_FEATURE_IMPORTS as '" + edgeKey + "'",
      );
    }
    expectNoViolations('R4', 'features may compose shared layers, not sibling features', violations);
  });

  it('R6: src root is assembly-only (main.tsx + contracts.ts); every other module belongs to a layer', () => {
    const allowedRootFiles = new Set(['main.tsx']);
    const violations = graph.sourceFiles
      .filter((file) => !file.includes('/') && !allowedRootFiles.has(file))
      .map((file) => file + ' is a root-level module; move it into app/features/domain/rendering/state/realtime/components/application');
    expectNoViolations('R6', 'the src root must stay small so module ownership is discoverable', violations);
  });

  it('R5: generated artifacts are registered, carry a do-not-edit header and are data-only', () => {
    interface AllowedGeneratedImport {
      readonly specifier: string;
      readonly target?: string;
      readonly typeOnly: boolean;
    }
    interface GeneratedArtifact {
      readonly file: string;
      readonly allowedImports: readonly AllowedGeneratedImport[];
    }
    const generatedArtifacts: readonly GeneratedArtifact[] = [
      { file: 'generated/contracts.generated.ts', allowedImports: [] },
      { file: 'generated/twin-translations.generated.ts', allowedImports: [] },
      {
        file: 'generated/static-structure-packed.generated.ts',
        // The hand-written payload data contract (a leaf module, not a rendering consumer);
        // type-only so generated data stays runtime-free.
        allowedImports: [
          {
            specifier: '../rendering/static-structure-data.contract',
            target: 'rendering/static-structure-data.contract.ts',
            typeOnly: true,
          },
        ],
      },
    ];
    const registeredFiles = generatedArtifacts.map((artifact) => artifact.file);
    const discovered = graph.sourceFiles.filter((file) => /(?:\.generated\.tsx?|-packed\.tsx?)$/.test(file));
    expectNoViolations('R5', 'new *.generated.ts / *-packed.ts files must be registered in the generated-artifact inventory', [
      ...discovered
        .filter((file) => !registeredFiles.includes(file))
        .map((file) => file + ' is not registered in the generated-artifact inventory'),
      ...registeredFiles
        .filter((file) => !discovered.includes(file))
        .map((file) => file + ' is registered but missing under web_app/src/'),
    ]);

    const violations: string[] = [];
    for (const artifact of generatedArtifacts) {
      const content = graph.text.get(artifact.file);
      if (content === undefined) {
        violations.push(artifact.file + ' is missing');
        continue;
      }
      const header = content.split(/\r?\n/).slice(0, 5).join('\n');
      if (!/(?:auto[- ]?generated|generated by)/i.test(header) || !/do not edit/i.test(header)) {
        violations.push(artifact.file + " is missing the generated 'do not edit' header in its first 5 lines");
      }
      const references = graph.references.filter((reference) => reference.from === artifact.file);
      if (references.length !== artifact.allowedImports.length) {
        const found = references.map((reference) => "'" + reference.specifier + "'").join(', ') || 'none';
        violations.push(
          artifact.file +
            ' has ' +
            references.length +
            ' module reference(s); expected ' +
            artifact.allowedImports.length +
            ' (' +
            found +
            ')',
        );
        continue;
      }
      for (const [index, reference] of references.entries()) {
        const allowed = artifact.allowedImports[index];
        const details =
          artifact.file +
          " imports '" +
          reference.specifier +
          "' as " +
          reference.kind +
          (reference.typeOnly ? ' (type-only)' : '');
        if (reference.specifier !== allowed.specifier || reference.typeOnly !== allowed.typeOnly) {
          violations.push(
            details +
              '; only ' +
              (allowed.typeOnly ? 'type-only ' : '') +
              "'" +
              allowed.specifier +
              "' is allowed",
          );
        } else if (allowed.target && reference.target !== allowed.target) {
          violations.push(
            details +
              "; resolved to '" +
              (reference.target ?? reference.asset ?? 'unknown') +
              "', expected '" +
              allowed.target +
              "'",
          );
        }
      }
    }
    expectNoViolations(
      'R5',
      'generated artifacts must be declared, marked and data-only (single type-only data-contract import allowed)',
      violations,
    );
  });
});
