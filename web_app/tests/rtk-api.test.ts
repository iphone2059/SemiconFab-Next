import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { twinApi } from '../src/store/api';

const NativeRequest = globalThis.Request;
const createStore = () => configureStore({ reducer: { [twinApi.reducerPath]: twinApi.reducer }, middleware: defaults => defaults().concat(twinApi.middleware) });
const stores: ReturnType<typeof createStore>[] = [];
function freshStore() { const store = createStore(); stores.push(store); return store; }
beforeEach(() => {
  // The browser resolves same-origin relative URLs; Node's Request needs a base.
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
    }
  });
});
afterEach(() => { stores.splice(0).forEach(store => store.dispatch(twinApi.util.resetApiState())); vi.unstubAllGlobals(); });

it('uses browser fetch, same-origin credentials and uncached requests without a client secret', async () => {
  let request: Request | undefined;
  vi.stubGlobal('fetch', function (this: unknown, input: Request) {
    expect(this).toBe(globalThis);
    request = input;
    return Promise.resolve(Response.json([]));
  });
  await expect(freshStore().dispatch(twinApi.endpoints.getRuns.initiate()).unwrap()).resolves.toEqual([]);
  expect(request?.url).toBe('http://localhost/api/v1/runs');
  expect(request?.credentials).toBe('same-origin');
  expect(request?.cache).toBe('no-store');
  expect(request?.headers.has('X-Fab-Dev-Key')).toBe(false);
});

it('encodes catalog filters and equipment site identities on the active endpoints', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (request: Request) => { urls.push(request.url); return Response.json({}); });
  const store = freshStore();
  await store.dispatch(twinApi.endpoints.getCatalog.initiate({ domain: 'FAB', category: 'dry_etch', q: 'A&B' })).unwrap();
  await store.dispatch(twinApi.endpoints.getEquipmentStatus.initiate('site/1')).unwrap();
  expect(urls).toEqual(['http://localhost/api/v1/catalog?domain=FAB&category=dry_etch&q=A%26B', 'http://localhost/api/v1/sites/site%2F1/equipment-status']);
});

it('preserves ProblemDetails and HTTP status for UI error rendering', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ title: '身份拒绝', detail: '缺少开发密钥' }, { status: 401 }));
  await expect(freshStore().dispatch(twinApi.endpoints.getRuns.initiate()).unwrap()).rejects.toEqual({ status: 401, data: { title: '身份拒绝', detail: '缺少开发密钥' } });
});

it('sends JSON and idempotency on the current createRun mutation', async () => {
  let captured: Request | undefined;
  vi.stubGlobal('fetch', async (request: Request) => { captured = request; return Response.json({ runId: 'run-1' }); });
  const request = { scenario: { siteId: 'site-1' } };
  await freshStore().dispatch(twinApi.endpoints.createRun.initiate({ request, idempotencyKey: 'request-1' })).unwrap();
  expect(captured?.method).toBe('POST');
  expect(captured?.headers.get('Idempotency-Key')).toBe('request-1');
  expect(captured?.headers.has('X-Fab-Dev-Key')).toBe(false);
  expect(await captured?.json()).toEqual(request);
});

it('propagates query cancellation to the active transport', async () => {
  let captured: Request | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', (request: Request) => new Promise<Response>((_resolve, reject) => {
    captured = request; started();
    request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const operation = freshStore().dispatch(twinApi.endpoints.getRuns.initiate());
  await ready;
  operation.abort();
  await expect(operation.unwrap()).rejects.toMatchObject({ name: 'AbortError' });
  expect(captured?.signal.aborted).toBe(true);
});

it('retains non-JSON gateway errors instead of reporting a successful response', async () => {
  vi.stubGlobal('fetch', async () => new Response('Bad gateway', { status: 502 }));
  await expect(freshStore().dispatch(twinApi.endpoints.getRuns.initiate()).unwrap()).rejects.toMatchObject({ status: 'PARSING_ERROR', originalStatus: 502, data: 'Bad gateway' });
});
