/**
 * K线形态识别器。
 *
 * 15 种经典单根/双根/三根组合形态，全部是纯 OHLC 数学关系判定，
 * 不需要任何外部数据。每种形态返回：
 *   - 出现位置（barIndex）
 *   - 方向（bullish / bearish / neutral）
 *   - 可靠度（1~3 星，3 最高）
 *   - 图表标注数据（供 ECharts markPoint 直接使用）
 *
 * 判定阈值参考 Steve Nison《日本蜡烛图技术》+ TradingView 社区公开实现。
 */
import type { Kline } from '../types';

export interface CandlePattern {
  /** 形态英文名 */
  name: string;
  /** 中文名 */
  label: string;
  /** 出现在第几根 K 线（0-based） */
  index: number;
  /** 方向 */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 可靠度 1~3 */
  reliability: number;
  /** 简要说明 */
  description: string;
}

/** 实体长度 */
function body(k: Kline): number { return Math.abs(k.close - k.open); }
/** 上影线 */
function upperShadow(k: Kline): number { return k.high - Math.max(k.open, k.close); }
/** 下影线 */
function lowerShadow(k: Kline): number { return Math.min(k.open, k.close) - k.low; }
/** 全长 */
function range(k: Kline): number { return k.high - k.low || 0.001; }
/** 是否阳线 */
function isBull(k: Kline): boolean { return k.close > k.open; }
/** 近 N 日平均实体（用于判断"大"/"小"） */
function avgBody(klines: readonly Kline[], end: number, n = 14): number {
  let s = 0, c = 0;
  for (let i = Math.max(0, end - n); i < end; i++) { s += body(klines[i]); c++; }
  return c ? s / c : body(klines[end]);
}
/** 近期趋势方向：+1 上 / -1 下 / 0 震荡 */
function recentTrend(klines: readonly Kline[], end: number, lookback = 5): number {
  if (end < lookback) return 0;
  const d = klines[end].close - klines[end - lookback].close;
  const threshold = klines[end].close * 0.02;
  return d > threshold ? 1 : d < -threshold ? -1 : 0;
}

export function detectCandlePatterns(klines: readonly Kline[]): CandlePattern[] {
  const results: CandlePattern[] = [];
  const n = klines.length;
  if (n < 3) return results;

  // 只检测最近 60 根，避免图表被标注淹没
  const start = Math.max(1, n - 60);

  for (let i = start; i < n; i++) {
    const k = klines[i];
    const prev = klines[i - 1];
    const prev2 = i >= 2 ? klines[i - 2] : null;
    const ab = avgBody(klines, i);
    const b = body(k);
    const r = range(k);
    const us = upperShadow(k);
    const ls = lowerShadow(k);
    const trend = recentTrend(klines, i);

    // ══════════ 单根形态 ══════════

    // 锤子线 Hammer（下影 ≥ 实体×2，上影极短，出现在下降趋势）
    if (ls >= b * 2 && us < r * 0.1 && b > 0 && trend === -1) {
      results.push({ name: 'hammer', label: '锤子线', index: i,
        direction: 'bullish', reliability: 2,
        description: '下降趋势中出现长下影，空方试图打压但被多方拉回，可能见底反转' });
    }

    // 倒锤 Inverted Hammer（上影 ≥ 实体×2，下影极短，下降趋势）
    if (us >= b * 2 && ls < r * 0.1 && b > 0 && trend === -1) {
      results.push({ name: 'inverted_hammer', label: '倒锤', index: i,
        direction: 'bullish', reliability: 1,
        description: '下降趋势中出现长上影，多方开始试探，需后续阳线确认' });
    }

    // 上吊线 Hanging Man（形态同锤子线，但出现在上升趋势 = 看跌）
    if (ls >= b * 2 && us < r * 0.1 && b > 0 && trend === 1) {
      results.push({ name: 'hanging_man', label: '上吊线', index: i,
        direction: 'bearish', reliability: 1,
        description: '上升趋势中出现长下影，获利盘开始松动，注意风险' });
    }

    // 射击之星 Shooting Star（上影 ≥ 实体×2，下影极短，上升趋势）
    if (us >= b * 2 && ls < r * 0.1 && b > 0 && trend === 1) {
      results.push({ name: 'shooting_star', label: '射击之星', index: i,
        direction: 'bearish', reliability: 2,
        description: '上升趋势中冲高回落，上方抛压沉重，见顶信号' });
    }

    // 十字星 Doji（实体极小）
    if (b < r * 0.05 && r > ab * 0.3) {
      const isLongLeg = ls > r * 0.25 && us > r * 0.25;
      const isDragonfly = ls > r * 0.6 && us < r * 0.1;
      const isGravestone = us > r * 0.6 && ls < r * 0.1;
      if (isDragonfly && trend === -1) {
        results.push({ name: 'dragonfly_doji', label: '蜻蜓十字', index: i,
          direction: 'bullish', reliability: 2,
          description: '下降趋势中蜻蜓十字（长下影无上影），强烈的底部反转信号' });
      } else if (isGravestone && trend === 1) {
        results.push({ name: 'gravestone_doji', label: '墓碑十字', index: i,
          direction: 'bearish', reliability: 2,
          description: '上升趋势中墓碑十字（长上影无下影），强烈的顶部反转信号' });
      } else if (isLongLeg) {
        results.push({ name: 'long_doji', label: '长脚十字', index: i,
          direction: 'neutral', reliability: 1,
          description: '多空分歧剧烈，变盘信号，需关注后续方向选择' });
      }
    }

    // 大阳线 / 大阴线 Marubozu（实体占全长 > 85%）
    if (b > r * 0.85 && b > ab * 1.5) {
      if (isBull(k)) {
        results.push({ name: 'bull_marubozu', label: '光头光脚阳', index: i,
          direction: 'bullish', reliability: 2,
          description: '实体极大无影线，多方完全控盘，强势信号' });
      } else {
        results.push({ name: 'bear_marubozu', label: '光头光脚阴', index: i,
          direction: 'bearish', reliability: 2,
          description: '实体极大无影线，空方完全控盘，弱势信号' });
      }
    }

    // ══════════ 双根形态 ══════════
    if (i < 1) continue;
    const pb = body(prev);

    // 看涨吞没 Bullish Engulfing
    if (!isBull(prev) && isBull(k)
      && k.open <= prev.close && k.close >= prev.open
      && b > pb * 1.1 && trend === -1) {
      results.push({ name: 'bull_engulfing', label: '看涨吞没', index: i,
        direction: 'bullish', reliability: 3,
        description: '下降趋势中，阳线实体完全包住前一根阴线，强烈反转信号' });
    }

    // 看跌吞没 Bearish Engulfing
    if (isBull(prev) && !isBull(k)
      && k.open >= prev.close && k.close <= prev.open
      && b > pb * 1.1 && trend === 1) {
      results.push({ name: 'bear_engulfing', label: '看跌吞没', index: i,
        direction: 'bearish', reliability: 3,
        description: '上升趋势中，阴线实体完全包住前一根阳线，强烈反转信号' });
    }

    // 刺穿 Piercing（阴线后阳线开低走高，收盘价穿过前阴线实体中点）
    if (!isBull(prev) && isBull(k)
      && k.open < prev.low
      && k.close > (prev.open + prev.close) / 2
      && k.close < prev.open
      && trend === -1) {
      results.push({ name: 'piercing', label: '刺穿', index: i,
        direction: 'bullish', reliability: 2,
        description: '阳线开低后大幅收高穿过前阴线中点，底部反转信号' });
    }

    // 乌云盖顶 Dark Cloud Cover
    if (isBull(prev) && !isBull(k)
      && k.open > prev.high
      && k.close < (prev.open + prev.close) / 2
      && k.close > prev.open
      && trend === 1) {
      results.push({ name: 'dark_cloud', label: '乌云盖顶', index: i,
        direction: 'bearish', reliability: 2,
        description: '阴线开高后大幅走低穿过前阳线中点，顶部反转信号' });
    }

    // 看涨孕线 Bullish Harami
    if (!isBull(prev) && isBull(k)
      && k.open > prev.close && k.close < prev.open
      && b < pb * 0.5 && trend === -1) {
      results.push({ name: 'bull_harami', label: '看涨孕线', index: i,
        direction: 'bullish', reliability: 1,
        description: '大阴线后的小阳线被包含在前者实体内，趋势可能反转' });
    }

    // 看跌孕线 Bearish Harami
    if (isBull(prev) && !isBull(k)
      && k.open < prev.close && k.close > prev.open
      && b < pb * 0.5 && trend === 1) {
      results.push({ name: 'bear_harami', label: '看跌孕线', index: i,
        direction: 'bearish', reliability: 1,
        description: '大阳线后的小阴线被包含在前者实体内，趋势可能反转' });
    }

    // ══════════ 三根形态 ══════════
    if (!prev2) continue;

    // 早晨之星 Morning Star
    if (!isBull(prev2) && body(prev2) > ab
      && body(prev) < ab * 0.3
      && isBull(k) && b > ab * 0.5
      && k.close > (prev2.open + prev2.close) / 2
      && trend === -1) {
      results.push({ name: 'morning_star', label: '早晨之星', index: i,
        direction: 'bullish', reliability: 3,
        description: '大阴 + 小实体(星线) + 大阳，经典三根底部反转形态' });
    }

    // 黄昏之星 Evening Star
    if (isBull(prev2) && body(prev2) > ab
      && body(prev) < ab * 0.3
      && !isBull(k) && b > ab * 0.5
      && k.close < (prev2.open + prev2.close) / 2
      && trend === 1) {
      results.push({ name: 'evening_star', label: '黄昏之星', index: i,
        direction: 'bearish', reliability: 3,
        description: '大阳 + 小实体(星线) + 大阴，经典三根顶部反转形态' });
    }
  }

  // 去重：同一根 K 线上只保留可靠度最高的一个
  const best = new Map<number, CandlePattern>();
  for (const p of results) {
    const existing = best.get(p.index);
    if (!existing || p.reliability > existing.reliability) {
      best.set(p.index, p);
    }
  }

  return [...best.values()].sort((a, b) => a.index - b.index);
}

/** 生成 ECharts markPoint 数据。 */
export function patternsToMarkPoints(
  patterns: readonly CandlePattern[],
  klines: readonly Kline[],
): Array<Record<string, unknown>> {
  return patterns.map((p) => {
    const k = klines[p.index];
    const isBull = p.direction === 'bullish';
    const isNeutral = p.direction === 'neutral';
    return {
      coord: [k.date, isBull ? k.low * 0.995 : k.high * 1.005],
      symbol: isBull ? 'triangle' : isNeutral ? 'diamond' : 'pin',
      symbolRotate: isBull ? 0 : 180,
      symbolSize: [10, 8],
      symbolOffset: isBull ? [0, 6] : [0, -6],
      itemStyle: {
        color: isBull ? '#00d68f' : isNeutral ? '#fcd535' : '#ff4d5a',
        opacity: 0.75,
      },
      label: {
        show: true,
        position: isBull ? 'bottom' : 'top',
        formatter: p.label,
        fontSize: 9,
        color: isBull ? '#00d68f' : isNeutral ? '#fcd535' : '#ff4d5a',
        distance: 4,
      },
      // 供 tooltip 使用
      _pattern: p,
    };
  });
}
