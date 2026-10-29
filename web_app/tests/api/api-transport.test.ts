import { afterEach, expect, it, vi } from 'vitest';
import {
  createHttpTransport,
  httpTransport,
  problemDetail,
  type FetchLike,
} from '@/api/http.transport';

/**
 * R-10 contract for the single API transport shared by every query/mutation module.
 *
 * The transport owns one HTTP policy: same-origin credentials, no-store caching, a
 * same-origin relative path, AbortSignal pass-through, ProblemDetails-aware errors and
 * no browser-side identity secret. Request/response validation stays in the schema layer.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const textResponse = (text: string, status = 200) => new Response(text, { status });

const capture = () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({ ok: true });
  });
  return { fetchImpl, calls };
};

afterEach(() => vi.unstubAllGlobals());

it('defaults to same-origin credentials and no-store caching on a relative URL', async () => {
  const { fetchImpl, calls } = capture();
  const transport = createHttpTransport({ fetchImpl });
  await expect(transport.fetchJson('/api/v1/sites')).resolves.toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].input).toBe('/api/v1/sites');
  expect(calls[0].init).toEqual({ credentials: 'same-origin', cache: 'no-store' });
});

it('merges call-site init over the defaults and passes the AbortSignal through', async () => {
  const { fetchImpl, calls } = capture();
  const controller = new AbortController();
  const transport = createHttpTransport({ fetchImpl });
  await transport.fetchJson('/api/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: '{"lotCount":3}',
    signal: controller.signal,
  });
  expect(calls[0].init).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    method: 'POST',
    body: '{"lotCount":3}',
  });
  expect(calls[0].init?.signal).toBe(controller.signal);
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.get('Idempotency-Key')).toBe('idem-1');
});

it('cannot override same-origin credentials or no-store policy', async () => {
  const { fetchImpl, calls } = capture();
  const transport = createHttpTransport({ fetchImpl });
  await transport.fetchText('/api/v1/sites', { credentials: 'include', cache: 'force-cache' });
  expect(calls[0].init?.credentials).toBe('same-origin');
  expect(calls[0].init?.cache).toBe('no-store');
});

it('rejects when the caller aborts the request', async () => {
  const controller = new AbortController();
  const fetchImpl: FetchLike = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller signal')));
  });
  const transport = createHttpTransport({ fetchImpl });
  const pending = transport.fetchText('/twin/events-t1-fifo.jsonl', { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow(/aborted by caller signal/);
});

it('rejects absolute, protocol-relative and backslash paths so credentials stay same-origin', async () => {
  const { fetchImpl, calls } = capture();
  const transport = createHttpTransport({ fetchImpl });
  for (const path of ['https://evil.example/api/v1/runs', 'http://127.0.0.1:5080/api/v1/runs', '//evil.example/api', 'api/v1/runs', '/\\evil.example/api']) {
    await expect(transport.fetchJson(path), path).rejects.toThrow(/same-origin relative path|相对路径/);
  }
  expect(calls).toHaveLength(0);
});

it('never sends the server-side development identity key from the browser', async () => {
  const { fetchImpl, calls } = capture();
  const transport = createHttpTransport({ fetchImpl });
  await transport.fetchJson('/api/v1/sites');
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.has('X-Fab-Dev-Key')).toBe(false);
  expect(headers.has('Authorization')).toBe(false);
  await expect(transport.fetchJson('/api/v1/sites', { headers: { 'X-Fab-Dev-Key': 'secret' } })).rejects.toThrow(/X-Fab-Dev-Key/);
  await expect(transport.fetchJson('/api/v1/sites', { headers: new Headers({ 'x-fab-dev-key': 'secret' }) })).rejects.toThrow(/X-Fab-Dev-Key/);
  await expect(transport.fetchJson('/api/v1/runs', { headers: [['X-Fab-Dev-Key', 'secret']] })).rejects.toThrow(/X-Fab-Dev-Key/);
  expect(calls).toHaveLength(1);
});

it('uses the current global fetch by default', async () => {
  const mock = vi.fn<typeof fetch>(async () => jsonResponse({ sites: [] }));
  vi.stubGlobal('fetch', mock);
  await expect(httpTransport.fetchJson('/api/v1/sites')).resolves.toEqual({ sites: [] });
  await expect(createHttpTransport().fetchText('/api/v1/sites')).resolves.toBe(JSON.stringify({ sites: [] }));
  expect(mock).toHaveBeenCalledTimes(2);
});

it('keeps transports isolated: injection is per instance, not global mutable state', async () => {
  const first = createHttpTransport({ fetchImpl: async () => jsonResponse({ transport: 'first' }) });
  const second = createHttpTransport({ fetchImpl: async () => jsonResponse({ transport: 'second' }) });
  await expect(first.fetchJson('/api/v1/runs')).resolves.toEqual({ transport: 'first' });
  await expect(second.fetchJson('/api/v1/runs')).resolves.toEqual({ transport: 'second' });
});

it('extracts ProblemDetails detail/title and falls back to trimmed raw text', () => {
  expect(problemDetail(JSON.stringify({ title: 't', detail: 'd' }))).toBe('d');
  expect(problemDetail(JSON.stringify({ title: 't' }))).toBe('t');
  expect(problemDetail(JSON.stringify({ title: 't', detail: '' }))).toBe('t');
  expect(problemDetail('  Bad gateway  ')).toBe('Bad gateway');
  expect(problemDetail('')).toBe('');
  expect(problemDetail(JSON.stringify({ detail: 42, title: null }))).toBe('{"detail":42,"title":null}');
  expect(problemDetail('x'.repeat(300))).toHaveLength(180);
});

it('keeps the Chinese status-aware ProblemDetails error for every verb', async () => {
  const transport = createHttpTransport({
    fetchImpl: async () => jsonResponse({ title: '身份拒绝', detail: '缺少开发密钥' }, 401),
  });
  await expect(transport.fetchJson('/api/v1/runs')).rejects.toThrow(/HTTP 401[\s\S]*缺少开发密钥/);
  await expect(transport.fetchText('/api/v1/runs')).rejects.toThrow(/HTTP 401[\s\S]*缺少开发密钥/);
});

it('falls back to the raw body of a non-JSON gateway error', async () => {
  const transport = createHttpTransport({ fetchImpl: async () => textResponse('Bad gateway', 502) });
  await expect(transport.fetchJson('/api/v1/runs')).rejects.toThrow(/HTTP 502[\s\S]*Bad gateway/);
});

it('rejects a non-JSON success body instead of returning undefined', async () => {
  const transport = createHttpTransport({ fetchImpl: async () => textResponse('not json', 200) });
  await expect(transport.fetchJson('/twin/routes.json')).rejects.toThrow(/非 JSON/);
});

it('returns the raw text for text endpoints without parsing it', async () => {
  const transport = createHttpTransport({ fetchImpl: async () => textResponse('{"a":1}\n') });
  await expect(transport.fetchText('/twin/events-t1-fifo.jsonl')).resolves.toBe('{"a":1}\n');
});
