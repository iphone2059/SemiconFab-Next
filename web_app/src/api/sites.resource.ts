import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { SiteDto } from '@/contracts/app-contracts';
import { createHttpTransport, type FetchLike } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

const fabSchema = z.object({
  fabId: z.string().min(1),
  code: z.string().min(1),
});

const siteSchema = z.object({
  siteId: z.string().min(1),
  code: z.string().min(1),
  templateHash: z.string(),
  fabs: z.array(fabSchema).min(1),
});

const sitesSchema = z.array(siteSchema);

/**
 * Fetch and validate the sites document through the shared HTTP transport: same-origin
 * credentials, no-store cache semantics and a relative URL (the dev proxy injects
 * X-Fab-Dev-Key server-side; the browser never holds the client secret).
 */
export async function fetchSites(fetcher: FetchLike = globalThis.fetch): Promise<SiteDto[]> {
  const payload = await createHttpTransport({ fetchImpl: fetcher }).fetchJson('/api/v1/sites');
  const parsed = sitesSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const problem = issue ? (issue.path.join('.') || 'root') + ': ' + issue.message : 'unknown';
    throw new Error('站点响应格式无效 / invalid sites response: ' + problem);
  }
  return parsed.data;
}

export const sitesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.sites.all,
    queryFn: () => fetchSites(),
    staleTime: 30_000,
  });


/** Route-param -> site lookup; the URL owns FAB identity in M1. */
export function findSiteByFabId(sites: readonly SiteDto[], fabId: string): SiteDto | undefined {
  return sites.find((site) => site.fabs.some((fab) => fab.fabId === fabId));
}
