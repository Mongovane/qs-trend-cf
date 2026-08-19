/**
 * 信号后处理：硬否决 / 软否决 / 分级体系 / 仓位管理 / 盈亏比检查。
 * 移植自 app.py::_apply_signal_optimization。
 *
 * 该逻辑在原项目中位于 API 层（因分析模块曾被加密而无法内部修改），
 * 这里保持相同位置与相同顺序，以确保输出逐字段一致。
 */
import type { MarketBreadth, OptimizedSignal, SignalEngineResult, TradePlan } from '../types';
import { clamp, pyRound } from '../util/pynum';

const HARD_VETO: Array<[string, string]> = [
  ['跌破MA20', '价格跌破MA20，趋势已坏'],
  ['价跌量增', '价跌量增，恐慌抛售信号'],
  ['OBV下降', 'OBV下降，量能走弱'],
  ['OBV走低', 'OBV走低，量能走弱'],
  ['OBV下行', 'OBV下行，量能走弱'],
];

const SOFT_VETO: Array<[string, string]> = [
  ['MA20向下', 'MA20向下，短期趋势偏弱'],
  ['MA20下行', 'MA20下行，短期趋势偏弱'],
  ['受压60日', '受压60日决策线，上方压力大'],
];

/** 用市场宽度修正 CANSLIM 的 M 分（对应 app.py 中 handle_analyze 的后处理）。 */
export function applyBreadthToMScore(
  signal: OptimizedSignal,
  breadth: MarketBreadth | null | undefined,
  withText = true,
): void {
  if (!breadth || !signal.canslim || (breadth.total ?? 0) < 50) return;
  const br = breadth.breadth_ratio ?? 0.5;
  const upN = breadth.up ?? 0;
  const downN = breadth.down ?? 0;
  const pctStr = `${Math.round(br * 100)}%`;
  const oldM = signal.canslim.m_score;

  let bonus: number;
  let brLabel: string;
  if (br >= 0.7) { bonus = 15; brLabel = '广度强'; }
  else if (br >= 0.6) { bonus = 10; brLabel = '偏多'; }
  else if (br >= 0.5) { bonus = 5; brLabel = '中性'; }
  else if (br >= 0.4) { bonus = -5; brLabel = '偏空'; }
  else if (br >= 0.3) { bonus = -10; brLabel = '广度弱'; }
  else { bonus = -15; brLabel = '普跌'; }

  signal.canslim.m_score = clamp(oldM + bonus, 0, 100);

  if (!withText) return;
  const brSignal = `今日${upN}涨/${downN}跌，${pctStr}个股上涨(${brLabel})`;
  if (signal.canslim.signals && signal.canslim.signals.length) {
    signal.canslim.signals = [...signal.canslim.signals, brSignal];
  }
  if (signal.canslim.description) {
    signal.canslim.description = `${signal.canslim.description}；${brSignal}`;
  }
}

/** 信号引擎优化后处理。就地修改并返回同一对象（与 Python 版语义一致）。 */
export function applySignalOptimization(signalData: OptimizedSignal): OptimizedSignal {
  let action = signalData.action ?? '观望';
  const score = signalData.score ?? 0;
  const confidence = signalData.confidence ?? 0;
  const moduleScores = signalData.module_scores ?? {};
  const buySignals = signalData.buy_signals ?? [];
  const sellSignals = signalData.sell_signals ?? [];
  const riskWarnings = [...(signalData.risk_warnings ?? [])];
  const canslim = signalData.canslim ?? null;
  const mScore = canslim ? canslim.m_score : 50;
  const tradePlan: Partial<TradePlan> = { ...(signalData.trade_plan ?? {}) } as Partial<TradePlan>;

  const originalAction = action;

  // ---- 1. 收集个股信号文本（排除大盘 M 信号）----
  const stockSignals: string[] = [];
  const trendData = signalData.trend ?? null;
  if (trendData?.signals) stockSignals.push(...trendData.signals);
  const vpData = signalData.volume_price ?? null;
  if (vpData?.signals) stockSignals.push(...vpData.signals);
  for (const s of [...buySignals, ...sellSignals]) {
    if (['大盘', '空头环境', '今日', '上证'].some((kw) => s.includes(kw))) continue;
    stockSignals.push(s);
  }
  const allSignalText = stockSignals.join(' ');

  // ---- 2. 硬否决 ----
  let hardVetoReason: string | null = null;

  // 可交易性优先级最高：涨停买不到、停牌、出货形态、大盘在200日线下方，
  // 这些与技术评分高低无关 —— 分数再高也执行不了。
  const exec = (signalData as { execution?: { tradable: boolean; findings: Array<{ severity: string; message: string }> } }).execution;
  if (exec && !exec.tradable) {
    const blocker = exec.findings.find((f) => f.severity === 'block');
    if (blocker) hardVetoReason = blocker.message;
  }
  if (!hardVetoReason) {
    for (const [kw, desc] of HARD_VETO) {
      if (allSignalText.includes(kw)) {
        hardVetoReason = desc;
        break;
      }
    }
  }
  const vpPattern = vpData?.pattern ?? '';
  if (vpPattern.includes('价跌量增') && !hardVetoReason) {
    hardVetoReason = '价跌量增，恐慌抛售信号';
  }

  // ---- 3. 软否决 ----
  let softVetoReason: string | null = null;
  for (const [kw, desc] of SOFT_VETO) {
    if (allSignalText.includes(kw)) {
      softVetoReason = desc;
      break;
    }
  }

  // ---- 4. 分级体系重新评级 ----
  const isBuy = action === '买入' || action === '强烈买入';
  const isSell = action === '卖出' || action === '强烈卖出';
  let vetoReason: string | null = null;

  const scoresList = [
    moduleScores['趋势'] ?? 50,
    moduleScores['CAN_SLIM'] ?? 50,
    moduleScores['突破'] ?? 50,
    moduleScores['量价'] ?? 50,
    moduleScores['形态'] ?? 50,
    // enhanced 档位的第六模块（legacy 档位不会有这个 key，?? 50 不影响）
    moduleScores['技术指标'] ?? 50,
  ];
  const modulesAbove55 = scoresList.filter((s) => s >= 55).length;

  if (isSell) {
    // 卖出信号不拦截，顺势离场
  } else if (isBuy) {
    if (hardVetoReason) {
      action = '观望';
      vetoReason = `硬否决：${hardVetoReason}`;
    } else {
      let newAction: string;
      if (score >= 75 && confidence >= 60 && modulesAbove55 >= 4) newAction = '强烈买入';
      else if (score >= 65 && confidence >= 45 && modulesAbove55 >= 3) newAction = '买入';
      else if (score >= 60) newAction = '谨慎买入';
      else newAction = '观望';

      if (softVetoReason) {
        if (newAction === '强烈买入') {
          newAction = '买入';
          vetoReason = `软否决：${softVetoReason}`;
        } else if (newAction === '买入') {
          newAction = '谨慎买入';
          vetoReason = `软否决：${softVetoReason}`;
        }
      }
      action = newAction;
    }
  }

  // ---- 5. M 分驱动仓位管理 ----
  const originalPosition = tradePlan.position_size ?? '';
  let positionAdvice: string;
  if (action === '买入' || action === '强烈买入' || action === '谨慎买入') {
    if (mScore < 40) {
      positionAdvice = '轻仓(1/4) — 大盘偏空，严格控制仓位';
      if (action === '强烈买入') {
        action = '买入';
        vetoReason = (vetoReason ? `${vetoReason}；` : '') + `大盘M分${mScore}偏低，降级为买入`;
      } else if (action === '买入') {
        action = '谨慎买入';
        vetoReason = (vetoReason ? `${vetoReason}；` : '') + `大盘M分${mScore}偏低，降级为谨慎买入`;
      }
    } else if (mScore < 55) {
      positionAdvice = '半仓(1/2) — 大盘中性偏弱';
    } else if (mScore < 65) {
      positionAdvice = originalPosition || '半仓(1/2)';
    } else {
      positionAdvice = originalPosition || '正常仓位';
    }
  } else {
    positionAdvice = '空仓等待';
  }

  // ---- 6. 盈亏比检查 ----
  const entry = tradePlan.entry_price || 0;
  const stop = tradePlan.stop_loss || 0;
  const target = tradePlan.target_price || 0;
  let riskReward = tradePlan.risk_reward_ratio || 0;

  const riskNotes: string[] = [];
  if (entry && stop && target && entry > 0) {
    if (!riskReward) {
      const riskAmt = entry - stop;
      const rewardAmt = target - entry;
      if (riskAmt > 0) riskReward = pyRound(rewardAmt / riskAmt, 1);
    }
    if (riskReward) {
      if (riskReward < 1.0) {
        riskNotes.push(`盈亏比${riskReward}倒挂，不建议入场`);
        if (action === '买入' || action === '强烈买入' || action === '谨慎买入') {
          action = '观望';
          vetoReason = (vetoReason ? `${vetoReason}；` : '') + `盈亏比${riskReward}倒挂`;
        }
      } else if (riskReward < 1.5) {
        riskNotes.push(`盈亏比${riskReward}偏低，谨慎操作`);
      } else if (riskReward < 2.0) {
        riskNotes.push(`盈亏比${riskReward}，勉强达标`);
      } else {
        riskNotes.push(`盈亏比${riskReward}，风险收益比良好`);
      }
    }
  }

  // ---- 6b. 如果最终被降为观望，仓位建议应为空仓 ----
  if (action === '观望') {
    positionAdvice = '空仓等待';
  }

  // ---- 7. 写回 ----
  signalData.action = action;
  signalData.optimized_action = action;
  signalData.original_action = originalAction;
  if (vetoReason) {
    signalData.veto_reason = vetoReason;
    riskWarnings.unshift(vetoReason);
  }
  if (exec) {
    for (const f of exec.findings) {
      if (f.severity === 'warn' && !riskWarnings.includes(f.message)) riskWarnings.push(f.message);
    }
  }
  signalData.risk_warnings = riskWarnings;
  signalData.position_advice = positionAdvice;
  signalData.risk_notes = riskNotes;
  signalData.risk_reward = riskReward;

  // ---- 盈亏比倒挂时修正 risk_level（否则出现"风险低+盈亏比0.67"的矛盾） ----
  if (riskReward > 0 && riskReward < 1.0 && signalData.risk_level === '低') {
    signalData.risk_level = '中';
  }

  if (Object.keys(tradePlan).length > 0) {
    tradePlan.position_size = positionAdvice;
    signalData.trade_plan = tradePlan as TradePlan;
  }

  if (vetoReason && action !== originalAction) {
    const prefix = `[优化：${originalAction}→${action}] ${vetoReason}。`;
    signalData.plain_summary = prefix + (signalData.plain_summary ?? '');
  }

  return signalData;
}

/** 深拷贝 SignalEngineResult 为可变的 OptimizedSignal（避免共享引用）。 */
export function toOptimizable(result: SignalEngineResult): OptimizedSignal {
  return JSON.parse(JSON.stringify(result)) as OptimizedSignal;
}
