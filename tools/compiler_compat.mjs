#!/usr/bin/env node
/**
 * CORE-011 / G15: executable Oxc peer-compatibility gate.
 *
 * No published @vitejs/plugin-react release declares compatibility with the
 * locked oxc-transform-react@0.156.0, so the repository maintains an explicit
 * compatibility patch (pnpm patchedDependencies + declared range) instead of a
 * peerDependencyRules bypass. This gate proves the patch is still in effect and
 * that the exact API the plugin consumes really works on the locked Oxc release.
 *
 * Usage: node tools/compiler_compat.mjs [--out <json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const webApp = path.join(root, 'web_app');
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outPath = arg('out', undefined);
const checks = [];
const failure = (error) => (error instanceof Error ? error.message : String(error));
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail: detail ?? '' });
  if (ok) console.log('PASS ' + name + (detail ? ': ' + detail : ''));
  else console.error('FAIL ' + name + ': ' + detail);
};
const check = (name, run) => {
  try { record(name, true, run()); } catch (error) { record(name, false, failure(error)); }
};
const checkAsync = async (name, run) => {
  try { record(name, true, await run()); } catch (error) { record(name, false, failure(error)); }
};
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const packageJson = json(path.join(webApp, 'package.json'));
const lockfile = read(path.join(webApp, 'pnpm-lock.yaml'));
const workspace = read(path.join(webApp, 'pnpm-workspace.yaml'));
const pluginPackage = json(path.join(webApp, 'node_modules/@vitejs/plugin-react/package.json'));
const oxcPackage = json(path.join(webApp, 'node_modules/oxc-transform-react/package.json'));
const pluginDist = read(path.join(webApp, 'node_modules/@vitejs/plugin-react/dist/index.js'));
const patchFile = path.join(webApp, 'patches/@vitejs__plugin-react@6.1.2.patch');
const viteConfig = read(path.join(webApp, 'vite.config.ts'));

check('locks one exact oxc-transform-react version', () => {
  expect(packageJson.devDependencies?.['oxc-transform-react'] === '0.156.0', 'package.json must pin oxc-transform-react 0.156.0');
  expect(oxcPackage.version === '0.156.0', 'installed oxc-transform-react is ' + oxcPackage.version);
  expect(lockfile.includes('  oxc-transform-react@0.156.0:'), 'lockfile must resolve oxc-transform-react@0.156.0');
  return '0.156.0';
});

check('has no peerDependencyRules.allowedVersions bypass', () => {
  const configLines = workspace.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  expect(!configLines.some((line) => /^\s*peerDependencyRules:/.test(line)), 'pnpm-workspace.yaml must not declare peerDependencyRules');
  expect(!configLines.some((line) => /^\s*allowedVersions:/.test(line)), 'pnpm-workspace.yaml must not declare allowedVersions');
  return 'no bypass rule';
});

check('keeps the maintained plugin-react compatibility patch in effect', () => {
  expect(/patchedDependencies:\s*\n\s+'@vitejs\/plugin-react@6\.1\.2':/.test(workspace), 'workspace must declare patchedDependencies for @vitejs/plugin-react@6.1.2');
  expect(lockfile.includes('patchedDependencies:'), 'lockfile must record patchedDependencies');
  expect(fs.existsSync(patchFile), 'patch file missing: ' + patchFile);
  const patch = read(patchFile);
  expect(patch.includes('-    "oxc-transform-react": "^0.152.0",'), 'patch must replace the upstream peer range');
  expect(patch.includes('+    "oxc-transform-react": ">=0.152.0 <0.157.0",'), 'patch must widen to the verified range');
  const peers = pluginPackage.peerDependencies ?? {};
  expect(peers['oxc-transform-react'] === '>=0.152.0 <0.157.0', 'installed plugin peer range is ' + peers['oxc-transform-react']);
  // The lockfile keeps the upstream registry metadata, so the deviation stays auditable.
  expect(lockfile.includes('      oxc-transform-react: ^0.152.0'), 'lockfile must retain the upstream peer range for audit');
  return 'patched >=0.152.0 <0.157.0 (upstream ^0.152.0)';
});

check('plugin-react consumes only the locked Oxc API surface', () => {
  expect(pluginDist.includes('import("oxc-transform-react")'), 'plugin must load oxc-transform-react');
  expect(pluginDist.includes('{ transform }'), 'plugin must consume transform()');
  expect(pluginDist.includes('await transform('), 'plugin must await transform()');
  for (const token of ['result.fatal', 'result.errors', 'result.code', 'reactCompiler', 'compilationMode', 'sourcemap']) {
    expect(pluginDist.includes(token), 'plugin dist must use ' + token);
  }
  // The optional Babel preset helper mentions the package name via import.meta.resolve;
  // the compiler plugin path itself must load only the Oxc package.
  expect(!pluginDist.includes('import("babel-plugin-react-compiler")'), 'plugin must not load a Babel compiler');
  expect(!pluginDist.includes("await import('babel-plugin-react-compiler')"), 'plugin must not import a Babel compiler dynamically');
  return 'transform/reactCompiler/result.fatal';
});

check('installed dependency tree has no Babel compiler fallback', () => {
  for (const forbidden of ['babel-plugin-react-compiler', '@rolldown/plugin-babel', '@babel/core']) {
    expect(!fs.existsSync(path.join(webApp, 'node_modules', forbidden)), forbidden + ' must not be installed');
    expect(packageJson.dependencies?.[forbidden] === undefined && packageJson.devDependencies?.[forbidden] === undefined, forbidden + ' must not be declared');
  }
  for (const forbidden of ['babel-plugin-react-compiler', '@rolldown/plugin-babel']) {
    expect(!viteConfig.includes(forbidden), 'vite config must not reference ' + forbidden);
  }
  return 'oxc only';
});

check('vite build can produce compiler ON and OFF controls', () => {
  expect(viteConfig.includes("FAB_REACT_COMPILER !== 'off'"), 'vite config must expose the CORE-011 OFF control');
  expect(viteConfig.includes("compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true }"), 'compiler options contract changed');
  return 'FAB_REACT_COMPILER=off';
});

const COMPONENT = [
  "import { useState, useCallback } from 'react';",
  "import { sumCompletedLots } from './domain';",
  "",
  'export function CompilerFixture({ step }: { step: number }) {',
  "  const [count, setCount] = useState(0);",
  "  const next = count + step;",
  "  const completed = sumCompletedLots([{ completedLots: 2n }, { completedLots: 3n }]);",
  '  const onPick = useCallback((index: number) => setCount((value) => value + index), []);',
  '  return <button onClick={() => onPick(next)}>{String(completed + BigInt(next))}</button>;',
  '}',
].join('\n');

const pluginOptions = (reactCompiler) => ({
  jsx: { runtime: 'automatic', development: false, importSource: undefined, refresh: false },
  reactCompiler,
  sourcemap: false,
});

const main = async () => {
  // Resolve the workspace install explicitly: this script lives outside web_app.
  const oxcEntry = path.join(webApp, 'node_modules/oxc-transform-react/index.js');
  const oxc = await import(pathToFileURL(oxcEntry).href);
  await checkAsync('installed oxc-transform-react exports transform/transformSync', () => {
    expect(typeof oxc.transform === 'function', 'transform() missing');
    expect(typeof oxc.transformSync === 'function', 'transformSync() missing');
    return 'transform + transformSync';
  });

  check('compiler ON transform succeeds through the plugin option shape', () => {
    const result = oxc.transformSync('compiler-fixture.tsx', COMPONENT, pluginOptions({ target: '19', compilationMode: 'infer', reportDiagnostics: true }));
    expect(result.fatal === false, 'fatal transform: ' + (result.errors ?? []).map((error) => error.message).join('; '));
    expect(result.code.includes('react/compiler-runtime'), 'compiler runtime missing');
    expect(/\b_c\(/.test(result.code), 'compiler cache call _c missing');
    expect(result.code.includes('react/jsx-runtime'), 'JSX runtime missing');
    expect(!/babel/i.test(result.code), 'Babel output is not allowed');
    return 'fatal=false, compiler-runtime emitted';
  });


  await checkAsync('@vitejs/plugin-react compiler path transforms through the locked Oxc', async () => {
    const pluginUrl = pathToFileURL(path.join(webApp, 'node_modules/@vitejs/plugin-react/dist/index.js')).href;
    const reactModule = await import(pluginUrl);
    const flatten = (value) => (Array.isArray(value) ? value : [value]).flat().filter((entry) => entry && entry.name);
    const withCompiler = flatten(reactModule.default({ compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true } }));
    const withoutCompiler = flatten(reactModule.default({}));
    const compilerPlugin = withCompiler.find((plugin) => plugin.name === 'vite:react-compiler');
    expect(compilerPlugin !== undefined, 'react() with compiler must install the vite:react-compiler plugin');
    expect(!withoutCompiler.some((plugin) => plugin.name === 'vite:react-compiler'), 'react() without compiler must not install a compiler plugin');
    const context = {
      environment: { config: { consumer: 'client', command: 'build', build: { sourcemap: false } } },
      error(message) { throw new Error(String(message)); },
      warn() {},
    };
    const result = await compilerPlugin.transform.handler.call(context, COMPONENT, '/tmp/compiler-plugin-fixture.tsx');
    expect(String(result?.code).includes('react/compiler-runtime'), 'plugin compiler path emitted no compiler runtime');
    expect(/\b_c\(/.test(String(result?.code)), 'plugin compiler path emitted no cache call');
    return 'vite:react-compiler transform OK';
  });

  await checkAsync('async transform() works (the plugin awaits it)', async () => {
    const result = await oxc.transform('compiler-fixture.tsx', COMPONENT, pluginOptions({ target: '19', compilationMode: 'infer', reportDiagnostics: true }));
    expect(result.fatal === false, 'async fatal transform');
    expect(result.code.includes('react/compiler-runtime'), 'async compiler runtime missing');
    return 'async path OK';
  });

  check('compiler OFF transform emits no compiler runtime (equivalence control)', () => {
    const result = oxc.transformSync('compiler-fixture.tsx', COMPONENT, pluginOptions(false));
    expect(result.fatal === false, 'OFF transform fatal');
    expect(!result.code.includes('react/compiler-runtime'), 'OFF build must not include the compiler runtime');
    expect(result.code.includes('react/jsx-runtime'), 'JSX runtime missing in OFF build');
    return 'no compiler-runtime';
  });

  const failed = checks.filter((entry) => !entry.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    provider: process.platform + '-' + process.arch,
    versions: {
      '@vitejs/plugin-react': pluginPackage.version,
      'oxc-transform-react': oxcPackage.version,
      binding: oxc.__napiBindingTarget,
    },
    checks,
    ok: failed.length === 0,
  };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log('report: ' + outPath);
  }
  console.log(failed.length === 0 ? 'COMPILER COMPAT PASS' : 'COMPILER COMPAT FAIL (' + failed.length + ' checks)');
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
