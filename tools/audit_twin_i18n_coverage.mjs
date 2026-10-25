// Audits Twin UI copy against the frozen en/zh inventory and the generated translation map.
// Node 26 runs this file directly and imports the TypeScript modules through native type stripping.
//
// Scope: every .ts/.tsx file under web_app/src (sorted, .d.ts excluded). A file that imports
// './twin-i18n' is categorised as 'twin-ui' (the /twin page surface); every other file is 'other-ui'.
// For each literal-first t(...) call site the audit records:
//   - one-arg       t('zh')                -> en resolved from GENERATED_TWIN_EN, then TWIN_EN
//   - parameterized t('zh', [params])      -> parameters array, no explicit English argument
//   - explicit      t('zh', 'English')     -> compared against the frozen map when zh is present
//   - non-string    t('zh', someIdentifier)-> hard failure: missing English argument
// A literal empty string as the English argument is also a hard failure.
// A contradiction between an explicit English argument and the frozen en value is a hard failure
// unless a declared, justified Next-specific allowlist entry matches it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(root, 'web_app/src');
const fixturePath = path.join(root, 'web_app/assets/original-twin-i18n.json');
const twinTranslationsPath = path.join(srcRoot, 'twin-translations.ts');
const generatedPath = path.join(srcRoot, 'twin-translations.generated.ts');
const destinationPath = path.join(root, 'web_app/assets/twin-i18n-coverage.json');
const checkMode = process.argv.includes('--check');

const TICK = String.fromCharCode(96);
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const relPath = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// Explicit, justified exceptions for Next-specific labels whose English copy intentionally differs
// from the frozen value for the same zh string. Match key: zhCN + explicitEn. Keep empty unless a
// real contradiction is a deliberate Next label difference.
const NEXT_SPECIFIC_ALLOWLIST = [
  // Shape when a real finding appears:
  // { zhCN: 'example', explicitEn: 'Example', justification: 'Next-specific label: ...' },
];

function walk(dir, collected) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(absolute, collected);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      collected.push(absolute);
    }
  }
  return collected;
}

function decodeQuotedLiteral(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  if (quote === TICK) return body.includes(String.fromCharCode(36) + '{') ? null : body;
  let decoded = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = body[index];
    if (escaped === 'n') decoded += '\n';
    else if (escaped === 'r') decoded += '\r';
    else if (escaped === 't') decoded += '\t';
    else if (escaped === 'b') decoded += '\b';
    else if (escaped === 'f') decoded += '\f';
    else if (escaped === 'v') decoded += '\v';
    else if (escaped === '0') decoded += '\0';
    else if (escaped === 'x') {
      decoded += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (escaped === 'u') {
      if (body[index + 1] === '{') {
        const end = body.indexOf('}', index);
        decoded += String.fromCodePoint(Number.parseInt(body.slice(index + 2, end), 16));
        index = end;
      } else {
        decoded += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 5), 16));
        index += 4;
      }
    } else if (escaped === '\r') {
      if (body[index + 1] === '\n') index += 1;
    } else if (escaped === '\n') {
      // Line continuation contributes nothing.
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

// A single string literal with no concatenation; returns null for anything else.
function literalValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  if (first !== '"' && first !== "'" && first !== TICK) return null;
  if (trimmed[trimmed.length - 1] !== first) return null;
  let trailingEscapes = 0;
  for (let index = trimmed.length - 2; index >= 0 && trimmed[index] === '\\'; index -= 1) trailingEscapes += 1;
  if (trailingEscapes % 2 === 1) return null;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    if (trimmed[index] === '\\') {
      index += 1;
      continue;
    }
    if (trimmed[index] === first) return null;
  }
  return decodeQuotedLiteral(trimmed);
}

// Split a call's argument list starting at the '(' offset, respecting nested (), [], {} and strings.
function splitCallArguments(text, openIndex) {
  let paren = 0;
  let square = 0;
  let brace = 0;
  const args = [];
  let current = '';
  for (let index = openIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === TICK) {
      const quote = character;
      let raw = character;
      let cursor = index + 1;
      while (cursor < text.length) {
        const next = text[cursor];
        raw += next;
        if (next === '\\') {
          raw += text[cursor + 1] === undefined ? '' : text[cursor + 1];
          cursor += 2;
          continue;
        }
        if (next === quote) break;
        cursor += 1;
      }
      current += raw;
      index = cursor;
      continue;
    }
    if (character === '(') paren += 1;
    else if (character === ')') {
      if (paren === 0 && square === 0 && brace === 0) {
        if (current.trim()) args.push(current.trim());
        return { args, end: index };
      }
      paren -= 1;
    } else if (character === '[') square += 1;
    else if (character === ']') square -= 1;
    else if (character === '{') brace += 1;
    else if (character === '}') brace -= 1;
    else if (character === ',' && paren === 0 && square === 0 && brace === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  return { args: null, end: text.length };
}

function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function emptyTotals() {
  return {
    literalPairs: 0,
    twinUiPairs: 0,
    otherUiPairs: 0,
    explicitPairs: 0,
    oneArgPairs: 0,
    parameterizedPairs: 0,
    frozenMappedPairs: 0,
    twinEnOnlyPairs: 0,
    absentFromBothMaps: 0,
    matchedFrozen: 0,
    frozenContradictions: 0,
    allowlistedContradictions: 0,
    unallowlistedContradictions: 0,
    absentExplicitPairs: 0,
    emptyEnglishArguments: 0,
    nonStringEnglishArguments: 0,
    nonLiteralFirstArgumentCalls: 0,
  };
}

async function main() {
  const fixtureBuffer = fs.readFileSync(fixturePath);
  const fixture = JSON.parse(fixtureBuffer.toString('utf8'));
  const generatedModule = await import(pathToFileURL(generatedPath).href);
  const translationsModule = await import(pathToFileURL(twinTranslationsPath).href);
  const GENERATED_TWIN_EN = generatedModule.GENERATED_TWIN_EN;
  const GENERATED_TWIN_COLLISIONS = generatedModule.GENERATED_TWIN_COLLISIONS;
  const GENERATED_TWIN_PROVENANCE = generatedModule.GENERATED_TWIN_PROVENANCE;
  const TWIN_EN = translationsModule.TWIN_EN;
  if (!GENERATED_TWIN_EN || !TWIN_EN) throw new Error('Translation modules did not expose their maps');

  const fixtureSha256 = sha256(fixtureBuffer);
  if (GENERATED_TWIN_PROVENANCE.fixtureSha256 !== fixtureSha256) {
    throw new Error('Generated map provenance does not match the frozen fixture; run node tools/build_twin_translations.cjs');
  }
  if (GENERATED_TWIN_PROVENANCE.sourceSha256['twin.html'] !== fixture.source['twin.html'].sha256) {
    throw new Error('Generated provenance twin.html hash disagrees with the fixture');
  }

  const filePaths = walk(srcRoot, []).sort(compareText);
  const scannedFiles = [];
  const twinUiFiles = [];
  const calls = [];
  let nonLiteralFirstArgumentCalls = 0;
  for (const absolute of filePaths) {
    const relative = relPath(absolute);
    const text = fs.readFileSync(absolute, 'utf8');
    const surface = /from\s+['"]\.\/twin-i18n['"]/.test(text) ? 'twin-ui' : 'other-ui';
    scannedFiles.push(relative);
    if (surface === 'twin-ui') twinUiFiles.push(relative);
    const callPattern = /(?<![A-Za-z0-9_$.])t\(/g;
    let match;
    while ((match = callPattern.exec(text))) {
      const { args } = splitCallArguments(text, match.index + 1);
      if (!args || args.length === 0) continue;
      const zhCN = literalValue(args[0]);
      if (zhCN === null) {
        nonLiteralFirstArgumentCalls += 1;
        continue;
      }
      const call = { file: relative, surface, line: lineOf(text, match.index), zhCN, argument: { kind: 'one-arg' } };
      if (args.length > 1) {
        const second = literalValue(args[1]);
        if (second !== null) call.argument = { kind: 'explicit', english: second };
        else if (args[1].trim().startsWith('[')) call.argument = { kind: 'parameters' };
        else call.argument = { kind: 'non-string', source: args[1].slice(0, 60) };
      }
      calls.push(call);
    }
  }
  calls.sort((left, right) => compareText(left.file, right.file) || left.line - right.line || compareText(left.zhCN, right.zhCN));

  const totals = emptyTotals();
  const surfaces = { 'twin-ui': emptyTotals(), 'other-ui': emptyTotals() };
  const perFile = new Map();
  const findings = {
    absentFromBothMaps: [],
    twinEnOnly: [],
    frozenContradictions: [],
    allowlistedContradictions: [],
    missingEnglishArguments: [],
    staleAllowlist: [],
  };

  const usedAllowlist = new Set();
  const findAllowlistEntry = (call) => {
    const index = NEXT_SPECIFIC_ALLOWLIST.findIndex((entry) => entry.zhCN === call.zhCN && entry.explicitEn === call.argument.english);
    if (index < 0) return null;
    usedAllowlist.add(index);
    return NEXT_SPECIFIC_ALLOWLIST[index];
  };
  const ensureFile = (call) => {
    if (!perFile.has(call.file)) {
      perFile.set(call.file, { path: call.file, surface: call.surface, ...emptyTotals() });
    }
    return perFile.get(call.file);
  };

  for (const call of calls) {
    const fileStats = ensureFile(call);
    const surfaceStats = surfaces[call.surface];
    totals.literalPairs += 1;
    fileStats.literalPairs += 1;
    surfaceStats.literalPairs += 1;
    if (call.surface === 'twin-ui') {
      totals.twinUiPairs += 1;
      surfaceStats.twinUiPairs += 1;
    } else {
      totals.otherUiPairs += 1;
      surfaceStats.otherUiPairs += 1;
    }
    const frozenEn = GENERATED_TWIN_EN[call.zhCN];
    const twinEn = TWIN_EN[call.zhCN];
    const inFrozen = frozenEn !== undefined;
    const inTwinEn = twinEn !== undefined;
    if (inFrozen) {
      totals.frozenMappedPairs += 1;
      fileStats.frozenMappedPairs += 1;
      surfaceStats.frozenMappedPairs += 1;
    } else if (inTwinEn) {
      totals.twinEnOnlyPairs += 1;
      fileStats.twinEnOnlyPairs += 1;
      surfaceStats.twinEnOnlyPairs += 1;
      findings.twinEnOnly.push({
        file: call.file, line: call.line, surface: call.surface, zhCN: call.zhCN,
        explicitEn: call.argument.kind === 'explicit' ? call.argument.english : null, twinEn,
      });
    } else {
      totals.absentFromBothMaps += 1;
      fileStats.absentFromBothMaps += 1;
      surfaceStats.absentFromBothMaps += 1;
      findings.absentFromBothMaps.push({
        file: call.file, line: call.line, surface: call.surface, zhCN: call.zhCN,
        explicitEn: call.argument.kind === 'explicit' ? call.argument.english : null, kind: call.argument.kind,
      });
    }
    if (call.argument.kind === 'explicit') {
      totals.explicitPairs += 1;
      fileStats.explicitPairs += 1;
      surfaceStats.explicitPairs += 1;
      if (call.argument.english.length === 0) {
        totals.emptyEnglishArguments += 1;
        fileStats.emptyEnglishArguments += 1;
        surfaceStats.emptyEnglishArguments += 1;
        findings.missingEnglishArguments.push({
          file: call.file, line: call.line, surface: call.surface, zhCN: call.zhCN,
          reason: 'empty English argument', argument: JSON.stringify(call.argument.english),
        });
      } else if (inFrozen) {
        if (frozenEn === call.argument.english) {
          totals.matchedFrozen += 1;
          fileStats.matchedFrozen += 1;
          surfaceStats.matchedFrozen += 1;
        } else {
          totals.frozenContradictions += 1;
          fileStats.frozenContradictions += 1;
          surfaceStats.frozenContradictions += 1;
          const finding = {
            file: call.file, line: call.line, surface: call.surface, zhCN: call.zhCN,
            explicitEn: call.argument.english, frozenEn,
          };
          const allowEntry = findAllowlistEntry(call);
          if (allowEntry) {
            totals.allowlistedContradictions += 1;
            fileStats.allowlistedContradictions += 1;
            surfaceStats.allowlistedContradictions += 1;
            findings.allowlistedContradictions.push({ ...finding, justification: allowEntry.justification });
          } else {
            totals.unallowlistedContradictions += 1;
            fileStats.unallowlistedContradictions += 1;
            surfaceStats.unallowlistedContradictions += 1;
            findings.frozenContradictions.push(finding);
          }
        }
      } else {
        totals.absentExplicitPairs += 1;
        fileStats.absentExplicitPairs += 1;
        surfaceStats.absentExplicitPairs += 1;
      }
    } else if (call.argument.kind === 'one-arg') {
      totals.oneArgPairs += 1;
      fileStats.oneArgPairs += 1;
      surfaceStats.oneArgPairs += 1;
    } else if (call.argument.kind === 'parameters') {
      totals.parameterizedPairs += 1;
      fileStats.parameterizedPairs += 1;
      surfaceStats.parameterizedPairs += 1;
    } else {
      totals.nonStringEnglishArguments += 1;
      fileStats.nonStringEnglishArguments += 1;
      surfaceStats.nonStringEnglishArguments += 1;
      findings.missingEnglishArguments.push({
        file: call.file, line: call.line, surface: call.surface, zhCN: call.zhCN,
        reason: 'non-string English argument', argument: call.argument.source,
      });
    }
  }

  totals.nonLiteralFirstArgumentCalls = nonLiteralFirstArgumentCalls;

  for (const entry of NEXT_SPECIFIC_ALLOWLIST) {
    if (typeof entry.justification !== 'string' || entry.justification.trim().length < 12) {
      throw new Error('Allowlist entry must carry an explicit justification: ' + JSON.stringify(entry.zhCN));
    }
  }
  NEXT_SPECIFIC_ALLOWLIST.forEach((entry, index) => {
    if (!usedAllowlist.has(index)) {
      findings.staleAllowlist.push({ zhCN: entry.zhCN, explicitEn: entry.explicitEn, justification: entry.justification });
    }
  });

  const hardFailures = [];
  if (totals.unallowlistedContradictions > 0) hardFailures.push('unallowlisted explicit-English contradictions: ' + totals.unallowlistedContradictions);
  if (totals.emptyEnglishArguments > 0) hardFailures.push('empty English arguments: ' + totals.emptyEnglishArguments);
  if (totals.nonStringEnglishArguments > 0) hardFailures.push('non-string English arguments: ' + totals.nonStringEnglishArguments);
  if (findings.staleAllowlist.length > 0) hardFailures.push('stale allowlist entries: ' + findings.staleAllowlist.length);

  const perFileRows = [...perFile.values()].sort((left, right) => compareText(left.path, right.path));

  const report = {
    schemaVersion: 1,
    generatedBy: 'tools/audit_twin_i18n_coverage.mjs',
    generatorCommand: 'node tools/audit_twin_i18n_coverage.mjs',
    source: {
      fixture: relPath(fixturePath),
      fixtureSha256,
      module: relPath(generatedPath),
      twinTranslations: relPath(twinTranslationsPath),
      generatedMapEntries: Object.keys(GENERATED_TWIN_EN).length,
      generatedCollisions: Object.keys(GENERATED_TWIN_COLLISIONS).length,
      twinEnEntries: Object.keys(TWIN_EN).length,
    },
    generated: {
      entries: GENERATED_TWIN_PROVENANCE.entries,
      fixtureCounts: GENERATED_TWIN_PROVENANCE.fixtureCounts,
      sourceSha256: GENERATED_TWIN_PROVENANCE.sourceSha256,
      fixtureSha256: GENERATED_TWIN_PROVENANCE.fixtureSha256,
      collisionPolicy: GENERATED_TWIN_PROVENANCE.collisionPolicy,
      collisionKeys: Object.keys(GENERATED_TWIN_COLLISIONS).sort(compareText),
    },
    scope: {
      scanRoot: 'web_app/src',
      fileExtensions: ['.ts', '.tsx'],
      excluded: ['.d.ts'],
      twinUiRule: "file imports the twin i18n hook module (useTwinLocale surface)",
      callRule: 't(<literal zh>), t(<literal zh>, <literal en>), t(<literal zh>, [parameters]); non-literal first arguments are counted, not paired',
      scannedFiles,
      twinUiFiles,
    },
    totals,
    surfaces,
    files: perFileRows,
    allowlistPolicy: 'An explicit English argument that contradicts the frozen en value is only tolerated for a declared Next-specific label (zhCN + explicitEn) carrying a non-empty justification. Empty, non-string, non-allowlisted contradictory and stale allowlist entries are hard failures.',
    allowlist: NEXT_SPECIFIC_ALLOWLIST.map((entry) => ({
      zhCN: entry.zhCN,
      explicitEn: entry.explicitEn,
      justification: entry.justification,
    })),
    findings,
    checks: {
      ok: hardFailures.length === 0,
      hardFailures,
    },
  };

  const json = JSON.stringify(report, null, 2) + '\n';
  if (checkMode) {
    const checkFailures = [...hardFailures];
    let existing = null;
    try {
      existing = fs.readFileSync(destinationPath, 'utf8');
    } catch (error) {
      checkFailures.push('coverage report is missing; run node tools/audit_twin_i18n_coverage.mjs');
    }
    if (existing !== null && existing !== json) {
      checkFailures.push('coverage report drift: ' + relPath(destinationPath));
    }
    if (checkFailures.length > 0) {
      throw new Error('Twin i18n coverage check failed: ' + checkFailures.join('; '));
    }
    console.log('Twin i18n coverage stable: ' + totals.literalPairs + ' literal pairs (' +
      totals.explicitPairs + ' explicit), ' + totals.matchedFrozen + ' matched, ' +
      totals.frozenContradictions + ' contradictions (' + totals.allowlistedContradictions + ' allowlisted), ' +
      totals.absentFromBothMaps + ' absent from both maps, ' + findings.missingEnglishArguments.length + ' missing English arguments');
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, json);
  console.log('Twin i18n coverage: ' + totals.literalPairs + ' literal pairs (' +
    totals.explicitPairs + ' explicit), ' + totals.frozenMappedPairs + ' frozen-mapped, ' +
    totals.twinEnOnlyPairs + ' TWIN_EN-only, ' + totals.absentFromBothMaps + ' absent from both maps; ' +
    totals.matchedFrozen + ' matched, ' + totals.frozenContradictions + ' contradictions (' +
    totals.allowlistedContradictions + ' allowlisted), ' + findings.missingEnglishArguments.length +
    ' missing English arguments -> ' + relPath(destinationPath));
  if (hardFailures.length > 0) {
    process.exitCode = 1;
    console.error('Twin i18n coverage hard failures: ' + hardFailures.join('; '));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
