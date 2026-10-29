/**
 * Map an unknown API/worker error to the Workbench's user-facing message.
 * (No server payload is cached here; this only formats an error.)
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { status?: unknown; data?: unknown; error?: unknown };
    if (value.data && typeof value.data === 'object') {
      const detail =
        (value.data as { detail?: unknown; title?: unknown }).detail ??
        (value.data as { title?: unknown }).title;
      if (typeof detail === 'string') return detail;
    }
    if (typeof value.data === 'string') return value.data.slice(0, 180);
    if (typeof value.error === 'string') return value.error;
    if (value.status !== undefined) return `HTTP ${String(value.status)}`;
  }
  return '未知错误';
}
