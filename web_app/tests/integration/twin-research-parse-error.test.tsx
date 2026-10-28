// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { TwinPage } from '../../src/features/twin/twin-page';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { ResearchReplay } from '../../src/research-replay';
import { useLocaleStore } from '../../src/state/localeStore';
import { resetTwinUiStore } from '../../src/state/twinUiStore';
import { resetTwinPageStore } from '../../src/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore } from '../../src/state/twinDemoStore';

/**
 * A16 (twin-page portion): a ResearchReplay.parse exception must surface a
 * distinct, visible parse error state instead of silently becoming undefined and
 * reusing the network researchError. src/research-replay.ts itself is owned by
 * another task; this test only mocks the parser call.
 */

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTwinUiStore(); resetTwinPageStore(); resetRuntimeStore(); resetTwinDemoStore();
});

it('A16: shows a distinct visible research parse error when ResearchReplay.parse throws', async () => {
  useLocaleStore.setState({ language: 'zh', theme: 'light' }, true);
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/twin/events-t1-fifo.jsonl')) {
      return Promise.resolve(new Response('{"timestamp_sec":1,"event_type":"wip_sample","payload":{"wip_count":5}}\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    }
    return new Promise(() => {});
  }));
  vi.spyOn(ResearchReplay, 'parse').mockImplementation(() => {
    throw new Error('RangeError: Maximum call stack size exceeded');
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
  render(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-1" search={{ mode: 'research', modal: 'arch' }} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(document.querySelector('.twin-research-parse-error')).not.toBeNull());
  const parseError = document.querySelector('.twin-research-parse-error') as HTMLElement;
  expect(parseError.textContent).toContain('回放数据解析失败');
  expect(parseError.textContent).toContain('RangeError');
  // The network error state stays separate and is not wrongly reported.
  expect(document.body.textContent).not.toContain('回放加载失败');
  expect(document.querySelector('#research-hud')).not.toBeNull();
  expect(ResearchReplay.parse).toHaveBeenCalled();
  client.clear();
});
