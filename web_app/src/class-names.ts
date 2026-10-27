/**
 * Local TypeScript implementation of clsx 2.1.1's token semantics.
 * Reference: https://github.com/lukeed/clsx/tree/v2.1.1
 * Copyright (c) Luke Edwards. MIT notice: /licenses/clsx.txt.
 */
export type ClassDictionary = Readonly<Record<string, unknown>>;
export type ClassValue = string | number | boolean | null | undefined | ClassDictionary | readonly ClassValue[];

function append(value: ClassValue, tokens: string[]): void {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number') {
    tokens.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) append(item, tokens);
  } else if (typeof value === 'object') {
    for (const key in value) if ((value as ClassDictionary)[key]) tokens.push(key);
  }
}

/** Merge conditional class tokens; does not deduplicate or rewrite CSS classes. */
export function classNames(...values: readonly ClassValue[]): string {
  const tokens: string[] = [];
  for (const value of values) append(value, tokens);
  return tokens.join(' ');
}
