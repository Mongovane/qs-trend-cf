/**
 * 事件驱动回测引擎。
 *
 * ══ 防未来函数的三条结构性约束 ══
 *
 * 1. **切片隔离**：第 t 个交易日调用分析引擎时，只传入 klines.slice(0, t+1)。
 *    引擎内部所有 `[-1]` 都指向第 t 天，物理上拿不到未来数据。
 *
 * 2. **次日开盘成交**：第 t 日收盘后产生的信号，在第 t+1 日开盘价成交。
 *    绝不允许用第 t 日收盘价成交 —— 那意味着你在收盘前就知道了收盘价。
 *
 * 3. **基准与资金流同步切片**：指数 K 线、资金流也按日期截断，
 *    否则 CANSLIM 的 M 维度会偷看未来大盘走势。
 *
 * ══ 已建模的 A股约束 ══
 *   T+1 卖出限制 / 一字涨停买不到 / 一字跌停卖不出 / 停牌跳过 /
 *   100 股整手 / 双边佣金(含最低5元) / 卖出印花税 / 过户费 / 滑点
 */
import type { FundFlow, Kline, Quote } from '../../src/types';
import { runAnalysis, type ScoringProfile } from '../../src/analysis/signalEngine';
import { DEFAULT_FILTER_PARAMS, type EntryFilterParams } from '../../src/analysis/entryFilters';
import { applySignalOptimization, toOptimizable } from '../../src/analysis/optimizer';
import type { OptimizedSignal } from '../../src/types';
import {
  DEFAULT_COSTS, applySlippage, buyFees, detectBoard, isLimitDownAtOpen,
  isLimitUpAtOpen, isSuspended, roundLot, sellFees, type Board, type CostConfig,
} from './market';
import { computeMetrics, type EquityPoint, type Metrics, type Trade } from './metrics';

export interface SymbolData {
  symbol: string;
  name: string;
  klines: Kline[];
  flows?: FundFlow[];
}

export interface StrategyParams {
  /** 触发建仓的最低综合分 */
  minScore: number;
  /** 触发建仓的最低置信度 */
  minConfidence: number;
  /** 允许建仓的 action 集合 */
  allowedActions: string[];
  /** 最大同时持仓数 */
  maxPositions: number;
  /** 单票最大资金占比 */
  maxWeight: number;
  /** 是否按 position_advice 缩放仓位 */
  usePositionAdvice: boolean;
  /** 止损方式 */
  stopMode: 'plan' | 'atr' | 'fixed';
  /** stopMode=fixed 时的固定止损百分比 */
  fixedStopPct: number;
  /** ATR 止损倍数（stopMode=atr） */
  atrMult: number;
  /** 是否启用目标价止盈 */
  useTarget: boolean;
  /** 移动止盈：从最高点回撤该比例即离场，0 表示关闭 */
  trailingPct: number;
  /** 最长持仓交易日，0 表示不限 */
  maxHoldDays: number;
  /** 信号退化为观望时是否离场 */
  exitOnDowngrade: boolean;
  /**
   * 离场分数线（滞后带下沿）。必须明显低于 minScore，否则评分在阈值附近
   * 抖动会导致「今天买、明天卖」的高频换手，费用直接吃掉全部收益。
   * 这是回测暴露出的首要问题：原始逻辑下 90% 交易因信号退化在 2.5 日内平仓。
   */
  exitScore: number;
  /** 最短持仓交易日，期间不因信号退化离场（止损止盈仍生效） */
  minHoldDays: number;
  /** 按当前权益而非期初资金计算仓位（复利） */
  compound: boolean;
  /** 评分档位 */
  profile: ScoringProfile;
  /** 分析所需最少历史 K 线 */
  warmup: number;
  /** 每 N 个交易日重算一次信号（1=每日，降低回测耗时） */
  rebalanceEvery: number;
  /** 入场过滤参数（涨停、流动性、大盘择时、追高、量能、风险仓位） */
  filters: EntryFilterParams;
  /** 是否用 execution.plan 的结构化止损/目标替代 trade_plan */
  useStructuralPlan: boolean;
  /** 是否按 execution.plan.weight 的风险预算定仓 */
  useRiskSizing: boolean;
}

export const DEFAULT_PARAMS: StrategyParams = {
  minScore: 60,
  minConfidence: 0,
  allowedActions: ['强烈买入', '买入', '谨慎买入'],
  maxPositions: 5,
  maxWeight: 0.2,
  usePositionAdvice: true,
  stopMode: 'plan',
  fixedStopPct: 0.08,
  atrMult: 2,
  useTarget: true,
  trailingPct: 0,
  maxHoldDays: 60,
  exitOnDowngrade: true,
  exitScore: 45,
  minHoldDays: 5,
  compound: true,
  profile: 'enhanced',
  warmup: 125,
  rebalanceEvery: 1,
  filters: DEFAULT_FILTER_PARAMS,
  useStructuralPlan: true,
  useRiskSizing: true,
};

export interface BacktestConfig {
  initialCapital: number;
  startDate?: string;
  endDate?: string;
  costs: CostConfig;
  params: StrategyParams;
  /** 基准指数日线，用于 alpha/beta 与 CANSLIM 的 M 维度 */
  benchmark?: Kline[];
  riskFreeRate: number;
  verbose: boolean;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 1_000_000,
  costs: DEFAULT_COSTS,
  params: DEFAULT_PARAMS,
  riskFreeRate: 0.015,
  verbose: false,
};

interface Position {
  symbol: string;
  name: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  entryBarIdx: number;
  stopLoss: number;
  targetPrice: number;
  highSinceEntry: number;
  entryScore: number;
  entryAction: string;
  board: Board;
  /** 买入当日不可卖（T+1） */
  buyDate: string;
}

interface PendingOrder {
  symbol: string;
  side: 'buy' | 'sell';
  /** 买入时为目标金额，卖出时忽略 */
  targetAmount?: number;
  reason: string;
  score: number;
  action: string;
  stopLoss: number;
  targetPrice: number;
}

export interface BacktestResult {
  metrics: Metrics;
  equity: EquityPoint[];
  trades: Trade[];
  /** 因涨停/停牌等原因未能成交的订单数 */
  rejected: { limitUp: number; limitDown: number; suspended: number; noCash: number };
  params: StrategyParams;
}

/** 构造 t 日的伪实时行情，供分析引擎使用（等价于收盘快照）。 */
function quoteFromBar(sym: SymbolData, k: Kline, prevClose: number): Quote {
  return {
    symbol: sym.symbol,
    name: sym.name,
    price: k.close,
    pct: k.pct,
    change: k.close - prevClose,
    high: k.high,
    low: k.low,
    open: k.open,
    pre_close: prevClose,
    volume: k.volume,
    amount: k.amount,
    turnover: k.turnover,
  };
}

/** 简易 ATR，用于 stopMode='atr'。 */
function atr(klines: readonly Kline[], period = 14): number {
  if (klines.length < period + 1) return 0;
  let s = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const k = klines[i];
    const pc = klines[i - 1].close;
    s += Math.max(k.high - k.low, Math.abs(k.high - pc), Math.abs(k.low - pc));
  }
  return s / period;
}

export function runBacktest(
  universe: readonly SymbolData[],
  cfgIn: Partial<BacktestConfig> = {},
): BacktestResult {
  const cfg: BacktestConfig = { ...DEFAULT_CONFIG, ...cfgIn };
  const P: StrategyParams = { ...DEFAULT_PARAMS, ...(cfgIn.params ?? {}) };
  const costs: CostConfig = { ...DEFAULT_COSTS, ...(cfgIn.costs ?? {}) };

  // ── 建立统一交易日历（各标的日期并集，避免停牌股拖累对齐）──
  const dateSet = new Set<string>();
  for (const s of universe) for (const k of s.klines) dateSet.add(k.date);
  let calendar = [...dateSet].sort();
  if (cfg.startDate) calendar = calendar.filter((d) => d >= cfg.startDate!);
  if (cfg.endDate) calendar = calendar.filter((d) => d <= cfg.endDate!);

  // 日期 → bar 索引，O(1) 查询
  const idxOf = new Map<string, Map<string, number>>();
  for (const s of universe) {
    const m = new Map<string, number>();
    s.klines.forEach((k, i) => m.set(k.date, i));
    idxOf.set(s.symbol, m);
  }
  const bySymbol = new Map<string, SymbolData>();
  for (const s of universe) bySymbol.set(s.symbol, s);
  const benchIdx = new Map<string, number>();
  (cfg.benchmark ?? []).forEach((k, i) => benchIdx.set(k.date, i));

  let cash = cfg.initialCapital;
  let lastEquity = cfg.initialCapital;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let pending: PendingOrder[] = [];
  const rejected = { limitUp: 0, limitDown: 0, suspended: 0, noCash: 0 };
  let totalBuyAmount = 0;
  let bar = 0;

  for (const date of calendar) {
    bar += 1;

    // ══ 阶段 1：执行上一交易日收盘后生成的订单（按今日开盘价）══
    // 先卖后买，释放资金
    for (const ord of pending.filter((o) => o.side === 'sell')) {
      const sym = bySymbol.get(ord.symbol);
      const pos = positions.get(ord.symbol);
      if (!sym || !pos) continue;
      const i = idxOf.get(sym.symbol)!.get(date);
      if (i === undefined) continue;
      const k = sym.klines[i];
      const prevClose = i > 0 ? sym.klines[i - 1].close : k.open;

      if (isSuspended(k.volume)) { rejected.suspended += 1; continue; }
      if (isLimitDownAtOpen(k.open, prevClose, pos.board)) { rejected.limitDown += 1; continue; }
      if (pos.buyDate === date) continue; // T+1

      const fill = applySlippage(k.open, 'sell', costs);
      const gross = fill * pos.shares;
      const fee = sellFees(gross, costs);
      cash += gross - fee;

      const entryGross = pos.entryPrice * pos.shares;
      const entryFee = buyFees(entryGross, costs);
      const pnl = (gross - fee) - (entryGross + entryFee);
      trades.push({
        symbol: pos.symbol, name: pos.name,
        entryDate: pos.entryDate, exitDate: date,
        entryPrice: pos.entryPrice, exitPrice: fill, shares: pos.shares,
        pnl, pnlPct: entryGross > 0 ? pnl / (entryGross + entryFee) : 0,
        holdingDays: bar - pos.entryBarIdx,
        exitReason: ord.reason,
        entryScore: pos.entryScore, entryAction: pos.entryAction,
      });
      positions.delete(ord.symbol);
    }

    for (const ord of pending.filter((o) => o.side === 'buy')) {
      if (positions.size >= P.maxPositions) break;
      if (positions.has(ord.symbol)) continue;
      const sym = bySymbol.get(ord.symbol);
      if (!sym) continue;
      const i = idxOf.get(sym.symbol)!.get(date);
      if (i === undefined) continue;
      const k = sym.klines[i];
      const prevClose = i > 0 ? sym.klines[i - 1].close : k.open;
      const board = detectBoard(sym.symbol, sym.name);

      if (isSuspended(k.volume)) { rejected.suspended += 1; continue; }
      // 一字涨停买不到 —— 忽略这条会让突破类策略凭空多出大量成交
      if (isLimitUpAtOpen(k.open, prevClose, board)) { rejected.limitUp += 1; continue; }

      const fill = applySlippage(k.open, 'buy', costs);
      const budget = Math.min(ord.targetAmount ?? 0, cash * 0.995);
      let shares = roundLot(budget / fill);
      if (shares <= 0) { rejected.noCash += 1; continue; }
      let gross = fill * shares;
      let fee = buyFees(gross, costs);
      while (shares > 0 && gross + fee > cash) {
        shares -= 100;
        gross = fill * shares;
        fee = buyFees(gross, costs);
      }
      if (shares <= 0) { rejected.noCash += 1; continue; }

      cash -= gross + fee;
      totalBuyAmount += gross;
      positions.set(ord.symbol, {
        symbol: sym.symbol, name: sym.name, shares,
        entryPrice: fill, entryDate: date, entryBarIdx: bar,
        stopLoss: ord.stopLoss, targetPrice: ord.targetPrice,
        highSinceEntry: k.close, entryScore: ord.score, entryAction: ord.action,
        board, buyDate: date,
      });
    }
    pending = [];

    // ══ 阶段 2：盘中风控（用当日 high/low 判定触发，成交在次日开盘）══
    // 注意：这里只**登记**卖出意图，不在当日成交，避免用当日数据实现当日成交。
    for (const pos of positions.values()) {
      const sym = bySymbol.get(pos.symbol);
      if (!sym) continue;
      const i = idxOf.get(sym.symbol)!.get(date);
      if (i === undefined) continue;
      const k = sym.klines[i];
      pos.highSinceEntry = Math.max(pos.highSinceEntry, k.high);

      let reason = '';
      if (pos.stopLoss > 0 && k.low <= pos.stopLoss) reason = '止损';
      else if (P.useTarget && pos.targetPrice > 0 && k.high >= pos.targetPrice) reason = '止盈';
      else if (P.trailingPct > 0 && k.close <= pos.highSinceEntry * (1 - P.trailingPct)) reason = '移动止盈';
      else if (P.maxHoldDays > 0 && bar - pos.entryBarIdx >= P.maxHoldDays) reason = '到期';
      if (reason) {
        pending.push({
          symbol: pos.symbol, side: 'sell', reason,
          score: 0, action: '', stopLoss: 0, targetPrice: 0,
        });
      }
    }

    // ══ 阶段 3：收盘后重算信号，生成次日订单 ══
    const doRebalance = bar % Math.max(1, P.rebalanceEvery) === 0;
    if (doRebalance) {
      const alreadySelling = new Set(pending.map((o) => o.symbol));
      const candidates: PendingOrder[] = [];

      for (const sym of universe) {
        const i = idxOf.get(sym.symbol)!.get(date);
        if (i === undefined || i < P.warmup) continue;

        // ★ 结构性防未来：只给引擎看到第 i 天为止的数据
        const hist = sym.klines.slice(0, i + 1);
        const prevClose = i > 0 ? sym.klines[i - 1].close : hist[i].close;
        const quote = quoteFromBar(sym, hist[i], prevClose);
        const flows = sym.flows ? sym.flows.filter((f) => f.date <= date) : null;
        let benchSlice: Kline[] | null = null;
        if (cfg.benchmark) {
          const bi = benchIdx.get(date);
          const cut = bi !== undefined ? bi + 1 : cfg.benchmark.findIndex((b) => b.date > date);
          benchSlice = cfg.benchmark.slice(0, cut > 0 ? cut : cfg.benchmark.length);
        }

        let sig: OptimizedSignal;
        try {
          sig = applySignalOptimization(
            toOptimizable(runAnalysis(hist, quote, flows, benchSlice, P.profile, P.filters)),
          );
        } catch {
          continue;
        }

        const held = positions.get(sym.symbol);
        if (held) {
          const heldDays = bar - held.entryBarIdx;
          // 滞后带：只有跌破 exitScore 才离场，避免在 minScore 附近反复抖动
          const degraded = (sig.score ?? 0) < P.exitScore
            || (P.exitOnDowngrade && sig.action === '观望' && (sig.score ?? 0) < P.exitScore);
          if (degraded && heldDays >= P.minHoldDays && !alreadySelling.has(sym.symbol)) {
            pending.push({
              symbol: sym.symbol, side: 'sell',
              reason: `信号退化(${sig.score}分)`,
              score: sig.score, action: sig.action, stopLoss: 0, targetPrice: 0,
            });
            alreadySelling.add(sym.symbol);
          }
          continue;
        }

        // 执行层拦截：涨停买不到、停牌、出货形态、大盘在长期均线下方
        if (sig.execution && !sig.execution.tradable) continue;
        if (!P.allowedActions.includes(sig.action)) continue;
        if ((sig.score ?? 0) < P.minScore) continue;
        if ((sig.confidence ?? 0) < P.minConfidence) continue;

        const plan = (sig.trade_plan ?? {}) as { stop_loss?: number; target_price?: number };
        const exPlan = P.useStructuralPlan ? (sig.execution?.plan ?? null) : null;
        const price = hist[i].close;
        let stop = 0;
        if (P.stopMode === 'plan') stop = exPlan?.stop ?? plan.stop_loss ?? price * (1 - P.fixedStopPct);
        else if (P.stopMode === 'fixed') stop = price * (1 - P.fixedStopPct);
        else {
          const a = atr(hist, 14);
          stop = a > 0 ? price - P.atrMult * a : price * (1 - P.fixedStopPct);
        }
        if (stop >= price) stop = price * (1 - P.fixedStopPct);

        // 仓位系数：优化器的 position_advice 直接映射为满仓倍率
        let factor = 1;
        if (P.usePositionAdvice) {
          const adv = sig.position_advice ?? '';
          if (adv.includes('空仓')) factor = 0;
          else if (adv.includes('轻仓')) factor = 0.25;
          else if (adv.includes('半仓')) factor = 0.5;
        }
        // 风险预算定仓：仓位 = 单笔风险预算 ÷ 单股风险距离（海龟法则思想）
        const baseWeight = P.useRiskSizing && exPlan?.weight ? exPlan.weight : P.maxWeight;
        const weight = Math.min(baseWeight, P.maxWeight) * factor;
        if (weight <= 0) continue;

        candidates.push({
          symbol: sym.symbol, side: 'buy',
          targetAmount: (P.compound ? lastEquity : cfg.initialCapital) * weight,
          reason: '信号建仓', score: sig.score ?? 0, action: sig.action,
          stopLoss: stop,
          targetPrice: P.useTarget ? (exPlan?.target ?? plan.target_price ?? 0) : 0,
        });
      }

      // 评分高者优先，填满可用仓位
      candidates.sort((a, b) => b.score - a.score);
      const slots = P.maxPositions - positions.size
        + pending.filter((o) => o.side === 'sell').length;
      pending.push(...candidates.slice(0, Math.max(0, slots)));
    }

    // ══ 阶段 4：按收盘价结算净值 ══
    let posValue = 0;
    for (const pos of positions.values()) {
      const sym = bySymbol.get(pos.symbol);
      const i = sym ? idxOf.get(sym.symbol)!.get(date) : undefined;
      const px = sym && i !== undefined ? sym.klines[i].close : pos.entryPrice;
      posValue += px * pos.shares;
    }
    lastEquity = cash + posValue;
    const bi = benchIdx.get(date);
    equity.push({
      date, equity: cash + posValue, cash, positionValue: posValue,
      positions: positions.size,
      benchmark: bi !== undefined ? cfg.benchmark![bi].close : undefined,
    });
  }

  const metrics = computeMetrics(
    equity, trades, cfg.initialCapital, cfg.riskFreeRate, totalBuyAmount,
  );
  return { metrics, equity, trades, rejected, params: P };
}
