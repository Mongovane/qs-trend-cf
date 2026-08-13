/**
 * 市面通行技术指标库（新增冗余层）。
 *
 * 原项目仅覆盖 MA / OBV / MACD / 唐奇安通道，缺少 A 股与国际市场最常用的
 * 摆动类与波动类指标。本模块补齐以下指标，全部采用行业通行参数与公式：
 *
 *   RSI(14)        Wilder 平滑相对强弱
 *   KDJ(9,3,3)     随机指标（A股默认参数）
 *   BOLL(20,2)     布林带（总体标准差口径，与通达信/同花顺一致）
 *   DMI/ADX(14)    Wilder 动向指标
 *   CCI(14)        顺势指标（0.015 常数）
 *   WR(14)         威廉指标（A股 0~100 正向口径）
 *   MFI(14)        资金流量指标
 *   ATR(14)        Wilder 真实波幅均值
 *   SuperTrend(10,3) 超级趋势
 *   ROC(12)        变动率
 *   VWAP(20)       滚动成交量加权均价
 *   MA 多头排列     MA5/10/20/60 排列
 *
 * 所有函数对数据不足场景返回 null 而非抛错，调用方按需降级。
 */
import type { Kline } from '../types';
import { emaSeries, smaSeries } from './indicators';
import { sum } from '../util/pynum';

/* ------------------------------------------------------------------ */
/* Wilder 平滑                                                          */
/* ------------------------------------------------------------------ */

/** Wilder 平滑（RMA）：seed 为前 period 项均值，其后 prev + (x - prev)/period。 */
function wilderSmooth(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  let prev = sum(values.slice(0, period)) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = prev + (values[i] - prev) / period;
    out[i] = prev;
  }
  return out;
}

function hhv(values: readonly number[], end: number, period: number): number {
  const start = Math.max(0, end - period + 1);
  let m = -Infinity;
  for (let i = start; i <= end; i++) if (values[i] > m) m = values[i];
  return m;
}

function llv(values: readonly number[], end: number, period: number): number {
  const start = Math.max(0, end - period + 1);
  let m = Infinity;
  for (let i = start; i <= end; i++) if (values[i] < m) m = values[i];
  return m;
}

/* ------------------------------------------------------------------ */
/* 单指标                                                               */
/* ------------------------------------------------------------------ */

/** RSI(period)，Wilder 平滑。返回与输入等长的序列。 */
export function rsiSeries(closes: readonly number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let avgGain = sum(gains.slice(1, period + 1)) / period;
  let avgLoss = sum(losses.slice(1, period + 1)) / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface KdjPoint { k: number; d: number; j: number; }

/** KDJ(9,3,3)。 */
export function kdjSeries(
  klines: readonly Kline[],
  n = 9,
  m1 = 3,
  m2 = 3,
): (KdjPoint | null)[] {
  const len = klines.length;
  const out: (KdjPoint | null)[] = new Array(len).fill(null);
  if (len < n) return out;
  const highs = klines.map((x) => x.high);
  const lows = klines.map((x) => x.low);
  let k = 50;
  let d = 50;
  for (let i = n - 1; i < len; i++) {
    const h = hhv(highs, i, n);
    const l = llv(lows, i, n);
    const rsv = h === l ? 50 : ((klines[i].close - l) / (h - l)) * 100;
    k = ((m1 - 1) * k + rsv) / m1;
    d = ((m2 - 1) * d + k) / m2;
    out[i] = { k, d, j: 3 * k - 2 * d };
  }
  return out;
}

export interface BollPoint { mid: number; upper: number; lower: number; width: number; }

/** BOLL(20,2)，总体标准差（与通达信一致）。 */
export function bollSeries(closes: readonly number[], period = 20, mult = 2): (BollPoint | null)[] {
  const out: (BollPoint | null)[] = new Array(closes.length).fill(null);
  const ma = smaSeries(closes, period);
  for (let i = period - 1; i < closes.length; i++) {
    const mid = ma[i];
    if (mid === null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (closes[j] - mid) ** 2;
    const sd = Math.sqrt(acc / period);
    out[i] = {
      mid,
      upper: mid + mult * sd,
      lower: mid - mult * sd,
      width: mid ? ((mult * 2 * sd) / mid) * 100 : 0,
    };
  }
  return out;
}

export interface DmiPoint { pdi: number; mdi: number; adx: number; }

/** DMI / ADX(14)，Wilder 口径。 */
export function dmiSeries(klines: readonly Kline[], period = 14): (DmiPoint | null)[] {
  const n = klines.length;
  const out: (DmiPoint | null)[] = new Array(n).fill(null);
  if (n < period * 2) return out;
  const tr: number[] = [0];
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - klines[i - 1].high;
    const dn = klines[i - 1].low - l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const trS = wilderSmooth(tr.slice(1), period);
  const pdmS = wilderSmooth(pdm.slice(1), period);
  const mdmS = wilderSmooth(mdm.slice(1), period);

  const dx: number[] = [];
  const dxIdx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const t = trS[i];
    const p = pdmS[i];
    const m = mdmS[i];
    if (t === null || p === null || m === null || t === 0) continue;
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    const denom = pdi + mdi;
    dx.push(denom === 0 ? 0 : (Math.abs(pdi - mdi) / denom) * 100);
    dxIdx.push(i + 1); // +1 还原到原始 klines 索引
  }
  const adxS = wilderSmooth(dx, period);
  for (let i = 0; i < dxIdx.length; i++) {
    const orig = dxIdx[i];
    const t = trS[orig - 1];
    const p = pdmS[orig - 1];
    const m = mdmS[orig - 1];
    const a = adxS[i];
    if (t === null || p === null || m === null || a === null || t === 0) continue;
    out[orig] = { pdi: (p / t) * 100, mdi: (m / t) * 100, adx: a };
  }
  return out;
}

/** CCI(14)。 */
export function cciSeries(klines: readonly Kline[], period = 14): (number | null)[] {
  const n = klines.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const tp = klines.map((k) => (k.high + k.low + k.close) / 3);
  const ma = smaSeries(tp, period);
  for (let i = period - 1; i < n; i++) {
    const m = ma[i];
    if (m === null) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m);
    const md = dev / period;
    out[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md);
  }
  return out;
}

/** WR(14)，A股正向口径（0 超买 ~ 100 超卖 的反向习惯这里统一为 0~100，越大越超卖）。 */
export function wrSeries(klines: readonly Kline[], period = 14): (number | null)[] {
  const n = klines.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  for (let i = period - 1; i < n; i++) {
    const h = hhv(highs, i, period);
    const l = llv(lows, i, period);
    out[i] = h === l ? 50 : ((h - klines[i].close) / (h - l)) * 100;
  }
  return out;
}

/** MFI(14) 资金流量指标。 */
export function mfiSeries(klines: readonly Kline[], period = 14): (number | null)[] {
  const n = klines.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tp = klines.map((k) => (k.high + k.low + k.close) / 3);
  const rmf = klines.map((k, i) => tp[i] * (k.volume || 0));
  for (let i = period; i < n; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += rmf[j];
      else if (tp[j] < tp[j - 1]) neg += rmf[j];
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** ATR(14)，Wilder 口径。 */
export function atrSeries(klines: readonly Kline[], period = 14): (number | null)[] {
  const tr: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const s = wilderSmooth(tr, period);
  return [null, ...s];
}

export interface SuperTrendPoint { value: number; trend: 1 | -1; }

/** SuperTrend(10, 3)。 */
export function superTrendSeries(
  klines: readonly Kline[],
  period = 10,
  mult = 3,
): (SuperTrendPoint | null)[] {
  const n = klines.length;
  const out: (SuperTrendPoint | null)[] = new Array(n).fill(null);
  const atr = atrSeries(klines, period);
  let finalUpper = 0;
  let finalLower = 0;
  let trend: 1 | -1 = 1;
  let started = false;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (a === null) continue;
    const hl2 = (klines[i].high + klines[i].low) / 2;
    const basicUpper = hl2 + mult * a;
    const basicLower = hl2 - mult * a;
    if (!started) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = klines[i].close >= hl2 ? 1 : -1;
      started = true;
    } else {
      const prevClose = klines[i - 1].close;
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (trend === 1 && klines[i].close < finalLower) trend = -1;
      else if (trend === -1 && klines[i].close > finalUpper) trend = 1;
    }
    out[i] = { value: trend === 1 ? finalLower : finalUpper, trend };
  }
  return out;
}

/** ROC(12) 变动率（%）。 */
export function rocSeries(closes: readonly number[], period = 12): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period];
    out[i] = base ? ((closes[i] - base) / base) * 100 : null;
  }
  return out;
}

/** 滚动 VWAP(period)。成交额缺失时用 close*volume 近似。 */
export function vwapSeries(klines: readonly Kline[], period = 20): (number | null)[] {
  const n = klines.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let pv = 0;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const vol = klines[j].volume || 0;
      const amt = klines[j].amount || klines[j].close * vol;
      pv += amt;
      v += vol;
    }
    out[i] = v ? pv / v : null;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 指标快照                                                             */
/* ------------------------------------------------------------------ */

export interface IndicatorSnapshot {
  rsi14: number | null;
  kdj: KdjPoint | null;
  kdjPrev: KdjPoint | null;
  boll: BollPoint | null;
  dmi: DmiPoint | null;
  cci: number | null;
  wr: number | null;
  mfi: number | null;
  atr: number | null;
  atrPct: number | null;
  superTrend: SuperTrendPoint | null;
  superTrendPrev: SuperTrendPoint | null;
  roc: number | null;
  vwap: number | null;
  macdDif: number | null;
  macdDea: number | null;
  macdBar: number | null;
  macdBarPrev: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  price: number;
}

function last<T>(arr: readonly (T | null)[]): T | null {
  return arr.length ? arr[arr.length - 1] : null;
}

function nthLast<T>(arr: readonly (T | null)[], k: number): T | null {
  return arr.length > k ? arr[arr.length - 1 - k] : null;
}

/** 计算全部指标的最新快照。 */
export function computeIndicators(klines: readonly Kline[]): IndicatorSnapshot {
  const closes = klines.map((k) => k.close);
  const kdj = kdjSeries(klines);
  const st = superTrendSeries(klines);

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = ema12.map((v, i) => (v === null || ema26[i] === null ? null : v - (ema26[i] as number)));
  const difClean = dif.map((v) => v ?? 0);
  const dea = emaSeries(difClean, 9);
  const bar = difClean.map((d, i) => (dea[i] === null ? null : 2 * (d - (dea[i] as number))));

  const ma = (p: number) => last(smaSeries(closes, p));

  const atr = last(atrSeries(klines));
  const price = closes.length ? closes[closes.length - 1] : 0;

  return {
    rsi14: last(rsiSeries(closes, 14)),
    kdj: last(kdj),
    kdjPrev: nthLast(kdj, 1),
    boll: last(bollSeries(closes)),
    dmi: last(dmiSeries(klines)),
    cci: last(cciSeries(klines)),
    wr: last(wrSeries(klines)),
    mfi: last(mfiSeries(klines)),
    atr,
    atrPct: atr !== null && price ? (atr / price) * 100 : null,
    superTrend: last(st),
    superTrendPrev: nthLast(st, 1),
    roc: last(rocSeries(closes)),
    vwap: last(vwapSeries(klines)),
    macdDif: last(dif),
    macdDea: last(dea),
    macdBar: last(bar),
    macdBarPrev: nthLast(bar, 1),
    ma5: ma(5),
    ma10: ma(10),
    ma20: ma(20),
    ma60: ma(60),
    price,
  };
}
