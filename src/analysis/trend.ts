/**
 * 趋势模块。移植自 analysis/trend_module.py。
 * 判断趋势方向、强度、阶段、均线排列，并查找上升趋势线。
 */
import type { Kline, TrendResult, TrendLine } from '../types';
import { smaSeries, maDirection } from './indicators';
import { pyRound, sum } from '../util/pynum';

/**
 * 查找最近一条有效上升趋势线。
 * 规则与 Python 版一致：窗口 20 日，局部低点邻域 5 日（截断到窗口边界）。
 */
function findTrendline(klines: readonly Kline[], direction: string): TrendLine | null {
  if (direction !== '上升' || klines.length < 21) return null;
  const lows = klines.map((k) => k.low);
  const windowStart = klines.length - 20;
  const windowEnd = klines.length - 1;

  const troughs: number[] = [];
  for (let i = windowStart; i <= windowEnd; i++) {
    const lo = Math.max(windowStart, i - 5);
    const hi = Math.min(windowEnd, i + 5);
    if (lo === i && hi === i) continue;
    const neighbors = [...lows.slice(lo, i), ...lows.slice(i + 1, hi + 1)];
    if (neighbors.length === 0) continue;
    if (lows[i] <= Math.min(...neighbors)) troughs.push(i);
  }

  const t0 = troughs.length ? troughs[0] : windowStart;
  const after = lows.slice(t0 + 1, windowEnd + 1);
  if (after.length === 0) return null;
  const minAfter = Math.min(...after);
  const t1 = t0 + 1 + after.indexOf(minAfter);

  if (lows[t1] <= lows[t0]) return null;
  if (t0 > windowStart) {
    const leftMin = Math.min(...lows.slice(windowStart, t0));
    if (lows[t1] >= leftMin) return null;
  }
  const slope = (lows[t1] - lows[t0]) / (t1 - t0);
  if (slope <= 0) return null;
  return {
    type: '上升趋势线',
    slope: pyRound(slope, 4),
    current_price: pyRound(lows[t0] + slope * (klines.length - 1 - t0), 2),
    points: [t0 - windowStart, t1 - windowStart],
  };
}

interface MaScoreOut {
  maScores: Record<string, number>;
  signals: string[];
  ma20Val: number | null;
  ma60Val: number | null;
}

/** 计算均线评分项。 */
function calcMaScores(klines: readonly Kline[]): MaScoreOut {
  const closes = klines.map((k) => k.close);
  const price = closes[closes.length - 1];
  const ma20 = smaSeries(closes, 20);
  const ma60 = smaSeries(closes, 60);
  const ma20Last = ma20.length ? ma20[ma20.length - 1] : null;
  const ma60Last = ma60.length ? ma60[ma60.length - 1] : null;

  if (ma20Last === null || ma60Last === null) {
    return {
      maScores: { ma20_dir: 0, ma60_dir: 0, price_vs_ma20: 0, price_vs_ma60: 0, resonance: 0 },
      signals: [],
      ma20Val: null,
      ma60Val: null,
    };
  }

  const ma20Dir = maDirection(ma20, 5);
  const ma60Dir = maDirection(ma60, 5);
  const maScores: Record<string, number> = {};
  const signals: string[] = [];

  // MA20 方向（30分）
  maScores.ma20_dir = ma20Dir === '向上' ? 30 : 0;
  if (ma20Dir === '向上') signals.push('MA20向上');
  else if (ma20Dir === '向下') signals.push('MA20向下');

  // MA60 方向（25分）
  maScores.ma60_dir = ma60Dir === '向上' ? 25 : 0;

  // 价格 vs MA20（15分）
  maScores.price_vs_ma20 = price > ma20Last ? 15 : 0;

  // 价格 vs MA60（10分）—— 60日决策线
  maScores.price_vs_ma60 = price > ma60Last ? 10 : 0;
  if (price > ma60Last) signals.push('站稳60日决策线');

  // 均线共振（20分）：近20日价格上行
  const gain20 =
    closes.length >= 21 && closes[closes.length - 21]
      ? ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
      : 0;
  maScores.resonance = gain20 > 0 ? 20 : 0;

  return { maScores, signals, ma20Val: ma20Last, ma60Val: ma60Last };
}

/** 均线排列：MA5>MA10>MA20>MA60 为多头，反之为空头，其余为纠缠。 */
function calcArrangement(closes: readonly number[]): string {
  const ma = (p: number): number | null => {
    const s = smaSeries(closes, p);
    return s.length ? s[s.length - 1] : null;
  };
  const m5 = ma(5), m10 = ma(10), m20 = ma(20), m60 = ma(60);
  if (m5 === null || m10 === null || m20 === null || m60 === null) return '纠缠';
  if (m5 > m10 && m10 > m20 && m20 > m60) return '多头排列';
  if (m5 < m10 && m10 < m20 && m20 < m60) return '空头排列';
  return '纠缠';
}

/** 阶段判定。 */
function calcStage(direction: string, strength: number): string {
  if (direction === '上升') {
    if (strength >= 70) return '强势上升趋势';
    if (strength >= 45) return '上升趋势形成中';
    return '弱势上升';
  }
  if (direction === '下降') {
    if (strength <= 30) return '强势下降趋势';
    return '下降趋势';
  }
  return '震荡整理';
}

/** 趋势分析入口。 */
export function analyzeTrend(klines: readonly Kline[], legacy = false): TrendResult {
  const { maScores, signals, ma20Val } = calcMaScores(klines);
  const strength = sum(Object.values(maScores));

  const closes = klines.map((k) => k.close);
  const price = closes[closes.length - 1];

  let direction: string;
  if (ma20Val !== null && ma20Val > 0) {
    if (price > ma20Val && maScores.ma20_dir === 30) direction = '上升';
    else if (price < ma20Val && maScores.ma20_dir === 0) direction = '下降';
    else direction = '震荡';
  } else {
    direction = '震荡';
  }

  // [FIX-P8] 原实现硬编码为「纠缠」，此处按市面通行口径判定真实均线排列。
  // 仅用于展示，不参与 strength 计算，因此不影响综合评分权重。
  const arrangement = legacy ? '纠缠' : calcArrangement(closes);
  const stage = calcStage(direction, strength);
  const trendline = findTrendline(klines, direction);

  return {
    direction,
    strength,
    stage,
    ma_arrangement: arrangement,
    ma_scores: maScores,
    trendline,
    signals,
  };
}
