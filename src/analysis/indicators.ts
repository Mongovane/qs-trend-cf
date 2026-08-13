/**
 * 共享技术指标库。
 * 移植自 analysis/_indicators.py，逐函数保持算法与边界条件一致。
 */
import { pyRound, sum } from '../util/pynum';

/** 简单移动平均序列，前 period-1 个位置为 null 占位。 */
export function smaSeries(values: readonly number[], period: number): (number | null)[] {
  if (period <= 0 || values.length === 0) return [];
  const result: (number | null)[] = new Array(values.length).fill(null);
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i];
    if (i >= period) running -= values[i - period];
    if (i >= period - 1) result[i] = running / period;
  }
  return result;
}

/** 指数移动平均序列，以第一个完整窗口均值为种子。 */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  if (period <= 0 || values.length === 0) return [];
  const result: (number | null)[] = new Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  if (values.length < period) return result;
  let prev = sum(values.slice(0, period)) / period;
  result[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    result[i] = prev;
  }
  return result;
}

/** 返回序列最后一个 SMA 值（数据不足返回 0）。 */
export function lastSma(values: readonly number[], period: number): number {
  if (values.length < period || period <= 0) return 0;
  return sum(values.slice(values.length - period)) / period;
}

/** 判断均线方向：向上 / 向下 / 走平 / 未知。 */
export function maDirection(maValues: readonly (number | null)[], lookback = 5): string {
  const valid = maValues.filter((v): v is number => v !== null && v !== undefined);
  if (valid.length < lookback + 1) return '未知';
  const recent = valid.slice(valid.length - (lookback + 1));
  const slope = recent[recent.length - 1] - recent[0];
  const base = Math.abs(recent[0]);
  const threshold = base ? base * 0.002 : 1e-9;
  if (slope > threshold) return '向上';
  if (slope < -threshold) return '向下';
  return '走平';
}

/** 查找局部高点索引（窗口须完整且在数据内，不含首尾端点）。 */
export function findPeaks(values: readonly number[], window = 3): number[] {
  const peaks: number[] = [];
  const n = values.length;
  for (let i = window; i < n - window; i++) {
    const lo = i - window;
    const hi = i + window;
    let isPeak = true;
    for (let j = lo; j <= hi && isPeak; j++) {
      if (j !== i && !(values[i] >= values[j])) isPeak = false;
    }
    if (!isPeak) continue;
    let allEqual = true;
    for (let j = lo; j <= hi && allEqual; j++) {
      if (values[j] !== values[i]) allEqual = false;
    }
    if (!allEqual) peaks.push(i);
  }
  return peaks;
}

/** 查找局部低点索引。 */
export function findTroughs(values: readonly number[], window = 3): number[] {
  const troughs: number[] = [];
  const n = values.length;
  for (let i = window; i < n - window; i++) {
    const lo = i - window;
    const hi = i + window;
    let isTrough = true;
    for (let j = lo; j <= hi && isTrough; j++) {
      if (j !== i && !(values[i] <= values[j])) isTrough = false;
    }
    if (!isTrough) continue;
    let allEqual = true;
    for (let j = lo; j <= hi && allEqual; j++) {
      if (values[j] !== values[i]) allEqual = false;
    }
    if (!allEqual) troughs.push(i);
  }
  return troughs;
}

/** 最小二乘线性拟合斜率。数据不足返回 null。 */
export function fitTrendline(pointsIdx: readonly number[], values: readonly number[]): number | null {
  if (pointsIdx.length < 2) return null;
  const xs = pointsIdx.map((i) => i);
  const ys = pointsIdx.map((i) => values[i]);
  const n = xs.length;
  const meanX = sum(xs) / n;
  const meanY = sum(ys) / n;
  let denom = 0;
  for (const x of xs) denom += (x - meanX) ** 2;
  if (denom === 0) return null;
  let num = 0;
  for (let i = 0; i < n; i++) num += (xs[i] - meanX) * (ys[i] - meanY);
  return num / denom;
}

/** MACD 三线：DIF / DEA / BAR。 */
export function macdSeries(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signal = 9,
): [number[], number[], number[]] {
  if (closes.length < slow) {
    const n = closes.length;
    return [new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0)];
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const dif = emaFast.map((ef, i) => (ef ?? 0) - (emaSlow[i] ?? 0));
  const dea = emaSeries(dif, signal).map((d) => d ?? 0);
  const bar = dif.map((d, i) => 2 * (d - dea[i]));
  return [dif, dea, bar];
}

/** [start, end) 区间 MACD 柱面积（绝对值之和）。 */
export function macdArea(macdBar: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let i = Math.max(0, start); i < Math.min(end, macdBar.length); i++) {
    total += Math.abs(macdBar[i]);
  }
  return total;
}

/** 价格保留指定位数。 */
export function roundPrice(value: number, digits = 2): number {
  return pyRound(value, digits);
}
