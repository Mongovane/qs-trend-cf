/**
 * A股交易规则与成本模型。
 *
 * 回测结果对这一层极度敏感。忽略涨跌停会让「突破买入」类策略凭空多出
 * 大量买不到的成交；忽略 T+1 会让日内反手成为可能；忽略费用会把一个
 * 高换手策略的负期望粉饰成正期望。
 */

export type Board = 'main' | 'star' | 'chinext' | 'bse' | 'st' | 'fund';

/** 按代码与名称判定板块。ST 判定依赖名称，缺名称时按主板处理。 */
export function detectBoard(code: string, name = ''): Board {
  const c = String(code).replace(/\.(SH|SZ|SS|BJ)$/i, '');
  if (name.includes('ST') || name.startsWith('*')) return 'st';
  if (/^(5|1[56])/.test(c)) return 'fund';
  if (c.startsWith('688') || c.startsWith('689')) return 'star';
  if (c.startsWith('300') || c.startsWith('301')) return 'chinext';
  if (c.startsWith('8') || c.startsWith('4') || c.startsWith('920')) return 'bse';
  return 'main';
}

/** 单日涨跌幅限制（%）。北交所 30%，双创 20%，ST 5%，主板 10%。 */
export function limitPct(board: Board): number {
  switch (board) {
    case 'bse': return 30;
    case 'star':
    case 'chinext': return 20;
    case 'st': return 5;
    case 'fund': return 10;
    default: return 10;
  }
}

/** 涨停价 / 跌停价。A股按四舍五入保留两位。 */
export function limitPrices(preClose: number, board: Board): [number, number] {
  const p = limitPct(board) / 100;
  const up = Math.round(preClose * (1 + p) * 100) / 100;
  const down = Math.round(preClose * (1 - p) * 100) / 100;
  return [up, down];
}

export interface CostConfig {
  /** 佣金费率（双向），默认万 2.5 */
  commissionRate: number;
  /** 单笔佣金下限（元），默认 5 */
  commissionMin: number;
  /** 印花税（仅卖出），2023-08-28 起为 0.05% */
  stampRate: number;
  /** 过户费（双向），沪深统一 0.001% */
  transferRate: number;
  /** 滑点（基点，1bp = 0.01%），单边 */
  slippageBps: number;
}

export const DEFAULT_COSTS: CostConfig = {
  commissionRate: 0.00025,
  commissionMin: 5,
  stampRate: 0.0005,
  transferRate: 0.00001,
  slippageBps: 10,
};

/** 买入总成本（不含股票本金）。 */
export function buyFees(amount: number, cfg: CostConfig): number {
  const commission = Math.max(amount * cfg.commissionRate, cfg.commissionMin);
  const transfer = amount * cfg.transferRate;
  return commission + transfer;
}

/** 卖出总成本。 */
export function sellFees(amount: number, cfg: CostConfig): number {
  const commission = Math.max(amount * cfg.commissionRate, cfg.commissionMin);
  const stamp = amount * cfg.stampRate;
  const transfer = amount * cfg.transferRate;
  return commission + stamp + transfer;
}

/** 应用滑点：买入上滑，卖出下滑。 */
export function applySlippage(price: number, side: 'buy' | 'sell', cfg: CostConfig): number {
  const k = cfg.slippageBps / 10000;
  return side === 'buy' ? price * (1 + k) : price * (1 - k);
}

/** 按 100 股整手向下取整。 */
export function roundLot(shares: number): number {
  return Math.floor(shares / 100) * 100;
}

/**
 * 一字板判定：开盘即涨停（无法买入）或跌停（无法卖出）。
 * 用 0.3% 容差吸收复权与四舍五入误差。
 */
export function isLimitUpAtOpen(open: number, preClose: number, board: Board): boolean {
  const [up] = limitPrices(preClose, board);
  return open >= up * 0.997;
}

export function isLimitDownAtOpen(open: number, preClose: number, board: Board): boolean {
  const [, down] = limitPrices(preClose, board);
  return open <= down * 1.003;
}

/** 疑似停牌：成交量为 0 或缺失。 */
export function isSuspended(volume: number): boolean {
  return !volume || volume <= 0;
}
