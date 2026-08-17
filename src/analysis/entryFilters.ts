/**
 * 入场过滤与风险仓位（市面通行做法）。
 *
 * ══ 为什么需要这一层 ══
 *
 * 原始信号引擎只回答「这只股票现在的技术面评分多少」，不回答两个更要紧的问题：
 *   1. 这个价位**买得到吗**？（涨停板上没有卖盘）
 *   2. 该买**多少**？（原实现的止损恒为 −5%、目标恒为 +10%，
 *      盈亏比因此**永远等于 2.0** —— 那是两个常数的算术结果，
 *      不是对风险收益的评估）
 *
 * 本模块补齐这两层，全部采用有公开出处的通行规则，参数均可被回测优化。
 *
 * ══ 过滤器清单 ══
 *
 * | 过滤器        | 依据                                   |
 * |--------------|---------------------------------------|
 * | 涨跌停可交易性 | A股微观结构：涨停板无卖盘，买不到          |
 * | 流动性下限    | 成交额过小时滑点与冲击成本不可控           |
 * | 出货形态识别  | 涨停+高换手+主力净流出，典型的对倒出货特征   |
 * | 大盘择时      | Faber (2007)：指数在200日均线之下不做多     |
 * | 追高过滤      | 偏离均线过远时回归风险高于趋势收益           |
 * | 量能确认      | O'Neil：有效突破需量能显著放大              |
 * | ATR 风险仓位  | 海龟法则：单笔风险固定为总资金的 1 个百分点   |
 */
import type { FundFlow, Kline, PatternResult, Quote, BreakoutResult } from '../types';
import { smaSeries } from './indicators';
import { atrSeries } from './technicalIndicators';
import { fmt, pyRound } from '../util/pynum';
import { FULL_SESSION_MINUTES } from '../util/tradingClock';

export interface EntryFilterParams {
  /** 涨幅接近涨停的比例阈值（占涨跌停幅度），超过视为买不到 */
  limitUpTolerance: number;
  /** 日均成交额下限（元），低于此值不参与 */
  minTurnoverAmount: number;
  /** 换手率警戒线（%），配合主力净流出判定出货 */
  distributionTurnover: number;
  /** 大盘择时均线周期，0 表示关闭 */
  regimeMaPeriod: number;
  /** 距 MA20 的最大正偏离（%），超过视为追高 */
  maxExtensionPct: number;
  /** 量能确认的最低量比 */
  minVolumeRatio: number;
  /** 单笔风险预算（占总资金比例） */
  riskPerTrade: number;
  /** ATR 止损倍数 */
  atrStopMult: number;
  /** 单票最大权重上限 */
  maxWeight: number;
  /**
   * 是否用结构化止损/目标覆盖 trade_plan。
   * 前端应为 true（否则界面又会出现两套价位）；
   * 回测需要 false 来做 A/B，衡量这层改动到底带来了什么。
   */
  applyStructuralPlan: boolean;
}

export const DEFAULT_FILTER_PARAMS: EntryFilterParams = {
  limitUpTolerance: 0.97,
  minTurnoverAmount: 50_000_000,
  distributionTurnover: 15,
  regimeMaPeriod: 200,
  maxExtensionPct: 15,
  minVolumeRatio: 1.2,
  riskPerTrade: 0.01,
  atrStopMult: 2,
  maxWeight: 0.2,
  applyStructuralPlan: true,
};

export type Severity = 'block' | 'warn';

export interface FilterFinding {
  code: string;
  severity: Severity;
  message: string;
}

export interface TradabilityResult {
  tradable: boolean;
  findings: FilterFinding[];
}

/** 板块涨跌幅限制（%）。与 backtest/src/market.ts 保持一致。 */
function limitPctOf(code: string, name: string): number {
  const c = String(code).replace(/\.(SH|SZ|SS|BJ)$/i, '');
  if (name.includes('ST') || name.startsWith('*')) return 5;
  if (c.startsWith('688') || c.startsWith('689')) return 20;
  if (c.startsWith('300') || c.startsWith('301')) return 20;
  if (c.startsWith('8') || c.startsWith('4') || c.startsWith('920')) return 30;
  return 10;
}

/**
 * 可交易性与风险特征检查。
 * 这是本模块最重要的部分：截图里 300394 已 +20% 涨停，
 * 界面却给出「买入价 17.34」—— 那个价位在涨停板上没有卖盘，根本成交不了。
 */
export function checkTradability(
  code: string,
  name: string,
  klines: readonly Kline[],
  quote?: Quote | null,
  flows?: readonly FundFlow[] | null,
  params: EntryFilterParams = DEFAULT_FILTER_PARAMS,
  elapsedMinutes?: number,
): TradabilityResult {
  const findings: FilterFinding[] = [];
  if (!klines.length) return { tradable: false, findings: [{ code: 'NO_DATA', severity: 'block', message: '无K线数据' }] };

  const last = klines[klines.length - 1];
  const prevClose = klines.length > 1 ? klines[klines.length - 2].close : last.open;
  const price = quote?.price || last.close;
  const pct = quote?.pct ?? last.pct;
  const lim = limitPctOf(code, name);

  // ── 1. 涨停：买不到 ──
  if (pct >= lim * params.limitUpTolerance) {
    findings.push({
      code: 'LIMIT_UP',
      severity: 'block',
      message: `已涨停(${fmt(pct, 2)}%/${lim}%)，涨停板无卖盘，此价位无法成交`,
    });
  } else if (pct >= lim * 0.85) {
    findings.push({
      code: 'NEAR_LIMIT_UP',
      severity: 'warn',
      message: `逼近涨停(${fmt(pct, 2)}%)，实际成交价可能显著高于参考价`,
    });
  }

  // ── 2. 跌停：卖不出（持仓时的风险提示）──
  if (pct <= -lim * params.limitUpTolerance) {
    findings.push({
      code: 'LIMIT_DOWN',
      severity: 'block',
      message: `已跌停(${fmt(pct, 2)}%)，无法卖出`,
    });
  }

  // ── 3. 停牌 ──
  if (!last.volume || last.volume <= 0) {
    findings.push({ code: 'SUSPENDED', severity: 'block', message: '成交量为0，疑似停牌' });
  }

  // ── 4. 流动性 ──
  const recent = klines.slice(Math.max(0, klines.length - 20));
  const amts = recent.map((k) => k.amount).filter((a) => a > 0);
  const avgAmount = amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : 0;
  if (avgAmount > 0 && avgAmount < params.minTurnoverAmount) {
    findings.push({
      code: 'ILLIQUID',
      severity: 'block',
      message: `20日均成交额${fmt(avgAmount / 1e8, 2)}亿，低于${fmt(params.minTurnoverAmount / 1e8, 2)}亿门槛，滑点不可控`,
    });
  }

  // ── 5. 出货嫌疑：涨停/大涨 + 高换手 + 主力净流出 ──
  const turnover = quote?.turnover || last.turnover || 0;
  const mainNet = flows && flows.length ? flows[flows.length - 1].main_net : null;
  if (turnover >= params.distributionTurnover && pct > 5 && mainNet !== null && mainNet < 0) {
    findings.push({
      code: 'DISTRIBUTION',
      severity: 'block',
      message: `换手${fmt(turnover, 1)}%、涨${fmt(pct, 1)}%，但主力净流出`
        + `${fmt(Math.abs(mainNet) / 1e8, 2)}亿 —— 对倒出货特征`,
    });
  } else if (turnover >= params.distributionTurnover * 1.6) {
    findings.push({
      code: 'HIGH_TURNOVER',
      severity: 'warn',
      message: `换手率${fmt(turnover, 1)}%异常偏高，游资博弈特征，波动风险大`,
    });
  }

  // ── 6. 追高：偏离 MA20 过远 ──
  const closes = klines.map((k) => k.close);
  const ma20 = smaSeries(closes, 20);
  const ma20Last = ma20.length ? ma20[ma20.length - 1] : null;
  if (ma20Last && ma20Last > 0) {
    const ext = ((price - ma20Last) / ma20Last) * 100;
    if (ext > params.maxExtensionPct) {
      findings.push({
        code: 'EXTENDED',
        severity: 'block',
        message: `股价偏离MA20达${fmt(ext, 1)}%(阈值${params.maxExtensionPct}%)，追高回归风险大`,
      });
    }
  }

  // ── 7. 量能确认 ──
  if (klines.length >= 6) {
    const win = klines.slice(klines.length - 6, klines.length - 1);
    const avg5 = win.reduce((a, k) => a + k.volume, 0) / Math.max(1, win.length);
    const scale = elapsedMinutes && elapsedMinutes > 0
      ? FULL_SESSION_MINUTES / Math.min(elapsedMinutes, FULL_SESSION_MINUTES)
      : 1;
    const vr = avg5 > 0 ? ((quote?.volume || last.volume) / avg5) * scale : 1;
    // 盘中不足 30 分钟时样本太少，量比噪声极大，不做判定
    const tooEarly = elapsedMinutes !== undefined && elapsedMinutes < 30;
    if (vr < params.minVolumeRatio && !tooEarly) {
      findings.push({
        code: 'WEAK_VOLUME',
        severity: 'warn',
        message: `量比${fmt(vr, 2)}低于${params.minVolumeRatio}，突破缺乏量能确认`,
      });
    }
  }

  void prevClose;
  return { tradable: !findings.some((f) => f.severity === 'block'), findings };
}

/**
 * 大盘择时（regime filter）。
 * 依据 Faber (2007) "A Quantitative Approach to Tactical Asset Allocation"：
 * 指数收盘价在长期均线之下时退出多头，可显著降低最大回撤。
 */
export function checkRegime(
  indexKlines?: readonly Kline[] | null,
  params: EntryFilterParams = DEFAULT_FILTER_PARAMS,
): FilterFinding | null {
  if (!params.regimeMaPeriod || !indexKlines || indexKlines.length < params.regimeMaPeriod) return null;
  const closes = indexKlines.map((k) => k.close);
  const ma = smaSeries(closes, params.regimeMaPeriod);
  const maLast = ma[ma.length - 1];
  const px = closes[closes.length - 1];
  if (maLast === null) return null;
  if (px < maLast) {
    return {
      code: 'REGIME_OFF',
      severity: 'block',
      message: `大盘位于${params.regimeMaPeriod}日均线之下(${fmt(px, 1)} < ${fmt(maLast, 1)})，`
        + `系统性风险偏高，暂停做多`,
    };
  }
  return null;
}

export interface RealisticPlan {
  entry: number;
  stop: number;
  target: number;
  /** 止损依据说明 */
  stopBasis: string;
  /** 目标依据说明 */
  targetBasis: string;
  riskReward: number;
  /** 建议权重（按风险预算反推） */
  weight: number;
  /** 单笔最大亏损占总资金比例 */
  riskPct: number;
}

/**
 * 用结构位而非固定百分比构造交易计划。
 *
 * 原实现：stop = entry × 0.95、target = entry × 1.10（无形态时），
 * 于是盈亏比恒为 2.0 —— 这个数字不携带任何信息。
 *
 * 本实现：
 *   止损 = max(ATR止损, 唐奇安通道下轨, 近20日最低)  取最近的一个
 *   目标 = 看涨形态目标 / 前高 / 通道上轨+1ATR      取最近的一个
 *   仓位 = 风险预算 ÷ 单股风险  （海龟法则的核心思想）
 */
export function buildRealisticPlan(
  klines: readonly Kline[],
  patterns: readonly PatternResult[],
  breakouts: readonly BreakoutResult[],
  quote?: Quote | null,
  params: EntryFilterParams = DEFAULT_FILTER_PARAMS,
): RealisticPlan {
  const last = klines[klines.length - 1];
  const entry = quote?.price || last.close;

  // ── 止损：三个候选取最靠近现价的（最小可接受亏损）──
  const atrArr = atrSeries(klines, 14);
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : null;
  const cands: Array<[number, string]> = [];
  if (atr && atr > 0) {
    cands.push([entry - params.atrStopMult * atr, `${params.atrStopMult}×ATR(${fmt(atr, 2)})`]);
  }
  const b1 = breakouts.find((b) => b.system.includes('系统一'));
  if (b1 && b1.channel_low > 0 && b1.channel_low < entry) {
    cands.push([b1.channel_low, '20日通道下轨']);
  }
  if (klines.length >= 20) {
    const lo = Math.min(...klines.slice(klines.length - 20).map((k) => k.low));
    if (lo < entry) cands.push([lo, '近20日最低']);
  }
  let stop = entry * 0.92;
  let stopBasis = '固定8%(无结构位可用)';
  if (cands.length) {
    cands.sort((a, b) => b[0] - a[0]);  // 取最高的止损位 = 最小亏损
    stop = cands[0][0];
    stopBasis = cands[0][1];
  }
  if (stop >= entry) { stop = entry * 0.92; stopBasis = '固定8%(结构位异常)'; }

  // ── 目标：只接受高于现价的看涨结构位 ──
  const tCands: Array<[number, string]> = [];
  for (const p of patterns) {
    if (p.direction === '看涨' && p.target_price && p.target_price > entry) {
      tCands.push([p.target_price, `${p.name}目标位`]);
    }
    const upper = p.key_levels?.['箱体上沿'];
    if (upper && upper > entry) tCands.push([upper, '箱体上沿']);
  }
  if (klines.length >= 60) {
    const hi = Math.max(...klines.slice(klines.length - 60, klines.length - 1).map((k) => k.high));
    if (hi > entry) tCands.push([hi, '近60日前高']);
  }
  if (b1 && b1.channel_high > entry && atr) {
    tCands.push([b1.channel_high + atr, '通道上轨+1ATR']);
  }
  let target = entry + (entry - stop) * 2;
  let targetBasis = '按2倍风险推算(无结构位)';
  if (tCands.length) {
    tCands.sort((a, b) => a[0] - b[0]);  // 取最近的目标 = 最可能达到
    target = tCands[0][0];
    targetBasis = tCands[0][1];
  }

  const riskPerShare = entry - stop;
  const riskReward = riskPerShare > 0 ? pyRound((target - entry) / riskPerShare, 2) : 0;

  // ── 仓位：风险预算 ÷ 单股风险，再受单票权重上限约束 ──
  const riskFrac = entry > 0 ? riskPerShare / entry : 1;
  let weight = riskFrac > 0 ? params.riskPerTrade / riskFrac : 0;
  weight = Math.min(weight, params.maxWeight);

  return {
    entry: pyRound(entry, 2),
    stop: pyRound(stop, 2),
    target: pyRound(target, 2),
    stopBasis,
    targetBasis,
    riskReward,
    weight: pyRound(weight, 4),
    riskPct: pyRound(weight * riskFrac, 4),
  };
}
