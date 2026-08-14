/**
 * 滚动窗口优化（Walk-Forward Optimization）。
 *
 * ══ 为什么不能只做样本内网格搜索 ══
 *
 * 在同一段历史上试 200 组参数，然后挑最好的那组 —— 这几乎必然得到一个
 * 过拟合结果。原因很简单：即使策略毫无预测能力，200 次随机试验里
 * 也总会有几组「看起来很棒」。这不是策略好，是你挑出了噪声。
 *
 * 本模块的做法：
 *   1. 把历史切成 K 段，每段用「前 N 段优化 → 下一段检验」
 *   2. 只报告**样本外**拼接净值，这才是可参考的结果
 *   3. 输出样本内 vs 样本外的衰减幅度（degradation），
 *      衰减越大越说明是拟合噪声
 *   4. 输出去偏 Sharpe（Deflated Sharpe Ratio 的简化版），
 *      按试验次数惩罚，回答「这个 Sharpe 有多大概率纯属侥幸」
 *
 * 判读经验：样本外 Sharpe 不到样本内的一半，基本可以认为参数是拟合出来的。
 */
import type { Kline } from '../../src/types';
import { runBacktest, type BacktestConfig, type StrategyParams, type SymbolData, DEFAULT_PARAMS } from './engine';
import { computeMetrics, type EquityPoint, type Metrics, type Trade } from './metrics';

export interface ParamGrid {
  [K: string]: Array<number | string | boolean | string[]>;
}

/** 笛卡尔积展开参数网格。 */
export function expandGrid(grid: ParamGrid): Partial<StrategyParams>[] {
  const keys = Object.keys(grid);
  let out: Record<string, unknown>[] = [{}];
  for (const k of keys) {
    const next: Record<string, unknown>[] = [];
    for (const base of out) for (const v of grid[k]) next.push({ ...base, [k]: v });
    out = next;
  }
  return out as Partial<StrategyParams>[];
}

export interface WalkForwardOptions {
  /** 切分段数 */
  folds: number;
  /** 每次优化使用的历史段数（滚动窗口长度） */
  trainFolds: number;
  /** 选参目标函数（可对小样本给 -Infinity 以淘汰） */
  objective: (m: Metrics) => number;
  /** 报告用指标（不得返回 ±Infinity，否则衰减幅度无法计算） */
  report: (m: Metrics) => number;
  /** 最少交易笔数，低于此值的参数组直接淘汰（避免用 2 笔交易的 Sharpe 挑参数） */
  minTrades: number;
}

export const DEFAULT_WF: WalkForwardOptions = {
  folds: 5,
  trainFolds: 2,
  // 默认用 Calmar（年化/最大回撤），比 Sharpe 更贴近实际持仓体验
  objective: (m) => (m.lowSample ? -Infinity : m.calmar),
  report: (m) => (Number.isFinite(m.calmar) ? m.calmar : 0),
  minTrades: 10,
};

export interface FoldResult {
  fold: number;
  trainRange: [string, string];
  testRange: [string, string];
  bestParams: Partial<StrategyParams>;
  inSample: Metrics;
  outSample: Metrics;
}

export interface WalkForwardResult {
  folds: FoldResult[];
  /** 样本外净值拼接后的整体表现 —— 唯一可参考的数字 */
  stitched: Metrics;
  stitchedEquity: EquityPoint[];
  stitchedTrades: Trade[];
  /** 样本内均值 vs 样本外均值 */
  inSampleAvg: number;
  outSampleAvg: number;
  degradation: number;
  trialsPerFold: number;
  /** 按试验次数惩罚后的 Sharpe 显著性判断 */
  deflatedNote: string;
}

function splitCalendar(universe: readonly SymbolData[], folds: number, warmup: number): string[][] {
  const set = new Set<string>();
  for (const s of universe) for (const k of s.klines) set.add(k.date);
  const all = [...set].sort();
  const usable = all.slice(warmup);
  const size = Math.floor(usable.length / folds);
  const out: string[][] = [];
  for (let i = 0; i < folds; i++) {
    const start = i * size;
    const end = i === folds - 1 ? usable.length : start + size;
    out.push(usable.slice(start, end));
  }
  return out;
}

/**
 * 去偏 Sharpe 的粗略判断。
 * 在 N 次独立试验下，即使真实 Sharpe 为 0，观测到的最大 Sharpe 期望约为
 * sqrt(2*ln(N)) / sqrt(T) * sqrt(244)。低于该阈值的结果无法与噪声区分。
 */
function deflatedNote(observedSharpe: number, trials: number, days: number): string {
  if (days < 60 || trials < 2) return '样本或试验次数太少，无法评估显著性';
  const expectedMax = Math.sqrt(2 * Math.log(trials)) / Math.sqrt(days) * Math.sqrt(244);
  if (observedSharpe <= expectedMax) {
    return `样本外 Sharpe ${observedSharpe.toFixed(2)} ≤ ${trials} 次试验下的噪声上界 `
      + `${expectedMax.toFixed(2)} —— 无法与随机结果区分，不应据此认为策略有效`;
  }
  return `样本外 Sharpe ${observedSharpe.toFixed(2)} > 噪声上界 ${expectedMax.toFixed(2)}，`
    + `通过初步显著性检查（仍不构成有效性证明）`;
}

export function walkForward(
  universe: readonly SymbolData[],
  grid: ParamGrid,
  baseConfig: Partial<BacktestConfig> = {},
  optIn: Partial<WalkForwardOptions> = {},
  benchmark?: Kline[],
): WalkForwardResult {
  const opt: WalkForwardOptions = { ...DEFAULT_WF, ...optIn };
  const baseParams: StrategyParams = { ...DEFAULT_PARAMS, ...(baseConfig.params ?? {}) };
  const combos = expandGrid(grid);
  const segments = splitCalendar(universe, opt.folds, baseParams.warmup);

  const results: FoldResult[] = [];
  const stitchedEquity: EquityPoint[] = [];
  const stitchedTrades: Trade[] = [];
  let stitchedBuyAmount = 0;
  let capital = baseConfig.initialCapital ?? 1_000_000;
  const initialCapital = capital;

  for (let f = opt.trainFolds; f < segments.length; f++) {
    const train = segments.slice(Math.max(0, f - opt.trainFolds), f).flat();
    const test = segments[f];
    if (!train.length || !test.length) continue;
    const trainRange: [string, string] = [train[0], train[train.length - 1]];
    const testRange: [string, string] = [test[0], test[test.length - 1]];

    // ── 样本内：网格搜索 ──
    let best: { params: Partial<StrategyParams>; m: Metrics; score: number } | null = null;
    for (const combo of combos) {
      const r = runBacktest(universe, {
        ...baseConfig,
        initialCapital,
        startDate: trainRange[0],
        endDate: trainRange[1],
        benchmark,
        params: { ...baseParams, ...combo },
      });
      if (r.metrics.trades < opt.minTrades) continue;
      const score = opt.objective(r.metrics);
      if (!best || score > best.score) best = { params: combo, m: r.metrics, score };
    }
    if (!best) continue;

    // ── 样本外：用样本内选出的参数，跑下一段 ──
    const oos = runBacktest(universe, {
      ...baseConfig,
      initialCapital: capital,
      startDate: testRange[0],
      endDate: testRange[1],
      benchmark,
      params: { ...baseParams, ...best.params },
    });

    // 拼接净值：以上一段期末权益为下一段期初
    const scale = stitchedEquity.length
      ? stitchedEquity[stitchedEquity.length - 1].equity / (oos.equity[0]?.equity || capital)
      : 1;
    for (const e of oos.equity) {
      stitchedEquity.push({ ...e, equity: e.equity * scale, cash: e.cash * scale, positionValue: e.positionValue * scale });
    }
    stitchedTrades.push(...oos.trades);
    // 用成交额近似累计买入额，供换手率计算
    for (const t of oos.trades) stitchedBuyAmount += t.entryPrice * t.shares * scale;
    capital = oos.metrics.finalEquity;

    results.push({
      fold: f, trainRange, testRange,
      bestParams: best.params, inSample: best.m, outSample: oos.metrics,
    });
  }

  const stitched = computeMetrics(stitchedEquity, stitchedTrades, initialCapital,
    baseConfig.riskFreeRate ?? 0.015, stitchedBuyAmount);
  const isAvg = results.length ? results.reduce((a, r) => a + opt.report(r.inSample), 0) / results.length : 0;
  const oosAvg = results.length ? results.reduce((a, r) => a + opt.report(r.outSample), 0) / results.length : 0;

  return {
    folds: results,
    stitched,
    stitchedEquity,
    stitchedTrades,
    inSampleAvg: isAvg,
    outSampleAvg: oosAvg,
    degradation: isAvg !== 0 ? 1 - oosAvg / isAvg : 0,
    trialsPerFold: combos.length,
    deflatedNote: deflatedNote(stitched.sharpe, combos.length * Math.max(1, results.length), stitched.days),
  };
}

export function formatWalkForward(r: WalkForwardResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const L: string[] = [];
  L.push(`\n${'═'.repeat(74)}`);
  L.push('  滚动窗口优化（Walk-Forward）');
  L.push(`  参数组合 ${r.trialsPerFold} 组 × ${r.folds.length} 段 = ${r.trialsPerFold * r.folds.length} 次试验`);
  L.push('═'.repeat(74));
  L.push('段  训练区间                  检验区间                  样本内    样本外');
  L.push('─'.repeat(74));
  for (const f of r.folds) {
    const tr = `${f.trainRange[0]}~${f.trainRange[1]}`;
    const te = `${f.testRange[0]}~${f.testRange[1]}`;
    L.push(
      `${String(f.fold).padEnd(3)} ${tr.padEnd(25)} ${te.padEnd(25)} `
      + `${pct(f.inSample.cagr).padStart(8)}  ${pct(f.outSample.cagr).padStart(8)}`,
    );
    L.push(`    选中参数: ${JSON.stringify(f.bestParams)}`);
  }
  L.push('─'.repeat(74));
  L.push(`样本内目标均值  ${r.inSampleAvg.toFixed(3)}`);
  L.push(`样本外目标均值  ${r.outSampleAvg.toFixed(3)}`);
  if (r.inSampleAvg <= 0) {
    L.push('衰减幅度        n/a（样本内目标本身非正，无从谈衰减——策略在训练段就没优势）');
  } else {
    L.push(`衰减幅度        ${pct(r.degradation)}  ${r.degradation > 0.5 ? '⚠ 衰减超过50%，参数很可能是拟合噪声' : ''}`);
  }
  const lowFolds = r.folds.filter((f) => f.outSample.lowSample).length;
  if (lowFolds) {
    L.push(`⚠ ${lowFolds}/${r.folds.length} 段的样本外交易不足30笔，该段指标不可信`);
  }
  L.push('');
  L.push(`显著性：${r.deflatedNote}`);
  return L.join('\n');
}
