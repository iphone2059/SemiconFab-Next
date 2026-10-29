/**
 * Single HTTP transport for the browser API layer (R-10).
 *
 * One policy owns every request: same-origin credentials, no-store caching, a same-origin
 * relative path (the Vite dev proxy injects X-Fab-Dev-Key server-side; the browser never
 * holds the client secret), AbortSignal pass-through and ProblemDetails-aware errors.
 * Payload validation stays in the schema layer: this module only owns bytes/status/error
 * semantics, so no response data is coerced here.
 */

import { Effect, Schema } from 'effect';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export class NetworkUnavailable extends Error {
  readonly _tag = 'NetworkUnavailable';
  constructor(readonly cause: unknown) { super(cause instanceof Error ? cause.message : 'Network unavailable'); }
}
/**
 * The physical request was aborted without the caller's init.signal being the
 * cause: the fiber was interrupted (timeout/dispose). Gateway implementations map
 * this to CommandRequestAborted — cancellation is not a business failure.
 */
export class RequestAborted extends Error {
  readonly _tag = 'RequestAborted';
  constructor(readonly cause: unknown) { super(cause instanceof Error ? cause.message : 'Request aborted'); }
}
export class HttpFailure extends Error {
  readonly _tag = 'HttpFailure';
  /** Parsed ProblemDetails body when the error response was JSON; undefined otherwise. */
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); }
}
export class IdempotencyConflict extends Error {
  readonly _tag = 'IdempotencyConflict';
  readonly status = 409;
  /** Parsed ProblemDetails body when the error response was JSON; undefined otherwise. */
  constructor(message: string, readonly body?: unknown) { super(message); }
}
export class InvalidServerResponse extends Error {
  readonly _tag = 'InvalidServerResponse';
  constructor(message: string, readonly cause?: unknown) { super(message); }
}
export class CommandIdentityMismatch extends Error {
  readonly _tag = 'CommandIdentityMismatch';
  constructor(readonly fields: readonly string[]) { super('command response identity mismatch: ' + fields.join(', ')); }
}
export class InvalidRequest extends Error {
  readonly _tag = 'InvalidRequest';
  constructor(message: string, readonly cause?: unknown) { super(message); }
}
export type ApiError = NetworkUnavailable | RequestAborted | HttpFailure | IdempotencyConflict | InvalidServerResponse | CommandIdentityMismatch | InvalidRequest;
export interface HttpTransportOptions { readonly fetchImpl?: FetchLike; }
export interface HttpTransport {
  fetchText(path: string, init?: RequestInit): Effect.Effect<string, ApiError>;
  fetchJson(path: string, init?: RequestInit): Effect.Effect<unknown, ApiError>;
  problemDetail(raw: string): string;
}

/** Schema failures are expected failures, with decoding services checked at the boundary. */
export const decodeApiResponse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, label: string) =>
  (input: unknown): Effect.Effect<S['Type'], InvalidServerResponse> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(cause =>
      new InvalidServerResponse(label + ': ' + cause.message, cause)));

const defaultFetch: FetchLike = (target, init) => fetch(target, init);

/** True for the raw abort rejection of an interrupted fetch (never a business failure). */
function isAbortCause(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('name' in cause)) return false;
  return cause.name === 'AbortError';
}

/** ProblemDetails bodies are parsed only when the gateway actually sent JSON; never coerced. */
function parseProblemBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

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

/** Injectable, lazy and interruptible: the fiber signal reaches fetch and body consumption. */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const fetchText = (path: string, init: RequestInit = {}): Effect.Effect<string, ApiError> => Effect.gen(function*() {
    yield* Effect.try({ try: () => { assertSameOriginPath(path); assertNoIdentitySecret(init.headers); },
      catch: cause => new InvalidRequest(cause instanceof Error ? cause.message : 'Invalid API request', cause) });
    if (init.signal?.aborted) return yield* Effect.interrupt;
    const { response, raw } = yield* Effect.tryPromise({
      try: async signal => {
        const response = await fetchImpl(path, { ...init, credentials: 'same-origin', cache: 'no-store',
          signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
        return { response, raw: await response.text() };
      },
      // A caller-initiated init.signal abort keeps the historical interrupt exit;
      // the fiber-interruption abort is a typed RequestAborted (cancellation) error.
      catch: cause => isAbortCause(cause) && !init.signal?.aborted
        ? new RequestAborted(cause)
        : new NetworkUnavailable(cause),
    }).pipe(Effect.catchTag('NetworkUnavailable', error => init.signal?.aborted ? Effect.interrupt : Effect.fail(error)));
    if (!response.ok) {
      const detail = problemDetail(raw);
      const message = '请求失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : '');
      const body = parseProblemBody(raw);
      return yield* Effect.fail(response.status === 409 ? new IdempotencyConflict(message, body) : new HttpFailure(response.status, message, body));
    }
    return raw;
  });
  const fetchJson = (path: string, init?: RequestInit): Effect.Effect<unknown, ApiError> => Effect.gen(function*() {
    const raw = yield* fetchText(path, init);
    return yield* Effect.try({ try: (): unknown => JSON.parse(raw),
      catch: cause => new InvalidServerResponse('API 返回了非 JSON 响应 / API response was not JSON', cause) });
  });
  return { fetchText, fetchJson, problemDetail };
}
export const httpTransport: HttpTransport = createHttpTransport();
