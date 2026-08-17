/**
 * 筹码分布（CYQ）计算器。
 *
 * ══ 算法原理（三角形衰减模型）══
 *
 * 这是同花顺/通达信/东财筹码分布的通行实现思路：
 *
 * 1. 每根 K 线的成交量按三角形分布在 [low, high] 区间内，
 *    峰值在收盘价处（假设成交密集在收盘价附近）
 * 2. 每日新增筹码叠加到分布上；同时旧筹码按换手率衰减
 *    （换手率 = 当日成交量 / 流通股本，流通股本未知时用近期均量估算）
 * 3. 最终得到一个「价格 → 持仓量」的分布，可以算出：
 *    - 获利比例（current price 以下的筹码占比）
 *    - 平均成本
 *    - 90%/70% 成本区间
 *    - 集中度（90% 区间宽度 / 收盘价）
 *    - 筹码峰（众数价位）
 *
 * ══ 不需要外部接口 ══
 *
 * 东财的 stock_cyq_em 用混淆 JS 脚本在客户端做同样的事。
 * 我们直接用已有的 K 线数据（klines）就够了，因为输入只有 OHLCV。
 *
 * ══ 精度说明 ══
 *
 * 价格分辨率为 0.01 元（A股最小价格变动单位）。
 * 对于 100 元以上的高价股，分布数组会很大（10000+ 个 bin），
 * 因此改用相对分辨率（价格的 0.1%），高低价股统一约 1000 个 bin。
 */
import type { Kline } from '../types';
import { pyRound } from '../util/pynum';

export interface ChipDistribution {
  /** 获利比例（0~1，当前价以下筹码占比） */
  profitRatio: number;
  /** 平均成本 */
  avgCost: number;
  /** 90% 成本区间 [low, high] */
  cost90: [number, number];
  /** 70% 成本区间 [low, high] */
  cost70: [number, number];
  /** 集中度（90% 区间宽度 / 收盘价，越小越集中） */
  concentration: number;
  /** 筹码峰（持仓量最大的价位） */
  peakPrice: number;
  /** 当前价是否在筹码密集区（90% 区间内） */
  inDenseZone: boolean;
  /** 压力位（当前价上方最近的筹码峰） */
  resistancePrice: number | null;
  /** 支撑位（当前价下方最近的筹码峰） */
  supportPrice: number | null;
  /** 分布数据（用于图表渲染） */
  distribution: Array<{ price: number; volume: number }>;
}

/**
 * 计算筹码分布。
 *
 * @param klines   日K线数据（至少 60 根）
 * @param calcDays 参与计算的交易日数（默认 120，越长越准但越慢）
 * @param currentPrice 当前价（用于计算获利比例，不传则用最后收盘价）
 */
export function calcChipDistribution(
  klines: readonly Kline[],
  calcDays = 120,
  currentPrice?: number,
): ChipDistribution | null {
  if (klines.length < 30) return null;

  const window = klines.slice(Math.max(0, klines.length - calcDays));
  const price = currentPrice ?? window[window.length - 1].close;
  if (price <= 0) return null;

  // ── 确定价格范围与分辨率 ──
  let lo = Infinity, hi = 0;
  for (const k of window) {
    if (k.low > 0 && k.low < lo) lo = k.low;
    if (k.high > hi) hi = k.high;
  }
  if (lo >= hi || lo <= 0) return null;

  // 相对分辨率：约 1000 个 bin
  const step = Math.max(0.01, (hi - lo) / 1000);
  const bins = Math.ceil((hi - lo) / step) + 1;
  const dist = new Float64Array(bins);

  // ── 逐日累加筹码 ──
  // 近期均量（用于估算换手率，流通股本未知时的替代方案）
  const totalVol = window.reduce((s, k) => s + k.volume, 0);
  const avgVol = totalVol / window.length;
  // 「流通盘」估算：用最近 20 日平均成交量 × 衰减系数推算
  // 这是个粗估，但对筹码分布的形状影响不大（只影响衰减速度）
  const estFloat = avgVol * 100; // 假设平均换手率约 1%

  for (const k of window) {
    if (k.volume <= 0 || k.high <= k.low) continue;

    // 换手率 = 成交量 / 流通盘
    const turnover = k.turnover > 0
      ? k.turnover / 100
      : (estFloat > 0 ? k.volume / estFloat : 0.01);

    // 旧筹码按 (1 - 换手率) 衰减
    const decay = Math.max(0, Math.min(1, 1 - turnover));
    for (let j = 0; j < bins; j++) dist[j] *= decay;

    // 新增筹码按三角形分布在 [low, high]，峰值在 close
    const kLo = k.low, kHi = k.high, kClose = k.close;
    const startBin = Math.max(0, Math.floor((kLo - lo) / step));
    const endBin = Math.min(bins - 1, Math.ceil((kHi - lo) / step));
    const closeBin = Math.round((kClose - lo) / step);

    // 三角形面积归一化到当日成交量
    let triSum = 0;
    for (let j = startBin; j <= endBin; j++) {
      const p = lo + j * step;
      const weight = j <= closeBin
        ? (p - kLo) / Math.max(kClose - kLo, step)      // 左半三角
        : (kHi - p) / Math.max(kHi - kClose, step);      // 右半三角
      triSum += Math.max(0, weight);
    }
    if (triSum <= 0) continue;
    const scale = k.volume / triSum;
    for (let j = startBin; j <= endBin; j++) {
      const p = lo + j * step;
      const weight = j <= closeBin
        ? (p - kLo) / Math.max(kClose - kLo, step)
        : (kHi - p) / Math.max(kHi - kClose, step);
      dist[j] += Math.max(0, weight) * scale;
    }
  }

  // ── 统计指标 ──
  let totalChips = 0, profitChips = 0, costSum = 0;
  let peakVol = 0, peakBin = 0;
  for (let j = 0; j < bins; j++) {
    totalChips += dist[j];
    const p = lo + j * step;
    costSum += p * dist[j];
    if (p <= price) profitChips += dist[j];
    if (dist[j] > peakVol) { peakVol = dist[j]; peakBin = j; }
  }
  if (totalChips <= 0) return null;

  const profitRatio = profitChips / totalChips;
  const avgCost = costSum / totalChips;
  const peakPrice = lo + peakBin * step;

  // 百分位区间
  function percentileRange(pct: number): [number, number] {
    const target = totalChips * (1 - pct) / 2;
    let cumLo = 0, cumHi = 0;
    let loBound = lo, hiBound = hi;
    for (let j = 0; j < bins; j++) {
      cumLo += dist[j];
      if (cumLo >= target) { loBound = lo + j * step; break; }
    }
    for (let j = bins - 1; j >= 0; j--) {
      cumHi += dist[j];
      if (cumHi >= target) { hiBound = lo + j * step; break; }
    }
    return [pyRound(loBound, 2), pyRound(hiBound, 2)];
  }

  const cost90 = percentileRange(0.9);
  const cost70 = percentileRange(0.7);
  const concentration = price > 0 ? (cost90[1] - cost90[0]) / price : 0;

  // 压力位/支撑位：找当前价上下方最近的局部峰
  let resistance: number | null = null, support: number | null = null;
  const priceBin = Math.round((price - lo) / step);
  // 向上找峰
  for (let j = priceBin + 3; j < bins - 3; j++) {
    if (dist[j] > dist[j - 1] && dist[j] > dist[j + 1]
      && dist[j] > dist[j - 2] && dist[j] > dist[j + 2]
      && dist[j] > totalChips / bins * 2) {
      resistance = pyRound(lo + j * step, 2);
      break;
    }
  }
  // 向下找峰
  for (let j = priceBin - 3; j >= 3; j--) {
    if (dist[j] > dist[j - 1] && dist[j] > dist[j + 1]
      && dist[j] > dist[j - 2] && dist[j] > dist[j + 2]
      && dist[j] > totalChips / bins * 2) {
      support = pyRound(lo + j * step, 2);
      break;
    }
  }

  // 分布数据（降采样到最多 80 个点，给图表渲染用）
  const sampleStep = Math.max(1, Math.floor(bins / 80));
  const distribution: Array<{ price: number; volume: number }> = [];
  for (let j = 0; j < bins; j += sampleStep) {
    let v = 0;
    for (let jj = j; jj < Math.min(j + sampleStep, bins); jj++) v += dist[jj];
    if (v > 0) distribution.push({ price: pyRound(lo + j * step, 2), volume: pyRound(v, 0) });
  }

  return {
    profitRatio: pyRound(profitRatio, 4),
    avgCost: pyRound(avgCost, 2),
    cost90,
    cost70,
    concentration: pyRound(concentration, 4),
    peakPrice: pyRound(peakPrice, 2),
    inDenseZone: price >= cost90[0] && price <= cost90[1],
    resistancePrice: resistance,
    supportPrice: support,
    distribution,
  };
}

/** 筹码分布摘要文案。 */
export function chipSummary(chip: ChipDistribution, price: number): string {
  const pr = (chip.profitRatio * 100).toFixed(1);
  const conc = (chip.concentration * 100).toFixed(1);
  const parts: string[] = [];
  parts.push(`获利${pr}%`);
  parts.push(`均价${chip.avgCost}`);
  parts.push(`集中度${conc}%`);
  if (chip.profitRatio > 0.9) parts.push('几乎全部获利，注意抛压');
  else if (chip.profitRatio < 0.2) parts.push('大部分套牢，抛压轻');
  if (chip.concentration < 0.1) parts.push('筹码高度集中');
  else if (chip.concentration > 0.3) parts.push('筹码分散');
  if (chip.resistancePrice && chip.resistancePrice > price) {
    parts.push(`上方压力${chip.resistancePrice}`);
  }
  if (chip.supportPrice && chip.supportPrice < price) {
    parts.push(`下方支撑${chip.supportPrice}`);
  }
  return parts.join('，');
}
