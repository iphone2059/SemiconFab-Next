/**
 * Architecture contract gates R7-R14 (plan section 9).
 *
 * tests/architecture-import-graph.test.ts covers R0-R6. This file adds the next gate tier.
 * Every gate parses real TypeScript with the project's pinned compiler
 * (typescript/unstable/{sync,ast}) instead of a hand-written regex, and every rule is proven
 * able to fail by a negative fixture under tests/architecture/fixtures/**.
 *
 *   R7  generic base modules (api/realtime/rendering/components/state/application/runtime)
 *       never import features/**; assembly roots app/providers + app/router/routes are exempt
 *   R8  domain/** uses no ambient clock/random/DOM/timer/network and no top-level side effect;
 *       static reference data may only come from web_app/assets/**
 *   R9  SceneCommands has no optional members, only the acceptance capability group may stay
 *       optional on ScenePort, and rendering/lite-backend.ts implements every required command
 *   R10 the module graph is acyclic, type-only import edges included
 *   R11 every generated artifact under src/generated is registered with one generator, its
 *       source inputs and a current sha256 (checked through tools/check_generated_artifacts.mjs)
 *   R12 every public component under src/components/** is cross-feature or carries a justified
 *       design-system role; unused components fail
 *   R13 no empty-dependency effect in src/features/** captures changing props/state/callbacks
 *       (useEffectEvent or ref indirection is the documented stable primitive)
 *   R14 no unlicensed any / as any / undocumented as unknown as / String()/Number() fake
 *       validation of fetched response data in src/**
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SyntaxKind,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'typescript/unstable/ast';
import { API, type Project, type Snapshot } from 'typescript/unstable/sync';

const architectureRoot = dirname(fileURLToPath(import.meta.url));
const testsRoot = resolve(architectureRoot, '..');
const webAppRoot = resolve(testsRoot, '..');
const repoRoot = resolve(webAppRoot, '..');
const sourceRoot = join(webAppRoot, 'src');
const fixturesRoot = join(architectureRoot, 'fixtures');
const tsconfigPath = join(webAppRoot, 'tsconfig.json');

let api: API;
let snapshot: Snapshot;
let program: Project['program'];
let programFileNames: Map<string, string>;

beforeAll(() => {
  api = new API({ cwd: webAppRoot });
  snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
  const project = snapshot.getProjects()[0];
  if (!project) throw new Error('[architecture] tsconfig.json produced no project; the R7-R14 gates cannot build the program.');
  program = project.program;
  programFileNames = new Map(program.getSourceFileNames().map((name) => [toPosix(name).toLowerCase(), name]));
}, 120_000);

afterAll(() => {
  snapshot?.dispose();
  api?.close();
});

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

function relativeTo(root: string, absolutePath: string): string {
  return toPosix(relative(root, absolutePath));
}

function isFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(absolutePath));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolutePath);
  }
  return files.sort();
}

/** Parse a file through the real project program; a file outside the program is a gate error. */
function parseFile(absolutePath: string): SourceFile {
  const name = programFileNames.get(toPosix(absolutePath).toLowerCase());
  const sourceFile = name ? program.getSourceFile(name) : undefined;
  if (!sourceFile) throw new Error('[architecture] file is not part of the tsconfig program: ' + relative(webAppRoot, absolutePath));
  return sourceFile;
}

function locationOf(file: string, sourceFile: SourceFile, node: Node): string {
  const position = node.getStart(sourceFile);
  return file + ':' + (sourceFile.getLineAndCharacterOfPosition(position).line + 1);
}

function formatViolations(rule: string, violations: readonly string[]): string[] {
  return violations.map((violation) => '[' + rule + '] ' + violation);
}

function expectNoViolations(rule: string, summary: string, violations: readonly string[]): void {
  expect(formatViolations(rule, violations), rule + ': ' + summary).toEqual([]);
}

type ReferenceKind = 'static' | 're-export' | 'dynamic';

interface RawReference {
  readonly specifier: string;
  readonly kind: ReferenceKind;
  /** True when the whole edge is erased at emit (import type / export type). */
  readonly typeOnly: boolean;
}

interface ModuleReference extends RawReference {
  /** Posix path relative to this graph's source root. */
  readonly from: string;
  readonly external: boolean;
  readonly unresolved: boolean;
  /** Resolved in-source module (posix path relative to the source root). */
  readonly target?: string;
  /** Resolved non-TS asset (posix path relative to the web root). */
  readonly asset?: string;
}

interface ModuleGraph {
  readonly webRoot: string;
  readonly sourceRoot: string;
  /** Every .ts/.tsx file under the source root, posix paths relative to it. */
  readonly files: readonly string[];
  readonly references: readonly ModuleReference[];
}

function collectRawReferences(sourceFile: SourceFile): RawReference[] {
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
        references.push({ specifier: node.moduleSpecifier.text, kind: 're-export', typeOnly: node.isTypeOnly });
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

const PROBE_SUFFIXES: readonly string[] = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveReference(
  webRoot: string,
  sourceRootPath: string,
  from: string,
  specifier: string,
): Pick<ModuleReference, 'external' | 'unresolved' | 'target' | 'asset'> {
  const isAlias = specifier.startsWith('@/');
  if (!specifier.startsWith('.') && !isAlias) return { external: true, unresolved: false };
  const base = isAlias
    ? resolve(sourceRootPath, specifier.slice(2).replace(/[?#].*$/, ''))
    : resolve(dirname(join(sourceRootPath, from)), specifier.replace(/[?#].*$/, ''));
  const found = PROBE_SUFFIXES.map((suffix) => base + suffix).find(isFile);
  if (!found) return { external: false, unresolved: true };
  if (/\.(?:ts|tsx)$/.test(found)) return { external: false, unresolved: false, target: relativeTo(sourceRootPath, found) };
  return { external: false, unresolved: false, asset: relativeTo(webRoot, found) };
}

function buildGraph(webRoot: string): ModuleGraph {
  const graphSourceRoot = join(webRoot, 'src');
  const files = collectSourceFiles(graphSourceRoot).map((file) => relativeTo(graphSourceRoot, file));
  const references: ModuleReference[] = [];
  for (const from of files) {
    const sourceFile = parseFile(join(graphSourceRoot, from));
    for (const raw of collectRawReferences(sourceFile)) {
      references.push({ ...raw, from, ...resolveReference(webRoot, graphSourceRoot, from, raw.specifier) });
    }
  }
  return { webRoot, sourceRoot: graphSourceRoot, files, references };
}

function graphForFixture(name: string): ModuleGraph {
  return buildGraph(join(fixturesRoot, name));
}

function findCycles(graph: ModuleGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const reference of graph.references) {
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

// ---------------------------------------------------------------------------------------------
// R7: generic base modules must not import features/**.
// ---------------------------------------------------------------------------------------------

const GENERIC_BASE_MODULES: readonly string[] = ['api', 'realtime', 'rendering', 'components', 'state', 'contracts', 'runtime', 'lib', 'localization'];
/** Assembly roots are allowed to compose feature pages; they are exempt by design. */
const ASSEMBLY_ROOTS: readonly string[] = ['app/', 'routes/'];

function r7Violations(graph: ModuleGraph): string[] {
  const violations: string[] = [];
  for (const reference of graph.references) {
    if (ASSEMBLY_ROOTS.some((prefix) => reference.from.startsWith(prefix))) continue;
    const module = reference.from.split('/')[0];
    if (!GENERIC_BASE_MODULES.includes(module)) continue;
    if (!reference.target || (!reference.target.startsWith('features/') && !/^(catalog|twin|workbench)\//.test(reference.target))) continue;
    violations.push(
      reference.from + " imports '" + reference.specifier + "' -> " + reference.target +
      ' (' + reference.kind + (reference.typeOnly ? ', type-only' : '') + ')',
    );
  }
  return violations;
}

it('R7: generic base modules never import features/** (assembly roots exempt)', () => {
  const graph = buildGraph(webAppRoot);
  expect(graph.files.length, 'the gate must see the whole src tree').toBeGreaterThan(100);
  expectNoViolations('R7', 'generic base modules must stay feature-agnostic', r7Violations(graph));

  const fixtureGraph = graphForFixture('r7');
  const violations = r7Violations(fixtureGraph);
  expect(formatViolations('R7', violations).some((violation) => violation.includes('api/client.ts')), 'the fixture must prove the rule can fail').toBe(true);
  expect(violations.every((violation) => violation.startsWith('api/client.ts')), 'assembly roots stay exempt').toBe(true);
});

// ---------------------------------------------------------------------------------------------
// R8: domain purity. No ambient clock/random/DOM/timer/network and no top-level side effects.
// Static reference data is allowed, but only from web_app/assets/**.
// ---------------------------------------------------------------------------------------------

function r8Violations(graph: ModuleGraph): string[] {
  const violations: string[] = [];
  for (const file of graph.files) {
    if (!file.startsWith('domain/')) continue;
    const sourceFile = parseFile(join(graph.sourceRoot, file));
    const report = (node: Node, api: string): void => {
      violations.push(locationOf(file, sourceFile, node) + ': ' + api + ' is not allowed in domain/**');
    };
    const visit = (node: Node): void => {
      if (isNewExpression(node) && isIdentifier(node.expression)) {
        if (node.expression.text === 'Date') report(node, 'new Date()');
        else if (node.expression.text === 'XMLHttpRequest') report(node, 'new XMLHttpRequest()');
      } else if (isPropertyAccessExpression(node) && isIdentifier(node.expression)) {
        const owner = node.expression.text;
        if (owner === 'window' || owner === 'document') report(node, owner + '.' + node.name.text + ' (DOM global)');
      } else if (isCallExpression(node)) {
        const callee = node.expression;
        if (isIdentifier(callee) && (callee.text === 'fetch' || callee.text === 'setTimeout' || callee.text === 'setInterval')) {
          report(node, callee.text + '()');
        } else if (isPropertyAccessExpression(callee) && isIdentifier(callee.expression)) {
          const owner = callee.expression.text;
          const member = callee.name.text;
          if (owner === 'Date' && member === 'now') report(node, 'Date.now()');
          else if (owner === 'Math' && member === 'random') report(node, 'Math.random()');
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    for (const statement of sourceFile.statements) {
      // A top-level expression statement is a module side effect unless it is a directive
      // prologue string; domain modules must be pure data/functions only.
      if (isExpressionStatement(statement) && !isStringLiteral(statement.expression)) {
        violations.push(locationOf(file, sourceFile, statement) + ': top-level side-effect call is not allowed in domain/**');
      }
    }
  }
  for (const reference of graph.references) {
    if (!reference.from.startsWith('domain/') || reference.asset === undefined) continue;
    if (!reference.asset.startsWith('assets/')) {
      violations.push(
        reference.from + " imports reference data '" + reference.specifier + "' -> " + reference.asset +
        "; domain reference data must live under web_app/assets/**",
      );
    }
  }
  return violations;
}

it('R8: domain/** is free of ambient clock/random/DOM/timer/network and only uses assets reference data', () => {
  const graph = buildGraph(webAppRoot);
  expect(graph.files.filter((file) => file.startsWith('domain/')).length, 'the gate must cover the domain layer').toBeGreaterThan(10);
  expectNoViolations('R8', 'domain must stay deterministic and framework-free', r8Violations(graph));

  const fixtureGraph = graphForFixture('r8');
  const violations = formatViolations('R8', r8Violations(fixtureGraph));
  for (const expected of [
    'Date.now()',
    'new Date()',
    'Math.random()',
    'setTimeout()',
    'setInterval()',
    'fetch()',
    'document.createElement',
    'window.innerWidth',
    'new XMLHttpRequest()',
    'top-level side-effect call',
    "domain/fab/outside-reference.ts imports reference data '../../../public/reference.json' -> public/reference.json",
  ]) {
    expect(violations.some((violation) => violation.includes(expected)), expected).toBe(true);
  }
  // The allowed static reference-data import is not a violation.
  expect(violations.some((violation) => violation.includes('domain/fab/reference-data.ts'))).toBe(false);
});

// ---------------------------------------------------------------------------------------------
// R9: ScenePort required capabilities. No silent optional product methods; the Lite backend
// implements every required command. The acceptance-only capability group may stay optional.
// ---------------------------------------------------------------------------------------------

interface InterfaceMember {
  readonly name: string;
  readonly optional: boolean;
}

function interfaceMembers(sourceFile: SourceFile, interfaceName: string): InterfaceMember[] | undefined {
  let members: InterfaceMember[] | undefined;
  const visit = (node: Node): void => {
    if (members !== undefined) return;
    if (isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      members = [];
      for (const member of node.members) {
        if (!isPropertySignatureDeclaration(member) && !isMethodSignatureDeclaration(member)) continue;
        if (!member.name || !isIdentifier(member.name)) continue;
        members.push({ name: member.name.text, optional: member.postfixToken?.kind === SyntaxKind.QuestionToken });
      }
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return members;
}

function optionalMemberNames(members: readonly InterfaceMember[]): string[] {
  return members.filter((member) => member.optional).map((member) => member.name).sort();
}

function returnedObjectKeys(sourceFile: SourceFile, functionName: string): string[] | undefined {
  let keys: string[] | undefined;
  const visit = (node: Node): void => {
    if (keys !== undefined) return;
    if (isFunctionDeclaration(node) && node.name && isIdentifier(node.name) && node.name.text === functionName && node.body) {
      for (const statement of node.body.statements) {
        if (!isReturnStatement(statement) || !statement.expression || !isObjectLiteralExpression(statement.expression)) continue;
        const objectLiteral: ObjectLiteralExpression = statement.expression;
        const propertyKeys: string[] = [];
        for (const property of objectLiteral.properties) {
          if (isMethodDeclaration(property) && isIdentifier(property.name)) propertyKeys.push(property.name.text);
          else if (isPropertyAssignment(property) && isIdentifier(property.name)) propertyKeys.push(property.name.text);
          else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) propertyKeys.push(property.name.text);
        }
        keys = propertyKeys;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return keys;
}

it('R9: SceneCommands has no optional members and lite-backend implements every required command', () => {
  const sceneFile = parseFile(join(sourceRoot, 'contracts/scene.port.ts'));
  const commands = interfaceMembers(sceneFile, 'SceneCommands');
  expect(commands, 'SceneCommands must exist in contracts/scene.port.ts').toBeDefined();
  expect(commands!.length, 'the gate must see the whole command surface').toBeGreaterThan(10);
  expect(optionalMemberNames(commands!), 'every product capability must be required').toEqual([]);

  const port = interfaceMembers(sceneFile, 'ScenePort');
  expect(port, 'ScenePort must exist').toBeDefined();
  expect(optionalMemberNames(port!), 'only the acceptance capability group may stay optional').toEqual(['acceptance']);

  const backendFile = parseFile(join(sourceRoot, 'rendering/lite-backend.ts'));
  const implemented = returnedObjectKeys(backendFile, 'createLiteBackend');
  expect(implemented, 'createLiteBackend must return one object literal').toBeDefined();
  const required = [...commands!.map((member) => member.name), 'mount', 'dispose'];
  expect(required.filter((name) => !implemented!.includes(name)), 'missing ScenePort capabilities').toEqual([]);

  // Negative fixtures prove both checks can fail on a regressed port/implementation.
  const optionalFixture = parseFile(join(fixturesRoot, 'r9/optional-command.ts'));
  expect(optionalMemberNames(interfaceMembers(optionalFixture, 'SceneCommands')!)).toEqual(['setView']);

  const capabilityFixture = parseFile(join(fixturesRoot, 'r9/optional-capability.ts'));
  const fixturePortOptional = optionalMemberNames(interfaceMembers(capabilityFixture, 'ScenePort')!);
  expect(fixturePortOptional).toEqual(['acceptance', 'resize']);
  expect(fixturePortOptional.filter((name) => name !== 'acceptance')).toEqual(['resize']);

  const incompleteKeys = returnedObjectKeys(parseFile(join(fixturesRoot, 'r9/incomplete-backend.ts')), 'createLiteBackend')!;
  const missingInFixture = required.filter((name) => !incompleteKeys.includes(name));
  expect(missingInFixture.length, 'the fixture must be detected as incomplete').toBeGreaterThan(0);
  expect(missingInFixture).toContain('setCameraPose');

  const completeKeys = returnedObjectKeys(parseFile(join(fixturesRoot, 'r9/complete-backend.ts')), 'createLiteBackend')!;
  expect(required.filter((name) => !completeKeys.includes(name)), 'the complete fixture must pass').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// R10: every import edge is acyclic, type-only edges included.
// ---------------------------------------------------------------------------------------------

it('R10: the module graph is acyclic, type-only edges included', () => {
  const graph = buildGraph(webAppRoot);
  expect(graph.references.filter((reference) => reference.typeOnly).length, 'the gate must see type-only edges').toBeGreaterThan(0);
  expect(findCycles(graph).map((cycle) => cycle.join(' -> '))).toEqual([]);

  const fixtureCycles = findCycles(graphForFixture('r10')).map((cycle) => cycle.join(' -> '));
  expect(fixtureCycles).toHaveLength(2);
  expect(fixtureCycles.some((cycle) => cycle.includes('a.ts') && cycle.includes('b.ts')), 'value cycle').toBe(true);
  expect(fixtureCycles.some((cycle) => cycle.includes('c.ts') && cycle.includes('d.ts')), 'type-only cycle').toBe(true);
});

// ---------------------------------------------------------------------------------------------
// R11: generated artifacts are registered with one generator, source data and a current checksum.
// ---------------------------------------------------------------------------------------------

const registryPath = join(repoRoot, 'tools/generated-artifacts.json');
const checkerPath = join(repoRoot, 'tools/check_generated_artifacts.mjs');
const generatedDirectory = join(sourceRoot, 'generated');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'semiconfab-architecture-r7r14-'));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
const isGeneratedArtifactName = (name: string): boolean =>
  name.endsWith('.generated.ts') || name.endsWith('.generated.tsx')
  || name.endsWith('-packed.ts') || name.endsWith('-packed.tsx');

interface RegisteredArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly generator: { readonly tool: string; readonly command: string[]; readonly check: string[] };
  readonly sources: readonly { readonly path: string; readonly sha256: string }[];
}
interface ArtifactRegistry {
  schemaVersion: number;
  artifacts: RegisteredArtifact[];
}

const readArtifactRegistry = (): ArtifactRegistry => JSON.parse(readFileSync(registryPath, 'utf8')) as ArtifactRegistry;
const cloneArtifactRegistry = (registry: ArtifactRegistry): ArtifactRegistry =>
  JSON.parse(JSON.stringify(registry)) as ArtifactRegistry;
const runArtifactChecker = (arguments_: readonly string[]) =>
  spawnSync(process.execPath, [checkerPath, ...arguments_], { cwd: repoRoot, encoding: 'utf8' });

it('R11: generated artifacts are registered with one generator, source data and a current checksum', () => {
  const checkerRun = runArtifactChecker(['--check']);
  expect(checkerRun.status, checkerRun.stderr).toBe(0);

  const registry = readArtifactRegistry();
  expect(registry.schemaVersion).toBe(1);
  const registered = registry.artifacts.map((artifact) => artifact.path).sort();
  const discovered = readdirSync(generatedDirectory)
    .filter(isGeneratedArtifactName)
    .map((name) => 'web_app/src/generated/' + name)
    .sort();
  expect(registered).toEqual(discovered);
  for (const artifact of registry.artifacts) {
    expect(sha256(readFileSync(join(repoRoot, artifact.path))), artifact.path + ': checksum').toBe(artifact.sha256);
    expect(artifact.generator.command.filter((item) => item.endsWith(artifact.generator.tool)), artifact.path + ': unique generator').toHaveLength(1);
    expect(artifact.generator.check).toContain('--check');
    expect(artifact.sources.length, artifact.path + ': source data').toBeGreaterThan(0);
    for (const source of artifact.sources) {
      expect(sha256(readFileSync(join(repoRoot, source.path))), source.path + ': source checksum').toBe(source.sha256);
    }
  }
});

it('R11: an unregistered generated file and a deleted registered file both fail the checker', () => {
  const registry = readArtifactRegistry();

  const unregistered = cloneArtifactRegistry(registry);
  unregistered.artifacts = unregistered.artifacts.filter((artifact) => !artifact.path.endsWith('static-structure-packed.generated.ts'));
  const unregisteredPath = join(temporaryDirectory, 'unregistered-registry.json');
  writeFileSync(unregisteredPath, JSON.stringify(unregistered, null, 2) + '\n');
  const unregisteredRun = runArtifactChecker(['--check', '--registry', unregisteredPath]);
  expect(unregisteredRun.status).toBe(1);
  expect(unregisteredRun.stderr).toContain('static-structure-packed.generated.ts is a generated artifact but is not registered');

  const deleted = cloneArtifactRegistry(registry);
  deleted.artifacts = [...deleted.artifacts, { ...registry.artifacts[0], path: 'web_app/src/generated/removed.generated.ts' }];
  const deletedPath = join(temporaryDirectory, 'deleted-registry.json');
  writeFileSync(deletedPath, JSON.stringify(deleted, null, 2) + '\n');
  const deletedRun = runArtifactChecker(['--check', '--registry', deletedPath]);
  expect(deletedRun.status).toBe(1);
  expect(deletedRun.stderr).toContain('removed.generated.ts is registered but missing');
});

// ---------------------------------------------------------------------------------------------
// R12: public components need verified cross-feature usage or a justified design-system role.
// ---------------------------------------------------------------------------------------------

/**
 * Public components need a verifiable owner, not merely a cross-feature count.
 * Plan R12 explicitly allows application-level ownership by responsibility:
 * - design-system: a primitive any layer may compose (must still have an importer);
 * - frozen-asset: a versioned original data inventory whose provenance is owned globally;
 * - app-infrastructure: application-shell plumbing (e.g. ErrorBoundary) that must be
 *   genuinely composed by app/** or main.tsx - that claim is verified against the
 *   import graph instead of being trusted as a string.
 * A component claimed by exactly one feature without a role is a violation: move it
 * into that feature. Feature-local widgets are therefore not allowed to squat here.
 */
interface ComponentRole {
  readonly file: string;
  readonly kind: 'design-system' | 'frozen-asset' | 'app-infrastructure';
  readonly role: string;
}

/** Explicit component roles (plan R12 allows a provable role instead of 2 features). */
const COMPONENT_DESIGN_SYSTEM_ALLOWLIST: readonly ComponentRole[] = [
  { file: 'components/error-boundary.tsx', kind: 'app-infrastructure', role: 'application-shell fatal error boundary composed by app/ and routes/root.route' },
  { file: 'components/original-icons-data.ts', kind: 'frozen-asset', role: 'frozen original SVG data table, internal to original-icons.tsx; provenance docs/attribution.md' },
  { file: 'components/original-icons.tsx', kind: 'frozen-asset', role: 'single global frozen original icon source consumed by the Twin feature' },
];

function r12Violations(graph: ModuleGraph, allowlist: readonly ComponentRole[]): string[] {
  const components = graph.files.filter((file) => file.startsWith('components/'));
  const importers = new Map<string, Set<string>>(components.map((component) => [component, new Set<string>()]));
  for (const reference of graph.references) {
    if (!reference.target || !importers.has(reference.target) || reference.target === reference.from) continue;
    const owner = reference.from.startsWith('features/')
      ? reference.from.split('/').slice(0, 2).join('/')
      : reference.from.split('/')[0];
    importers.get(reference.target)!.add(owner);
  }
  const violations: string[] = [];
  for (const component of components) {
    const users = [...importers.get(component)!].sort();
    const featureOwners = users.filter((user) => user.startsWith('features/') || /^(catalog|twin|workbench)$/.test(user));
    const appOwners = users.filter((user) => user === 'main.tsx' || user.startsWith('app') || user.startsWith('routes'));
    const role = allowlist.find((entry) => entry.file === component);
    if (users.length === 0) {
      violations.push(component + ' is a public component with no importer (dead shared UI)' + (role ? '; allowlist role: ' + role.role : ''));
      continue;
    }
    if (featureOwners.length >= 2) continue;
    if (role?.kind === 'app-infrastructure') {
      // App-level ownership is a claim about the import graph, not an assertion string.
      if (appOwners.length === 0) {
        violations.push(
          component + ' is declared app-infrastructure but no app/** or main.tsx owner imports it (importers: [' + users.join(', ') + '])',
        );
      }
      continue;
    }
    if (role) continue;
    violations.push(
      component + ' is only used by [' + featureOwners.join(', ') + ']; move it into that feature or record a verified component role',
    );
  }
  return violations;
}

it('R12: public components are cross-feature or carry a justified design-system role', () => {
  const graph = buildGraph(webAppRoot);
  expect(graph.files.filter((file) => file.startsWith('components/')).length, 'the gate must see src/components').toBeGreaterThan(0);
  expectNoViolations('R12', 'shared components need a verifiable role', r12Violations(graph, COMPONENT_DESIGN_SYSTEM_ALLOWLIST));
  // modal is the cross-feature reference implementation: it must not need an allowlist entry.
  expect(COMPONENT_DESIGN_SYSTEM_ALLOWLIST.some((entry) => entry.file === 'components/modal.tsx')).toBe(false);

  const fixtureGraph = graphForFixture('r12');
  const fixtureViolations = r12Violations(fixtureGraph, []);
  expect(fixtureViolations.some((violation) => violation.includes('components/UnusedWidget.tsx') && violation.includes('no importer'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('components/FeatureWidget.tsx') && violation.includes('features/alpha'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('components/SharedWidget.tsx')), 'two features pass').toBe(false);

  // An explicit design-system/frozen role is justified by its recorded ownership reason.
  for (const kind of ['design-system', 'frozen-asset'] as const) {
    const allowlisted = r12Violations(fixtureGraph, [{ file: 'components/FeatureWidget.tsx', kind, role: 'fixture role' }]);
    expect(allowlisted.some((violation) => violation.includes('components/FeatureWidget.tsx')), kind).toBe(false);
  }
  // App-infrastructure ownership is verified: a string claim without an app/owner import fails.
  const appClaim = r12Violations(fixtureGraph, [{ file: 'components/FeatureWidget.tsx', kind: 'app-infrastructure', role: 'fixture app role' }]);
  expect(appClaim.some((violation) => violation.includes('components/FeatureWidget.tsx') && violation.includes('app-infrastructure'))).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// R13: empty-dependency effects must not capture changing props/state/callbacks.
// Stable primitives are useEffectEvent and ref indirection; the negative fixture proves the
// heuristic flags a first-render closure.
// ---------------------------------------------------------------------------------------------

interface FunctionLikeNode extends Node {
  readonly parameters: readonly Node[];
  readonly body?: Node;
}

function isFunctionLikeNode(node: Node): node is FunctionLikeNode {
  return isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node);
}

function enclosingFunction(node: Node): FunctionLikeNode | undefined {
  let current: Node = node.parent;
  while (current && current.kind !== SyntaxKind.SourceFile) {
    if (isFunctionLikeNode(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function addBindingName(name: Node, names: Set<string>): void {
  if (isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  if (isArrayBindingPattern(name) || isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (isBindingElement(element) && element.name) addBindingName(element.name, names);
    }
  }
}

/** Names recreated or replaced between renders in the hook/component scope. */
function collectChangingNames(owner: FunctionLikeNode): Set<string> {
  const changing = new Set<string>();
  for (const parameter of owner.parameters) {
    const named = parameter as Node & { readonly name?: Node };
    if (named.name) addBindingName(named.name, changing);
  }
  const visit = (node: Node): void => {
    if (isFunctionDeclaration(node)) {
      if (node.name && isIdentifier(node.name)) changing.add(node.name.text);
      return;
    }
    if (isFunctionExpression(node) || isArrowFunction(node) || isMethodDeclaration(node)) return;
    if (isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        const calleeName = initializer && isCallExpression(initializer) && isIdentifier(initializer.expression)
          ? initializer.expression.text
          : undefined;
        // Stable primitives: refs and effect events are the documented indirection.
        if (calleeName === 'useRef' || calleeName === 'useEffectEvent') continue;
        if ((calleeName === 'useState' || calleeName === 'useReducer') && isArrayBindingPattern(declaration.name)) {
          const value = declaration.name.elements[0];
          if (value && isBindingElement(value) && value.name) addBindingName(value.name, changing);
          continue;
        }
        addBindingName(declaration.name, changing);
      }
      return;
    }
    node.forEachChild(visit);
  };
  if (owner.body) visit(owner.body);
  return changing;
}

/** Names declared inside the effect callback itself (they shadow the enclosing scope). */
function collectDeclaredNames(node: Node, names: Set<string>): void {
  if (isVariableDeclaration(node)) {
    addBindingName(node.name, names);
    return;
  }
  if (isFunctionDeclaration(node)) {
    if (node.name && isIdentifier(node.name)) names.add(node.name.text);
    return;
  }
  if (isFunctionExpression(node) || isArrowFunction(node)) {
    for (const parameter of node.parameters) addBindingName(parameter.name, names);
    if (node.body) collectDeclaredNames(node.body, names);
    return;
  }
  node.forEachChild((child) => collectDeclaredNames(child, names));
}

/** Read references in the callback, skipping property names and declaration names. */
function walkReadReferences(node: Node, visit: (identifier: Node) => void): void {
  if (isPropertyAccessExpression(node)) {
    walkReadReferences(node.expression, visit);
    return;
  }
  if (isPropertyAssignment(node)) {
    walkReadReferences(node.initializer, visit);
    return;
  }
  if (isShorthandPropertyAssignment(node)) {
    visit(node.name);
    return;
  }
  if (isVariableDeclaration(node)) {
    if (node.initializer) walkReadReferences(node.initializer, visit);
    return;
  }
  if (isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node)) {
    for (const parameter of node.parameters) if (parameter.initializer) walkReadReferences(parameter.initializer, visit);
    if (node.body) walkReadReferences(node.body, visit);
    return;
  }
  if (isMethodDeclaration(node)) {
    if (node.body) walkReadReferences(node.body, visit);
    return;
  }
  if (isImportDeclaration(node)) return;
  if (isIdentifier(node)) {
    visit(node);
    return;
  }
  node.forEachChild((child) => walkReadReferences(child, visit));
}

interface EffectAllowlistEntry {
  readonly file: string;
  readonly snippet: string;
  readonly reason: string;
}

/**
 * R13 has no standing exceptions. The insertion point is kept deliberately explicit:
 * a future exception must be documented here with a provable stable-primitive argument
 * and the test below pins the list to be empty so it cannot grow silently.
 */
const R13_ALLOWLIST: readonly EffectAllowlistEntry[] = [];

function r13Violations(root: string, files: readonly string[], allowlist: readonly EffectAllowlistEntry[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const sourceFile = parseFile(join(root, file));
    const lineAt = (position: number): string => {
      const text = sourceFile.text;
      const start = text.lastIndexOf('\n', position) + 1;
      const end = text.indexOf('\n', position);
      return text.slice(start, end === -1 ? text.length : end).replace(/\s+/g, ' ').trim();
    };
    const visit = (node: Node): void => {
      if (isCallExpression(node) && isIdentifier(node.expression)
        && (node.expression.text === 'useEffect' || node.expression.text === 'useLayoutEffect')) {
        const callback = node.arguments[0];
        const dependencies = node.arguments[1];
        if (callback && dependencies && isArrayLiteralExpression(dependencies) && dependencies.elements.length === 0
          && (isArrowFunction(callback) || isFunctionExpression(callback))) {
          const owner = enclosingFunction(node);
          if (owner) {
            const changing = collectChangingNames(owner);
            const local = new Set<string>();
            collectDeclaredNames(callback, local);
            const captured = new Set<string>();
            walkReadReferences(callback, (identifier) => {
              if (isIdentifier(identifier) && changing.has(identifier.text) && !local.has(identifier.text)) captured.add(identifier.text);
            });
            const effectLine = lineAt(node.getStart(sourceFile));
            const documented = allowlist.some((entry) => entry.file === file && effectLine.includes(entry.snippet));
            if (captured.size > 0 && !documented) {
              violations.push(
                locationOf(file, sourceFile, node) + ': empty-dependency ' + node.expression.text +
                ' captures changing values [' + [...captured].sort().join(', ') + ']; use useEffectEvent or ref indirection',
              );
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return violations;
}

it('R13: no empty-dependency effect captures changing props/state/callbacks', () => {
  const graph = buildGraph(webAppRoot);
  // The mechanism supports documented exceptions, but the real tree must need none:
  // the Tour controller now has a stable stop identity with explicit dependencies.
  expect(R13_ALLOWLIST, 'R13 exceptions must stay empty until a proven stable-primitive case appears').toEqual([]);
  expectNoViolations('R13', 'empty-dependency effects must use useEffectEvent or refs', r13Violations(sourceRoot, graph.files.filter((file) => /^(catalog|twin|workbench)\//.test(file)), R13_ALLOWLIST));

  const fixtureRoot = join(fixturesRoot, 'r13');
  const unstableViolations = formatViolations('R13', r13Violations(fixtureRoot, ['unstable-effect.tsx'], []));
  expect(unstableViolations, 'an empty-dep effect capturing changing values must fail').toHaveLength(1);
  for (const captured of ['label', 'onReport', 'count']) expect(unstableViolations[0], captured).toContain(captured);
  expect(
    formatViolations('R13', r13Violations(fixtureRoot, ['stable-effect.tsx'], [])),
    'useEffectEvent + ref indirection are the documented stable primitive',
  ).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// R14: no unlicensed any / as any / undocumented as unknown as / String()/Number() fake
// validation of fetched data. Every pre-existing allowed site is registered with a reason.
// ---------------------------------------------------------------------------------------------

interface AllowlistEntry {
  readonly file: string;
  readonly snippet: string;
  readonly reason: string;
}

const R14_ALLOWLIST: readonly AllowlistEntry[] = [
  // Documented pre-existing as-unknown-as sites (each cast is the narrowest possible boundary).
  { file: 'state/create-slice-store.ts', snippet: 'actions as unknown as SliceActions<M>', reason: 'typed action factory: reducers are stored behind a never[] rest contract, SliceActions<M> is the only typed surface.' },
  { file: 'realtime/telemetry.worker.ts', snippet: 'globalThis as unknown as WorkerScope', reason: 'worker entry: the app tsconfig has no DedicatedWorkerGlobalScope; WorkerScope is the locally declared structural contract.' },
  { file: 'rendering/lite-backend.ts', snippet: 'undefined as unknown as LiteRuntime', reason: 'single-assignment self reference needed by the runtime disposer callback; assigned before any use.' },
  { file: 'realtime/command-event-source.transport.ts', snippet: 'new EventSource(target) as unknown as EventSourceLike', reason: 'injectable EventSource seam: the browser class is structurally compatible with the EventSourceLike test contract.' },
  { file: 'realtime/telemetry-runtime.ts', snippet: 'payload as unknown as ArrayLike<number>', reason: 'ArrayBuffer.isView guard proves a numeric view; ArrayLike is the shared denotation for Float32Array.from.' },
  { file: 'realtime/telemetry-runtime.ts', snippet: 'new EventSource(target) as unknown as EventSourceLike', reason: 'injectable EventSource seam (same contract as the command transport).' },
  { file: 'realtime/telemetry-runtime.ts', snippet: 'createTelemetryWorker() as unknown as WorkerLike', reason: 'injectable Worker seam: the worker class is structurally compatible with the WorkerLike test contract.' },
  { file: 'domain/original-twin-data.ts', snippet: 'reference as unknown as OriginalTwinUi', reason: 'frozen reference JSON is checked by tools/check_frozen_assets.mjs in scripts/verify.ps1; this cast crosses only that build-validated static boundary.' },
  { file: 'api/catalog.resource.ts', snippet: 'envelope as unknown as CatalogPageDto', reason: 'zod validates the transport envelope; items are defensively parsed by catalog-data.parseCatalogEntries.' },
  { file: 'rendering/lite-geometry-static-structure.ts', snippet: 'context as unknown as Record<string, unknown>', reason: 'replays the frozen Canvas2D recipe data onto the context; typed access is not available for dynamic operations.' },
  { file: 'rendering/lite-geometry-static-structure.ts', snippet: 'matrices as unknown as Mat4', reason: 'a 16-float Float32Array is passed to decomposeMat4, whose public signature takes the Mat4 tuple.' },
  { file: 'twin/twin-elevation.tsx', snippet: 'source as unknown as Record<string,SvgNode>', reason: 'frozen elevation SVG JSON: properties() whitelists the attributes; the recursive SvgNode shape documents the data.' },
  // Pre-existing response/worker boundary coercions (guarded before use).
  { file: 'realtime/telemetry.worker.ts', snippet: 'Number(data.frameSize)', reason: 'Number.isInteger guard proves an integer frameSize before the bounded conversion.' },
  { file: 'realtime/command-event-source.transport.ts', snippet: 'Number(rawSequence)', reason: 'the /^\d+$/ guard precedes the conversion and Number.isSafeInteger validates the range on the next line.' },
  { file: 'realtime/equipment-status.transport.ts', snippet: 'String(event.data)', reason: 'EventSource.data is already the protocol string; decodeEquipmentStatusFrame parses and validates it.' },
];

function hasJustificationComment(text: string, node: Node, sourceFile: SourceFile): boolean {
  const nodeEnd = node.getEnd();
  const lineEndRaw = text.indexOf('\n', nodeEnd);
  const trailing = text.slice(nodeEnd, lineEndRaw === -1 ? text.length : lineEndRaw);
  if (trailing.includes('//')) return true;
  const lines = text.split('\n');
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line - 1;
  if (line < 0) return false;
  const value = lines[line].trim();
  // The justification comment must be directly attached (no blank line break).
  return value.startsWith('//') || value.startsWith('/*') || value.startsWith('*');
}

function r14Violations(root: string, files: readonly string[], allowlist: readonly AllowlistEntry[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const sourceFile = parseFile(join(root, file));
    const text = sourceFile.text;
    const lineAt = (position: number): string => {
      const start = text.lastIndexOf('\n', position) + 1;
      const end = text.indexOf('\n', position);
      return text.slice(start, end === -1 ? text.length : end).replace(/\s+/g, ' ').trim();
    };
    const allowed = (node: Node): boolean => {
      const line = lineAt(node.getStart(sourceFile));
      return allowlist.some((entry) => entry.file === file && line.includes(entry.snippet));
    };
    const report = (anchor: Node, description: string): void => {
      if (allowed(anchor)) return;
      violations.push(locationOf(file, sourceFile, anchor) + ': ' + description);
    };
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.AnyKeyword) report(node, 'unlicensed any type; add a typed contract or an allowlist entry with justification');
      if (isAsExpression(node)) {
        // Anchor cast reports on the asserted type node so the line is the 'as' clause, not
        // the (possibly multi-line) expression that precedes it.
        if (node.type.kind === SyntaxKind.AnyKeyword) report(node.type, 'unchecked as any cast; add a typed contract or an allowlist entry with justification');
        const inner = node.expression;
        if (isAsExpression(inner) && inner.type.kind === SyntaxKind.UnknownKeyword && !hasJustificationComment(text, node, sourceFile)) {
          report(node.type, 'undocumented as unknown as cast; add a justification comment or an allowlist entry');
        }
      }
      if ((file.startsWith('api/') || file.startsWith('realtime/')) && isCallExpression(node) && isIdentifier(node.expression)
        && (node.expression.text === 'String' || node.expression.text === 'Number')) {
        report(node, 'String()/Number() fake validation of response data; validate the response schema instead');
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return violations;
}

it('R14: no unlicensed any / as any / undocumented as unknown as / fake response coercion', () => {
  const graph = buildGraph(webAppRoot);
  expectNoViolations('R14', 'unchecked types need a typed contract or a documented allowlist entry', r14Violations(sourceRoot, graph.files, R14_ALLOWLIST));

  const fixtureRoot = join(fixturesRoot, 'r14');
  const fixtureSourceRoot = join(fixtureRoot, 'src');
  const fixtureFiles = collectSourceFiles(fixtureSourceRoot).map((file) => relativeTo(fixtureSourceRoot, file));
  const fixtureViolations = formatViolations('R14', r14Violations(fixtureSourceRoot, fixtureFiles, []));
  expect(fixtureViolations.some((violation) => violation.includes('any-usage.ts') && violation.includes('unlicensed any type'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('as-any.ts') && violation.includes('unchecked as any cast'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('undocumented-cast.ts') && violation.includes('undocumented as unknown as cast'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('api/coercion.ts') && violation.includes('fake validation'))).toBe(true);
  expect(fixtureViolations.some((violation) => violation.includes('] documented-cast.ts')), 'documented casts are allowed').toBe(false);
});

