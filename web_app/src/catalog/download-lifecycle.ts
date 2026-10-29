/**
 * Object-URL download lifecycle.
 *
 * A Blob URL must stay alive long enough for the browser to queue the download,
 * then be released. A single fixed timer is not a trustworthy release protocol:
 * browsers differ in when they read the URL, a failed click would leak it, and a
 * page navigation could drop it while the browser still needs it. This lifecycle
 * owns every URL it creates and releases it on the first applicable path:
 *
 *  1. the deferred revocation task (normal completion; cancellable),
 *  2. the document pagehide backstop (navigation / tab close), and
 *  3. the page's unmount dispose (SPA route change).
 *
 * An error while starting the download releases the URL immediately. Release is
 * idempotent, so racing paths revoke each URL exactly once.
 */

export interface DownloadEnvironment {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  /** Run `callback` later; returns a cancellation that clears the pending task. */
  schedule(callback: () => void, delayMs: number): () => void;
  /** Register the pagehide backstop; returns an unsubscribe. */
  onPageHide(listener: () => void): () => void;
  /** Hand the URL to the browser download machinery. */
  startDownload(href: string, filename: string): void;
}

export interface DownloadLifecycle {
  /** Start a download for `blob` and return its object URL (already released if the start fails). */
  save(blob: Blob, filename: string): string;
  saveJson(value: unknown, filename: string): string;
  /** Release one URL exactly once; false when it is already gone. */
  release(url: string): boolean;
  releaseAll(): void;
  /** Unsubscribe the pagehide backstop and release every pending URL. */
  dispose(): void;
  /** Number of URLs still waiting for a release. */
  activeCount(): number;
}

/**
 * The normal release happens in a browser task after the click, not on a fixed
 * wall-clock delay. The pagehide/dispose backstops cover navigation and errors.
 */
export const DOWNLOAD_REVOCATION_DELAY_MS = 0;

const noop = (): void => {};

function browserEnvironment(): DownloadEnvironment {
  return {
    createObjectUrl: (blob) => {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('Object URLs are unavailable.');
      }
      return URL.createObjectURL(blob);
    },
    revokeObjectUrl: (url) => {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    },
    schedule: (callback, delayMs) => {
      // Server rendering never starts a download; run it inline so the URL can
      // never outlive a caller that has no event loop, and report noop cancel.
      if (typeof window === 'undefined') {
        callback();
        return noop;
      }
      const id = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(id);
    },
    onPageHide: (listener) => {
      if (typeof window === 'undefined') return noop;
      window.addEventListener('pagehide', listener);
      return () => window.removeEventListener('pagehide', listener);
    },
    startDownload: (href, filename) => {
      if (typeof document === 'undefined') throw new Error('Downloads require a document.');
      const link = document.createElement('a');
      link.href = href;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },
  };
}

export function createDownloadLifecycle(
  overrides: Partial<DownloadEnvironment> = {},
): DownloadLifecycle {
  const environment: DownloadEnvironment = { ...browserEnvironment(), ...overrides };
  /** URL -> cancellation of the deferred revocation. */
  const pending = new Map<string, () => void>();
  let pageHideOff: (() => void) | null = null;

  function watchPageHide(): void {
    if (pageHideOff) return;
    pageHideOff = environment.onPageHide(() => releaseAll());
  }

  function release(url: string): boolean {
    const cancel = pending.get(url);
    if (cancel === undefined) return false;
    pending.delete(url);
    cancel();
    environment.revokeObjectUrl(url);
    return true;
  }

  function releaseAll(): void {
    for (const url of [...pending.keys()]) release(url);
  }

  function save(blob: Blob, filename: string): string {
    const url = environment.createObjectUrl(blob);
    // Track the URL before the click so an exception cannot leak it. The empty
    // cancellation is replaced by the scheduled one after the download starts.
    pending.set(url, noop);
    watchPageHide();
    try {
      environment.startDownload(url, filename);
    } catch (cause) {
      release(url);
      throw cause;
    }
    const cancel = environment.schedule(() => {
      release(url);
    }, DOWNLOAD_REVOCATION_DELAY_MS);
    // A schedule implementation may run the callback inline; never resurrect an
    // already released URL in the pending map.
    if (pending.has(url)) pending.set(url, cancel);
    return url;
  }

  return {
    save,
    saveJson: (value, filename) =>
      save(
        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
        filename,
      ),
    release,
    releaseAll,
    dispose: () => {
      pageHideOff?.();
      pageHideOff = null;
      releaseAll();
    },
    activeCount: () => pending.size,
  };
}
