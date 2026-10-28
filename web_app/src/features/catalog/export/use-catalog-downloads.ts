import { useEffect, useMemo } from 'react';
import { createDownloadLifecycle, type DownloadLifecycle } from './download-lifecycle';

export interface CatalogDownloads {
  /** Serialize `value` as pretty JSON and start a revocation-managed download. */
  downloadJson(value: unknown, filename: string): void;
}

/**
 * Page-owned download lifecycle. Every ObjectURL created by this page is
 * released by the lifecycle's deferred task, the pagehide backstop or this
 * effect's dispose when the page unmounts. Callers never revoke manually.
 */
export function useCatalogDownloads(): CatalogDownloads {
  const lifecycle = useMemo<DownloadLifecycle>(() => createDownloadLifecycle(), []);
  useEffect(() => () => lifecycle.dispose(), [lifecycle]);
  return useMemo(
    () => ({ downloadJson: (value: unknown, filename: string) => { lifecycle.saveJson(value, filename); } }),
    [lifecycle],
  );
}
