import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('injects only the server key and replaces a browser-supplied key in a real proxy request', async () => {
  const key = process.env.FAB_DEVELOPMENT_KEY;
  const target = process.env.FAB_API_TARGET;
  const serverKey = 'test-only-server-key-not-a-user-secret';
  const upstream = createHttpServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ correctKey: request.headers['x-fab-dev-key'] === serverKey, path: request.url }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.FAB_DEVELOPMENT_KEY = serverKey;
  process.env.FAB_API_TARGET = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const vite = await createServer({ configFile: join(import.meta.dirname, '../../vite.config.ts'), logLevel: 'silent', server: { port: 0, strictPort: false, host: '127.0.0.1' } });
  try {
    await vite.listen();
    const port = (vite.httpServer?.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sites`, { headers: { 'X-Fab-Dev-Key': 'browser-cannot-choose-the-key' } });
    expect(await response.json()).toEqual({ correctKey: true, path: '/api/v1/sites' });
    const entry = await fetch(`http://127.0.0.1:${port}/src/main.tsx`);
    expect(await entry.text()).not.toContain(serverKey);
  } finally {
    await vite.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (key === undefined) delete process.env.FAB_DEVELOPMENT_KEY; else process.env.FAB_DEVELOPMENT_KEY = key;
    if (target === undefined) delete process.env.FAB_API_TARGET; else process.env.FAB_API_TARGET = target;
  }
});
