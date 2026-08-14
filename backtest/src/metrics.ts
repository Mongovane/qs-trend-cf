/**
 * 绩效指标。
 *
 * 口径说明（不同软件算法不同，这里全部写明，便于与其他平台对账）：
 *  - 年化交易日按 244 天
 *  - Sharpe / Sortino 用**日频**收益的标准差年化，无风险利率默认 1.5%
 *  - 最大回撤基于净值序列的历史高点
 *  - 胜率与盈亏比基于**已平仓**交易，未平仓不计入
 */

export const TRADING_DAYS = 244;

export interface Trade {
  symbol: string;
  name: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  /** 净收益（已扣双边费用） */
  pnl: number;
  /** 净收益率 */
  pnlPct: number;
  holdingDays: number;
  exitReason: string;
  entryScore: number;
  entryAction: string;
}

export interface EquityPoint {
  date: string;
  equity: number;
  cash: number;
  positionValue: number;
  positions: number;
  benchmark?: number;
}

export interface Metrics {
  startDate: string;
  endDate: string;
  days: number;
  initialCapital: number;
  finalEquity: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  maxDrawdownStart: string;
  maxDrawdownEnd: string;
  maxDrawdownDays: number;
  annualVolatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  payoffRatio: number;
  expectancy: number;
  avgHoldingDays: number;
  maxConsecutiveLosses: number;
  exposure: number;
  turnover: number;
  benchmarkReturn: number | null;
  alpha: number | null;
  beta: number | null;
  informationRatio: number | null;
  /** 交易次数过少时为 true，此时所有统计量都不可信 */
  lowSample: boolean;
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function dailyReturns(equity: readonly EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity;
    if (prev > 0) out.push(equity[i].equity / prev - 1);
  }
  return out;
}

function maxDrawdown(equity: readonly EquityPoint[]): {
  dd: number; start: string; end: string; days: number;
} {
  let peak = equity.length ? equity[0].equity : 0;
  let peakIdx = 0;
  let worst = 0;
  let sIdx = 0;
  let eIdx = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i].equity > peak) {
      peak = equity[i].equity;
      peakIdx = i;
    }
    const dd = peak > 0 ? equity[i].equity / peak - 1 : 0;
    if (dd < worst) {
      worst = dd;
      sIdx = peakIdx;
      eIdx = i;
    }
  }
  return {
    dd: worst,
    start: equity[sIdx]?.date ?? '',
    end: equity[eIdx]?.date ?? '',
    days: eIdx - sIdx,
  };
}

/** 对基准做 OLS 回归，得到 beta / alpha。 */
function regress(strat: readonly number[], bench: readonly number[]): [number, number] | null {
  const n = Math.min(strat.length, bench.length);
  if (n < 30) return null;
  const x = bench.slice(0, n);
  const y = strat.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const beta = num / den;
  const alphaDaily = my - beta * mx;
  return [beta, alphaDaily * TRADING_DAYS];
}

export function computeMetrics(
  equity: readonly EquityPoint[],
  trades: readonly Trade[],
  initialCapital: number,
  riskFreeRate = 0.015,
  totalBuyAmount = 0,
): Metrics {
  const n = equity.length;
  const finalEquity = n ? equity[n - 1].equity : initialCapital;
  const totalReturn = initialCapital > 0 ? finalEquity / initialCapital - 1 : 0;
  const years = n > 1 ? n / TRADING_DAYS : 0;
  const cagr = years > 0 && initialCapital > 0
    ? (finalEquity / initialCapital) ** (1 / years) - 1
    : 0;

  const rets = dailyReturns(equity);
  const dailyVol = std(rets);
  const annualVol = dailyVol * Math.sqrt(TRADING_DAYS);
  const rfDaily = riskFreeRate / TRADING_DAYS;
  const excess = rets.map((r) => r - rfDaily);
  const sharpe = dailyVol > 0 ? (mean(excess) / dailyVol) * Math.sqrt(TRADING_DAYS) : 0;
  const downside = excess.filter((r) => r < 0);
  const downVol = downside.length > 1 ? Math.sqrt(mean(downside.map((r) => r * r))) : 0;
  const sortino = downVol > 0 ? (mean(excess) / downVol) * Math.sqrt(TRADING_DAYS) : 0;

  const md = maxDrawdown(equity);
  const calmar = md.dd < 0 ? cagr / Math.abs(md.dd) : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? mean(wins.map((t) => t.pnlPct)) : 0;
  const avgLoss = losses.length ? mean(losses.map((t) => t.pnlPct)) : 0;

  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  }

  const exposure = n ? mean(equity.map((e) => (e.equity > 0 ? e.positionValue / e.equity : 0))) : 0;
  const avgEquity = n ? mean(equity.map((e) => e.equity)) : initialCapital;
  const turnover = avgEquity > 0 && years > 0 ? totalBuyAmount / avgEquity / years : 0;

  let benchmarkReturn: number | null = null;
  let alpha: number | null = null;
  let beta: number | null = null;
  let ir: number | null = null;
  const hasBench = n > 1 && equity[0].benchmark != null && equity[n - 1].benchmark != null;
  if (hasBench) {
    const b0 = equity[0].benchmark as number;
    const b1 = equity[n - 1].benchmark as number;
    benchmarkReturn = b0 > 0 ? b1 / b0 - 1 : null;
    const benchRets: number[] = [];
    for (let i = 1; i < n; i++) {
      const p = equity[i - 1].benchmark as number;
      const c = equity[i].benchmark as number;
      if (p > 0) benchRets.push(c / p - 1);
    }
    const reg = regress(rets, benchRets);
    if (reg) {
      beta = reg[0];
      alpha = reg[1];
    }
    const diff = rets.map((r, i) => r - (benchRets[i] ?? 0));
    const te = std(diff);
    ir = te > 0 ? (mean(diff) / te) * Math.sqrt(TRADING_DAYS) : null;
  }

  return {
    startDate: n ? equity[0].date : '',
    endDate: n ? equity[n - 1].date : '',
    days: n,
    initialCapital,
    finalEquity,
    totalReturn,
    cagr,
    maxDrawdown: md.dd,
    maxDrawdownStart: md.start,
    maxDrawdownEnd: md.end,
    maxDrawdownDays: md.days,
    annualVolatility: annualVol,
    sharpe,
    sortino,
    calmar,
    trades: trades.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    payoffRatio: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0,
    expectancy: trades.length ? mean(trades.map((t) => t.pnlPct)) : 0,
    avgHoldingDays: trades.length ? mean(trades.map((t) => t.holdingDays)) : 0,
    maxConsecutiveLosses: maxStreak,
    exposure,
    turnover,
    benchmarkReturn,
    alpha,
    beta,
    informationRatio: ir,
    lowSample: trades.length < 30,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

/** 控制台报表。 */
export function formatMetrics(m: Metrics, label = '回测结果'): string {
  const L: string[] = [];
  L.push(`\n${'═'.repeat(62)}`);
  L.push(`  ${label}`);
  L.push(`  ${m.startDate} ~ ${m.endDate}   ${m.days} 个交易日`);
  L.push('═'.repeat(62));
  L.push('【收益】');
  L.push(`  期初资金        ${m.initialCapital.toLocaleString()}`);
  L.push(`  期末权益        ${Math.round(m.finalEquity).toLocaleString()}`);
  L.push(`  累计收益        ${pct(m.totalReturn)}`);
  L.push(`  年化收益        ${pct(m.cagr)}`);
  if (m.benchmarkReturn != null) {
    L.push(`  基准累计        ${pct(m.benchmarkReturn)}`);
    L.push(`  超额收益        ${pct(m.totalReturn - m.benchmarkReturn)}`);
  }
  L.push('【风险】');
  L.push(`  最大回撤        ${pct(m.maxDrawdown)}  (${m.maxDrawdownStart} → ${m.maxDrawdownEnd}, ${m.maxDrawdownDays}日)`);
  L.push(`  年化波动        ${pct(m.annualVolatility)}`);
  L.push(`  Sharpe          ${num(m.sharpe)}`);
  L.push(`  Sortino         ${num(m.sortino)}`);
  L.push(`  Calmar          ${num(m.calmar)}`);
  if (m.beta != null) L.push(`  Beta / Alpha    ${num(m.beta)} / ${pct(m.alpha ?? 0)}`);
  if (m.informationRatio != null) L.push(`  信息比率        ${num(m.informationRatio)}`);
  L.push('【交易】');
  L.push(`  交易笔数        ${m.trades}${m.lowSample ? '  ⚠ 样本不足30笔，统计量不可信' : ''}`);
  L.push(`  胜率            ${pct(m.winRate)}`);
  L.push(`  平均盈利/亏损   ${pct(m.avgWin)} / ${pct(m.avgLoss)}`);
  L.push(`  盈亏比(payoff)  ${num(m.payoffRatio)}`);
  L.push(`  盈利因子        ${num(m.profitFactor)}`);
  L.push(`  期望收益/笔     ${pct(m.expectancy)}`);
  L.push(`  平均持仓        ${num(m.avgHoldingDays, 1)} 日`);
  L.push(`  最大连亏        ${m.maxConsecutiveLosses} 笔`);
  L.push(`  平均仓位        ${pct(m.exposure)}`);
  L.push(`  年换手率        ${num(m.turnover)} 倍`);
  L.push('═'.repeat(62));
  return L.join('\n');
}
