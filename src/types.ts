/**
 * 全局类型定义 —— 与原 Python 版 dataclass 字段一一对应。
 * 迁移自: data/kline_fetcher.py, analysis/*.py
 */

/** K线（对应 data.kline_fetcher.Kline） */
export interface Kline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交量（A股=手，ETF=份） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 涨跌幅（%） */
  pct: number;
  /** 换手率（%） */
  turnover: number;
}

/** 实时行情（对应 data.kline_fetcher.Quote） */
export interface Quote {
  symbol: string;
  name: string;
  price: number;
  pct: number;
  change: number;
  high: number;
  low: number;
  open: number;
  pre_close: number;
  volume: number;
  amount: number;
  turnover: number;
  timestamp?: string;
}

/** 日级资金流（对应 data.kline_fetcher.FundFlow） */
export interface FundFlow {
  date: string;
  main_net: number;
  super_large_net: number;
  large_net: number;
  medium_net: number;
  small_net: number;
  main_pct: number;
}

/** 盘中分时资金流（对应 data.kline_fetcher.MinuteFlow） */
export interface MinuteFlow {
  time: string;
  main_net: number;
  small_net: number;
  medium_net: number;
  large_net: number;
  super_large_net: number;
}

/** 分时数据（对应 data.kline_fetcher.MinuteData） */
export interface MinuteData {
  times: string[];
  prices: number[];
  avg_prices: number[];
  volumes: number[];
  pre_close: number;
  name: string;
  high: number;
  low: number;
}

/** 市场宽度（涨跌家数） */
export interface MarketBreadth {
  up: number;
  down: number;
  flat: number;
  total: number;
  breadth_ratio: number;
  /** 新增：数据是否为抽样/部分统计（Cloudflare 子请求配额限制所致） */
  partial?: boolean;
  /** 新增：统计来源，便于前端与运维排查 */
  source?: string;
}

/** 搜索结果项 */
export interface SearchItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
}

/** A股列表项 */
export interface StockListItem {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
}

export type Period = 'day' | 'week' | 'month';

/* ------------------------------------------------------------------ */
/* 分析模块结果                                                         */
/* ------------------------------------------------------------------ */

export interface TrendResult {
  direction: string;
  strength: number;
  stage: string;
  ma_arrangement: string;
  ma_scores: Record<string, number>;
  trendline: TrendLine | null;
  signals: string[];
}

export interface TrendLine {
  type: string;
  slope: number;
  current_price: number;
  points: number[];
}

export interface PatternResult {
  name: string;
  direction: string;
  confidence: number;
  status: string;
  target_price: number | null;
  key_levels: Record<string, number>;
  description: string;
}

export interface VolumePriceResult {
  pattern: string;
  direction: string;
  confidence: number;
  volume_ratio: number;
  turnover: number;
  obv_trend: string;
  signals: string[];
  description: string;
}

export interface BreakoutResult {
  system: string;
  signal: string;
  breakout_price: number;
  current_n: number;
  stop_loss: number;
  entry_price: number | null;
  position_units: number;
  exit_price: number | null;
  channel_high: number;
  channel_low: number;
  next_add_price: number | null;
  signals: string[];
  description: string;
}

export interface CupHandle {
  pattern: string;
  cup_high: number;
  cup_low: number;
  handle_high: number;
  handle_low: number;
  cup_depth: number;
  handle_depth: number;
  breakout: boolean;
  buy_point: number;
  target: number;
}

export interface CanslimResult {
  c_score: number;
  a_score: number;
  n_score: number;
  s_score: number;
  l_score: number;
  i_score: number;
  m_score: number;
  total: number;
  grade: string;
  signals: string[];
  cup_handle: CupHandle | null;
  description: string;
}

export interface TradePlan {
  action: string;
  entry_price: number;
  stop_loss: number;
  target_price: number;
  position_size: string;
  holding_period: string;
  risk_reward_ratio: number;
  max_loss_pct: number;
  notes: string;
}

export interface TechnicalBlock {
  score: number;
  contributors: number;
  signals: string[];
  warnings: string[];
  values: Record<string, number | null>;
  description: string;
}

export interface FilterFindingOut {
  code: string;
  severity: 'block' | 'warn';
  message: string;
}

/** 可交易性与风险仓位（enhanced 档位） */
export interface ExecutionBlock {
  tradable: boolean;
  findings: FilterFindingOut[];
  plan: {
    entry: number; stop: number; target: number;
    stopBasis: string; targetBasis: string;
    riskReward: number; weight: number; riskPct: number;
  } | null;
}

export interface SignalEngineResult {
  action: string;
  score: number;
  confidence: number;
  risk_level: string;
  signal_strength: string;
  trend: TrendResult | null;
  patterns: PatternResult[];
  volume_price: VolumePriceResult | null;
  breakouts: BreakoutResult[];
  canslim: CanslimResult | null;
  module_scores: Record<string, number>;
  buy_signals: string[];
  sell_signals: string[];
  risk_warnings: string[];
  key_levels: Record<string, number>;
  description: string;
  plain_summary: string;
  trade_plan: TradePlan | Record<string, never>;
  /** 新增：技术指标模块（enhanced 档位） */
  technical: TechnicalBlock | null;
  /** 新增：本次使用的评分档位 */
  scoring_profile: string;
  /** 新增：可交易性检查与风险仓位（legacy 档位为 null） */
  execution: ExecutionBlock | null;
}

/** 经 optimizer 后处理的信号（序列化后的 JSON 形态） */
export interface OptimizedSignal extends SignalEngineResult {
  optimized_action?: string;
  original_action?: string;
  veto_reason?: string;
  position_advice?: string;
  risk_notes?: string[];
  risk_reward?: number;
}
