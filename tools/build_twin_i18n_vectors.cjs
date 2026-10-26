// Test-only extraction of the frozen original en-US/zh-CN twin strings; no original runtime ships.
// Source of truth: C:\Users\han_qingyu\SemiconFab (read-only), pinned by docs/migration/twin-parity/source-manifest.json.
//
// Extraction rules (deterministic):
//   1. dictionary: execute js/translations.js in a bare node:vm context and take ONLY the en and zh-CN
//      dictionaries. The other seven locales are verified present but neither emitted nor serialized.
//   2. static: every data-i18n / data-i18n-html / data-i18n-title / data-i18n-aria-label /
//      data-i18n-placeholder / data-i18n-lbl value in twin.html, resolved against en + zh-CN. Attribute
//      names are the exact selector contract implemented by the frozen js/i18n.js engine.
//   3. named-pair: adjacent literal nameZh/nameEn (and bayName/bayNameZh) property values or member
//      assignments such as bt.statusTextZh / bt.statusTextEn. The literal must be a plain string or a
//      template literal and must not be the first operand of a concatenation. The pair must sit within
//      four source lines, so unrelated objects never cross-pair. This covers patrol status texts and
//      waypoints, AMHS station bay names, cleanroom bay names, roof MAU names, tour waypoints and
//      onboarding steps.
//   4. ternary: a Chinese-language condition (isZh, currentLang === "zh-CN" / "zh-TW", lang === ...,
//      .startsWith("zh"), including negated/enum forms) whose true and false branches are both single
//      literals. The false branch is en unless the condition is negated. Template literals keep their
//      interpolation expressions verbatim. Locale-dependent canvas font strings are recorded as skipped,
//      not as user-visible copy.
//   5. grouped array: isZh ? [ ... ] : [ ... ] arrays of { text: "..." } option literals are paired
//      element-wise (scenario select labels).
//   6. zh-only-copy: showTwinToast(...) messages with a Chinese literal and no en variant are recorded
//      in missing as explicit source gaps.
// Non-literal locale ternaries (references, concatenations, nested ternaries) are listed in skipped with
// their line and kind so later phases can see exactly what this inventory cannot resolve.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const frozenRoot = path.resolve(root, '..', 'SemiconFab');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const destinationPath = path.join(root, 'web_app/assets/original-twin-i18n.json');

const ATTRIBUTE_NAMES = [
  'data-i18n',
  'data-i18n-html',
  'data-i18n-title',
  'data-i18n-aria-label',
  'data-i18n-placeholder',
  'data-i18n-lbl',
];
const REPO_LOCALES = ['en', 'zh-CN'];
const EXCLUDED_LOCALES = ['zh-TW', 'ja', 'ko', 'de', 'fr', 'it', 'es'];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TICK_CHAR = String.fromCharCode(96);

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function readFrozen(relativePath) {
  const buffer = fs.readFileSync(path.join(frozenRoot, relativePath));
  const hash = sha256(buffer);
  const pinned = manifest.source_sha256[relativePath];
  if (!pinned) throw new Error('Frozen source is not pinned in source-manifest.json: ' + relativePath);
  if (hash !== pinned) throw new Error('Frozen source drift: ' + relativePath);
  const text = buffer.toString('utf8');
  return { relativePath, text, sha256: hash, bytes: buffer.length, lines: text.split('\n').length };
}

const twin = readFrozen('twin.html');
const translations = readFrozen('js/translations.js');
const i18nEngine = readFrozen('js/i18n.js');

// 1-based line lookup over the frozen twin.html.
const lineStarts = [0];
for (let index = 0; index < twin.text.length; index += 1) {
  if (twin.text.charCodeAt(index) === 10) lineStarts.push(index + 1);
}
function lineOf(offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
function lineOfText(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

// The frozen engine is the attribute contract. Any new data-i18n-* attribute must be added deliberately.
const engineAttributes = [...new Set([...i18nEngine.text.matchAll(/\[(data-i18n[a-z-]*)\]/g)].map((match) => match[1]))];
if (engineAttributes.length !== ATTRIBUTE_NAMES.length || engineAttributes.some((name) => !ATTRIBUTE_NAMES.includes(name))) {
  throw new Error('js/i18n.js attribute contract drifted: ' + engineAttributes.join(', '));
}

// ---------------------------------------------------------------------------
// 1. Dictionary: en and zh-CN only.
// ---------------------------------------------------------------------------
function loadDictionary() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(translations.text + '\nglobalThis.__I18N_DICTIONARY = I18N_DICTIONARY;', sandbox, { filename: 'translations.js' });
  const dictionary = sandbox.__I18N_DICTIONARY;
  if (!dictionary || typeof dictionary !== 'object') throw new Error('I18N_DICTIONARY was not extracted from js/translations.js');
  const localeIds = Object.keys(dictionary);
  for (const locale of REPO_LOCALES) {
    if (!dictionary[locale] || typeof dictionary[locale] !== 'object') throw new Error('Missing frozen locale: ' + locale);
  }
  for (const locale of EXCLUDED_LOCALES) {
    if (!dictionary[locale]) throw new Error('Frozen locale disappeared: ' + locale);
  }
  const en = dictionary['en'];
  const zhCN = dictionary['zh-CN'];
  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zhCN);
  for (const key of enKeys) {
    if (typeof en[key] !== 'string') throw new Error('Non-string en dictionary value: ' + key);
    if (typeof zhCN[key] !== 'string') throw new Error('Missing zh-CN dictionary key: ' + key);
  }
  for (const key of zhKeys) {
    if (!(key in en)) throw new Error('zh-CN dictionary key missing from en: ' + key);
  }
  return { dictionary, localeIds, en, zhCN, enKeys, zhKeys };
}

const loadedDictionary = loadDictionary();
const localeIds = loadedDictionary.localeIds;
const enDictionary = loadedDictionary.en;
const zhCNDictionary = loadedDictionary.zhCN;
const enKeys = loadedDictionary.enKeys;
const zhKeys = loadedDictionary.zhKeys;

// Provenance: line range of each frozen locale block inside js/translations.js.
const localeStarts = [...translations.text.matchAll(/^  (?:"([^"]+)"|([A-Za-z-]+)): \{$/gm)].map((match) => ({
  locale: match[1] || match[2],
  line: lineOfText(translations.text, match.index),
}));
const dictionaryLines = Object.fromEntries(REPO_LOCALES.map((locale) => {
  const position = localeStarts.findIndex((entry) => entry.locale === locale);
  if (position < 0) throw new Error('Missing dictionary locale block: ' + locale);
  const start = localeStarts[position].line;
  const next = localeStarts[position + 1];
  const end = next ? next.line - 1 : translations.lines;
  return [locale, { start, end }];
}));

// ---------------------------------------------------------------------------
// 2. Static data-i18n* references.
// ---------------------------------------------------------------------------
const STATIC_ATTRIBUTE_PATTERN = 'data-i18n(?:-html|-title|-aria-label|-placeholder|-lbl)?';
const staticAttributeRegex = new RegExp('\\b(' + STATIC_ATTRIBUTE_PATTERN + ')\\s*=\\s*(["\'])([^"\']+)\\2', 'g');
const attributeCounts = Object.fromEntries(ATTRIBUTE_NAMES.map((name) => [name, 0]));
const staticKeyMap = new Map();
let staticReferenceCount = 0;
let staticMatch;
while ((staticMatch = staticAttributeRegex.exec(twin.text))) {
  const attribute = staticMatch[1];
  const key = staticMatch[3];
  const line = lineOf(staticMatch.index);
  attributeCounts[attribute] += 1;
  staticReferenceCount += 1;
  if (!staticKeyMap.has(key)) staticKeyMap.set(key, { key, attributes: [], sourceLines: [] });
  const entry = staticKeyMap.get(key);
  if (!entry.attributes.includes(attribute)) entry.attributes.push(attribute);
  entry.sourceLines.push(line);
}

// ---------------------------------------------------------------------------
// 3-5. Dynamic bilingual pairs from the twin inline script.
// ---------------------------------------------------------------------------
function findInlineScript() {
  const scriptPattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  let best = null;
  while ((match = scriptPattern.exec(twin.text))) {
    const type = (match[0].match(/\btype="([^"]+)"/) || [])[1] || 'text/javascript';
    if (type === 'application/ld+json') continue;
    const content = match[1];
    if (!best || content.length > best.content.length) {
      best = { content, offset: match.index + match[0].indexOf(content) };
    }
  }
  if (!best) throw new Error('twin.html inline script not found');
  return best;
}
const inlineScript = findInlineScript();
const scriptText = inlineScript.content;
const scriptLineOf = (index) => lineOf(inlineScript.offset + index);
const inlineScriptRange = {
  start: scriptLineOf(0),
  end: lineOf(inlineScript.offset + scriptText.length - 1),
};

// Category ranges to make dynamic ids self-describing. First match wins.
const CATEGORY_RANGES = [
  ['patrol', 9088, 10118],
  ['bay', 12688, 12803],
  ['draft', 13843, 14038],
  ['custom-layout', 14058, 14308],
  ['toast', 14388, 14428],
  ['amhs', 14488, 14521],
  ['amhs', 15218, 15338],
  ['mode', 14521, 14540],
  ['roof', 16048, 16548],
  ['wafer', 18348, 18413],
  ['wafer', 18538, 18568],
  ['tour', 19353, 19443],
  ['tour', 19673, 19753],
  ['scenario', 20538, 20570],
  ['equipment-ui', 21236, 21268],
  ['subfab', 20648, 20733],
  ['yield', 22043, 22103],
  ['sim', 22236, 22258],
  ['sidebar', 22558, 22668],
];
function categoryOf(line) {
  for (const [category, start, end] of CATEGORY_RANGES) {
    if (line >= start && line <= end) return category;
  }
  return 'misc';
}

// Last enclosing function name before an offset, used only for readable dynamic ids.
const functionStarts = [...scriptText.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => ({
  index: match.index,
  name: match[1],
}));
function enclosingFunction(offset) {
  let name = 'inline';
  for (const entry of functionStarts) {
    if (entry.index > offset) break;
    name = entry.name;
  }
  return name;
}
const kebab = (value) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Decode a plain JS string literal; template literals keep their interpolation expressions verbatim.
function decodeLiteral(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  if (quote === '`') return body;
  let decoded = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = body[index];
    switch (escaped) {
      case 'n': decoded += '\n'; break;
      case 'r': decoded += '\r'; break;
      case 't': decoded += '\t'; break;
      case 'b': decoded += '\b'; break;
      case 'f': decoded += '\f'; break;
      case 'v': decoded += '\v'; break;
      case '0': decoded += '\0'; break;
      case 'x': {
        const hex = body.slice(index + 1, index + 3);
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case 'u': {
        if (body[index + 1] === '{') {
          const end = body.indexOf('}', index);
          decoded += String.fromCodePoint(Number.parseInt(body.slice(index + 2, end), 16));
          index = end;
        } else {
          const hex = body.slice(index + 1, index + 5);
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        }
        break;
      }
      case '\r':
        if (body[index + 1] === '\n') index += 1;
        break;
      case '\n':
        break;
      default:
        decoded += escaped;
    }
  }
  return decoded;
}

const LITERAL_SOURCE = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)';
const dynamicEntries = [];
const missingEntries = [];
const skippedEntries = [];
const missingKinds = {
  'dictionary-key': 'twin.html reference missing from the frozen en or zh-CN dictionary',
  'zh-only-copy': 'frozen Chinese-only UI copy with no en variant',
};
const skippedKinds = {
  'font-metric-ternary': 'locale-dependent canvas font metric, not user-visible copy',
  'non-cjk-zh-branch': 'zh/en literal pair whose Chinese side has no CJK characters',
  'expression-branch': 'locale-conditioned ternary with a non-literal or concatenated branch',
  'nested-ternary': 'locale-conditioned ternary whose Chinese branch is itself a ternary',
  'non-literal-branch': 'locale-conditioned ternary whose branches are variable references',
  'grouped-array': 'grouped option arrays whose zh/en text fields do not align',
};

// Pair the zh and en halves of a candidate set and emit ids of the form category.base.n.
function emitPairs(pairs, usedCounters) {
  pairs.sort((left, right) => left.sourceLine - right.sourceLine || left.base.localeCompare(right.base));
  for (const pair of pairs) {
    const category = categoryOf(pair.sourceLine);
    const counterKey = category + '.' + pair.base;
    const next = (usedCounters.get(counterKey) || 0) + 1;
    usedCounters.set(counterKey, next);
    dynamicEntries.push({
      id: category + '.' + pair.base + '.' + next,
      zhCN: pair.zhCN,
      en: pair.en,
      sourceLine: pair.sourceLine,
    });
  }
}

// --- 3. Named zh/en property pairs (literal values only). -------------------
const literalGroup = '(' + LITERAL_SOURCE + ')';
const propertyCandidateRegex = new RegExp('([A-Za-z_$][\\w$]*)\\s*:\\s*' + literalGroup, 'g');
const assignmentCandidateRegex = new RegExp('([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*=\\s*' + literalGroup, 'g');
const concatTail = /^[ \t]*\+/;
const allLiteralCandidates = [];
let candidateMatch;
while ((candidateMatch = propertyCandidateRegex.exec(scriptText))) {
  const tail = scriptText.slice(propertyCandidateRegex.lastIndex, propertyCandidateRegex.lastIndex + 16);
  if (concatTail.test(tail)) continue;
  allLiteralCandidates.push({
    mode: 'property',
    receiver: null,
    name: candidateMatch[1],
    raw: candidateMatch[2],
    line: scriptLineOf(candidateMatch.index),
    index: candidateMatch.index,
  });
}
while ((candidateMatch = assignmentCandidateRegex.exec(scriptText))) {
  const tail = scriptText.slice(assignmentCandidateRegex.lastIndex, assignmentCandidateRegex.lastIndex + 16);
  if (concatTail.test(tail)) continue;
  allLiteralCandidates.push({
    mode: 'assignment',
    receiver: candidateMatch[1],
    name: candidateMatch[2],
    raw: candidateMatch[3],
    line: scriptLineOf(candidateMatch.index),
    index: candidateMatch.index,
  });
}
// A candidate participates when it carries a Zh/En suffix, or when it is the unsuffixed en half
// of a suffixed zh name (the AMHS station bayName / bayNameZh convention).
const candidateNameSet = new Set(allLiteralCandidates.map((candidate) => candidate.name));
const namedCandidates = allLiteralCandidates.filter((candidate) =>
  /Zh$|En$/.test(candidate.name) || candidateNameSet.has(candidate.name + 'Zh'));
namedCandidates.sort((left, right) => left.index - right.index);
const MAX_PAIR_LINE_GAP = 4;
const pairedIndexes = new Set();
const namedPairs = [];
for (let position = 0; position < namedCandidates.length; position += 1) {
  if (pairedIndexes.has(position)) continue;
  const candidate = namedCandidates[position];
  const zhSide = candidate.name.endsWith('Zh');
  const family = candidate.name.endsWith('Zh') || candidate.name.endsWith('En') ? candidate.name.slice(0, -2) : candidate.name;
  const zhName = zhSide ? candidate.name : family + 'Zh';
  const expectedNames = zhSide ? [family + 'En', family] : [zhName];
  let best = -1;
  let bestDistance = Infinity;
  for (let other = 0; other < namedCandidates.length; other += 1) {
    if (other === position || pairedIndexes.has(other)) continue;
    const counterpart = namedCandidates[other];
    if (counterpart.mode !== candidate.mode) continue;
    if (counterpart.receiver !== candidate.receiver) continue;
    if (!expectedNames.includes(counterpart.name)) continue;
    const distance = Math.abs(counterpart.line - candidate.line);
    if (distance > MAX_PAIR_LINE_GAP) continue;
    if (distance < bestDistance) { best = other; bestDistance = distance; }
  }
  if (best < 0) continue;
  pairedIndexes.add(position);
  pairedIndexes.add(best);
  const counterpart = namedCandidates[best];
  const zhCandidate = zhSide ? candidate : counterpart;
  const enCandidate = zhSide ? counterpart : candidate;
  const zhCN = decodeLiteral(zhCandidate.raw);
  const en = decodeLiteral(enCandidate.raw);
  if (zhCN.length === 0 || en.length === 0) continue;
  if (!CJK.test(zhCN)) {
    // Template pairs may carry the Chinese copy through an interpolation (for example
    // `${wp.nameZh} (...)`); accept only when both sides are templates that actually differ.
    const templatePair = zhCandidate.raw[0] === TICK_CHAR && enCandidate.raw[0] === TICK_CHAR && zhCN !== en;
    if (!templatePair) {
      skippedEntries.push({
        kind: 'non-cjk-zh-branch',
        sourceLine: Math.min(zhCandidate.line, enCandidate.line),
        reason: 'zh/en suffixed literal pair whose Chinese side has no CJK characters',
      });
      continue;
    }
  }
  namedPairs.push({
    zhCN,
    en,
    sourceLine: Math.min(zhCandidate.line, enCandidate.line),
    base: kebab(family),
  });
}
emitPairs(namedPairs, new Map());

// --- 4. Locale-conditioned ternary literals --------------------------------
const ZH_CONDITIONS = [
  { pattern: '\\bisZh\\b', zhWhenTrue: true },
  { pattern: '\\bcurrentLang\\s*===\\s*"zh-CN"', zhWhenTrue: true },
  { pattern: '\\bcurrentLang\\s*===\\s*"zh-TW"', zhWhenTrue: true },
  { pattern: '\\blang\\s*===\\s*"zh-CN"', zhWhenTrue: true },
  { pattern: '\\blang\\s*===\\s*"zh-TW"', zhWhenTrue: true },
  { pattern: '\\bcurrentLang\\.startsWith\\("zh"\\)', zhWhenTrue: true },
  { pattern: '\\blang\\.startsWith\\("zh"\\)', zhWhenTrue: true },
  { pattern: '\\bcurrentLang\\s*!==\\s*"zh-CN"', zhWhenTrue: false },
  { pattern: '\\blang\\s*!==\\s*"zh-CN"', zhWhenTrue: false },
  { pattern: '(?:\\bcurrentLang|\\blang)\\s*===\\s*"en"', zhWhenTrue: false },
];
const literalBothRegex = new RegExp('^\\s*' + literalGroup + '\\s*:\\s*' + literalGroup);
const firstLiteralRegex = new RegExp('^\\s*' + literalGroup);
const ternaryPositions = new Map();
for (const condition of ZH_CONDITIONS) {
  const conditionRegex = new RegExp(condition.pattern + '\\s*\\?', 'g');
  let conditionMatch;
  while ((conditionMatch = conditionRegex.exec(scriptText))) {
    const questionMark = conditionMatch.index + conditionMatch[0].length - 1;
    if (ternaryPositions.has(questionMark)) continue;
    ternaryPositions.set(questionMark, { zhWhenTrue: condition.zhWhenTrue, index: conditionMatch.index });
  }
}
const sortedTernaries = [...ternaryPositions.entries()].sort((left, right) => left[0] - right[0]);

// --- 5. Grouped option arrays: isZh ? [ {text} ] : [ {text} ] --------------
function findClosingBracket(text, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
const handledGrouped = new Set();
{
  const groupedRegex = /\bisZh\s*\?\s*\[/g;
  let groupedMatch;
  while ((groupedMatch = groupedRegex.exec(scriptText))) {
    const questionMark = groupedMatch.index + groupedMatch[0].indexOf('?');
    const openTrue = scriptText.indexOf('[', groupedMatch.index);
    const closeTrue = findClosingBracket(scriptText, openTrue, '[', ']');
    if (closeTrue < 0) continue;
    const elseMatch = /^\s*:\s*\[/.exec(scriptText.slice(closeTrue + 1));
    if (!elseMatch) continue;
    const openFalse = closeTrue + 1 + elseMatch[0].length - 1;
    const closeFalse = findClosingBracket(scriptText, openFalse, '[', ']');
    if (closeFalse < 0) continue;
    const textFieldRegex = new RegExp('text\\s*:\\s*' + literalGroup, 'g');
    const collect = (source) => {
      const values = [];
      let fieldMatch;
      while ((fieldMatch = textFieldRegex.exec(source))) values.push(decodeLiteral(fieldMatch[1]));
      return values;
    };
    const zhValues = collect(scriptText.slice(openTrue, closeTrue + 1));
    const enValues = collect(scriptText.slice(openFalse, closeFalse + 1));
    if (zhValues.length === 0 || zhValues.length !== enValues.length) {
      skippedEntries.push({
        kind: 'grouped-array',
        sourceLine: scriptLineOf(questionMark),
        reason: 'grouped option array whose zh/en text fields do not align',
      });
      handledGrouped.add(questionMark);
      continue;
    }
    const category = categoryOf(scriptLineOf(groupedMatch.index));
    const slug = kebab(enclosingFunction(groupedMatch.index));
    for (let index = 0; index < zhValues.length; index += 1) {
      dynamicEntries.push({
        id: category + '.' + slug + '.' + (index + 1),
        zhCN: zhValues[index],
        en: enValues[index],
        sourceLine: scriptLineOf(groupedMatch.index),
      });
    }
    handledGrouped.add(questionMark);
  }
}

for (const [questionMark, condition] of sortedTernaries) {
  if (handledGrouped.has(questionMark)) continue;
  const rest = scriptText.slice(questionMark + 1);
  const literalMatch = literalBothRegex.exec(rest);
  if (literalMatch) {
    // literalGroup nests one capture per literal, so the false branch is group 3.
    const trueValue = decodeLiteral(literalMatch[1]);
    const falseValue = decodeLiteral(literalMatch[3]);
    const zhCN = condition.zhWhenTrue ? trueValue : falseValue;
    const en = condition.zhWhenTrue ? falseValue : trueValue;
    if (!CJK.test(zhCN)) {
      const fontLike = /(?:^|\s)\d+(?:\.\d+)?px\b/.test(zhCN) && /(?:^|\s)\d+(?:\.\d+)?px\b/.test(en);
      skippedEntries.push({
        kind: fontLike ? 'font-metric-ternary' : 'non-cjk-zh-branch',
        sourceLine: scriptLineOf(questionMark),
        reason: fontLike
          ? 'locale-dependent canvas font string, not user-visible copy'
          : 'locale-conditioned ternary whose Chinese branch has no CJK characters',
      });
      continue;
    }
    const category = categoryOf(scriptLineOf(condition.index));
    const slug = kebab(enclosingFunction(condition.index));
    const counterKey = category + '.' + slug;
    const counter = dynamicEntries.filter((entry) => entry.id.startsWith(counterKey + '.')).length + 1;
    dynamicEntries.push({
      id: counterKey + '.' + counter,
      zhCN,
      en,
      sourceLine: scriptLineOf(condition.index),
    });
    continue;
  }
  const preview = rest.replace(/^\s+/, '').slice(0, 240);
  const snippet = preview.split('\n')[0].trim().slice(0, 90);
  const firstToken = firstLiteralRegex.exec(rest);
  let kind = 'non-literal-branch';
  if (firstToken) kind = 'expression-branch';
  else if (/^\w+\s*(?:===|!==|&&|\|\||\()/.test(preview) && preview.includes('?')) kind = 'nested-ternary';
  skippedEntries.push({
    kind,
    sourceLine: scriptLineOf(questionMark),
    reason: skippedKinds[kind],
    snippet,
  });
}

// --- 6. Chinese-only toast copy -------------------------------------------
{
  const toastRegex = /showTwinToast\s*\(/g;
  const conditionRegex = new RegExp('(?:' + ZH_CONDITIONS.map((entry) => entry.pattern).join('|') + ')');
  let toastMatch;
  while ((toastMatch = toastRegex.exec(scriptText))) {
    const argumentStart = toastRegex.lastIndex;
    const argumentEnd = findClosingBracket(scriptText, argumentStart - 1, '(', ')');
    if (argumentEnd < 0) continue;
    const argument = scriptText.slice(argumentStart, argumentEnd);
    if (conditionRegex.test(argument)) continue;
    const literalRegex = new RegExp(literalGroup, 'g');
    let literalMatch;
    let zhCN = null;
    while ((literalMatch = literalRegex.exec(argument))) {
      const value = decodeLiteral(literalMatch[1]);
      if (CJK.test(value)) { zhCN = value; break; }
    }
    if (!zhCN) continue;
    missingEntries.push({
      kind: 'zh-only-copy',
      surface: 'twin-toast',
      zhCN,
      en: null,
      sourceLine: scriptLineOf(toastMatch.index),
      reason: 'showTwinToast message has no en variant in the frozen source',
    });
  }
}

// ---------------------------------------------------------------------------
// Assemble the fixture.
// ---------------------------------------------------------------------------
const keys = [];
const missingDictionary = new Map();
for (const [key, reference] of staticKeyMap) {
  const en = enDictionary[key];
  const zhCN = zhCNDictionary[key];
  const missingLocales = [];
  if (typeof en !== 'string' || en.length === 0) missingLocales.push('en');
  if (typeof zhCN !== 'string' || zhCN.length === 0) missingLocales.push('zh-CN');
  if (missingLocales.length > 0) {
    missingDictionary.set(key, {
      kind: 'dictionary-key',
      key,
      attributes: reference.attributes,
      sourceLines: reference.sourceLines,
      sourceLine: Math.min(...reference.sourceLines),
      locales: missingLocales,
      reason: 'referenced by twin.html but absent from the frozen dictionary',
    });
    continue;
  }
  keys.push({ key, en, zhCN, attributes: reference.attributes });
}
for (const entry of missingDictionary.values()) missingEntries.push(entry);

function countPlaceholders(value) {
  return (value.match(/\$\{/g) || []).length;
}
for (const entry of dynamicEntries) {
  if (countPlaceholders(entry.zhCN) !== countPlaceholders(entry.en)) {
    throw new Error('Dynamic pair placeholder mismatch at line ' + entry.sourceLine + ': ' + entry.id);
  }
}
const dynamicIds = new Set();
for (const entry of dynamicEntries) {
  if (dynamicIds.has(entry.id)) throw new Error('Duplicate dynamic id: ' + entry.id);
  dynamicIds.add(entry.id);
}

dynamicEntries.sort((left, right) => left.sourceLine - right.sourceLine || left.id.localeCompare(right.id));
missingEntries.sort((left, right) => left.sourceLine - right.sourceLine || left.kind.localeCompare(right.kind) || String(left.key || '').localeCompare(String(right.key || '')));
skippedEntries.sort((left, right) => left.sourceLine - right.sourceLine || left.kind.localeCompare(right.kind));

const fixture = {
  generatedBy: 'tools/build_twin_i18n_vectors.cjs',
  source: {
    'twin.html': {
      sha256: twin.sha256,
      bytes: twin.bytes,
      lines: twin.lines,
      inlineScript: inlineScriptRange,
    },
    'js/translations.js': {
      sha256: translations.sha256,
      bytes: translations.bytes,
      lines: translations.lines,
      dictionaryLines,
    },
    'js/i18n.js': { sha256: i18nEngine.sha256, bytes: i18nEngine.bytes, lines: i18nEngine.lines },
  },
  locales: REPO_LOCALES,
  excludedLocales: EXCLUDED_LOCALES,
  frozenLocaleIds: localeIds,
  dictionaryKeyCounts: { en: enKeys.length, 'zh-CN': zhKeys.length },
  attributeNames: ATTRIBUTE_NAMES,
  attributeCounts,
  missingKinds,
  skippedKinds,
  counts: {
    keys: keys.length,
    attributeRefs: staticReferenceCount,
    uniqueAttributeKeys: staticKeyMap.size,
    missingDictionaryKeys: missingDictionary.size,
    dynamic: dynamicEntries.length,
    missing: missingEntries.length,
    skipped: skippedEntries.length,
  },
  rules: {
    dictionary: 'js/translations.js executed in node:vm; only the en and zh-CN maps are read and emitted.',
    static: 'every data-i18n, data-i18n-html, data-i18n-title, data-i18n-aria-label, data-i18n-placeholder and data-i18n-lbl attribute in twin.html, aggregated by key; no nine-locale arrays are copied.',
    namedPair: 'literal zh/en property pairs (nameZh/nameEn, bayName/bayNameZh, statusTextZh/statusTextEn) or member assignments within four source lines; concatenated values are excluded.',
    ternary: 'Chinese-language condition (isZh, currentLang or lang === zh-CN/zh-TW, .startsWith("zh"), negated and en variants) with two plain literal branches; zh is the true branch unless the condition is negated; template interpolation expressions are kept verbatim.',
    groupedArray: 'isZh ? [ {text: "..."} ] : [ {text: "..."} ] option arrays paired element-wise.',
    zhOnlyCopy: 'showTwinToast calls with a Chinese literal and no locale ternary are recorded in missing with kind zh-only-copy.',
    skipped: 'locale-conditioned ternaries this inventory cannot pair (font metrics, non-literal branches, nested ternaries) are listed in skipped, never silently dropped.',
  },
  keys,
  dynamic: dynamicEntries,
  missing: missingEntries,
  skipped: skippedEntries,
};

const json = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const existing = fs.readFileSync(destinationPath, 'utf8');
  if (existing !== json) throw new Error('Twin i18n vectors drift: ' + path.relative(root, destinationPath));
  console.log('Twin i18n vectors stable: ' + keys.length + ' keys, ' + dynamicEntries.length + ' dynamic, ' +
    missingEntries.length + ' missing, ' + skippedEntries.length + ' skipped');
} else {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, json);
  console.log('Original twin i18n vectors: ' + keys.length + ' keys, ' + dynamicEntries.length + ' dynamic, ' +
    missingEntries.length + ' missing, ' + skippedEntries.length + ' skipped; ' +
    staticReferenceCount + ' i18n attributes on ' + staticKeyMap.size + ' unique keys');
}
