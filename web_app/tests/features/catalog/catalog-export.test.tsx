// @vitest-environment jsdom
import { resetCatalogState, resetLocaleState } from '../../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
const { registry, render } = createAtomTestScope();
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { CatalogPage } from '@/catalog/catalog-page';
import { createTestRuntime, seedCatalog, ResourceTestProviders } from '../../support/resource-test-runtime.tsx';


import {
  CATALOG_EXPORT_FILENAME,
  catalogExportDocument,
  catalogRecordFilename,
} from '@/catalog/catalog-export';
import {
  createDownloadLifecycle,
  type DownloadEnvironment,
} from '@/catalog/download-lifecycle';

/** Injectable platform boundary: no browser timer/URL/anchor is used directly. */
function lifecycleFixture() {
  const revoke = vi.fn();
  const startDownload = vi.fn();
  const scheduled = new Map<number, () => void>();
  const pageHideListeners = new Set<() => void>();
  let nextTask = 0;
  let nextUrl = 0;
  const environment: DownloadEnvironment = {
    createObjectUrl: vi.fn(() => `blob:${++nextUrl}`),
    revokeObjectUrl: revoke,
    schedule: (callback) => {
      const id = ++nextTask;
      scheduled.set(id, callback);
      return () => scheduled.delete(id);
    },
    onPageHide: (listener) => {
      pageHideListeners.add(listener);
      return () => pageHideListeners.delete(listener);
    },
    startDownload,
  };
  return {
    environment,
    revoke,
    startDownload,
    runScheduled(): void {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    firePageHide(): void {
      for (const listener of [...pageHideListeners]) listener();
    },
    pendingTasks: () => scheduled.size,
    pageHideListenerCount: () => pageHideListeners.size,
  };
}

const entry: CatalogEntryDto = {
  recordId: '3acd7b05-e6e8-5312-bb5b-045e7dd3074b',
  vendor: 'Canon',
  model: 'FPA',
  category: 'lithography',
  domain: 'FAB',
  conformanceLevel: 'draft',
  completenessPct: 50,
  missingFields: ['physical.depth_mm'],
  price: null,
  legacy: {},
  record: {
    record_id: '3acd7b05-e6e8-5312-bb5b-045e7dd3074b',
    identity: {
      vendor: { value: 'Canon' },
      model: { value: 'FPA' },
      category: { value: 'lithography' },
    },
    physical: {
      width_mm: { value: 2300, unit: 'mm', provenance: { tier: 'inferred', source: 'https://example.test/spec' } },
    },
  },
};

describe('catalog export document', () => {
  it('exports the representation entries, not the raw reference rows', () => {
    const document = catalogExportDocument([entry], { importId: 'snapshot-1', localPreview: false });
    expect(document.contractVersion).toBe(1);
    expect(document.importId).toBe('snapshot-1');
    expect(document.source).toBe('SemiconFab-main');
    expect(document.entries).toEqual([entry]);
    // The raw record/legacy payloads stay nested per entry for traceability.
    expect(document.entries[0].record).toBe(entry.record);
    expect(catalogExportDocument([entry], { importId: 'local.json', localPreview: true }).source)
      .toBe('LOCAL_PREVIEW');
    expect(CATALOG_EXPORT_FILENAME).toBe('semiconfab-catalog.json');
    expect(catalogRecordFilename(entry.recordId)).toBe(`${entry.recordId}.json`);
  });
});

describe('object URL download lifecycle', () => {
  it('hands the URL to the download and revokes it after the deferred task', () => {
    const fixture = lifecycleFixture();
    const lifecycle = createDownloadLifecycle(fixture.environment);
    const url = lifecycle.save(new Blob(['{}']), 'catalog.json');

    expect(fixture.startDownload).toHaveBeenCalledWith(url, 'catalog.json');
    expect(fixture.revoke).not.toHaveBeenCalled();
    expect(lifecycle.activeCount()).toBe(1);

    fixture.runScheduled();
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(lifecycle.activeCount()).toBe(0);
    // A later backstop must not revoke the same URL twice.
    fixture.firePageHide();
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });

  it('uses pagehide as an explicit backstop for every pending URL', () => {
    const fixture = lifecycleFixture();
    const lifecycle = createDownloadLifecycle(fixture.environment);
    const first = lifecycle.save(new Blob(['a']), 'a.json');
    const second = lifecycle.save(new Blob(['b']), 'b.json');
    expect(lifecycle.activeCount()).toBe(2);

    fixture.firePageHide();
    expect(fixture.revoke.mock.calls).toEqual([[first], [second]]);
    expect(lifecycle.activeCount()).toBe(0);
    // The deferred tasks were cancelled, so a later tick cannot double-revoke.
    expect(fixture.pendingTasks()).toBe(0);
    fixture.runScheduled();
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
  });

  it('releases the URL immediately when the download cannot start', () => {
    const fixture = lifecycleFixture();
    fixture.startDownload.mockImplementation(() => {
      throw new Error('blocked');
    });
    const lifecycle = createDownloadLifecycle(fixture.environment);

    expect(() => lifecycle.save(new Blob(['{}']), 'catalog.json')).toThrow('blocked');
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('blob:1');
    expect(lifecycle.activeCount()).toBe(0);
    expect(fixture.pendingTasks()).toBe(0);
  });

  it('dispose unsubscribes the backstop and releases pending URLs', () => {
    const fixture = lifecycleFixture();
    const lifecycle = createDownloadLifecycle(fixture.environment);
    const url = lifecycle.save(new Blob(['{}']), 'catalog.json');

    lifecycle.dispose();
    expect(fixture.pageHideListenerCount()).toBe(0);
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(fixture.pendingTasks()).toBe(0);
    fixture.firePageHide();
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });
});

describe('catalog page export integration', () => {
  let createObjectUrl: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
  let click: MockInstance;

  function restoreUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', original: PropertyDescriptor | undefined): void {
    if (original) Object.defineProperty(URL, name, original);
    else delete (URL as unknown as Record<string, unknown>)[name];
  }
  let originalCreate: PropertyDescriptor | undefined;
  let originalRevoke: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetCatalogState(registry);
    resetLocaleState(registry);
    localStorage.clear();
    vi.useFakeTimers();
    originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    createObjectUrl = vi.fn(() => 'blob:catalog-export');
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectUrl });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    click.mockRestore();
    restoreUrlMethod('createObjectURL', originalCreate);
    restoreUrlMethod('revokeObjectURL', originalRevoke);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderPage() {
    const queryClient = createTestRuntime(registry);
    seedCatalog(queryClient, {
      importId: 'snapshot-1',
      totalCount: 1,
      matchedCount: 1,
      categories: [{ category: 'lithography', domain: 'FAB', count: 1 }],
      items: [entry],
    });
    return render(
      <ResourceTestProviders runtime={queryClient}>
        <CatalogPage view="catalog" search={{}} onSearchChange={() => {}} onViewChange={() => {}} />
      </ResourceTestProviders>,
    );
  }

  it('downloads the catalog through the revocable lifecycle and releases the URL', async () => {
    const view = renderPage();
    fireEvent.click(screen.getByRole('button', { name: '导出目录' }));

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = createObjectUrl.mock.calls[0][0];
    const payload = JSON.parse(await blob.text()) as { contractVersion: number; importId: string; source: string };
    expect(payload).toMatchObject({ contractVersion: 1, importId: 'snapshot-1', source: 'SemiconFab-main' });
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:catalog-export');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('releases a pending download URL when the page unmounts before the deferred task', () => {
    const view = renderPage();
    fireEvent.click(screen.getByRole('button', { name: '导出目录' }));
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:catalog-export');
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });
});
