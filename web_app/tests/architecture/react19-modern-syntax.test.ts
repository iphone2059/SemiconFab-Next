import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * React 19 modernization gate.
 *
 * React 19 makes ref a normal prop (forwardRef is legacy) and this repository
 * standardizes on modern TypeScript/React idioms. Every hit is a regression:
 * legacy wrappers/APIs or type-error suppressions. FormEvent and inline type
 * imports are current idioms and are deliberately NOT flagged.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/react19-legacy', import.meta.url));

interface Violation { readonly file: string; readonly line: number; readonly pattern: string; readonly text: string }
interface Rule { readonly pattern: RegExp; readonly label: string; readonly raw?: boolean }

const RULES: readonly Rule[] = [
  { pattern: /\bforwardRef\b/, label: 'forwardRef is legacy in React 19 (ref is a prop)' },
  { pattern: /React\.FC\b|React\.FunctionComponent\b/, label: 'React.FC is discouraged; declare explicit props' },
  { pattern: /\bdefaultProps\b/, label: 'defaultProps is removed for function components' },
  { pattern: /\bpropTypes\b/, label: 'propTypes is removed' },
  { pattern: /ReactDOM\.render\b|\bfindDOMNode\b/, label: 'legacy ReactDOM root/findDOMNode API' },
  { pattern: /@ts-ignore\b/, label: '@ts-ignore must be @ts-expect-error with a reason', raw: true },
  { pattern: /\bJSX\.Element\b/, label: 'global JSX namespace is removed in React 19 types' },
  { pattern: /\bLegacyRef\b/, label: 'LegacyRef is deprecated (use Ref)' },
  { pattern: /useRef\s*<[^>]+>\s*\(\s*\)/, label: 'useRef requires an initial value in React 19' },
  { pattern: /React\.(?:FormEvent|MouseEvent|ChangeEvent|KeyboardEvent|CSSProperties|ReactNode|Ref|RefObject)\b/, label: 'use named type imports, not the React namespace' },
];

const collect = (directory: string, files: string[] = []): string[] => {
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) collect(absolute, files);
    else if (/\.tsx?$/.test(entry)) files.push(absolute);
  }
  return files;
};

/** Strip line and block comments so documentation may name legacy APIs without tripping the gate. */
const stripComments = (lines: readonly string[]): string[] => {
  const code: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) { code.push(''); continue; }
      text = text.slice(end + 2);
      inBlock = false;
    }
    const start = text.indexOf('/*');
    if (start >= 0) {
      const end = text.indexOf('*/', start + 2);
      if (end < 0) { text = text.slice(0, start); inBlock = true; }
      else text = text.slice(0, start) + text.slice(end + 2);
    }
    code.push(text.replace(/\/\/.*$/, ''));
  }
  return code;
};

const scan = (files: readonly string[], root: string): Violation[] => {
  const violations: Violation[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8').split(/\r?\n/);
    const code = stripComments(raw);
    raw.forEach((text, index) => {
      for (const rule of RULES) {
        const candidate = rule.raw ? text : code[index];
        if (rule.pattern.test(candidate)) {
          violations.push({ file: relative(root, file).replaceAll('\\', '/'), line: index + 1, pattern: rule.label, text: text.trim() });
        }
      }
    });
  }
  return violations;
};

describe('React 19 modern syntax gate', () => {
  it('production src uses React 19 idioms only (no forwardRef/legacy APIs/ts-ignore)', () => {
    const violations = scan(collect(SRC), SRC);
    const detail = violations.map((violation) => violation.file + ':' + violation.line + ' ' + violation.pattern + ' | ' + violation.text).join('\n');
    expect(violations, 'legacy React/TypeScript idioms in production src:\n' + detail).toEqual([]);
  });

  it('negative fixture proves every rule has teeth', () => {
    const violations = scan(collect(FIXTURE), FIXTURE);
    expect(violations.length).toBeGreaterThanOrEqual(RULES.length);
    for (const rule of RULES) expect(violations.some((violation) => violation.pattern === rule.label), 'rule not detected: ' + rule.label).toBe(true);
  });
});
