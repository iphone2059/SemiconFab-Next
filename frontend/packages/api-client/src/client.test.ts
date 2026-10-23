import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from './index';

describe('HTTP contract', () => {
  it('preserves ProblemDetails and status on failure', async () => {
    const api = new ApiClient(async () => new Response(JSON.stringify({ title: '身份拒绝', detail: '缺少开发密钥' }), { status: 401 }));
    await expect(api.sites()).rejects.toMatchObject({ status: 401, message: '缺少开发密钥' });
  });
  it('passes abort and idempotency headers without sending a browser secret', async () => {
    const controller = new AbortController();
    let sent: RequestInit | undefined;
    const api = new ApiClient(async (_url, init) => { sent = init; return new Response('{}'); });
    await api.createRun({ scenario: { contractVersion: 1, siteId: 's', mode: 'INDEPENDENT', masterSeed: '42', durationUs: '60000000', warmupUs: '0', fabs: [] } }, 'request-1', controller.signal);
    expect(new Headers(sent?.headers).get('Idempotency-Key')).toBe('request-1');
    expect(new Headers(sent?.headers).has('X-Fab-Dev-Key')).toBe(false);
    expect(sent?.signal).toBe(controller.signal);
  });
  it('reports non-JSON gateway errors explicitly', async () => {
    const api = new ApiClient(async () => new Response('Bad gateway', { status: 502 }));
    await expect(api.sites()).rejects.toBeInstanceOf(ApiError);
  });
});
