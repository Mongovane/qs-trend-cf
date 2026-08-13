/**
 * 量价模块。移植自 analysis/volume_price_module.py。
 * 量价模式识别 + OBV 能量潮 + 资金流辅助。
 */
import type { FundFlow, Kline, Quote, VolumePriceResult } from '../types';
import { maDirection } from './indicators';
import { clamp, fmt, pyRound, sum } from '../util/pynum';

/** OBV（能量潮）序列。 */
function calcObv(klines: readonly Kline[]): number[] {
  const obv: number[] = [];
  let running = 0;
  let prevClose: number | null = null;
  for (const k of klines) {
    if (prevClose !== null && k.close !== prevClose) {
      running += k.close > prevClose ? k.volume : -k.volume;
    }
    obv.push(running);
    prevClose = k.close;
  }
  return obv;
}

const BASE_CONF: Record<string, number> = {
  价涨量增: 80, 价涨量平: 55, 价涨量缩: 60,
  价平量增: 50, 价平量平: 20, 价平量缩: 35,
  价跌量增: 75, 价跌量平: 50, 价跌量缩: 60,
};

/** 量价模式分类，返回 [pattern, direction, baseConfidence]。 */
function classifyPriceVolume(klines: readonly Kline[]): [string, string, number] {
  if (klines.length < 10) return ['数据不足', '中性', 50];
  const closes = klines.map((k) => k.close);
  const n = closes.length;
  const g8 = closes[n - 8] ? ((closes[n - 1] - closes[n - 8]) / closes[n - 8]) * 100 : 0;
  const vols = klines.map((k) => k.volume);

  let priceDir: string;
  if (g8 > 2) priceDir = '涨';
  else if (g8 < -2) priceDir = '跌';
  else priceDir = '平';

  let volChange = 0;
  if (vols.length >= 8) {
    const ma3Vol = sum(vols.slice(vols.length - 3)) / 3;
    const ma5Prev = sum(vols.slice(vols.length - 8, vols.length - 3)) / 5;
    volChange = ma5Prev ? ((ma3Vol - ma5Prev) / ma5Prev) * 100 : 0;
  }
  let volDir: string;
  if (volChange > 30) volDir = '增';
  else if (volChange < -30) volDir = '缩';
  else volDir = '平';

  const pattern = `价${priceDir}量${volDir}`;
  let direction: string;
  if (priceDir === '涨') direction = '看涨';
  else if (priceDir === '跌') direction = '看跌';
  else direction = '中性';

  return [pattern, direction, BASE_CONF[pattern] ?? 50];
}

/** 资金流分析，返回 [信号文案, 置信度修正]。 */
function analyzeFundFlow(flows: readonly FundFlow[] | null | undefined): [string, number] {
  if (!flows || flows.length === 0) return ['', 0];
  const recent = flows.slice(Math.max(0, flows.length - 3));
  const mainNets = recent.map((f) => f.main_net).filter((v) => v !== null && v !== undefined);
  if (mainNets.length === 0) return ['', 0];

  if (mainNets.every((v) => v > 0)) return ['连续3日主力净流入', 15];
  if (mainNets.every((v) => v < 0)) return ['连续3日主力净流出', -15];

  const lastNet = mainNets[mainNets.length - 1];
  const prevAvg = (mainNets[0] + mainNets[1]) / 2;
  if (prevAvg >= 0) {
    const threshold = 0.5 * prevAvg;
    if (lastNet < -threshold) return ['今日主力大幅流出', -10];
    if (lastNet > threshold) return ['今日主力大幅流入', 10];
  }
  return ['主力资金温和', 0];
}

/** 放量涨停检测。 */
function detectLimitUpVolume(klines: readonly Kline[]): string | null {
  if (klines.length < 6) return null;
  const latest = klines[klines.length - 1];
  const vols = klines.slice(klines.length - 6, klines.length - 1).map((k) => k.volume);
  const avgVol = vols.length ? sum(vols) / vols.length : 1;
  if (latest.pct >= 9.5 && avgVol && latest.volume > avgVol * 1.5) {
    return `放量涨停(pct=${fmt(latest.pct, 1)}%)`;
  }
  return null;
}

/** 量能突破检测。 */
function detectVolumeBreakout(klines: readonly Kline[]): string | null {
  if (klines.length < 20) return null;
  const latest = klines[klines.length - 1];
  const vols = klines.slice(klines.length - 21, klines.length - 1).map((k) => k.volume);
  const avgVol = vols.length ? sum(vols) / vols.length : 1;
  if (latest.volume > avgVol * 1.5 && latest.volume > Math.max(...vols)) {
    return '量能突破，资金活跃';
  }
  return null;
}

/** 量价综合分析。 */
export function analyzeVolumePrice(
  klines: readonly Kline[],
  quote?: Quote | null,
  flows?: readonly FundFlow[] | null,
): VolumePriceResult {
  const [pattern, direction, base] = classifyPriceVolume(klines);

  let volumeRatio = 1.0;
  if (quote && klines.length >= 6) {
    const window = klines.slice(klines.length - 6, klines.length - 1);
    const avg5 = sum(window.map((k) => k.volume)) / Math.max(1, window.length);
    volumeRatio = avg5 ? pyRound(quote.volume / avg5, 2) : 1.0;
  }

  const turnover =
    (quote && quote.turnover ? quote.turnover : klines[klines.length - 1].turnover) || 0;
  const obv = calcObv(klines);
  // OBV 方向使用 lookback=8
  const obvDir = maDirection(obv, 8);
  const obvTrend = obvDir === '向上' ? '上升' : obvDir === '向下' ? '下降' : '走平';

  const [fundText, fundDelta] = analyzeFundFlow(flows);
  let confidence = base;
  if (volumeRatio < 0.5) confidence += -3;
  else if (volumeRatio < 1.5) confidence += 2;
  else if (volumeRatio < 2.0) confidence += 7;
  else confidence += 12;
  confidence += fundDelta;
  confidence = clamp(confidence, 5, 95);

  const signals: string[] = [];
  if (fundText) signals.push(fundText);
  if (obvTrend === '上升') signals.push('OBV上升');
  else if (obvTrend === '下降') signals.push('OBV下降');

  const limitUp = detectLimitUpVolume(klines);
  if (limitUp) signals.push(limitUp);
  const volBreakout = detectVolumeBreakout(klines);
  if (volBreakout && !signals.join(' ').includes('量能突破')) signals.push(volBreakout);

  let desc = `量价模式=${pattern}，量比=${volumeRatio}，换手=${fmt(turnover, 1)}%`;
  if (fundText) desc += `，${fundText}`;

  return {
    pattern,
    direction,
    confidence,
    volume_ratio: volumeRatio,
    turnover: pyRound(turnover, 2),
    obv_trend: obvTrend,
    signals,
    description: desc,
  };
}
