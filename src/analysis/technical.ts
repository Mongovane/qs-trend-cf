/**
 * 技术指标评分模块（新增第六模块）。
 *
 * 把 technicalIndicators 的原始数值折算为 0~100 的模块分，并产出可读信号。
 * 评分设计遵循市面通行的“多指标共振”思路：以 50 为中枢，每个指标给出
 * -12 ~ +12 的偏移，最终裁剪到 [0, 100]。任一指标数据不足时自动跳过，
 * 并按实际参与数量归一，避免短历史股票被系统性压低。
 */
import type { Kline } from '../types';
import { clamp, fmt, pyInt } from '../util/pynum';
import { computeIndicators, type IndicatorSnapshot } from './technicalIndicators';

export interface TechnicalResult {
  score: number;
  /** 参与评分的指标数量 */
  contributors: number;
  signals: string[];
  warnings: string[];
  /** 面向前端展示的指标快照（已格式化为 number|null） */
  values: Record<string, number | null>;
  description: string;
}

interface Contribution {
  delta: number;
  signal?: string;
  warning?: string;
}

function scoreRsi(s: IndicatorSnapshot): Contribution | null {
  if (s.rsi14 === null) return null;
  const v = s.rsi14;
  if (v >= 70) return { delta: -4, warning: `RSI ${fmt(v, 1)} 超买` };
  if (v >= 55) return { delta: 10, signal: `RSI ${fmt(v, 1)} 多头区间` };
  if (v >= 45) return { delta: 2 };
  if (v >= 30) return { delta: -6, warning: `RSI ${fmt(v, 1)} 偏弱` };
  return { delta: 4, signal: `RSI ${fmt(v, 1)} 超卖，存在反弹动能` };
}

function scoreKdj(s: IndicatorSnapshot): Contribution | null {
  if (!s.kdj) return null;
  const { k, d, j } = s.kdj;
  const prev = s.kdjPrev;
  const goldCross = !!prev && prev.k <= prev.d && k > d;
  const deadCross = !!prev && prev.k >= prev.d && k < d;
  if (goldCross && k < 80) return { delta: 12, signal: `KDJ金叉(K=${fmt(k, 1)} D=${fmt(d, 1)})` };
  if (deadCross) return { delta: -10, warning: `KDJ死叉(K=${fmt(k, 1)} D=${fmt(d, 1)})` };
  if (j > 100) return { delta: -5, warning: `KDJ J值${fmt(j, 1)}超买` };
  if (j < 0) return { delta: 5, signal: `KDJ J值${fmt(j, 1)}超卖` };
  if (k > d) return { delta: 6 };
  return { delta: -4 };
}

function scoreBoll(s: IndicatorSnapshot): Contribution | null {
  if (!s.boll) return null;
  const { mid, upper, lower, width } = s.boll;
  const p = s.price;
  if (p > upper) return { delta: -3, warning: `股价上穿布林上轨${fmt(upper, 2)}，短线过热` };
  if (p > mid) {
    const c: Contribution = { delta: 8, signal: `股价位于布林中轨${fmt(mid, 2)}之上` };
    if (width < 8) c.signal = `布林带收窄(${fmt(width, 1)}%)且价在中轨上方，变盘偏多`;
    return c;
  }
  if (p < lower) return { delta: 3, signal: `股价下穿布林下轨${fmt(lower, 2)}，超跌` };
  return { delta: -6, warning: `股价位于布林中轨${fmt(mid, 2)}之下` };
}

function scoreDmi(s: IndicatorSnapshot): Contribution | null {
  if (!s.dmi) return null;
  const { pdi, mdi, adx } = s.dmi;
  if (pdi > mdi && adx >= 25) {
    return { delta: 12, signal: `DMI多头(+DI ${fmt(pdi, 1)} > -DI ${fmt(mdi, 1)}, ADX ${fmt(adx, 1)}趋势明确)` };
  }
  if (pdi > mdi) return { delta: 5, signal: `DMI偏多但ADX ${fmt(adx, 1)}趋势偏弱` };
  if (mdi > pdi && adx >= 25) {
    return { delta: -12, warning: `DMI空头(-DI ${fmt(mdi, 1)} > +DI ${fmt(pdi, 1)}, ADX ${fmt(adx, 1)})` };
  }
  return { delta: -5 };
}

function scoreCci(s: IndicatorSnapshot): Contribution | null {
  if (s.cci === null) return null;
  const v = s.cci;
  if (v > 200) return { delta: -3, warning: `CCI ${fmt(v, 0)} 严重超买` };
  if (v > 100) return { delta: 8, signal: `CCI ${fmt(v, 0)} 进入强势区` };
  if (v > -100) return { delta: 0 };
  if (v > -200) return { delta: -6, warning: `CCI ${fmt(v, 0)} 弱势区` };
  return { delta: 3, signal: `CCI ${fmt(v, 0)} 极度超卖` };
}

function scoreWr(s: IndicatorSnapshot): Contribution | null {
  if (s.wr === null) return null;
  const v = s.wr; // 0 = 最高位（超买），100 = 最低位（超卖）
  if (v <= 20) return { delta: -3, warning: `WR ${fmt(v, 1)} 超买区` };
  if (v <= 50) return { delta: 6 };
  if (v <= 80) return { delta: -4 };
  return { delta: 4, signal: `WR ${fmt(v, 1)} 超卖区` };
}

function scoreMfi(s: IndicatorSnapshot): Contribution | null {
  if (s.mfi === null) return null;
  const v = s.mfi;
  if (v >= 80) return { delta: -4, warning: `MFI ${fmt(v, 1)} 资金过热` };
  if (v >= 55) return { delta: 10, signal: `MFI ${fmt(v, 1)} 资金持续流入` };
  if (v >= 45) return { delta: 2 };
  if (v >= 20) return { delta: -7, warning: `MFI ${fmt(v, 1)} 资金流出` };
  return { delta: 3, signal: `MFI ${fmt(v, 1)} 极度超卖` };
}

function scoreSuperTrend(s: IndicatorSnapshot): Contribution | null {
  if (!s.superTrend) return null;
  const cur = s.superTrend;
  const prev = s.superTrendPrev;
  if (cur.trend === 1 && prev && prev.trend === -1) {
    return { delta: 12, signal: `SuperTrend翻多，支撑${fmt(cur.value, 2)}` };
  }
  if (cur.trend === -1 && prev && prev.trend === 1) {
    return { delta: -12, warning: `SuperTrend翻空，压力${fmt(cur.value, 2)}` };
  }
  if (cur.trend === 1) return { delta: 8, signal: `SuperTrend多头，止损参考${fmt(cur.value, 2)}` };
  return { delta: -8, warning: `SuperTrend空头，压力${fmt(cur.value, 2)}` };
}

function scoreMacd(s: IndicatorSnapshot): Contribution | null {
  if (s.macdBar === null || s.macdDif === null || s.macdDea === null) return null;
  const bar = s.macdBar;
  const prev = s.macdBarPrev ?? 0;
  if (bar > 0 && prev <= 0) return { delta: 12, signal: 'MACD金叉，红柱翻正' };
  if (bar < 0 && prev >= 0) return { delta: -12, warning: 'MACD死叉，绿柱翻负' };
  if (bar > 0 && bar > prev) return { delta: 9, signal: 'MACD红柱放大，动能增强' };
  if (bar > 0) return { delta: 3, warning: 'MACD红柱缩短，动能衰减' };
  if (bar < 0 && bar > prev) return { delta: 1, signal: 'MACD绿柱缩短，跌势放缓' };
  return { delta: -9, warning: 'MACD绿柱放大，跌势加速' };
}

function scoreMaStack(s: IndicatorSnapshot): Contribution | null {
  const { ma5, ma10, ma20, ma60, price } = s;
  if (ma5 === null || ma10 === null || ma20 === null) return null;
  if (ma60 !== null && ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && price > ma5) {
    return { delta: 12, signal: '均线完全多头排列(MA5>MA10>MA20>MA60)' };
  }
  if (ma60 !== null && ma5 < ma10 && ma10 < ma20 && ma20 < ma60) {
    return { delta: -12, warning: '均线完全空头排列' };
  }
  if (price > ma20 && ma5 > ma20) return { delta: 6 };
  if (price < ma20) return { delta: -6, warning: '股价运行于MA20下方' };
  return { delta: 0 };
}

function scoreVwap(s: IndicatorSnapshot): Contribution | null {
  if (s.vwap === null) return null;
  if (s.price > s.vwap) return { delta: 5, signal: `股价高于20日VWAP ${fmt(s.vwap, 2)}` };
  return { delta: -5, warning: `股价低于20日VWAP ${fmt(s.vwap, 2)}` };
}

function scoreVolatility(s: IndicatorSnapshot): Contribution | null {
  if (s.atrPct === null) return null;
  const v = s.atrPct;
  if (v > 8) return { delta: -6, warning: `ATR占比${fmt(v, 1)}%，波动过大需降低仓位` };
  if (v > 5) return { delta: -2, warning: `ATR占比${fmt(v, 1)}%，波动偏高` };
  if (v < 1.2) return { delta: 2, signal: `ATR占比${fmt(v, 1)}%，波动收敛` };
  return { delta: 0 };
}

/** 技术指标综合分析。 */
export function analyzeTechnical(klines: readonly Kline[]): TechnicalResult {
  const s = computeIndicators(klines);

  const scorers: Array<[string, (x: IndicatorSnapshot) => Contribution | null]> = [
    ['MACD', scoreMacd],
    ['DMI', scoreDmi],
    ['均线', scoreMaStack],
    ['KDJ', scoreKdj],
    ['SuperTrend', scoreSuperTrend],
    ['RSI', scoreRsi],
    ['MFI', scoreMfi],
    ['BOLL', scoreBoll],
    ['CCI', scoreCci],
    ['WR', scoreWr],
    ['VWAP', scoreVwap],
    ['ATR', scoreVolatility],
  ];

  let deltaSum = 0;
  let maxAbs = 0;
  let contributors = 0;
  const signals: string[] = [];
  const warnings: string[] = [];

  for (const [, fn] of scorers) {
    const c = fn(s);
    if (!c) continue;
    contributors += 1;
    deltaSum += c.delta;
    maxAbs += 12;
    if (c.signal) signals.push(c.signal);
    if (c.warning) warnings.push(c.warning);
  }

  // 按实际参与指标归一到 ±40 的评分区间，再叠加到 50 中枢
  const normalized = maxAbs > 0 ? (deltaSum / maxAbs) * 40 : 0;
  const score = clamp(pyInt(50 + normalized), 0, 100);

  const values: Record<string, number | null> = {
    rsi14: s.rsi14,
    kdj_k: s.kdj ? s.kdj.k : null,
    kdj_d: s.kdj ? s.kdj.d : null,
    kdj_j: s.kdj ? s.kdj.j : null,
    boll_mid: s.boll ? s.boll.mid : null,
    boll_upper: s.boll ? s.boll.upper : null,
    boll_lower: s.boll ? s.boll.lower : null,
    boll_width: s.boll ? s.boll.width : null,
    pdi: s.dmi ? s.dmi.pdi : null,
    mdi: s.dmi ? s.dmi.mdi : null,
    adx: s.dmi ? s.dmi.adx : null,
    cci: s.cci,
    wr: s.wr,
    mfi: s.mfi,
    atr: s.atr,
    atr_pct: s.atrPct,
    supertrend: s.superTrend ? s.superTrend.value : null,
    supertrend_dir: s.superTrend ? s.superTrend.trend : null,
    roc: s.roc,
    vwap: s.vwap,
    macd_dif: s.macdDif,
    macd_dea: s.macdDea,
    macd_bar: s.macdBar,
    ma5: s.ma5,
    ma10: s.ma10,
    ma20: s.ma20,
    ma60: s.ma60,
  };

  const description =
    `技术指标${score}分（${contributors}项参与）` +
    (s.dmi ? ` | ADX=${fmt(s.dmi.adx, 1)}` : '') +
    (s.rsi14 !== null ? ` RSI=${fmt(s.rsi14, 1)}` : '') +
    (s.kdj ? ` KDJ=${fmt(s.kdj.k, 1)}/${fmt(s.kdj.d, 1)}` : '');

  return { score, contributors, signals, warnings, values, description };
}
