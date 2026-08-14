#!/usr/bin/env node
/**
 * 回测命令行。
 *
 *   单次回测：
 *     node --experimental-strip-types backtest/cli.ts run --data backtest/data
 *   滚动优化：
 *     node --experimental-strip-types backtest/cli.ts wf --data backtest/data
 *   引擎自检（合成数据，不代表策略有效性）：
 *     node --experimental-strip-types backtest/cli.ts selftest
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { runBacktest, DEFAULT_PARAMS, type StrategyParams } from './src/engine';
import { formatMetrics } from './src/metrics';
import { walkForward, formatWalkForward, type ParamGrid } from './src/walkforward';
import { loadDirectory, loadBenchmark, synthesize, syntheticBenchmark } from './src/datasource';
import { DEFAULT_FILTER_PARAMS } from '../src/analysis/entryFilters';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

const cmd = process.argv[2] ?? 'help';
const dataDir = arg('data', 'backtest/data')!;
const outDir = arg('out', 'backtest/out')!;
const capital = Number(arg('capital', '1000000'));

function paramsFromArgs(): Partial<StrategyParams> {
  const p: Partial<StrategyParams> = {};
  const n = (k: string) => { const v = arg(k); return v === undefined ? undefined : Number(v); };
  if (n('min-score') !== undefined) p.minScore = n('min-score')!;
  if (n('max-positions') !== undefined) p.maxPositions = n('max-positions')!;
  if (n('max-hold') !== undefined) p.maxHoldDays = n('max-hold')!;
  if (n('trailing') !== undefined) p.trailingPct = n('trailing')!;
  if (n('exit-score') !== undefined) p.exitScore = n('exit-score')!;
  if (n('min-hold') !== undefined) p.minHoldDays = n('min-hold')!;
  if (flag('no-compound')) p.compound = false;
  if (arg('profile')) p.profile = arg('profile') as StrategyParams['profile'];
  if (arg('stop-mode')) p.stopMode = arg('stop-mode') as StrategyParams['stopMode'];
  if (flag('strict')) p.allowedActions = ['强烈买入', '买入'];
  if (flag('no-filters')) {
    p.filters = {
      ...DEFAULT_FILTER_PARAMS,
      minTurnoverAmount: 0, regimeMaPeriod: 0, maxExtensionPct: 1e9,
      distributionTurnover: 1e9, minVolumeRatio: 0, limitUpTolerance: 99,
    };
  }
  if (flag('no-structural')) {
    p.useStructuralPlan = false;
    p.filters = { ...(p.filters ?? DEFAULT_FILTER_PARAMS), applyStructuralPlan: false };
  }
  if (flag('no-risk-sizing')) p.useRiskSizing = false;
  const rt = arg('risk-per-trade');
  const rg = arg('regime-ma');
  const ext = arg('max-ext');
  if (rt || rg || ext) {
    p.filters = { ...(p.filters ?? DEFAULT_FILTER_PARAMS) };
    if (rt) p.filters.riskPerTrade = Number(rt);
    if (rg) p.filters.regimeMaPeriod = Number(rg);
    if (ext) p.filters.maxExtensionPct = Number(ext);
  }
  return p;
}

function save(name: string, data: unknown) {
  try { mkdirSync(outDir, { recursive: true }); } catch { /* 已存在 */ }
  const path = `${outDir}/${name}`;
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  console.log(`  → ${path}`);
}

function loadUniverse() {
  if (cmd === 'selftest' || flag('synthetic')) {
    const u = synthesize(Number(arg('symbols', '40')), Number(arg('bars', '760')));
    return { universe: u, benchmark: syntheticBenchmark(u), synthetic: true };
  }
  const universe = loadDirectory(dataDir);
  if (!universe.length) {
    console.error(
      `\n未在 ${dataDir} 找到可用数据。\n` +
      `  · 用 integrations/qmt/export_history.py 从 QMT 导出，或\n` +
      `  · 放入 CSV（表头含 date,open,high,low,close,volume）\n` +
      `  · 先跑 \`selftest\` 可用合成数据验证引擎是否正常\n`);
    process.exit(1);
  }
  const bpath = arg('benchmark', `${dataDir}/../benchmark.csv`)!;
  let benchmark = loadBenchmark(bpath);
  if (!benchmark.length) {
    console.log('  提示：未找到基准数据，alpha/beta 将不可用');
    benchmark = [];
  }
  return { universe, benchmark, synthetic: false };
}

if (cmd === 'run' || cmd === 'selftest') {
  const { universe, benchmark, synthetic } = loadUniverse();
  console.log(`标的 ${universe.length} 只，K线 ${universe[0].klines.length} 根`);
  if (synthetic) {
    console.log('\n⚠ 合成数据自检模式：只验证引擎逻辑是否正确。');
    console.log('  合成序列没有真实市场的截面结构，其收益率不能用于判断策略优劣。\n');
  }
  const started = Date.now();
  const r = runBacktest(universe, {
    initialCapital: capital,
    startDate: arg('from'), endDate: arg('to'),
    benchmark: benchmark.length ? benchmark : undefined,
    params: { ...DEFAULT_PARAMS, ...paramsFromArgs() },
  });
  console.log(formatMetrics(r.metrics, synthetic ? '引擎自检（合成数据）' : '回测结果'));
  console.log('\n【未成交统计】（这些数字越大，说明策略越依赖买不到的机会）');
  console.log(`  开盘涨停买不到  ${r.rejected.limitUp}`);
  console.log(`  开盘跌停卖不出  ${r.rejected.limitDown}`);
  console.log(`  停牌            ${r.rejected.suspended}`);
  console.log(`  资金不足        ${r.rejected.noCash}`);
  const byReason: Record<string, number> = {};
  for (const t of r.trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  console.log('\n【离场原因分布】');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  save('equity.json', r.equity);
  save('trades.json', r.trades);
  save('metrics.json', r.metrics);
  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} else if (cmd === 'wf') {
  const { universe, benchmark } = loadUniverse();
  console.log(`标的 ${universe.length} 只，开始滚动优化...`);
  const grid: ParamGrid = {
    minScore: [58, 62, 66, 70],
    exitScore: [40, 45, 50],
    maxHoldDays: [20, 40, 60],
    trailingPct: [0, 0.08],
  };
  const r = walkForward(
    universe, grid,
    { initialCapital: capital, params: { ...DEFAULT_PARAMS, ...paramsFromArgs() } },
    { folds: Number(arg('folds', '5')), trainFolds: Number(arg('train-folds', '2')) },
    benchmark.length ? benchmark : undefined,
  );
  console.log(formatWalkForward(r));
  console.log(formatMetrics(r.stitched, '样本外拼接净值（唯一可参考的结果）'));
  save('walkforward.json', { folds: r.folds, stitched: r.stitched, degradation: r.degradation, note: r.deflatedNote });
  save('wf-equity.json', r.stitchedEquity);
} else {
  console.log(`
回测工具

  run        单次回测
  wf         滚动窗口优化（样本外检验）
  selftest   用合成数据自检引擎

通用参数
  --data <dir>          数据目录，默认 backtest/data
  --benchmark <file>    基准 CSV
  --out <dir>           输出目录，默认 backtest/out
  --capital <n>         初始资金，默认 1000000
  --from / --to         回测区间 YYYY-MM-DD
  --min-score <n>       建仓最低分
  --max-positions <n>   最大持仓数
  --max-hold <n>        最长持仓交易日
  --trailing <0.08>     移动止盈比例
  --exit-score <45>     离场分数线（滞后带下沿，务必明显低于 min-score）
  --min-hold <5>        最短持仓交易日
  --no-compound         按期初资金定仓，不复利
  --stop-mode plan|atr|fixed
  --profile enhanced|legacy
  --strict              只接受「买入/强烈买入」，排除谨慎买入

wf 专用
  --folds <5>           切分段数
  --train-folds <2>     训练窗口段数
  --synthetic           用合成数据跑（仅验证流程，结果无意义）
`);
}
