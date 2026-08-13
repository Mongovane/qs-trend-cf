/** 统一 JSON 响应与环境读取工具。 */

export interface Env {
  SCAN_KV?: KVNamespace;
  SCORING_PROFILE?: string;
  SCAN_UNIVERSE?: string;
  SCAN_BATCH_SIZE?: string;
  BREADTH_MAX_PAGES?: string;
  UPSTREAM_PROXY_BASE?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function errorJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** 安全解析 count 参数：非法或超限时回退。 */
export function parseCount(url: URL, def = 250, max = 10000): number {
  const raw = url.searchParams.get('count');
  if (raw === null) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v <= 0) return def;
  return Math.min(v, max);
}

export function parseSymbol(url: URL): string {
  return (url.searchParams.get('symbol') ?? '').trim();
}

export function parsePeriod(url: URL): 'day' | 'week' | 'month' {
  const p = (url.searchParams.get('period') ?? 'day').trim();
  return p === 'week' || p === 'month' ? p : 'day';
}

export function scoringProfile(env: Env): 'legacy' | 'enhanced' {
  return env.SCORING_PROFILE === 'legacy' ? 'legacy' : 'enhanced';
}

/** 统一异常包装，避免把堆栈泄露到前端。 */
export async function guard(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
}
