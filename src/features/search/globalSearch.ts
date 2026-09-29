import { fetchJson } from "../../lib/api";
import type { SessionSearchResponse } from "../../shared/sessionSearch";

export interface GlobalSearchResponse extends SessionSearchResponse {
  query: string;
}

/** 全局搜索的客户端入口。`limit` 由服务端再夹一次（1..100）。 */
export async function searchGlobalSessions(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<GlobalSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 30) });
  return fetchJson<GlobalSearchResponse>(`/api/search?${params.toString()}`, {
    signal: options.signal,
  });
}