import { Effect, Option, Schema } from 'effect';
import { finiteNumber } from '@/api/primitives.schema';

/**
 * Search params parsed on every canonical route. Every known key is optional and
 * falls back to `undefined` instead of failing the navigation, so a malformed
 * link can never blank the page.
 *
 * TanStack Router's default search parser JSON-parses values such as `1` or
 * `true`, so text params accept string/number/boolean and are re-serialized
 * symmetrically. The object is loose: unknown debug params are preserved
 * unchanged, while the listed product params stay validated.
 *
 * The helpers below only convert generic router search values; feature-specific
 * conversions live in the owning feature module (for example
 * features/catalog/search.ts), so this generic router utility never imports a
 * feature. Pages no longer read `location` for product state.
 */
const textParam = Schema.optional(Schema.Union([Schema.String, finiteNumber, Schema.Boolean])).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
);
const themeParam = Schema.optional(Schema.Literals(['dark', 'light'])).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
);
export const routerSearchSchema = Schema.StructWithRest(Schema.Struct({
  lang: textParam, theme: themeParam, siteId: textParam, modal: textParam,
  mode: textParam, perf: textParam, domain: textParam, category: textParam,
  q: textParam, hideDrafts: textParam, compare: textParam,
}), [Schema.Record(Schema.String, Schema.Unknown)]);
export type RouterSearch = typeof routerSearchSchema.Type;
export const decodeRouterSearch = Schema.decodeUnknownSync(routerSearchSchema);

/** Coerce a validated router search value into display text. */
export function searchText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function searchFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Stable query-string form used for comparisons and preference parsing. */
export function searchToQueryString(search: RouterSearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}
