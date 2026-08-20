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

/**
 * 解析并严格校验股票代码。
 *
 * 只接受 6 位数字，可选 .SH/.SZ/.BJ/.SS 后缀（大小写不敏感）。
 * 非法输入返回空字符串，由调用方决定如何处理。
 *
 * 为什么必须校验：symbol 会流入
 *   1. KV 缓存 key（污染/耗尽风险）
 *   2. 上游 API 的 secid 参数（注入风险）
 * 不校验的话，恶意或畸形输入会造成缓存投毒或上游请求异常。
 */
export function parseSymbol(url: URL): string {
  const raw = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  // 去掉市场后缀后必须是纯 6 位数字
  const code = raw.replace(/\.(SH|SZ|BJ|SS)$/i, '');
  if (!/^\d{6}$/.test(code)) return '';
  return code;
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
