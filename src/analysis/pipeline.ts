/**
 * 完整分析管线（/api/analyze 与扫描器共用）。
 * 对应 app.py::handle_analyze 与 _scan_one_stock 的公共部分。
 */
import type { Kline, MarketBreadth, OptimizedSignal, Quote } from '../types';
import { fetchFundFlow, fetchKline, fetchQuote, klineToDict, quoteToDict } from '../data/fetcher';
import type { FetchEnv } from '../data/http';
import { runAnalysis, type ScoringProfile } from '../analysis/signalEngine';
import { applyBreadthToMScore, applySignalOptimization, toOptimizable } from '../analysis/optimizer';
import { fmt, fmtSigned } from '../util/pynum';
import { elapsedTradingMinutes } from '../util/tradingClock';
import { calcChipDistribution, chipSummary } from './chipDistribution';
import { detectCandlePatterns } from './candlePatterns';


export interface AnalyzeOptions {
  symbol: string;
  period?: 'day' | 'week' | 'month';
  profile?: ScoringProfile;
  indexKlines?: readonly Kline[] | null;
  breadth?: MarketBreadth | null;
  /** 扫描场景关闭 enrich 以节省子请求 */
  enrich?: boolean;
  /** 扫描场景只需评分，跳过 K 线序列化 */
  lite?: boolean;
}

export interface AnalyzeOutcome {
  ok: boolean;
  error?: string;
  symbol: string;
  quote: Quote | null;
  klines: Kline[];
  signal: OptimizedSignal | null;
  flows: Array<Record<string, unknown>>;
}

/** 运行分析并完成两步后处理（市场宽度修正 M 分 → 信号优化）。 */
export async function analyzeSymbol(opts: AnalyzeOptions, env?: FetchEnv): Promise<AnalyzeOutcome> {
  const { symbol } = opts;
  const period = opts.period ?? 'day';
  const profile = opts.profile ?? 'enhanced';

  const klines = await fetchKline(symbol, { count: 250, period, enrich: opts.enrich !== false }, env);
  if (klines.length < 30) {
    return {
      ok: false,
      error: `K线数据不足: ${klines.length}条`,
      symbol, quote: null, klines: [], signal: null, flows: [],
    };
  }

  const [quote, flows] = await Promise.all([
    fetchQuote(symbol, env),
    fetchFundFlow(symbol, 30, env),
  ]);

  // 实盘路径传入交易时钟，使量比按市场通行口径做时间归一化
  const result = runAnalysis(
    klines, quote, flows, opts.indexKlines ?? null, profile,
    undefined, elapsedTradingMinutes(),
  );
  const signal = toOptimizable(result);

  applyBreadthToMScore(signal, opts.breadth, !opts.lite);
  applySignalOptimization(signal);

  return {
    ok: true,
    symbol,
    quote,
    klines,
    signal,
    flows: opts.lite
      ? []
      : flows.map((f) => ({
          date: f.date,
          main_net: f.main_net,
          super_large_net: f.super_large_net,
          large_net: f.large_net,
          main_pct: f.main_pct,
        })),
  };
}

/** 构建大盘环境摘要文本（对应 app.py 的 market_env）。 */
export function buildMarketEnv(
  indexKlines: readonly Kline[] | null | undefined,
  breadth: MarketBreadth | null | undefined,
): string {
  if (!indexKlines || indexKlines.length < 20) return '';
  const n = indexKlines.length;
  const idxClose = indexKlines[n - 1].close;
  const idxPct = indexKlines[n - 1].pct;
  const idx20d =
    n >= 21 && indexKlines[n - 21].close
      ? ((indexKlines[n - 1].close - indexKlines[n - 21].close) / indexKlines[n - 21].close) * 100
      : 0;
  let env = `上证${fmt(idxClose, 1)}(${fmtSigned(idxPct, 2)}%) 20日${fmtSigned(idx20d, 1)}%`;
  if (breadth) {
    env += ` | ${breadth.up}涨${breadth.down}跌(${Math.round((breadth.breadth_ratio ?? 0) * 100)}%上涨)`;
    if (breadth.partial) env += ' [抽样]';
  }
  return env;
}

/** 组装 /api/analyze 的完整响应体。 */
export function buildAnalyzeResponse(
  outcome: AnalyzeOutcome,
  marketEnv: string,
  breadth: MarketBreadth | null | undefined,
): Record<string, unknown> {
  const { symbol, quote, klines, signal, flows } = outcome;
  return {
    symbol,
    name: quote ? quote.name : '',
    quote: quote ? quoteToDict(quote) : null,
    signal,
    klines: klines.slice(Math.max(0, klines.length - 120)).map(klineToDict),
    flows,
    market_env: marketEnv,
    breadth: breadth ?? null,
    analyzed_at: new Date().toISOString(),
    // 筹码分布
    chips: (() => {
      const chip = calcChipDistribution(klines, 120, quote?.price);
      if (!chip) return null;
      return {
        profitRatio: chip.profitRatio,
        avgCost: chip.avgCost,
        cost90: chip.cost90,
        cost70: chip.cost70,
        concentration: chip.concentration,
        peakPrice: chip.peakPrice,
        inDenseZone: chip.inDenseZone,
        resistancePrice: chip.resistancePrice,
        supportPrice: chip.supportPrice,
        summary: chipSummary(chip, quote?.price || klines[klines.length - 1].close),
        distribution: chip.distribution,
      };
    })(),
    // K线形态
    candlePatterns: detectCandlePatterns(klines).map(p => ({
      name: p.name, label: p.label, index: p.index, date: klines[p.index]?.date ?? '',
      direction: p.direction, reliability: p.reliability, description: p.description,
    })),
  };
}
