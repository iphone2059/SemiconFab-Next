import { z } from 'zod';

/**
 * Search params forwarded across the permanent legacy aliases and route
 * redirects. Every known key is optional and falls back to `undefined` instead of
 * failing the navigation, so a malformed link can never blank the page.
 *
 * TanStack Router's default search parser JSON-parses values such as `1` or
 * `true`, so text params accept string/number/boolean and are re-serialized
 * symmetrically. The object is loose: unknown legacy/debug params (for example
 * ?liteDebug=1 on the old /twin alias) are forwarded unchanged rather than
 * silently dropped, while the listed product params stay validated.
 */
const textParam = z.union([z.string(), z.number(), z.boolean()]).optional().catch(undefined);

export const routerSearchSchema = z.looseObject({
  lang: textParam,
  theme: z.enum(['dark', 'light']).optional().catch(undefined),
  siteId: textParam,
  modal: textParam,
  mode: textParam,
  perf: textParam,
  domain: textParam,
  category: textParam,
  q: textParam,
  hideDrafts: textParam,
  compare: textParam,
});

export type RouterSearch = z.infer<typeof routerSearchSchema>;
