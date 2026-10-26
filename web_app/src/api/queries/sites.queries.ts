import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { SiteDto } from '../../contracts';
import { queryKeys } from './queryKeys';

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

function problemDetail(raw: string): string {
  try {
    const body: unknown = JSON.parse(raw);
    if (body && typeof body === 'object') {
      const value = body as { detail?: unknown; title?: unknown };
      if (typeof value.detail === 'string' && value.detail) return value.detail;
      if (typeof value.title === 'string' && value.title) return value.title;
    }
  } catch {
    /* Non-JSON gateway bodies fall back to their raw text. */
  }
  return raw.trim().slice(0, 180);
}

/**
 * Fetch and validate the sites document exactly like the RTK transport it
 * replaces: same-origin credentials, no-store cache semantics and a relative URL
 * (the dev proxy injects X-Fab-Dev-Key server-side; the browser never holds the
 * client secret).
 */
export async function fetchSites(fetcher: typeof fetch = globalThis.fetch): Promise<SiteDto[]> {
  const response = await fetcher('/api/v1/sites', { credentials: 'same-origin', cache: 'no-store' });
  const raw = await response.text();
  if (!response.ok) {
    const detail = problemDetail(raw);
    throw new Error(`站点 API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('站点 API 返回了非 JSON 响应 / sites response was not JSON');
  }
  const parsed = sitesSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`站点响应格式无效 / invalid sites response: ${issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : 'unknown'}`);
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
