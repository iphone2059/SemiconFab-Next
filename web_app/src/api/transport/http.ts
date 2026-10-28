/**
 * Single HTTP transport for the browser API layer (R-10).
 *
 * One policy owns every request: same-origin credentials, no-store caching, a same-origin
 * relative path (the Vite dev proxy injects X-Fab-Dev-Key server-side; the browser never
 * holds the client secret), AbortSignal pass-through and ProblemDetails-aware errors.
 * Payload validation stays in the schema layer: this module only owns bytes/status/error
 * semantics, so no response data is coerced here.
 */

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HttpStatusError'; }
}

export interface HttpTransportOptions {
  /** Test seam; production defaults to the current global fetch. */
  readonly fetchImpl?: FetchLike;
}

export interface HttpTransport {
  /** Fetch raw text, failing on any non-2xx response. */
  fetchText(path: string, init?: RequestInit): Promise<string>;
  /** Fetch and JSON-parse a resource; the caller's schema validates the parsed value. */
  fetchJson(path: string, init?: RequestInit): Promise<unknown>;
  /** ProblemDetails summary for an error body (detail, then title, then raw text). */
  problemDetail(raw: string): string;
}

const defaultFetch: FetchLike = (target, init) => fetch(target, init);

/** The development identity secret must only ever be attached by the server-side proxy. */
const FORBIDDEN_IDENTITY_HEADERS: ReadonlyMap<string, string> = new Map([
  ['x-fab-dev-key', 'X-Fab-Dev-Key'],
]);

/** Extracts the ProblemDetails detail/title, falling back to the trimmed raw body. */
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

/**
 * Only a same-origin relative path is allowed: '//host' and '/\\host' are resolved by
 * browsers as cross-origin, and a path without a leading slash would resolve against the
 * current route. Rejecting them keeps credentials attached to this origin only.
 */
function assertSameOriginPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('API 请求路径必须是同源相对路径 / API path must be a same-origin relative path: ' + path);
  }
}

function headerNames(headers: HeadersInit): string[] {
  if (headers instanceof Headers) return [...headers.keys()];
  if (Array.isArray(headers)) return headers.map(([name]) => name);
  return Object.keys(headers);
}

function assertNoIdentitySecret(headers: HeadersInit | undefined): void {
  if (!headers) return;
  for (const name of headerNames(headers)) {
    const forbidden = FORBIDDEN_IDENTITY_HEADERS.get(name.toLowerCase());
    if (forbidden) {
      throw new Error(
        '浏览器端不得设置服务端身份密钥头 / browser requests must not set the server-side identity header: ' + forbidden,
      );
    }
  }
}

/** Builds an injectable transport; callers keep their own schema validation. */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const fetchText = async (path: string, init: RequestInit = {}): Promise<string> => {
    assertSameOriginPath(path);
    assertNoIdentitySecret(init.headers);
    const response = await fetchImpl(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
    const raw = await response.text();
    if (!response.ok) {
      const detail = problemDetail(raw);
      throw new HttpStatusError(response.status, '请求失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''));
    }
    return raw;
  };
  const fetchJson = async (path: string, init?: RequestInit): Promise<unknown> => {
    const raw = await fetchText(path, init);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('API 返回了非 JSON 响应 / API response was not JSON');
    }
  };
  return { fetchText, fetchJson, problemDetail };
}

/**
 * Process-wide transport used by the query/mutation modules. Tests that inspect the wire
 * call create their own instance through createHttpTransport({ fetchImpl }).
 */
export const httpTransport: HttpTransport = createHttpTransport();
