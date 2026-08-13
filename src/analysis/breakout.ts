/**
 * 突破模块（海龟交易法则）。移植自 analysis/breakout_module.py。
 * 系统一：20日唐奇安通道；系统二：55日唐奇安通道。
 * TR = max(H-L, |H-PDC|, |L-PDC|)；N = 前20日TR的SMA；止损 = 入场价 ± 2N。
 */
import type { BreakoutResult, Kline } from '../types';
import { fmt, floorDiv, pyRound, sum } from '../util/pynum';

/** 真实波幅。 */
export function calcTrueRange(high: number, low: number, preClose: number): number {
  return Math.max(high - low, Math.abs(high - preClose), Math.abs(low - preClose));
}

/** N 值 = 前 period 日 TR 的简单移动平均。 */
export function calcN(klines: readonly Kline[], period = 20): number {
  if (klines.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = klines.length - period; i < klines.length; i++) {
    const k = klines[i];
    trs.push(calcTrueRange(k.high, k.low, klines[i - 1].close));
  }
  return pyRound(sum(trs) / trs.length, 4);
}

/** 唐奇安通道（不含当日）。 */
export function calcDonchianChannel(klines: readonly Kline[], period: number): [number, number] {
  const window =
    klines.length <= period
      ? klines.length > 1
        ? klines.slice(0, klines.length - 1)
        : klines
      : klines.slice(klines.length - period - 1, klines.length - 1);
  return [Math.max(...window.map((k) => k.high)), Math.min(...window.map((k) => k.low))];
}

/** 查找最近一次突破入场：[方向, 入场价, 入场日索引]。 */
function findLastEntry(
  klines: readonly Kline[],
  period: number,
): ['多' | '空', number, number] | null {
  const n = klines.length;
  for (let i = n - 1; i >= period; i--) {
    const window = klines.slice(i - period, i);
    if (window.length < period) continue;
    const windowHigh = Math.max(...window.map((k) => k.high));
    const windowLow = Math.min(...window.map((k) => k.low));
    const k = klines[i];
    if (k.high > windowHigh) return ['多', windowHigh, i];
    if (k.low < windowLow) return ['空', windowLow, i];
  }
  return null;
}

function analyzeSystem(klines: readonly Kline[], period: number, systemName: string): BreakoutResult {
  const nVal = calcN(klines, 20);
  const [channelHigh, channelLow] = calcDonchianChannel(klines, period);
  const lastEntry = findLastEntry(klines, period);

  if (nVal <= 0 || channelHigh <= 0 || lastEntry === null) {
    return {
      system: systemName,
      signal: '无信号',
      breakout_price: pyRound(channelHigh, 2),
      current_n: nVal,
      stop_loss: 0,
      entry_price: null,
      position_units: 0,
      exit_price: null,
      channel_high: pyRound(channelHigh, 2),
      channel_low: pyRound(channelLow, 2),
      next_add_price: null,
      signals: [],
      description: `${systemName}无突破信号`,
    };
  }

  const [direction, entry, entryIdx] = lastEntry;
  const holdingDays = klines.length - 1 - entryIdx;

  let stop: number;
  let units: number;
  let nextAdd: number | null;
  let signal: string;
  let exitPrice: number | null;
  let sigText: string;

  if (direction === '多') {
    const highSince =
      klines.length > entryIdx + 1
        ? Math.max(...klines.slice(entryIdx + 1).map((k) => k.high))
        : entry;
    let extra = 0;
    if (highSince > entry + 0.5 * nVal) {
      extra = floorDiv(highSince - entry, 0.5 * nVal);
    }
    units = 1 + extra;
    const lastAddPrice = entry + (units - 1) * 0.5 * nVal;
    stop = lastAddPrice - 2 * nVal;
    nextAdd = units <= 4 && systemName !== '系统二(55日)' ? entry + units * 0.5 * nVal : null;
    if (klines[klines.length - 1].close <= stop) {
      signal = '卖出';
      exitPrice = stop;
    } else {
      signal = '持仓';
      exitPrice = null;
    }
    sigText =
      signal === '卖出'
        ? `触及2N止损${fmt(stop, 2)}，卖出`
        : `持有多头${holdingDays}日，止损${fmt(stop, 2)}`;
  } else {
    stop = entry + 2 * nVal;
    units = 1;
    nextAdd = null;
    const exitWindow = systemName.includes('系统一') ? 10 : 20;
    const highExitLevel = calcDonchianChannel(klines, exitWindow)[0];
    const last = klines[klines.length - 1];
    if (last.high >= highExitLevel) {
      signal = '空头平仓';
      exitPrice = highExitLevel;
      sigText = `突破${exitWindow}日高点${fmt(highExitLevel, 2)}，空头平仓`;
    } else if (last.close >= stop) {
      signal = '空头平仓';
      exitPrice = stop;
      sigText = `触及2N止损${fmt(stop, 2)}，空头平仓`;
    } else {
      signal = '持仓';
      exitPrice = null;
      sigText = `持有空头${holdingDays}日，止损${fmt(stop, 2)}`;
    }
  }

  return {
    system: systemName,
    signal,
    breakout_price: pyRound(channelHigh, 2),
    current_n: nVal,
    stop_loss: pyRound(stop, 2),
    entry_price: pyRound(entry, 2),
    position_units: units,
    exit_price: exitPrice ? pyRound(exitPrice, 2) : null,
    channel_high: pyRound(channelHigh, 2),
    channel_low: pyRound(channelLow, 2),
    next_add_price: nextAdd ? pyRound(nextAdd, 2) : null,
    signals: [sigText],
    description:
      `${systemName.replace('(20日)', '').replace('(55日)', '')}` +
      `入场=${direction}@${fmt(entry, 2)}，N=${fmt(nVal, 4)}，持有${holdingDays}日`,
  };
}

export function analyzeBreakoutSystem1(klines: readonly Kline[]): BreakoutResult {
  return analyzeSystem(klines, 20, '系统一(20日)');
}

export function analyzeBreakoutSystem2(klines: readonly Kline[]): BreakoutResult {
  return analyzeSystem(klines, 55, '系统二(55日)');
}

/** 突破综合分析：返回系统一/系统二两个结果。 */
export function analyzeBreakout(klines: readonly Kline[]): BreakoutResult[] {
  return [analyzeBreakoutSystem1(klines), analyzeBreakoutSystem2(klines)];
}
