/**
 * 形态模块。移植自 analysis/pattern_module.py。
 * 识别箱体、双底/双顶、头肩底/顶、双弧底、三角形、旗形、跳空。
 *
 * 缺陷修复（仅在 legacy=false 时生效，默认 enhanced 档位）：
 *  [FIX-P1] 原实现把 20 根切片喂给要求 >= 30 根的三角形检测器，导致该形态永远
 *           不触发。改为传入 60 根窗口，与市面主流实现（30~60 根识别窗口）一致。
 *  [FIX-P3] 圆弧底左侧单调判定 range(len-2) 漏检最后一对，改为完整遍历。
 * 传入 legacy=true 时完全复刻 v4.0 行为，用于 A/B 回归。
 */
import type { Kline, PatternResult } from '../types';
import { findPeaks, findTroughs } from './indicators';
import { fmt, pyRound } from '../util/pynum';

function peaksOf(klines: readonly Kline[], window = 3): number[] {
  return findPeaks(klines.map((k) => k.high), window);
}

function troughsOf(klines: readonly Kline[], window = 3): number[] {
  return findTroughs(klines.map((k) => k.low), window);
}

/** 箱体震荡（窗口 20 日）。 */
function detectBox(klines: readonly Kline[], price: number): PatternResult | null {
  if (klines.length < 20) return null;
  const w = klines.slice(klines.length - 20);
  const upper = Math.max(...w.map((k) => k.high));
  const lower = Math.min(...w.map((k) => k.low));
  if (upper <= lower) return null;
  const amplitude = ((upper - lower) / lower) * 100;
  if (!(amplitude >= 5 && amplitude <= 25)) return null;

  let status: string, direction: string, confidence: number, target: number | null;
  if (price >= upper * 0.98) {
    status = '接近突破上沿';
    direction = '看涨';
    confidence = 55;
    target = upper + (upper - lower);
  } else {
    status = '形成中';
    direction = '中性';
    confidence = 55;
    target = null;
  }

  const desc =
    `箱体振幅${fmt(amplitude, 1)}%，突破上沿目标${fmt(upper + (upper - lower), 2)}，` +
    `跌破下沿目标${fmt(lower - (upper - lower), 2)}`;
  return {
    name: '箱体震荡',
    direction,
    confidence,
    status,
    target_price: target !== null ? pyRound(target, 2) : null,
    key_levels: { 箱体上沿: pyRound(upper, 2), 箱体下沿: pyRound(lower, 2) },
    description: desc,
  };
}

/** 双底 / 双顶。 */
function detectDoubleTopBottom(klines: readonly Kline[], price: number): PatternResult | null {
  if (klines.length < 60) return null;
  const lows = klines.map((k) => k.low);
  const highs = klines.map((k) => k.high);
  const troughs = troughsOf(klines, 5);
  if (troughs.length < 2) return null;

  // 仅检查最后两个谷构成的相邻对
  for (let i = troughs.length - 2; i < troughs.length - 1; i++) {
    const t0 = troughs[i];
    const t1 = troughs[i + 1];
    if (t1 - t0 < 5) continue;
    const v0 = lows[t0];
    const v1 = lows[t1];
    if (Math.abs(v0 - v1) / Math.min(v0, v1) > 0.03) continue;
    const mid = klines.slice(t0, t1 + 1);
    const neck = Math.max(...mid.map((k) => k.high));
    const bottom = v0;
    if (neck <= bottom) continue;
    const target = neck + (neck - bottom);
    const status = price > neck ? '已突破' : '形成中';
    return {
      name: '双底',
      direction: '看涨',
      confidence: 55,
      status,
      target_price: pyRound(target, 2),
      key_levels: { 颈线: pyRound(neck, 2), 底部: pyRound(bottom, 2) },
      description: '双底可靠性约10%，需等待价格确认突破颈线',
    };
  }

  const peaks = peaksOf(klines, 5);
  if (peaks.length < 2) return null;
  for (let i = peaks.length - 2; i < peaks.length - 1; i++) {
    const p0 = peaks[i];
    const p1 = peaks[i + 1];
    if (p1 - p0 < 5) continue;
    const v0 = highs[p0];
    const v1 = highs[p1];
    if (Math.abs(v0 - v1) / Math.min(v0, v1) > 0.03) continue;
    const mid = klines.slice(p0, p1 + 1);
    const neck = Math.min(...mid.map((k) => k.low));
    const top = Math.max(v0, v1);
    if (neck >= top) continue;
    const target = neck - (top - neck);
    if (price >= neck) continue;
    return {
      name: '双顶',
      direction: '看跌',
      confidence: 55,
      status: '已突破',
      target_price: pyRound(target, 2),
      key_levels: { 颈线: pyRound(neck, 2), 顶部: pyRound(top, 2) },
      description: `双顶颈线${fmt(neck, 2)}，跌破后目标${fmt(target, 2)}`,
    };
  }
  return null;
}

/** 头肩底 / 头肩顶。 */
function detectHeadShoulders(klines: readonly Kline[], price: number): PatternResult | null {
  if (klines.length < 10) return null;
  const lows = klines.map((k) => k.low);
  const highs = klines.map((k) => k.high);
  const troughs = troughsOf(klines, 3);

  if (troughs.length >= 3) {
    for (let i = troughs.length - 2; i < troughs.length - 1; i++) {
      const l = troughs[i - 1];
      const m = troughs[i];
      const r = troughs[i + 1];
      if (m - l < 2 || r - m < 2) continue;
      const vl = lows[l];
      const vm = lows[m];
      const vr = lows[r];
      if (!(vm < vl && vm < vr)) continue;
      if (Math.abs(vl - vr) / Math.min(vl, vr) > 0.08) continue;
      const neck = Math.max(highs[l], highs[r]);
      const depth = neck - vm;
      if (neck <= vm) continue;
      const target = neck + depth;
      const status = price > neck ? '已突破' : '形成中';
      const confidence = status === '已突破' ? 80 : 60;
      return {
        name: '头肩底',
        direction: '看涨',
        confidence,
        status,
        target_price: pyRound(target, 2),
        key_levels: { 颈线: pyRound(neck, 2), 头部: pyRound(vm, 2) },
        description: `底部深度${fmt(depth, 2)}，突破颈线后目标${fmt(target, 2)}`,
      };
    }
  }

  const peaks = peaksOf(klines, 3);
  if (peaks.length >= 3) {
    for (let i = peaks.length - 2; i < peaks.length - 1; i++) {
      const l = peaks[i - 1];
      const m = peaks[i];
      const r = peaks[i + 1];
      if (m - l < 2 || r - m < 2) continue;
      const vl = highs[l];
      const vm = highs[m];
      const vr = highs[r];
      if (!(vm > vl && vm > vr)) continue;
      if (Math.abs(vl - vr) / Math.min(vl, vr) > 0.08) continue;
      const neck = Math.min(lows[l], lows[r]);
      if (neck >= vm) continue;
      const height = vm - neck;
      const target = neck - height;
      const status = price < neck ? '已突破' : '形成中';
      return {
        name: '头肩顶',
        direction: '看跌',
        confidence: status === '形成中' ? 45 : 60,
        status,
        target_price: pyRound(target, 2),
        key_levels: { 颈线: pyRound(neck, 2), 头部: pyRound(vm, 2) },
        description: `头部高度${fmt(height, 2)}，跌破颈线后目标${fmt(target, 2)}`,
      };
    }
  }
  return null;
}

/** 双弧底（圆弧底）。 */
function detectRoundingBottom(klines: readonly Kline[], _price: number, legacy = false): PatternResult | null {
  if (klines.length < 60) return null;
  const w = klines.slice(klines.length - 60);
  const lows = w.map((k) => k.low);
  const minVal = Math.min(...lows);
  const minIdx = lows.indexOf(minVal);
  if (minIdx < 15 || minIdx > w.length - 15) return null;
  const left = lows.slice(0, minIdx);
  const right = lows.slice(minIdx + 1);
  if (left.length < 8 || right.length < 8) return null;

  // [FIX-P3] 原实现为 range(len(left)-2)，漏检最后一对
  const leftBound = legacy ? left.length - 2 : left.length - 1;
  let leftDesc = true;
  for (let i = 0; i < leftBound; i++) {
    if (left[i] > 0 && !(left[i] >= left[i + 1])) {
      leftDesc = false;
      break;
    }
  }
  let rightAsc = true;
  for (let i = 0; i < right.length - 1; i++) {
    if (!(right[i] <= right[i + 1])) {
      rightAsc = false;
      break;
    }
  }
  if (!(leftDesc && rightAsc)) return null;

  const vols = w.map((k) => k.volume);
  const volMin = Math.min(...vols.slice(minIdx - 5, minIdx + 6));
  if (volMin <= 0) return null;
  const bottom = minVal;
  return {
    name: '双弧底',
    direction: '看涨',
    confidence: 70,
    status: '形成中',
    target_price: null,
    key_levels: { 弧底低点: pyRound(bottom, 2) },
    description: 'K线与成交量同时呈圆弧底，连续放量2-3日可确认起涨',
  };
}

/** 三角形（对称 / 上升 / 下降）。 */
function detectTriangle(klines: readonly Kline[], price: number): PatternResult | null {
  if (klines.length < 30) return null;
  const w = klines.slice(klines.length - 30);
  const firstHalf = w.slice(0, 15);
  const secondHalf = w.slice(15);
  if (!firstHalf.length || !secondHalf.length) return null;
  const h1 = Math.max(...firstHalf.map((k) => k.high));
  const h2 = Math.max(...secondHalf.map((k) => k.high));
  const l1 = Math.min(...firstHalf.map((k) => k.low));
  const l2 = Math.min(...secondHalf.map((k) => k.low));
  const upperSlope = h2 - h1;
  const lowerSlope = l2 - l1;

  if (Math.abs(upperSlope) < 1e-6 || Math.abs(lowerSlope) < 1e-6) return null;

  if (upperSlope < 0 && lowerSlope > 0) {
    return {
      name: '对称三角形',
      direction: '中性',
      confidence: 50,
      status: '形成中',
      target_price: null,
      key_levels: {},
      description: '对称三角形通常延续原有趋势，等待方向选择',
    };
  }
  if (Math.abs(upperSlope) / h1 < 0.02 && lowerSlope > 0) {
    const status = price > h2 ? '已突破' : '接近突破';
    return {
      name: '上升三角形',
      direction: '看涨',
      confidence: 60,
      status,
      target_price: pyRound(h2 + (h2 - l1), 2),
      key_levels: { 阻力位: pyRound(h2, 2) },
      description: `上升三角形偏多，突破${fmt(pyRound(h2, 2), 2)}确认`,
    };
  }
  if (Math.abs(lowerSlope) / l1 < 0.02 && upperSlope < 0) {
    const status = price < l2 ? '已跌破' : '接近跌破';
    return {
      name: '下降三角形',
      direction: '看跌',
      confidence: 60,
      status,
      target_price: pyRound(l2 - (h1 - l2), 2),
      key_levels: { 支撑位: pyRound(l2, 2) },
      description: `下降三角形偏空，跌破${fmt(pyRound(l2, 2), 2)}确认`,
    };
  }
  return null;
}

/** 旗形：急涨后窄幅整理。 */
function detectFlag(klines: readonly Kline[], _price: number): PatternResult | null {
  if (klines.length < 30) return null;
  const n = klines.length;
  const pole = klines.slice(n - 30, n - 15);
  const flag = klines.slice(n - 15);
  if (!pole.length || !flag.length) return null;
  const poleRise = pole[pole.length - 1].close - pole[0].close;
  if (poleRise <= 0) return null;
  const flagHigh = Math.max(...flag.map((k) => k.high));
  const flagLow = Math.min(...flag.map((k) => k.low));
  const flagRange = flagLow ? (flagHigh - flagLow) / flagLow : 0;
  if (flagRange > 0.08) return null;
  return {
    name: '上升旗形',
    direction: '看涨',
    confidence: 60,
    status: '整理中',
    target_price: pyRound(flagHigh + poleRise, 2),
    key_levels: { 旗形上沿: pyRound(flagHigh, 2) },
    description: `旗杆涨幅${fmt(pyRound(poleRise, 2), 2)}，突破后目标${fmt(pyRound(flagHigh + poleRise, 2), 2)}`,
  };
}

/** 跳空缺口。 */
function detectGap(klines: readonly Kline[], _price: number): PatternResult | null {
  if (klines.length < 5) return null;
  const latest = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  if (latest.low > prev.high) {
    const gap = latest.low - prev.high;
    return {
      name: '向上突破缺口',
      direction: '看涨',
      confidence: 65,
      status: '已形成',
      target_price: null,
      key_levels: { 缺口上沿: pyRound(latest.low, 2) },
      description: `向上跳空缺口${fmt(gap, 2)}，回补前视为支撑`,
    };
  }
  if (latest.high < prev.low) {
    const gap = prev.low - latest.high;
    return {
      name: '向下突破缺口',
      direction: '看跌',
      confidence: 65,
      status: '已形成',
      target_price: null,
      key_levels: { 缺口下沿: pyRound(latest.high, 2) },
      description: `向下跳空缺口${fmt(gap, 2)}，回补前视为压力`,
    };
  }
  return null;
}

/**
 * 形态综合分析。
 * 检测顺序：头肩 → 双顶/双底 → 三角形 → 箱体 → 旗形 → 跳空 → 双弧底，
 * 按检测顺序 append，最多返回 3 个。
 */
export function analyzePatterns(klines: readonly Kline[], legacy = false): PatternResult[] {
  const price = klines[klines.length - 1].close;
  const window60 = klines.slice(Math.max(0, klines.length - 60));
  const window20 = klines.slice(Math.max(0, klines.length - 20));

  const detectors: Array<() => PatternResult | null> = [
    () => detectHeadShoulders(window60, price),
    () => detectDoubleTopBottom(window60, price),
    () => detectTriangle(legacy ? window20 : window60, price), // [FIX-P1] 原为 window20，恒不触发
    () => detectBox(window20, price),
    () => detectFlag(window60, price),
    () => detectGap(window60, price),
    () => detectRoundingBottom(window60, price, legacy),
  ];

  const results: PatternResult[] = [];
  for (const detector of detectors) {
    let result: PatternResult | null = null;
    try {
      result = detector();
    } catch {
      result = null;
    }
    if (result !== null) results.push(result);
  }
  return results.slice(0, 3);
}
