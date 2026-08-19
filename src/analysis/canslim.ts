/**
 * CANSLIM 模块。移植自 analysis/canslim_module.py。
 * 七维度：C 近期动量 / A 中期趋势 / N 新高形态 / S 供需 / L 领涨强度 / I 机构资金 / M 大盘环境。
 * 加权总分 = int(0.15C + 0.10A + 0.25N + 0.05S + 0.20L + 0.15I + 0.10M)
 */
import type { CanslimResult, CupHandle, FundFlow, Kline, Quote } from '../types';
import { smaSeries } from './indicators';
import { clamp, pctChange, pyInt, pyRound, sum } from '../util/pynum';

/** C —— 近期动量：20日涨幅分级 与 5日涨幅分级 取较大。 */
function calcCScore(klines: readonly Kline[]): [number, string] {
  if (klines.length < 10) return [50, ''];
  const closes = klines.map((k) => k.close);
  const n = closes.length;
  const gain20 = n >= 21 ? pctChange(closes[n - 21], closes[n - 1]) : 0;
  const gain5 = pctChange(closes[n - 6], closes[n - 1]);
  let score20: number;
  if (gain20 > 20) score20 = 90;
  else if (gain20 > 15) score20 = 80;
  else if (gain20 > 10) score20 = 70;
  else if (gain20 > 5) score20 = 60;
  else if (gain20 > 0) score20 = 50;
  else if (gain20 > -5) score20 = 35;
  else score20 = 20;
  let score5: number;
  if (gain5 > 5) score5 = 80;
  else if (gain5 > 2) score5 = 70;
  else if (gain5 > 0) score5 = 60;
  else if (gain5 > -5) score5 = 50;
  else score5 = 35;
  const score = Math.max(score20, score5);
  return [score, `C(近期动量)${score}分`];
}

/** A —— 中期趋势：近120日涨幅分级。 */
function calcAScore(klines: readonly Kline[]): [number, string] {
  if (klines.length < 125) return [50, ''];
  const n = klines.length;
  const gain = pctChange(klines[n - 121].close, klines[n - 1].close);
  let score: number;
  if (gain > 150) score = 90;
  else if (gain > 30) score = 75;
  else if (gain > 15) score = 70;
  else if (gain > 12) score = 60;
  else if (gain > 5) score = 50;
  else if (gain > -15) score = 35;
  else score = 20;
  return [score, `A(中期趋势)${score}分`];
}

/** N —— 新高形态：接近52周新高 + 杯柄形态突破。 */
function calcNScore(klines: readonly Kline[]): [number, string, CupHandle | null] {
  if (klines.length < 60) return [50, '', null];
  const n = klines.length;
  const high250 =
    n >= 100
      ? Math.max(...klines.slice(Math.max(0, n - 250)).map((k) => k.high))
      : Math.max(...klines.map((k) => k.high));
  const price = klines[n - 1].close;
  const dist = high250 ? ((high250 - price) / high250) * 100 : 100;
  const cupHandle = detectCupHandle(klines);
  const high120Prev = n >= 121 ? Math.max(...klines.slice(n - 121, n - 1).map((k) => k.high)) : 0;
  let score: number;
  if (price >= high120Prev) score = 100;
  else if (dist < 3) score = 70;
  else if (cupHandle && cupHandle.breakout) {
    if (dist < 8) score = 90;
    else if (dist < 12) score = 85;
    else score = 75;
  } else score = 40;
  return [score, `N(新高/形态)${score}分`, cupHandle];
}

/** S —— 供需关系：40 基准，缩量 -2，放量加分。 */
function calcSScore(klines: readonly Kline[], quote?: Quote | null): [number, string] {
  const n = klines.length;
  let volRatio = 1.0;
  if (n >= 6) {
    const avg5 = sum(klines.slice(n - 6, n - 1).map((k) => k.volume)) / 5;
    volRatio = avg5 ? klines[n - 1].volume / avg5 : 1.0;
  }
  let score = 40;
  if (volRatio < 0.5) score -= 2;
  else if (volRatio >= 2.0) score += 15;
  else if (volRatio >= 1.5) score += 5;
  return [score, `S(供需关系)${score}分`];
}

/** L —— 领涨强度：60日涨幅基础分 + 250日涨幅奖罚。 */
function calcLScore(klines: readonly Kline[]): [number, string] {
  if (klines.length < 95) return [50, ''];
  const closes = klines.map((k) => k.close);
  const n = closes.length;
  const gain60 = n >= 61 ? pctChange(closes[n - 61], closes[n - 1]) : 0;
  const gain250 = n >= 251 ? pctChange(closes[n - 251], closes[n - 1]) : pctChange(closes[0], closes[n - 1]);
  let base: number;
  if (gain60 >= 30) base = 70;
  else if (gain60 >= 15) base = 60;
  else if (gain60 >= 5) base = 50;
  else if (gain60 >= 1) base = 43;
  else if (gain60 >= -9) base = 30;
  else base = 20;
  let adj: number;
  if (gain250 > 2.5) adj = 18;
  else if (gain250 > 0) adj = 13;
  else if (gain250 < -30) adj = -5;
  else adj = 0;
  const score = clamp(base + adj, 0, 100);
  return [score, `L(相对强度)${score}分`];
}

/** I —— 机构资金：以资金流替代机构持仓数据。 */
function calcIScore(flows?: readonly FundFlow[] | null): [number, string] {
  if (!flows || flows.length === 0) return [50, ''];
  const mainNets = flows.map((f) => f.main_net).filter((v) => v !== null && v !== undefined);
  if (mainNets.length === 0) return [50, ''];
  let streak = 0;
  const last3 = mainNets.slice(Math.max(0, mainNets.length - 3));
  for (let i = last3.length - 1; i >= 0; i--) {
    if (last3[i] > 0) streak += 1;
    else break;
  }
  const sum5 = sum(mainNets.slice(Math.max(0, mainNets.length - 5)));
  const last = mainNets[mainNets.length - 1];
  let score: number;
  if (streak >= 3) score = 85;
  else if (sum5 < 0) score = 10;
  else if (last < -5e8) score = 45;
  else if (sum5 > 0) score = 75;
  else score = 55;
  return [score, `I(机构资金)${score}分`];
}

/**
 * M —— 大盘环境：优先用上证指数；无指数数据时回退个股均线。
 * [FIX-P2] 原实现中 src 被赋值两次（第二次覆盖第一次），而 src_name 基于第一次判定，
 * 属冗余写法。此处合并为单次判定，行为与原版完全等价。
 */
/**
 * M —— 市场环境。
 *
 * 原实现：MA20 < MA60 时直接给 15 分，即使 78% 个股上涨也显示"偏空"。
 * 这在轮动反弹行情（均线向下但个股普涨）下会严重误判。
 *
 * 修复后用**双因子综合**：
 *   基础分 = 均线状态（35~80 分，占 60%）
 *   修正分 = 近期动量（20 日上涨天数，占 40%）
 * 两者加权取整。breadth bonus 在后续的 applyBreadthToMScore 里叠加。
 */
function calcMScore(
  indexKlines: readonly Kline[] | null | undefined,
  stockKlines: readonly Kline[],
  legacy = false,
): [number, string] {
  const hasIndex = !!indexKlines && indexKlines.length >= 30;
  const src = hasIndex ? (indexKlines as readonly Kline[]) : stockKlines;
  if (src.length < 30) return [50, ''];
  const closes = src.map((k) => k.close);
  const ma20 = smaSeries(closes, 20);
  const ma60 = smaSeries(closes, 60);
  const ma20Val = ma20.length ? ma20[ma20.length - 1] : null;
  const ma60Val = ma60.length ? ma60[ma60.length - 1] : null;
  if (ma20Val === null || ma60Val === null) return [50, ''];

  let upDays20 = 0;
  for (let i = closes.length - 20; i < closes.length; i++) {
    if (i > 0 && closes[i] > closes[i - 1]) upDays20 += 1;
  }

  if (legacy) {
    // ── legacy 档位：原版逻辑，与 Python 版逐字段一致 ──
    const hasIdx = !!indexKlines && indexKlines.length >= 30;
    let score: number;
    if (ma20Val > ma60Val && upDays20 >= 13) score = 80;
    else if (ma20Val > ma60Val && upDays20 >= 7) score = 70;
    else if (ma20Val > ma60Val) score = 60;
    else if (hasIdx) score = 15;
    else score = 35;
    return [score, `M(市场环境)${score}分`];
  }

  // ── enhanced 档位：双因子综合 ──
  let maFactor: number;
  if (ma20Val > ma60Val && upDays20 >= 13) maFactor = 80;
  else if (ma20Val > ma60Val && upDays20 >= 7) maFactor = 70;
  else if (ma20Val > ma60Val) maFactor = 60;
  else if (upDays20 >= 12) maFactor = 45;
  else if (upDays20 >= 8) maFactor = 35;
  else maFactor = 20;

  const momentumFactor = Math.round((upDays20 / 20) * 100);
  const score = Math.round(maFactor * 0.6 + momentumFactor * 0.4);
  return [score, `M(市场环境)${score}分`];
}

function calcGrade(score: number): string {
  if (score >= 85) return 'A+';
  if (score >= 70) return 'A';
  if (score >= 60) return 'B+';
  if (score >= 50) return 'B';
  if (score >= 40) return 'C+';
  if (score >= 30) return 'C';
  return 'D';
}

/** 杯柄形态检测。 */
function detectCupHandle(klines: readonly Kline[]): CupHandle | null {
  if (klines.length < 80) return null;
  const window = klines.slice(Math.max(0, klines.length - 120));
  const lows = window.map((k) => k.low);
  const cupLow = Math.min(...lows);
  const cupLowIdx = lows.indexOf(cupLow);
  if (cupLowIdx < 20 || cupLowIdx > window.length - 20) return null;

  const left = window.slice(0, cupLowIdx);
  if (left.length < 10) return null;
  const leftRecent = left.slice(Math.max(0, left.length - 20));
  const cupHigh = Math.max(...leftRecent.map((k) => k.high));
  if (cupHigh <= cupLow) return null;

  const right = window.slice(cupLowIdx);
  let handleHighIdx = 0;
  for (let i = 1; i < right.length; i++) {
    if (right[i].high > right[handleHighIdx].high) handleHighIdx = i;
  }
  const handleHigh = right[handleHighIdx].high;
  if (handleHigh <= cupLow) return null;

  const ws = klines.length - 20;
  const allLows = klines.map((k) => k.low);
  const handleLow = ws + 2 < allLows.length ? Math.min(...allLows.slice(ws + 2)) : null;
  if (!handleLow || handleLow <= 0) return null;

  const cupDepth = ((cupHigh - cupLow) / cupHigh) * 100;
  const handleDepth = ((handleHigh - handleLow) / handleHigh) * 100;
  if (!(cupDepth >= 5 && cupDepth <= 35) || handleDepth > 30) return null;

  const buyPoint = handleHigh;
  const target = buyPoint + (cupHigh - cupLow);
  const recentHighs = klines.slice(Math.max(0, klines.length - 30)).map((k) => k.high);
  const breakout = Math.max(...recentHighs) >= buyPoint;

  return {
    pattern: '杯柄形态',
    cup_high: pyRound(cupHigh, 2),
    cup_low: pyRound(cupLow, 2),
    handle_high: pyRound(handleHigh, 2),
    handle_low: pyRound(handleLow, 2),
    cup_depth: pyRound(cupDepth, 1),
    handle_depth: pyRound(handleDepth, 1),
    breakout,
    buy_point: pyRound(buyPoint, 2),
    target: pyRound(target, 2),
  };
}

/** CANSLIM 综合分析。 */
export function analyzeCanslim(
  klines: readonly Kline[],
  quote?: Quote | null,
  flows?: readonly FundFlow[] | null,
  indexKlines?: readonly Kline[] | null,
  legacy = false,
): CanslimResult {
  const [cScore, cText] = calcCScore(klines);
  const [aScore, aText] = calcAScore(klines);
  const [nScore, nText, cupHandle] = calcNScore(klines);
  const [sScore] = calcSScore(klines, quote); // S 维度不产出信号文本（与原版一致）
  const [lScore, lText] = calcLScore(klines);
  const [iScore, iText] = calcIScore(flows);
  const [mScore, mText] = calcMScore(indexKlines, klines, legacy);

  const total = pyInt(
    0.15 * cScore + 0.1 * aScore + 0.25 * nScore + 0.05 * sScore + 0.2 * lScore + 0.15 * iScore + 0.1 * mScore,
  );
  const grade = calcGrade(total);

  const signals: string[] = [];
  if (cScore >= 65) signals.push(cText);
  if (aScore >= 65) signals.push(aText);
  if (nScore >= 65) signals.push(nText);
  if (lScore >= 70) signals.push(lText);
  if (iScore >= 65) signals.push(iText);
  if (mScore >= 70) signals.push(mText);
  if (mScore < 40) signals.push('⚠️ 市场环境偏空，谨慎操作');
  if (iScore < 30) signals.push('⚠️ 机构资金流出，注意风险');
  if (lScore < 30) signals.push('⚠️ 相对强度弱势，非领涨股');

  const description =
    `综合${total}分(${grade}) | C=${cScore} A=${aScore} N=${nScore} ` +
    `S=${sScore} L=${lScore} I=${iScore} M=${mScore}`;

  return {
    c_score: cScore,
    a_score: aScore,
    n_score: nScore,
    s_score: sScore,
    l_score: lScore,
    i_score: iScore,
    m_score: mScore,
    total,
    grade,
    signals,
    cup_handle: cupHandle,
    description,
  };
}
