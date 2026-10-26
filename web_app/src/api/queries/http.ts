/**
 * Shared HTTP transport for TanStack Query modules. It mirrors the RTK
 * fetchBaseQuery contract that M1/M2 replace: same-origin credentials, no-store
 * caching, relative paths (the dev proxy injects X-Fab-Dev-Key server-side) and
 * ProblemDetails-aware errors. JSON parsing is followed by module-level Zod
 * validation so the query cache never stores an unvalidated payload.
 */
export function problemDetail(raw: string): string {
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

async function readBody(response: Response): Promise<string> {
  return response.text();
}

export async function fetchText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const raw = await readBody(response);
  if (!response.ok) {
    const detail = problemDetail(raw);
    throw new Error(`请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  return raw;
}

export async function fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const raw = await fetchText(path, init);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('API 返回了非 JSON 响应 / API response was not JSON');
  }
}
