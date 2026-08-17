/**
 * 数据层。移植自 data/kline_fetcher.py。
 *
 * 数据源策略（与原版一致）：
 *  - K线价格/成交量：腾讯前复权 → 新浪（不复权）→ 东财（最后兜底）
 *  - K线成交额/换手率：东财 K 线接口按日期补充
 *  - 实时行情：东财 stock/get（fltt=2）
 *  - 资金流：东财 fflow/daykline
 *  - 搜索：东财 suggest
 */
import type {
  FundFlow, Kline, MarketBreadth, MinuteData, MinuteFlow, Period, Quote, SearchItem, StockListItem,
} from '../types';
import { pyRound, toFloat } from '../util/pynum';
import {
  EM_KLINE_HOSTS, EM_UT, HIS_HOSTS, QUOTE_HOSTS, RT_FLOW_HOSTS, SEARCH_HOST,
  SINA_KLINE, TENCENT_KLINE, cached, getJson, getJsonEastmoney, mapLimit, type FetchEnv,
} from './http';

/** 实时数据缓存 TTL（秒）。 */
const RT_TTL = 3;
/** K线/资金流缓存 TTL（秒）。 */
const STD_TTL = 20;

function emptyKline(date: string, open: number, close: number, high: number, low: number, volume: number): Kline {
  return { date, open, close, high, low, volume, amount: 0, pct: 0, turnover: 0 };
}

/* ---------------- 代码转换 ---------------- */

export function symbolToSecid(symbol: string): string {
  const s = String(symbol).trim().padStart(6, '0');
  if (s.startsWith('920')) return `0.${s}`;
  if (/^[5679]/.test(s)) return `1.${s}`;
  return `0.${s}`;
}

export function symbolToTencent(symbol: string): string {
  const s = symbol.trim();
  if (s.startsWith('6') || s.startsWith('5')) return `sh${s}`;
  if (s.startsWith('920')) return `bj${s}`;
  return `sz${s}`;
}

function sinaSymbol(symbol: string): string {
  const s = symbol.trim();
  if (s.startsWith('6') || s.startsWith('5')) return `sh${s}`;
  if (s.startsWith('920')) return `bj${s}`;
  return `sz${s}`;
}

/* ---------------- K线 ---------------- */

async function fetchKlineTencent(
  symbol: string, count: number, period: Period, adjust: string, env?: FetchEnv,
): Promise<Kline[]> {
  const tc = symbolToTencent(symbol);
  const fq = adjust || '';
  const url = `${TENCENT_KLINE}?param=${encodeURIComponent(`${tc},${period},,,${count},${fq}`)}`;
  const data = await getJson(url, env, 'https://gu.qq.com/');
  if (!data || data.code !== 0) return [];
  const stockData = data?.data?.[tc] ?? {};
  const key = period === 'day' ? `${fq}day` : period === 'week' ? `${fq}week` : `${fq}month`;
  const rows: any[] = stockData[key] ?? stockData.day ?? stockData.week ?? [];
  const klines: Kline[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const k = emptyKline(
      String(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5]) || 0,
    );
    if (klines.length) {
      const prev = klines[klines.length - 1].close;
      k.pct = prev ? pyRound(((k.close - prev) / prev) * 100, 2) : 0;
    }
    klines.push(k);
  }
  return klines;
}

async function fetchKlineSina(symbol: string, count: number, period: Period, env?: FetchEnv): Promise<Kline[]> {
  const scaleMap: Record<Period, string> = { day: '240', week: '1200', month: '7200' };
  const params = new URLSearchParams({
    symbol: sinaSymbol(symbol), scale: scaleMap[period] ?? '240', ma: 'no', datalen: String(count),
  });
  const data = await getJson(`${SINA_KLINE}?${params}`, env, 'https://finance.sina.com.cn/');
  if (!Array.isArray(data)) return [];
  const klines: Kline[] = [];
  for (const row of data) {
    if (!row || !row.day) continue;
    // 新浪返回成交量单位为「股」，统一折算为「手」与腾讯口径对齐
    const volShares = Number(row.volume) || 0;
    const k = emptyKline(
      String(row.day), Number(row.open), Number(row.close), Number(row.high), Number(row.low), volShares / 100,
    );
    if (klines.length) {
      const prev = klines[klines.length - 1].close;
      k.pct = prev ? pyRound(((k.close - prev) / prev) * 100, 2) : 0;
    }
    klines.push(k);
  }
  return klines;
}

async function fetchKlineEastmoney(symbol: string, count: number, period: Period, env?: FetchEnv): Promise<Kline[]> {
  const klt = period === 'day' ? '101' : period === 'week' ? '102' : '103';
  const data = await getJsonEastmoney('/api/qt/stock/kline/get', {
    secid: symbolToSecid(symbol), ut: EM_UT,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt, fqt: '1', lmt: String(count), end: '20500101',
  }, EM_KLINE_HOSTS, env);
  const lines: string[] = data?.data?.klines ?? [];
  const klines: Kline[] = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 7) continue;
    const k = emptyKline(p[0], Number(p[1]), Number(p[2]), Number(p[3]), Number(p[4]), Number(p[5]));
    k.amount = toFloat(p[6]) ?? 0;
    if (p.length >= 11) k.turnover = toFloat(p[10]) ?? 0;
    if (klines.length) {
      const prev = klines[klines.length - 1].close;
      k.pct = prev ? pyRound(((k.close - prev) / prev) * 100, 2) : 0;
    }
    klines.push(k);
  }
  return klines;
}

/** 从东财补充成交额与换手率（按日期匹配）。 */
async function enrichFromEastmoney(symbol: string, count: number, klines: Kline[], env?: FetchEnv): Promise<void> {
  const requestCount = Math.min(count + 60, 500);
  const data = await getJsonEastmoney('/api/qt/stock/kline/get', {
    secid: symbolToSecid(symbol), ut: EM_UT,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101', fqt: '0', lmt: String(requestCount), end: '20500101',
  }, EM_KLINE_HOSTS, env);
  const lines: string[] = data?.data?.klines ?? [];
  if (!lines.length) return;
  const map = new Map<string, [number, number]>();
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 11) continue;
    map.set(p[0], [toFloat(p[6]) ?? 0, toFloat(p[10]) ?? 0]);
  }
  for (const k of klines) {
    const hit = map.get(k.date);
    if (hit) {
      k.amount = hit[0];
      k.turnover = hit[1];
    }
  }
}

/**
 * 数据校验。
 *
 * 原实现只检查**结构一致性**（high≥low、low≤close 等）和一个绝对上限，
 * 完全没有**量级合理性**检查。于是一根 low=0.5 / high=750 / close=743 的
 * 脏数据能通过全部 8 项检查：high≥low 成立、low≤close 成立、close<10000 成立。
 *
 * 后果是灾难性的：
 *   1. ECharts 的 y 轴被迫从 0 起画，真实价格结构被压进顶部 1/4，图表报废
 *   2. ATR / N值 / 通道下轨 / 止损全部被这一根污染
 *   3. 而界面不会有任何异常提示，因为每一项校验都"通过"了
 *
 * A股有涨跌幅限制，单日振幅存在物理上限：
 *   主板 ±10% → high/low ≤ 1.222   双创 ±20% → ≤ 1.5   北交所 ±30% → ≤ 1.857
 * 取 2.2 作为统一上限（留出复权、新股首日、长期停牌复牌的余量）。
 */
const MAX_INTRADAY_RANGE_RATIO = 2.2;
/** 相邻两日收盘价的最大跳变倍数。超过说明复权口径断裂或数据错行。 */
const MAX_GAP_RATIO = 2.5;

function validateKlines(klines: readonly Kline[]): Kline[] {
  const out: Kline[] = [];
  let dropped = 0;
  for (const k of klines) {
    // ── 原有的结构一致性检查 ──
    const structOk = k.close > 0 && k.high > 0 && k.low > 0 && k.open > 0
      && k.high >= k.low && k.high >= k.close && k.high >= k.open
      && k.low <= k.close && k.low <= k.open
      && k.close < 100000;
    if (!structOk) { dropped += 1; continue; }

    // ── 新增：单日振幅不可能超过涨跌停允许的范围 ──
    if (k.high / k.low > MAX_INTRADAY_RANGE_RATIO) { dropped += 1; continue; }

    // ── 新增：相邻日跳变检查（复权断裂 / 数据错行）──
    if (out.length) {
      const prev = out[out.length - 1].close;
      if (prev > 0) {
        const r = k.close / prev;
        if (r > MAX_GAP_RATIO || r < 1 / MAX_GAP_RATIO) { dropped += 1; continue; }
      }
    }
    out.push(k);
  }
  if (dropped > 0) {
    // 上游脏数据不是罕见事件，留痕便于排查
    console.warn(`[kline] 丢弃 ${dropped} 根异常K线（共 ${klines.length} 根）`);
  }
  return out;
}

export interface FetchKlineOptions {
  count?: number;
  period?: Period;
  adjust?: string;
  /** 是否调用东财补充 amount/turnover。扫描场景关闭可节省 1/4 子请求。 */
  enrich?: boolean;
}

/** 获取 K 线数据（多源 fallback）。 */
export async function fetchKline(symbol: string, opts: FetchKlineOptions = {}, env?: FetchEnv): Promise<Kline[]> {
  const count = opts.count ?? 250;
  const period = opts.period ?? 'day';
  const adjust = opts.adjust ?? 'qfq';
  const enrich = opts.enrich !== false;
  const key = `kline_${symbol}_${count}_${period}_${adjust}_${enrich ? 1 : 0}`;

  return cached(key, STD_TTL, async () => {
    let klines = await fetchKlineTencent(symbol, count, period, adjust, env);
    if (!klines.length) klines = await fetchKlineSina(symbol, count, period, env);
    if (!klines.length) klines = await fetchKlineEastmoney(symbol, count, period, env);
    if (!klines.length || klines.length < 10) return klines;

    klines = validateKlines(klines);
    if (enrich) {
      try {
        await enrichFromEastmoney(symbol, count, klines, env);
      } catch {
        /* 补充失败不影响主流程 */
      }
    }
    return klines;
  });
}

/* ---------------- 实时行情 ---------------- */

export async function fetchQuote(symbol: string, env?: FetchEnv): Promise<Quote | null> {
  return cached(`quote_${symbol}`, RT_TTL, async () => {
    const data = await getJsonEastmoney('/api/qt/stock/get', {
      secid: symbolToSecid(symbol),
      fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f168',
      fltt: '2', invt: '2', ut: EM_UT,
    }, QUOTE_HOSTS, env);
    const d = data?.data;
    if (!d) return null;
    const q: Quote = {
      symbol,
      name: d.f58 ?? '',
      price: toFloat(d.f43) ?? 0,
      pct: toFloat(d.f170) ?? 0,
      change: toFloat(d.f169) ?? 0,
      high: toFloat(d.f44) ?? 0,
      low: toFloat(d.f45) ?? 0,
      open: toFloat(d.f46) ?? 0,
      pre_close: toFloat(d.f60) ?? 0,
      volume: toFloat(d.f47) ?? 0,
      amount: toFloat(d.f48) ?? 0,
      turnover: toFloat(d.f168) ?? 0,
    };
    return q;
  });
}

/* ---------------- 资金流 ---------------- */

export async function fetchFundFlow(symbol: string, days = 30, env?: FetchEnv): Promise<FundFlow[]> {
  return cached(`flow_${symbol}_${days}`, STD_TTL, async () => {
    const data = await getJsonEastmoney('/api/qt/stock/fflow/daykline/get', {
      lmt: String(days), klt: '101', secid: symbolToSecid(symbol),
      fields1: 'f1,f2,f3,f7', fields2: 'f51,f52,f53,f54,f55,f56,f57', ut: EM_UT,
    }, HIS_HOSTS, env);
    const lines: string[] = data?.data?.klines ?? [];
    const flows: FundFlow[] = [];
    for (const line of lines) {
      const p = line.split(',');
      if (p.length < 7) continue;
      flows.push({
        date: p[0],
        main_net: Number(p[1]),
        small_net: Number(p[2]),
        medium_net: Number(p[3]),
        large_net: Number(p[4]),
        super_large_net: Number(p[5]),
        main_pct: p[6] ? Number(p[6]) : 0,
      });
    }
    return flows.length >= 3 ? flows : [];
  });
}

export async function fetchRealtimeFlow(symbol: string, env?: FetchEnv): Promise<MinuteFlow[]> {
  return cached(`rt_flow_${symbol}`, RT_TTL, async () => {
    const data = await getJsonEastmoney('/api/qt/stock/fflow/kline/get', {
      klt: '1', secid: symbolToSecid(symbol),
      fields1: 'f1,f2,f3,f7', fields2: 'f51,f52,f53,f54,f55,f56,f57', ut: EM_UT, lmt: '300',
    }, RT_FLOW_HOSTS, env);
    const lines: string[] = data?.data?.klines ?? [];
    const flows: MinuteFlow[] = [];
    for (const line of lines) {
      const p = line.split(',');
      if (p.length < 6) continue;
      const t = p[0].includes(' ') ? p[0].split(' ').pop()! : p[0];
      flows.push({
        time: t,
        main_net: toFloat(p[1]) ?? 0,
        small_net: toFloat(p[2]) ?? 0,
        medium_net: toFloat(p[3]) ?? 0,
        large_net: toFloat(p[4]) ?? 0,
        super_large_net: toFloat(p[5]) ?? 0,
      });
    }
    return flows;
  });
}

/* ---------------- 搜索 ---------------- */

export async function searchStock(keyword: string, count = 10, env?: FetchEnv): Promise<SearchItem[]> {
  const kw = keyword.trim();
  if (!kw) return [];

  const marketOf = (code: string): SearchItem['market'] =>
    code.startsWith('6') || code.startsWith('5') ? 'SH' : code.startsWith('920') ? 'BJ' : 'SZ';

  if (/^\d{6}$/.test(kw)) {
    return [{ code: kw, name: '', market: marketOf(kw) }];
  }

  return cached(`search_${kw}_${count}`, 300, async () => {
    const params = new URLSearchParams({ input: kw, type: '14', count: String(count), ut: EM_UT });
    const body = await getJson(`${SEARCH_HOST}/api/suggest/get?${params}`, env);
    const items: any[] = body?.QuotationCodeTable?.Data ?? [];
    const results: SearchItem[] = [];
    for (const item of items) {
      const code = String(item?.Code ?? '');
      const name = String(item?.Name ?? '');
      const classify = String(item?.Classify ?? '');
      const isValid =
        classify === 'AStock' || classify === 'Fund' ||
        (code.length === 6 && '036'.includes(code[0])) ||
        code.startsWith('920') ||
        (code.length === 6 && code.startsWith('5'));
      if (isValid && code.length === 6) {
        results.push({ code, name, market: marketOf(code) });
      }
    }
    return results.slice(0, count);
  });
}

/* ---------------- 分时 ---------------- */

export async function fetchMinute(symbol: string, env?: FetchEnv): Promise<MinuteData | null> {
  return cached(`minute_${symbol}`, RT_TTL, async () => {
    const data = await getJsonEastmoney('/api/qt/stock/trends2/get', {
      secid: symbolToSecid(symbol),
      fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
      isccr: '1', ndays: '1', iscca: '0', klt: '5', fqt: '1', ut: EM_UT,
    }, QUOTE_HOSTS, env);
    const d = data?.data;
    const trends: string[] = d?.trends ?? [];
    if (!d || !trends.length) return null;

    const times: string[] = [];
    const prices: number[] = [];
    const avgPrices: number[] = [];
    const volumes: number[] = [];
    let high = 0;
    let low = 999999;
    for (const line of trends) {
      const p = line.split(',');
      if (p.length < 8) continue;
      const t = p[0].includes(' ') ? p[0].split(' ').pop()! : p[0];
      const price = p[2] ? Number(p[2]) : 0;
      times.push(t);
      prices.push(price);
      avgPrices.push(p[7] ? Number(p[7]) : 0);
      volumes.push(p[5] ? Number(p[5]) : 0);
      if (price > 0) {
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
    }
    const md: MinuteData = {
      times, prices, avg_prices: avgPrices, volumes,
      pre_close: Number(d.preClose ?? 0) || 0,
      name: d.name ?? '',
      high: high > 0 ? high : 0,
      low: low < 999999 ? low : 0,
    };
    return md;
  });
}

/* ---------------- 大盘指数 ---------------- */

const INDEX_TENCENT: Record<string, string> = {
  '000001': 'sh000001', '399001': 'sz399001', '399006': 'sz399006', '000300': 'sh000300',
};

export async function fetchIndexKline(indexCode = '000001', count = 60, env?: FetchEnv): Promise<Kline[]> {
  return cached(`index_${indexCode}_${count}`, 60, async () => {
    // 腾讯优先
    const tc = INDEX_TENCENT[indexCode] ?? (indexCode.startsWith('000') ? `sh${indexCode}` : `sz${indexCode}`);
    const url = `${TENCENT_KLINE}?param=${encodeURIComponent(`${tc},day,,,${count},`)}`;
    const data = await getJson(url, env, 'https://gu.qq.com/');
    const rows: any[] = data?.data?.[tc]?.day ?? [];
    const klines: Kline[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const k = emptyKline(String(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5]) || 0);
      if (klines.length) {
        const prev = klines[klines.length - 1].close;
        k.pct = prev ? pyRound(((k.close - prev) / prev) * 100, 2) : 0;
      }
      klines.push(k);
    }
    if (klines.length >= 10) return klines;

    // 东财兜底
    const secid = indexCode.startsWith('000') && indexCode !== '000300' ? `1.${indexCode}` : indexCode === '000300' ? `1.${indexCode}` : `0.${indexCode}`;
    const em = await getJsonEastmoney('/api/qt/stock/kline/get', {
      secid, ut: EM_UT,
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
      klt: '101', fqt: '1', lmt: String(count), end: '20500101',
    }, EM_KLINE_HOSTS, env);
    const lines: string[] = em?.data?.klines ?? [];
    const out: Kline[] = [];
    for (const line of lines) {
      const p = line.split(',');
      if (p.length < 7) continue;
      const k = emptyKline(p[0], Number(p[1]), Number(p[2]), Number(p[3]), Number(p[4]), Number(p[5]));
      k.amount = toFloat(p[6]) ?? 0;
      if (out.length) {
        const prev = out[out.length - 1].close;
        k.pct = prev ? pyRound(((k.close - prev) / prev) * 100, 2) : 0;
      }
      out.push(k);
    }
    return out;
  });
}

/* ---------------- 市场宽度 ---------------- */

const CLIST_PATH = '/api/qt/clist/get';
const A_SHARE_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

/**
 * 市场宽度（涨跌家数）。
 *
 * 原版全量抓取 ~59 页。Cloudflare Workers 免费版单次调用最多 50 个子请求，
 * 因此这里改为「按成交额排序抽取前 maxPages 页」并标记 partial=true。
 * 抽样偏差会被 applyBreadthToMScore 的分档吸收（±15 分封顶），可接受；
 * 若部署在付费计划，把 BREADTH_MAX_PAGES 调大即可恢复全量精度。
 */
export async function fetchMarketBreadth(env?: FetchEnv & { BREADTH_MAX_PAGES?: string }): Promise<MarketBreadth | null> {
  const maxPages = Math.max(1, Math.min(60, Number(env?.BREADTH_MAX_PAGES ?? '10') || 10));
  return cached(`market_breadth_${maxPages}`, 120, async () => {
    const base: Record<string, string> = {
      po: '1', np: '1', fltt: '2', fields: 'f3', fs: A_SHARE_FS, pz: '100', fid: 'f6',
    };

    const first = await getJsonEastmoney(CLIST_PATH, { ...base, pn: '1' }, QUOTE_HOSTS, env);
    const firstDiff: any[] = first?.data?.diff ?? [];
    if (!firstDiff.length) return null;
    const totalStocks: number = first?.data?.total ?? 0;
    const totalPages = totalStocks ? Math.ceil(totalStocks / 100) : 59;
    const pagesToFetch = Math.min(maxPages, totalPages);

    let up = 0, down = 0, flat = 0;
    const tally = (diff: any[]) => {
      for (const d of diff) {
        const pct = toFloat(d?.f3);
        if (pct === null || pct === 0) flat += 1;
        else if (pct > 0) up += 1;
        else down += 1;
      }
    };
    tally(firstDiff);

    if (pagesToFetch > 1) {
      const pages = Array.from({ length: pagesToFetch - 1 }, (_, i) => i + 2);
      const results = await mapLimit(pages, 6, async (pn) => {
        const r = await getJsonEastmoney(CLIST_PATH, { ...base, pn: String(pn) }, QUOTE_HOSTS, env);
        return (r?.data?.diff ?? []) as any[];
      });
      for (const diff of results) tally(diff);
    }

    const total = up + down + flat;
    if (total < 100) return null;
    const ratio = up + down > 0 ? up / Math.max(up + down, 1) : 0.5;
    const result: MarketBreadth = {
      up, down, flat, total,
      breadth_ratio: pyRound(ratio, 3),
      partial: pagesToFetch < totalPages,
      source: `eastmoney/clist top${total} (${pagesToFetch}/${totalPages}页)`,
    };
    return result;
  });
}

/**
 * A 股列表（按成交额降序）。
 * 原版全量抓取 ~5800 只；此处按 limit 截断，默认 500 只，
 * 恰好落在 Cloudflare 免费版子请求配额内。
 */
export async function fetchTopAShares(limit = 500, env?: FetchEnv): Promise<StockListItem[]> {
  const pages = Math.max(1, Math.ceil(limit / 100));
  return cached(`a_shares_top_${limit}`, 60, async () => {
    const base: Record<string, string> = {
      po: '1', np: '1', fltt: '2', fields: 'f2,f3,f6,f12,f14', fs: A_SHARE_FS, pz: '100', fid: 'f6',
    };
    const pageNums = Array.from({ length: pages }, (_, i) => i + 1);
    const chunks = await mapLimit(pageNums, 5, async (pn) => {
      const r = await getJsonEastmoney(CLIST_PATH, { ...base, pn: String(pn) }, QUOTE_HOSTS, env);
      return (r?.data?.diff ?? []) as any[];
    });
    const out: StockListItem[] = [];
    for (const diff of chunks) {
      for (const d of diff) {
        const code = String(d?.f12 ?? '').trim();
        if (code.length !== 6) continue;
        out.push({
          code,
          name: String(d?.f14 ?? '').trim(),
          price: toFloat(d?.f2) ?? 0,
          pct: toFloat(d?.f3) ?? 0,
          amount: toFloat(d?.f6) ?? 0,
        });
      }
    }
    return out.slice(0, limit);
  });
}

/* ---------------- 序列化 ---------------- */

export function klineToDict(k: Kline): Record<string, unknown> {
  return {
    date: k.date, open: k.open, close: k.close, high: k.high, low: k.low,
    volume: k.volume, amount: k.amount, pct: k.pct, turnover: k.turnover,
  };
}

export function quoteToDict(q: Quote): Record<string, unknown> {
  return {
    symbol: q.symbol, name: q.name, price: q.price, pct: q.pct, change: q.change,
    high: q.high, low: q.low, open: q.open, pre_close: q.pre_close,
    volume: q.volume, amount: q.amount, turnover: q.turnover,
  };
}
