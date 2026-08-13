/**
 * 上游数据请求层。
 *
 * 与原 Python 版的差异（Cloudflare Workers 运行时约束）：
 *  1. 原版通过 monkey-patch `socket.getaddrinfo` 把 push2his 强行解析到
 *     push2delay 的 IP（117.184.45.167）。Workers 的 fetch 无法覆写 DNS，
 *     因此改为「host 池顺序重试」——把 push2delay 放在池首即可达到同样效果。
 *  2. 原版用模块级 dict 做进程内缓存。Workers isolate 会被随时回收，
 *     因此改为「isolate 内存 + Cache API」双层缓存，Cache API 免费且不计 KV 配额。
 *  3. 新增 UPSTREAM_PROXY_BASE：当边缘节点无法直连境内行情源时，
 *     可配置一个反向代理前缀兜底。
 */

export interface FetchEnv {
  UPSTREAM_PROXY_BASE?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
];

let uaIdx = 0;
function nextUa(): string {
  uaIdx = (uaIdx + 1) % UA_POOL.length;
  return UA_POOL[uaIdx];
}

/* ---------------- host 池 ---------------- */

/** 实时行情类。push2delay 放首位（原版 DNS 劫持的等价做法）。 */
export const QUOTE_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://push2test.eastmoney.com',
];

/** 历史资金流类。 */
export const HIS_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2his.eastmoney.com',
  'https://push2test.eastmoney.com',
  'https://82.push2his.eastmoney.com',
  'https://90.push2his.eastmoney.com',
];

/** 东财 K 线类。 */
export const EM_KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://push2test.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2his.eastmoney.com',
];

/** 盘中分时资金流。 */
export const RT_FLOW_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://90.push2.eastmoney.com',
];

export const SEARCH_HOST = 'https://searchapi.eastmoney.com';
export const TENCENT_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
export const SINA_KLINE =
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

/** 东财通用 ut 令牌（公开接口固定值）。 */
export const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

/* ---------------- 缓存 ---------------- */

interface MemEntry { value: unknown; expires: number; }
const memCache = new Map<string, MemEntry>();
const MEM_MAX = 400;

function memGet<T>(key: string): T | undefined {
  const e = memCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) {
    memCache.delete(key);
    return undefined;
  }
  return e.value as T;
}

function memSet(key: string, value: unknown, ttlMs: number): void {
  if (memCache.size >= MEM_MAX) {
    const firstKey = memCache.keys().next().value;
    if (firstKey !== undefined) memCache.delete(firstKey);
  }
  memCache.set(key, { value, expires: Date.now() + ttlMs });
}

const CACHE_ORIGIN = 'https://qs-trend-cache.internal';

/**
 * 双层缓存包装：isolate 内存（毫秒级命中）+ Cloudflare Cache API（跨 isolate 共享）。
 * Cache API 免费且不占用 KV 配额，非常适合行情这种高频只读数据。
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = memGet<T>(key);
  if (hit !== undefined) return hit;

  const cacheKey = new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`);
  let cache: Cache | undefined;
  try {
    cache = (caches as unknown as { default: Cache }).default;
  } catch {
    cache = undefined;
  }

  if (cache) {
    try {
      const res = await cache.match(cacheKey);
      if (res) {
        const value = (await res.json()) as T;
        memSet(key, value, Math.min(ttlSeconds, 15) * 1000);
        return value;
      }
    } catch {
      /* 缓存读取失败不影响主流程 */
    }
  }

  const value = await producer();
  memSet(key, value, Math.min(ttlSeconds, 15) * 1000);

  if (cache && value !== undefined && value !== null) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(value), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `max-age=${ttlSeconds}`,
          },
        }),
      );
    } catch {
      /* 写缓存失败忽略 */
    }
  }
  return value;
}

/* ---------------- 请求 ---------------- */

function buildUrl(base: string, path: string, params: Record<string, string>, env?: FetchEnv): string {
  const qs = new URLSearchParams(params).toString();
  const raw = `${base}${path}${qs ? `?${qs}` : ''}`;
  const proxy = env?.UPSTREAM_PROXY_BASE?.trim();
  if (proxy) return `${proxy.replace(/\/$/, '')}/${encodeURIComponent(raw)}`;
  return raw;
}

function timeoutMs(env?: FetchEnv): number {
  const v = Number(env?.UPSTREAM_TIMEOUT_MS ?? '8000');
  return Number.isFinite(v) && v > 0 ? v : 8000;
}

/** 单次带超时的 GET，返回文本。 */
export async function getText(url: string, env?: FetchEnv, referer = 'https://quote.eastmoney.com/'): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': nextUa(),
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: referer,
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 东财 API 请求，带 host 池轮换。
 * 与原版一致：当返回体的 data.klines 为空数组时视为该 host 无效，继续下一个。
 */
export async function getJsonEastmoney(
  path: string,
  params: Record<string, string>,
  hostPool: readonly string[],
  env?: FetchEnv,
): Promise<Record<string, any> | null> {
  for (let attempt = 0; attempt < hostPool.length; attempt++) {
    const url = buildUrl(hostPool[attempt], path, params, env);
    const text = await getText(url, env);
    if (!text) continue;
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (data && data.data !== null && data.data !== undefined) {
      const d = data.data;
      if (d && typeof d === 'object' && 'klines' in d && (!d.klines || d.klines.length === 0)) {
        continue; // 该 host 返回空 klines，换下一个
      }
      return data;
    }
  }
  return null;
}

/** 直接请求任意 URL 并解析 JSON（腾讯/新浪等非东财源）。 */
export async function getJson(url: string, env?: FetchEnv, referer?: string): Promise<any | null> {
  const finalUrl = env?.UPSTREAM_PROXY_BASE
    ? `${env.UPSTREAM_PROXY_BASE.replace(/\/$/, '')}/${encodeURIComponent(url)}`
    : url;
  const text = await getText(finalUrl, env, referer);
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 带并发上限的批量执行，避免一次性打爆子请求配额。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
