import type { CreateRunRequest, RunResult, RunSummary, SiteDto } from '@fab/contracts';
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class ApiClient {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.transport(`/api/v1${path}`, { ...init, cache: 'no-store', credentials: 'same-origin' });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { if (response.ok) throw new ApiError(response.status, 'API 返回了无效 JSON'); }
    if (!response.ok) {
      const problem = typeof body === 'object' && body !== null ? body : {};
      const detail = 'detail' in problem && typeof problem.detail === 'string' ? problem.detail : 'title' in problem && typeof problem.title === 'string' ? problem.title : `HTTP ${response.status}：${text.slice(0, 180) || response.statusText}`;
      throw new ApiError(response.status, detail);
    }
    return body as T;
  }
  sites(signal?: AbortSignal): Promise<SiteDto[]> { return this.request('/sites', { signal }); }
  runs(signal?: AbortSignal): Promise<RunSummary[]> { return this.request('/runs', { signal }); }
  run(id: string, signal?: AbortSignal): Promise<RunSummary> { return this.request(`/runs/${encodeURIComponent(id)}`, { signal }); }
  results(id: string, signal?: AbortSignal): Promise<RunResult> { return this.request(`/runs/${encodeURIComponent(id)}/results`, { signal }); }
  createRun(request: CreateRunRequest, key: string, signal?: AbortSignal): Promise<RunSummary> {
    if (!key.trim()) return Promise.reject(new Error('Idempotency-Key 必填'));
    return this.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(request), signal });
  }
}
