/**
 * 板块对比。
 *
 * 数据源：东方财富公开接口
 *   行业板块列表：push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2
 *   个股所属行业：push2.eastmoney.com/api/qt/stock/get?fields=f100,f127
 *   板块 K 线：   push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BKxxxx
 *
 * 输出：
 *   - 个股所属行业名称与代码
 *   - 行业当日涨跌幅
 *   - 行业近 5/20/60 日涨跌幅
 *   - 个股 vs 行业的相对强度（RS）
 *   - 行业在全市场的排名（按今日涨幅）
 */
import type { Kline } from '../types';
import { cached, getJsonEastmoney, EM_UT, QUOTE_HOSTS, EM_KLINE_HOSTS, type FetchEnv } from '../data/http';
import { pyRound } from '../util/pynum';

export interface IndustryFlow {
  code: string;
  name: string;
  /** 主力净流入（元） */
  mainNetInflow: number;
  /** 涨跌幅 */
  pct: number;
}

export interface SectorInfo {
  /** 行业名称 */
  name: string;
  /** 行业板块代码（BKxxxx） */
  code: string;
  /** 当日涨跌幅 */
  pct: number;
  /** 近 5 日涨跌幅 */
  pct5d: number | null;
  /** 近 20 日涨跌幅 */
  pct20d: number | null;
  /** 近 60 日涨跌幅 */
  pct60d: number | null;
  /** 行业在全市场排名（1 = 最强） */
  rank: number | null;
  /** 全市场行业总数 */
  totalSectors: number;
  /** 个股 vs 行业的相对强度 RS（>1 = 跑赢行业） */
  relativeStrength: number | null;
  /** 行业领涨股 */
  leader: string | null;
  /** 行业资金流排名（按主力净流入降序） */
  flowRank: number | null;
  /** 行业主力净流入（亿） */
  mainNetInflow: number | null;
}

/** 获取行业资金流排名（主力净流入 Top/Bottom）。 */
export async function fetchIndustryFlowRanking(env?: FetchEnv): Promise<IndustryFlow[]> {
  return cached('industry_flow_rank', 180, async () => {
    const data = await getJsonEastmoney('/api/qt/clist/get', {
      fs: 'm:90+t:2',
      fields: 'f12,f14,f3,f62',  // f62 = 主力净流入
      fid: 'f62',
      po: '1',
      pn: '1',
      pz: '50',
      np: '1',
      fltt: '2',
      ut: EM_UT,
    }, QUOTE_HOSTS, env);
    const diff: any[] = data?.data?.diff ?? [];
    return diff.map((d: any) => ({
      code: String(d.f12 ?? ''),
      name: String(d.f14 ?? ''),
      mainNetInflow: Number(d.f62 ?? 0),
      pct: Number(d.f3 ?? 0),
    })).filter((s) => s.code);
  });
}

/** 获取个股所属行业。 */
export async function fetchStockSector(symbol: string, env?: FetchEnv): Promise<{ name: string; code: string } | null> {
  return cached(`sector_of_${symbol}`, 3600, async () => {
    const secid = symbol.startsWith('6') || symbol.startsWith('5') ? `1.${symbol}` : `0.${symbol}`;
    const data = await getJsonEastmoney('/api/qt/stock/get', {
      secid,
      fields: 'f100,f127',
      ut: EM_UT,
    }, QUOTE_HOSTS, env);
    const d = data?.data;
    if (!d) return null;
    const name = d.f100 ? String(d.f100) : null;
    const code = d.f127 ? String(d.f127) : null;
    if (!name || !code) return null;
    return { name, code: `BK${String(code).padStart(4, '0')}` };
  });
}

/** 获取全部行业板块列表（今日涨跌幅排序）。 */
export async function fetchSectorList(env?: FetchEnv): Promise<Array<{ code: string; name: string; pct: number; leader: string }>> {
  return cached('sector_list', 120, async () => {
    const data = await getJsonEastmoney('/api/qt/clist/get', {
      fs: 'm:90+t:2',
      fields: 'f2,f3,f12,f14,f128',
      fid: 'f3',
      po: '1',
      pn: '1',
      pz: '100',
      np: '1',
      fltt: '2',
      ut: EM_UT,
    }, QUOTE_HOSTS, env);
    const diff: any[] = data?.data?.diff ?? [];
    return diff.map((d: any) => ({
      code: String(d.f12 ?? ''),
      name: String(d.f14 ?? ''),
      pct: Number(d.f3 ?? 0),
      leader: String(d.f128 ?? ''),
    })).filter((s) => s.code && s.name);
  });
}

/** 获取板块 K 线（用于计算多周期涨跌幅）。 */
async function fetchSectorKline(sectorCode: string, count = 65, env?: FetchEnv): Promise<Kline[]> {
  return cached(`sector_kl_${sectorCode}_${count}`, 300, async () => {
    // 东财板块 secid 格式：90.BKxxxx
    const secid = `90.${sectorCode}`;
    const data = await getJsonEastmoney('/api/qt/stock/kline/get', {
      secid,
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: 'f51,f52,f53,f54,f55,f56',
      klt: '101',
      fqt: '1',
      lmt: String(count),
      end: '20500101',
      ut: EM_UT,
    }, EM_KLINE_HOSTS, env);
    const lines: string[] = data?.data?.klines ?? [];
    const out: Kline[] = [];
    for (const line of lines) {
      const p = line.split(',');
      if (p.length < 6) continue;
      out.push({
        date: p[0], open: Number(p[1]), close: Number(p[2]),
        high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]),
        amount: 0, pct: 0, turnover: 0,
      });
    }
    return out;
  });
}

/** 计算涨跌幅 */
function pctChange(arr: readonly Kline[], days: number): number | null {
  if (arr.length < days + 1) return null;
  const n = arr.length;
  const base = arr[n - days - 1].close;
  return base > 0 ? pyRound(((arr[n - 1].close - base) / base) * 100, 2) : null;
}

/**
 * 获取个股的板块对比信息。
 *
 * @param symbol   六位代码
 * @param stockPct 个股的近 20 日涨跌幅（用于计算相对强度）
 */
export async function fetchSectorComparison(
  symbol: string,
  stockPct20d?: number,
  env?: FetchEnv,
): Promise<SectorInfo | null> {
  try {
    const sector = await fetchStockSector(symbol, env);
    if (!sector) return null;

    const [sectorList, sectorKl] = await Promise.all([
      fetchSectorList(env),
      fetchSectorKline(sector.code, 65, env),
    ]);

    // 行业排名
    const sorted = [...sectorList].sort((a, b) => b.pct - a.pct);
    const rankIdx = sorted.findIndex((s) => s.code === sector.code);
    const sectorItem = sectorList.find((s) => s.code === sector.code);

    // 多周期涨跌幅
    const pct5d = pctChange(sectorKl, 5);
    const pct20d = pctChange(sectorKl, 20);
    const pct60d = pctChange(sectorKl, 60);

    // 相对强度
    let rs: number | null = null;
    if (stockPct20d !== undefined && pct20d !== null && pct20d !== 0) {
      rs = pyRound(stockPct20d / pct20d, 2);
    }

    // 资金流排名
    let flowRank: number | null = null;
    let mainNetInflow: number | null = null;
    try {
      const flows = await fetchIndustryFlowRanking(env);
      const fi = flows.findIndex((f) => f.code === sector.code);
      if (fi >= 0) {
        flowRank = fi + 1;
        mainNetInflow = pyRound(flows[fi].mainNetInflow / 1e8, 2);
      }
    } catch { /* 资金流失败不影响主流程 */ }

    return {
      name: sector.name,
      code: sector.code,
      pct: sectorItem?.pct ?? 0,
      pct5d,
      pct20d,
      pct60d,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      totalSectors: sorted.length,
      relativeStrength: rs,
      leader: sectorItem?.leader || sorted.find((s) => s.code === sector.code)?.leader || null,
      flowRank,
      mainNetInflow,
    };
  } catch {
    return null;
  }
}
