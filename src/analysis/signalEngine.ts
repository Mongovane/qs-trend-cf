/**
 * 信号引擎 —— 五模块聚合与决策。移植自 analysis/signal_engine.py。
 *
 * 综合分 = int(趋势×25% + CANSLIM×20% + 突破×20% + 量价×20% + 形态×15%)
 * 形态分 = 50 + Σ(方向 × confidence × 0.2)
 */
import type {
  BreakoutResult,
  CanslimResult,
  FundFlow,
  Kline,
  PatternResult,
  Quote,
  SignalEngineResult,
  TradePlan,
  TrendResult,
  VolumePriceResult,
} from '../types';
import { analyzeTrend } from './trend';
import { analyzeVolumePrice } from './volumePrice';
import { analyzePatterns } from './pattern';
import { analyzeBreakout } from './breakout';
import { analyzeCanslim } from './canslim';
import { analyzeTechnical, type TechnicalResult } from './technical';
import {
  buildRealisticPlan, checkRegime, checkTradability,
  DEFAULT_FILTER_PARAMS, type EntryFilterParams,
} from './entryFilters';
import { clamp, fmt, pyInt, pyRound } from '../util/pynum';

/**
 * 评分档位。
 *  - legacy   : 与原 Python 版完全一致的五模块权重（趋势25/CANSLIM20/突破20/量价20/形态15）
 *  - enhanced : 引入「技术指标」第六模块后的六模块权重（默认）
 */
export type ScoringProfile = 'legacy' | 'enhanced';

const WEIGHTS: Record<ScoringProfile, Record<string, number>> = {
  legacy: { 趋势: 0.25, CAN_SLIM: 0.2, 突破: 0.2, 量价: 0.2, 形态: 0.15 },
  enhanced: { 趋势: 0.2, 技术指标: 0.2, 量价: 0.18, 突破: 0.15, CAN_SLIM: 0.15, 形态: 0.12 },
};

/** 风险等级 / 信号强度判定的分档阈值。 */
const RISK_HEAVY = 5;
const RISK_MEDIUM = 3;
const STRONG_SCORE = 75;
const MEDIUM_SCORE = 60;

function trendToScore(trend: TrendResult): number {
  return trend.strength;
}

function patternToScore(patterns: readonly PatternResult[]): number {
  let total = 50;
  for (const p of patterns) {
    const sign = p.direction === '看涨' ? 1 : p.direction === '看跌' ? -1 : 0;
    total += sign * p.confidence * 0.2;
  }
  return clamp(pyInt(total), 20, 100);
}

function volumePriceToScore(vp: VolumePriceResult): number {
  if (vp.direction === '看涨') return vp.confidence;
  if (vp.direction === '看跌') return Math.max(20, 100 - vp.confidence);
  return 50;
}

function breakoutToScore(breakouts: readonly BreakoutResult[]): number {
  let score = 50;
  let hasSignal = false;
  let hasShortCover = false;
  for (const b of breakouts) {
    if (b.signal === '持仓' || b.signal === '持仓空头' || b.signal === '多头止损') hasSignal = true;
    if (b.signal === '空头平仓') hasShortCover = true;
  }
  if (hasSignal) score = 60;
  else if (hasShortCover) score = 60;
  if (hasShortCover) score += 3;
  return Math.min(100, score);
}

function calcRiskLevel(
  score: number,
  trend: TrendResult,
  vp: VolumePriceResult,
  canslim: CanslimResult,
  breakouts: readonly BreakoutResult[],
): [string, string] {
  let riskPoints = 0;
  if (trend.direction === '下降') riskPoints += 2;
  if (vp.direction === '看跌') riskPoints += 2;
  if (canslim.m_score < 30) riskPoints += 1;
  const hasStopLoss = breakouts.some((b) => b.signals.some((s) => s.includes('止损')));
  if (hasStopLoss) riskPoints += 1;

  let riskLevel: string;
  if (riskPoints >= RISK_HEAVY) riskLevel = '高';
  else if (riskPoints >= RISK_MEDIUM) riskLevel = '中';
  else riskLevel = '低';

  let strength: string;
  if (score >= STRONG_SCORE) strength = '强';
  else if (score >= MEDIUM_SCORE) strength = '中';
  else strength = '弱';
  return [riskLevel, strength];
}

const PRIORITY_MAP: Record<string, number> = { 头肩底: 0, 双底: 1, 箱体: 2 };

function buildTradePlan(
  action: string,
  score: number,
  patterns: readonly PatternResult[],
  breakouts: readonly BreakoutResult[],
  klines: readonly Kline[],
): TradePlan {
  const entry = klines.length ? klines[klines.length - 1].close : 0;
  const stop = pyRound(entry * 0.95, 2);

  const ordered = patterns
    .filter((p) => p.direction === '看涨' && p.target_price)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const pa = PRIORITY_MAP[a.p.name] ?? 9;
      const pb = PRIORITY_MAP[b.p.name] ?? 9;
      return pa === pb ? a.i - b.i : pa - pb;
    })
    .map((x) => x.p);

  let target: number | null = null;
  for (const p of ordered) {
    if (p.target_price !== null && p.target_price > entry) {
      target = p.target_price;
      break;
    }
  }
  if (target === null) {
    for (const p of patterns) {
      if ('箱体上沿' in p.key_levels) {
        target = p.key_levels['箱体上沿'];
        break;
      }
    }
  }
  if (target === null) target = entry * 1.1;

  const riskAmt = entry - stop;
  const rewardAmt = target - entry;
  const riskReward = riskAmt > 0 ? pyRound(rewardAmt / riskAmt, 1) : 0;
  const maxLossPct = 5.0;

  let positionSize: string;
  if (action === '观望') positionSize = '空仓等待';
  else if (score >= STRONG_SCORE) positionSize = '正常仓位';
  else positionSize = '半仓(1/2)';

  const holdingPeriod = '中线(1-3月)';

  const notes: string[] = [];
  for (const b of breakouts) {
    if (b.signal === '持仓' && b.entry_price) {
      let note = `${b.system}：持仓中(突破价${b.entry_price})，止损${fmt(b.stop_loss, 2)}`;
      if (b.next_add_price) note += `；加仓价${fmt(b.next_add_price, 2)}`;
      notes.push(note);
      break;
    }
  }

  return {
    action,
    entry_price: pyRound(entry, 2),
    stop_loss: pyRound(stop, 2),
    target_price: pyRound(target, 2),
    position_size: positionSize,
    holding_period: holdingPeriod,
    risk_reward_ratio: riskReward,
    max_loss_pct: maxLossPct,
    notes: notes.join('；'),
  };
}

function buildPlainSummary(
  action: string,
  trend: TrendResult,
  patterns: readonly PatternResult[],
  vp: VolumePriceResult,
  canslim: CanslimResult,
  plan: TradePlan,
): string {
  const hasHeadShoulder = patterns.some((p) => p.name === '头肩底');
  const hasFlowOut = (vp ? vp.signals : []).some((s) => s.includes('流出'));
  const volumePriceOk = !!(vp && vp.direction === '看涨' && vp.confidence >= 70);

  if (action === '观望') {
    const parts = [`处于${trend.direction}趋势`];
    if (hasFlowOut) parts.push('主力资金流出');
    if (canslim.m_score < 30) parts.push('大盘环境偏空');
    return `建议观望，${parts.join('，')}。建议耐心等待信号明确后再操作。`;
  }

  const trendDesc = trend.strength >= 70 ? '强势上升趋势' : '上升趋势';
  const parts = [`处于${trendDesc}`];
  if (canslim.m_score < 30) parts.push('⚠️大盘偏空');
  if (hasHeadShoulder) parts.push('头肩底形态确认');
  if (volumePriceOk) parts.push('量价配合良好');

  const entry = plan.entry_price ?? 0;
  const stop = plan.stop_loss ?? 0;
  const target = plan.target_price ?? 0;
  const rr = plan.risk_reward_ratio ?? 0;
  return (
    `出现买入信号，${parts.join('，')}。` +
    `建议${plan.position_size ?? ''}入场，买入价${fmt(entry, 2)}，` +
    `止损${fmt(stop, 2)}，目标${fmt(target, 2)}（盈亏比${rr}）。`
  );
}

/** 五模块综合分析入口。 */
export function runAnalysis(
  klines: readonly Kline[],
  quote?: Quote | null,
  flows?: readonly FundFlow[] | null,
  indexKlines?: readonly Kline[] | null,
  profile: ScoringProfile = 'enhanced',
  filterParams: EntryFilterParams = DEFAULT_FILTER_PARAMS,
  /** 盘中已开市分钟数；回测与 legacy 不传 */
  elapsedMinutes?: number,
): SignalEngineResult {
  const isLegacy = profile === 'legacy';
  const trend = analyzeTrend(klines, isLegacy);
  const patterns = analyzePatterns(klines, isLegacy);
  const vp = analyzeVolumePrice(klines, quote, flows, isLegacy ? undefined : elapsedMinutes);
  const breakouts = analyzeBreakout(klines);
  const canslim = analyzeCanslim(klines, quote, flows, indexKlines);
  const technical: TechnicalResult | null =
    profile === 'enhanced' ? analyzeTechnical(klines) : null;

  const trendScore = trendToScore(trend);
  const patternScore = patternToScore(patterns);
  const vpScore = volumePriceToScore(vp);
  const breakoutScore = breakoutToScore(breakouts);
  const canslimScore = canslim.total;

  const moduleScores: Record<string, number> = {
    趋势: trendScore,
    形态: patternScore,
    量价: vpScore,
    突破: breakoutScore,
    CAN_SLIM: canslimScore,
  };
  if (technical) moduleScores['技术指标'] = technical.score;

  const w = WEIGHTS[profile];
  let weighted = 0;
  for (const [key, weight] of Object.entries(w)) {
    weighted += (moduleScores[key] ?? 50) * weight;
  }
  const score = pyInt(weighted);

  let action: string;
  if (score >= 75) action = '强烈买入';
  else if (score >= 60) action = '买入';
  else action = '观望';

  const qualifiedCount = Object.values(moduleScores).filter((s) => s >= 60).length;
  const confidence = Math.max(10, pyInt(score * 0.8) + 12 * qualifiedCount - 40);

  const [riskLevel, signalStrength] = calcRiskLevel(score, trend, vp, canslim, breakouts);

  // ---- 信号聚合 ----
  const buySignals: string[] = [];
  const sellSignals: string[] = [];

  if (trend.strength >= 65) buySignals.push(`趋势强势上升(${trend.strength}分)`);
  else if (trend.strength >= 45) buySignals.push(`趋势上升(${trend.strength}分)`);
  for (const sig of trend.signals) {
    if (!buySignals.includes(sig) && !sig.startsWith('MA20')) buySignals.push(sig);
  }

  for (const p of patterns) {
    if (p.name === '头肩底' && p.direction === '看涨') buySignals.push(`${p.name}(${p.status})`);
  }

  if (vp.direction === '看涨' && vp.confidence >= 60) {
    buySignals.push(`量价${vp.pattern}(${vp.confidence}分)`);
  }
  for (const sig of vp.signals) {
    if (sig.includes('流出')) sellSignals.push(sig);
    else if (sig.includes('净流入')) buySignals.push(sig);
  }

  for (const b of breakouts) {
    if (b.signal === '持仓' && b.entry_price) {
      buySignals.push(`${b.system}持仓(N=${fmt(b.current_n, 2)}，止损${fmt(b.stop_loss, 2)})`);
    } else if (b.signal === '空头平仓') {
      buySignals.push(`${b.system}空头平仓@${b.breakout_price}(偏多)`);
    } else if (b.signal === '多头止损') {
      sellSignals.push(`${b.system}多头止损@${fmt(b.stop_loss, 2)}`);
    }
  }

  for (const sig of canslim.signals) {
    if (sig.includes('⚠️')) sellSignals.push(sig);
    else if (!sig.startsWith('M(')) buySignals.push(sig);
  }

  // 技术指标模块信号（enhanced 档位）
  if (technical) {
    for (const sig of technical.signals) buySignals.push(sig);
    for (const wmsg of technical.warnings) sellSignals.push(wmsg);
  }

  // ---- 风险提示 ----
  const riskWarnings: string[] = [];
  if (canslim.m_score < 30) riskWarnings.push('市场环境偏空');
  if (vp.direction === '看跌') riskWarnings.push('量价配合不佳');
  if (trend.direction === '下降') riskWarnings.push('处于下降趋势');
  if (technical && technical.score < 40) riskWarnings.push(`技术指标偏空(${technical.score}分)`);

  // ---- 关键价位：仅聚合最高优先级形态 ----
  const keyLevels: Record<string, number> = {};
  let primaryPattern: PatternResult | null = null;
  for (const namePrefix of ['头肩', '双底', '箱体']) {
    for (const p of patterns) {
      if (p.name.startsWith(namePrefix)) {
        primaryPattern = p;
        break;
      }
    }
    if (primaryPattern !== null) break;
  }
  if (primaryPattern !== null) {
    for (const [label, val] of Object.entries(primaryPattern.key_levels)) {
      keyLevels[`${primaryPattern.name}_${label}`] = pyRound(val, 2);
    }
  }
  for (const b of breakouts) {
    if (b.stop_loss > 0) keyLevels[`${b.system}_止损`] = b.stop_loss;
  }
  if (canslim.cup_handle) keyLevels['杯柄买点'] = canslim.cup_handle.buy_point;
  if (trend.trendline) keyLevels['趋势线'] = trend.trendline.current_price;

  // ══ 可交易性检查与真实交易计划（仅 enhanced 档位）══
  // legacy 档位必须与 v4.0 逐字段一致，因此完全不走这条分支。
  let execution: SignalEngineResult['execution'] = null;
  if (!isLegacy) {
    const code = quote?.symbol ?? '';
    const nm = quote?.name ?? '';
    const trad = checkTradability(code, nm, klines, quote, flows, filterParams, elapsedMinutes);
    const regime = checkRegime(indexKlines, filterParams);
    const findings = [...trad.findings];
    if (regime) findings.push(regime);
    const rp = buildRealisticPlan(klines, patterns, breakouts, quote, filterParams);
    execution = {
      tradable: trad.tradable && !findings.some((f) => f.severity === 'block'),
      findings,
      plan: rp,
    };
  }

  const tradePlan = buildTradePlan(action, score, patterns, breakouts, klines);
  // enhanced 档位用结构位替换硬编码的 −5%/+10%。
  // 原实现下 target/stop 恒为 entry×1.1 / entry×0.95，盈亏比因此**永远是 2.0**，
  // 那是两个常数的算术结果，不携带任何关于该标的的信息。
  if (execution?.plan && filterParams.applyStructuralPlan) {
    tradePlan.entry_price = execution.plan.entry;
    tradePlan.stop_loss = execution.plan.stop;
    tradePlan.target_price = execution.plan.target;
    tradePlan.risk_reward_ratio = execution.plan.riskReward;
    tradePlan.max_loss_pct = pyRound(
      execution.plan.entry > 0
        ? ((execution.plan.entry - execution.plan.stop) / execution.plan.entry) * 100 : 0, 2);
  }

  const descParts = [`综合${score}分`];
  if (trend.direction) descParts.push(`趋势=${trend.direction}(${trendScore})`);
  if (vp) descParts.push(`量价=${vp.pattern}(${vpScore})`);
  descParts.push(`突破=${breakoutScore}`);
  if (canslim) descParts.push(`CS=${canslim.grade}(${canslimScore})`);
  if (patterns.length) descParts.push(`形态=${patternScore}`);
  if (technical) descParts.push(`技术=${technical.score}`);
  const description = descParts.join(' | ');

  const plainSummary = buildPlainSummary(action, trend, patterns, vp, canslim, tradePlan);

  return {
    action,
    score,
    confidence,
    risk_level: riskLevel,
    signal_strength: signalStrength,
    trend,
    patterns: patterns.slice(),
    volume_price: vp,
    breakouts: breakouts.slice(),
    canslim,
    module_scores: moduleScores,
    buy_signals: buySignals,
    sell_signals: sellSignals,
    risk_warnings: riskWarnings,
    key_levels: keyLevels,
    description,
    plain_summary: plainSummary,
    trade_plan: tradePlan,
    technical: technical
      ? {
          score: technical.score,
          contributors: technical.contributors,
          signals: technical.signals,
          warnings: technical.warnings,
          values: technical.values,
          description: technical.description,
        }
      : null,
    scoring_profile: profile,
    execution,
  };
}
