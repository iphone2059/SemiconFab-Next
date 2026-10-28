#!/usr/bin/env node
/**
 * Generated-artifact provenance checker (plan section 8 "Generated", R11 groundwork).
 *
 * tools/generated-artifacts.json is the single machine-readable registry of every committed
 * generated file: the generator command that writes it, the tracked source inputs it is
 * derived from, the committed output path and the sha256 of both inputs and output. Generated
 * files must never be hand-edited; this CLI proves the committed bytes are the ones the
 * recorded inputs and generator produce.
 *
 * Checks performed by --check:
 *   1. registry shape (schemaVersion 1, non-empty artifacts with path/generator/sources/sha256);
 *   2. every registered output exists and matches its recorded sha256 (stale output);
 *   3. every source input exists and matches its recorded sha256 (stale input recording);
 *   4. every generator/check argv invokes the declared tool and every check passes --check;
 *   5. every generated file under web_app/src/generated is registered exactly once (R11).
 *
 * Usage (from the repository root):
 *   node tools/check_generated_artifacts.mjs --check    exit 1 when the registry or an artifact is stale
 *   node tools/check_generated_artifacts.mjs --update   re-record source/output sha256 (then re-check)
 *   node tools/check_generated_artifacts.mjs --check --registry <path>   check another registry (tests)
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_REGISTRY = join(ROOT, 'tools', 'generated-artifacts.json');
const GENERATED_DIR = join(ROOT, 'web_app', 'src', 'generated');
/** Same discovery rule as R5 in web_app/tests/architecture/architecture-import-graph.test.ts. */
const GENERATED_FILE_PATTERN = /(?:\.generated\.tsx?|-packed\.tsx?)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const USAGE = 'usage: node tools/check_generated_artifacts.mjs [--check|--update] [--registry <path>]';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toPosix = (value) => value.split(String.fromCharCode(92)).join('/');
const displayPath = (absolute) => toPosix(relative(ROOT, absolute));

function fail(message) {
  throw new Error('generated-artifacts: ' + message);
}

function parseArguments(argv) {
  const options = { mode: 'check', registry: DEFAULT_REGISTRY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check' || argument === '--update') {
      const mode = argument === '--check' ? 'check' : 'update';
      if (options.mode !== 'check' && options.mode !== mode) fail('cannot combine --check and --update');
      options.mode = mode;
    } else if (argument === '--registry') {
      const value = argv[index + 1];
      if (value === undefined || value === '') fail('--registry requires a path');
      options.registry = resolve(process.cwd(), value);
      index += 1;
    } else {
      fail('unknown argument ' + JSON.stringify(argument) + '\n' + USAGE);
    }
  }
  return options;
}

function readRegistry(registryPath) {
  if (!existsSync(registryPath)) fail('registry is missing: ' + registryPath);
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    fail('registry is not valid JSON (' + registryPath + '): ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) fail('registry root must be a JSON object');
  return registry;
}

function hashFile(absolutePath, label) {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) fail('file is missing: ' + label);
  return sha256(readFileSync(absolutePath));
}

/** Recompute every recorded sha256 from the files on disk. */
function refreshHashes(registry) {
  if (!Array.isArray(registry.artifacts)) fail('registry.artifacts must be an array before --update');
  for (const artifact of registry.artifacts) {
    if (!artifact || typeof artifact.path !== 'string') fail('every artifact needs a path before --update');
    artifact.sha256 = hashFile(resolve(ROOT, artifact.path), artifact.path);
    if (!Array.isArray(artifact.sources)) fail(artifact.path + ' needs a sources array before --update');
    for (const source of artifact.sources) {
      if (!source || typeof source.path !== 'string') fail(artifact.path + ' has a source without a path');
      source.sha256 = hashFile(resolve(ROOT, source.path), source.path);
    }
  }
}

function commandText(artifact) {
  const argv = artifact?.generator?.command;
  return Array.isArray(argv) ? argv.join(' ') : 'the recorded generator command';
}

function isSafeRelativePath(value) {
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) return false;
  return true;
}

/** Every problem that makes the committed generated tree not provably reproducible. */
function collectProblems(registry) {
  const problems = [];
  if (registry.schemaVersion !== 1) problems.push('schemaVersion must be 1, found ' + JSON.stringify(registry.schemaVersion));
  const artifacts = registry.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    problems.push('registry.artifacts must be a non-empty array');
    return problems;
  }
  const registered = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const label = 'artifacts[' + index + ']';
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      problems.push(label + ' must be an object');
      continue;
    }
    if (typeof artifact.path !== 'string' || !isSafeRelativePath(artifact.path)) {
      problems.push(label + '.path must be a repo-relative posix path');
      continue;
    }
    if (registered.has(artifact.path)) problems.push('duplicate artifact registration: ' + artifact.path);
    registered.add(artifact.path);

    const outputAbsolute = resolve(ROOT, artifact.path);
    if (!existsSync(outputAbsolute) || !statSync(outputAbsolute).isFile()) {
      problems.push(artifact.path + ' is registered but missing');
    } else if (!SHA256_PATTERN.test(String(artifact.sha256))) {
      problems.push(artifact.path + ' has an invalid sha256 entry');
    } else {
      const actual = sha256(readFileSync(outputAbsolute));
      if (actual !== artifact.sha256) {
        problems.push(
          artifact.path + ' is stale: committed sha256 ' + actual + ' != registry ' + artifact.sha256 +
          '; regenerate with "' + commandText(artifact) + '" then run: node tools/check_generated_artifacts.mjs --update',
        );
      }
    }

    const generator = artifact.generator;
    if (!generator || typeof generator !== 'object' || Array.isArray(generator)) {
      problems.push(artifact.path + '.generator must describe tool/command/check');
    } else {
      if (typeof generator.tool !== 'string' || !existsSync(resolve(ROOT, generator.tool))) {
        problems.push(artifact.path + '.generator.tool must name an existing script (' + String(generator.tool) + ')');
      }
      for (const key of ['command', 'check']) {
        const argv = generator[key];
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === 'string' && item.length > 0)) {
          problems.push(artifact.path + '.generator.' + key + ' must be a non-empty argv array');
        } else if (!argv.includes(generator.tool)) {
          problems.push(artifact.path + '.generator.' + key + ' must invoke ' + generator.tool);
        }
      }
      if (Array.isArray(generator.check) && !generator.check.includes('--check')) {
        problems.push(artifact.path + '.generator.check must pass --check');
      }
    }

    if (!Array.isArray(artifact.sources) || artifact.sources.length === 0) {
      problems.push(artifact.path + '.sources must be a non-empty array of tracked inputs');
      continue;
    }
    for (const [sourceIndex, source] of artifact.sources.entries()) {
      const sourceLabel = artifact.path + '.sources[' + sourceIndex + ']';
      if (!source || typeof source !== 'object' || typeof source.path !== 'string' || !isSafeRelativePath(source.path)) {
        problems.push(sourceLabel + ' must be an object with a repo-relative path');
        continue;
      }
      if (!SHA256_PATTERN.test(String(source.sha256))) {
        problems.push(sourceLabel + ' has an invalid sha256 entry');
        continue;
      }
      const sourceAbsolute = resolve(ROOT, source.path);
      if (!existsSync(sourceAbsolute) || !statSync(sourceAbsolute).isFile()) {
        problems.push(sourceLabel + ' source is missing: ' + source.path);
        continue;
      }
      const actual = sha256(readFileSync(sourceAbsolute));
      if (actual !== source.sha256) {
        problems.push(
          sourceLabel + ' input is stale: sha256 ' + actual + ' != registry ' + source.sha256 +
          '; regenerate the artifact then run: node tools/check_generated_artifacts.mjs --update',
        );
      }
    }
  }

  const discovered = existsSync(GENERATED_DIR)
    ? readdirSync(GENERATED_DIR)
      .filter((name) => GENERATED_FILE_PATTERN.test(name))
      .map((name) => toPosix(relative(ROOT, join(GENERATED_DIR, name))))
      .sort()
    : [];
  for (const file of discovered) {
    if (!registered.has(file)) problems.push(file + ' is a generated artifact but is not registered in tools/generated-artifacts.json');
  }
  for (const file of registered) {
    if (!discovered.includes(file)) problems.push(file + ' is registered but is not a discovered generated artifact under web_app/src/generated/');
  }
  return problems;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const registry = readRegistry(options.registry);
  const registryLabel = displayPath(options.registry);
  if (options.mode === 'update') {
    refreshHashes(registry);
    writeFileSync(options.registry, JSON.stringify(registry, null, 2) + '\n');
    console.log('Updated ' + registryLabel + ': ' + registry.artifacts.length + ' generated artifact(s) re-hashed from disk.');
  }
  const problems = collectProblems(registry);
  if (problems.length > 0) {
    for (const problem of problems) console.error('[generated-artifacts] ' + problem);
    process.exitCode = 1;
    return;
  }
  console.log(
    'PASS: ' + registry.artifacts.length + ' generated artifact(s) registered in ' + registryLabel +
    '; generator commands, source inputs and output sha256 all match the committed tree.',
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
