import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api-client';

afterEach(() => vi.unstubAllGlobals());

describe('HTTP contract', () => {
  it('calls the browser fetch function with its global receiver', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('[]'));
    });
    await expect(new ApiClient().sites()).resolves.toEqual([]);
  });
  it('encodes catalog query parameters and uses the existing abortable transport', async () => {
    let sentUrl = '';
    let sent: RequestInit | undefined;
    const api = new ApiClient(async (url, init) => {
      sentUrl = String(url);
      sent = init;
      return new Response('{}');
    });
    const controller = new AbortController();
    await api.catalog({ domain: 'FAB', category: 'dry_etch', q: 'A&B' }, controller.signal);
    expect(sentUrl).toBe('/api/v1/catalog?domain=FAB&category=dry_etch&q=A%26B');
    expect(sent?.signal).toBe(controller.signal);
    expect(new Headers(sent?.headers).has('X-Fab-Dev-Key')).toBe(false);
  });
  it('requests the server equipment status feed with an abort signal', async () => {
    let sentUrl = '';
    let sent: RequestInit | undefined;
    const controller = new AbortController();
    const api = new ApiClient(async (url, init) => {
      sentUrl = String(url);
      sent = init;
      return new Response(JSON.stringify({ siteId: 's', generatedAt: 'now', tools: [] }));
    });
    await api.equipmentStatus('site-1', controller.signal);
    expect(sentUrl).toBe('/api/v1/sites/site-1/equipment-status');
    expect(sent?.signal).toBe(controller.signal);
  });
  it('preserves ProblemDetails and status on failure', async () => {
    const api = new ApiClient(
      async () =>
        new Response(JSON.stringify({ title: '身份拒绝', detail: '缺少开发密钥' }), {
          status: 401,
        }),
    );
    await expect(api.sites()).rejects.toMatchObject({ status: 401, message: '缺少开发密钥' });
  });
  it('passes abort and idempotency headers without sending a browser secret', async () => {
    const controller = new AbortController();
    let sent: RequestInit | undefined;
    const api = new ApiClient(async (_url, init) => {
      sent = init;
      return new Response('{}');
    });
    await api.createRun(
      {
        scenario: {
          contractVersion: 1,
          siteId: 's',
          mode: 'INDEPENDENT',
          masterSeed: '42',
          durationUs: '60000000',
          warmupUs: '0',
          fabs: [],
        },
      },
      'request-1',
      controller.signal,
    );
    expect(new Headers(sent?.headers).get('Idempotency-Key')).toBe('request-1');
    expect(new Headers(sent?.headers).has('X-Fab-Dev-Key')).toBe(false);
    expect(sent?.signal).toBe(controller.signal);
  });
  it('reports non-JSON gateway errors explicitly', async () => {
    const api = new ApiClient(async () => new Response('Bad gateway', { status: 502 }));
    await expect(api.sites()).rejects.toBeInstanceOf(ApiError);
  });
});
