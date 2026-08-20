/**
 * 多战法并行评分。
 *
 * ══ 设计思路 ══
 *
 * 原始信号引擎给出一个综合分（如 72 分），但用户无法判断"72 分是因为趋势好
 * 还是因为突破好"。同一只股票在不同市况下适合不同策略：
 *
 *   - 震荡市里趋势策略会反复打脸，但均值回归可能有效
 *   - 单边上涨时动量追涨的胜率远高于抄底
 *   - CANSLIM 适合中线持仓，不适合短线博弈
 *
 * 本模块把现有的 6 个模块分数**重新组合**成 4 种战法模板，
 * 每种用不同的权重加权，取最高分的作为推荐战法。
 *
 * 不新增计算，只是把已有信息重新包装——同样的数据，更多的视角。
 *
 * ══ 四种战法（参考 NiuOne + 市面通行分类）══
 *
 * 1. 趋势跟踪（Trend Following）—— William O'Neil / 海龟
 *    核心：趋势方向 + 均线排列 + 量能确认
 *    适用：单边上涨/下跌市
 *
 * 2. 动量突破（Momentum Breakout）—— Minervini / Livermore
 *    核心：突破信号 + 技术指标共振 + 放量
 *    适用：盘整后的方向选择
 *
 * 3. 均值回归（Mean Reversion）—— Bollinger / RSI 超买超卖
 *    核心：技术指标超卖 + 形态支撑 + 筹码密集
 *    适用：震荡市、超跌反弹
 *
 * 4. 价值成长（CANSLIM Growth）—— William O'Neil
 *    核心：CANSLIM 七维 + 行业领先 + 机构认可
 *    适用：中线持仓、牛市初期
 */

export interface StrategyProfile {
  /** 战法英文 ID */
  id: string;
  /** 中文名 */
  name: string;
  /** 英文名 */
  nameEn: string;
  /** 简要描述 */
  description: string;
  /** 适用市况 */
  suitableMarket: string;
  /** 各模块权重（与 signalEngine 的 moduleScores key 一致） */
  weights: Record<string, number>;
  /** 加分/扣分修正规则 */
  bonusRules: Array<{
    condition: (ctx: StrategyContext) => boolean;
    delta: number;
    reason: string;
  }>;
}

export interface StrategyContext {
  moduleScores: Record<string, number>;
  trend: { direction: string; strength: number; ma_arrangement: string };
  volumePrice: { direction: string; volume_ratio: number; pattern: string };
  breakouts: Array<{ signal: string; system: string }>;
  canslim: { total: number; m_score: number; grade: string };
  technical: { score: number };
  chipData?: { profitRatio: number; concentration: number; inDenseZone: boolean } | null;
}

export interface StrategyResult {
  id: string;
  name: string;
  nameEn: string;
  score: number;
  /** 匹配度标签 */
  verdict: string;
  /** 关键匹配理由 */
  reasons: string[];
  /** 适用市况 */
  suitableMarket: string;
}

export interface MultiStrategyResult {
  /** 最优战法 */
  best: StrategyResult;
  /** 全部战法得分（降序） */
  strategies: StrategyResult[];
  /** 一句话推荐 */
  recommendation: string;
}

// ══════════════════════════════════════════════════════════════════
// 战法定义
// ══════════════════════════════════════════════════════════════════

const PROFILES: StrategyProfile[] = [
  {
    id: 'trend_following',
    name: '趋势跟踪',
    nameEn: 'Trend Following',
    description: '顺势而为，趋势确认后入场，均线多头排列时持有',
    suitableMarket: '单边上涨/下跌',
    weights: {
      '趋势': 0.35,
      '量价': 0.25,
      'CAN_SLIM': 0.15,
      '突破': 0.10,
      '技术指标': 0.10,
      '形态': 0.05,
    },
    bonusRules: [
      {
        condition: (ctx) => ctx.trend.ma_arrangement === '多头排列',
        delta: 8,
        reason: '均线完全多头排列',
      },
      {
        condition: (ctx) => ctx.trend.direction === '上升' && ctx.volumePrice.direction === '看涨',
        delta: 5,
        reason: '趋势+量价共振',
      },
      {
        condition: (ctx) => ctx.trend.direction === '下降',
        delta: -15,
        reason: '趋势向下，不适合趋势跟踪',
      },
    ],
  },
  {
    id: 'momentum_breakout',
    name: '动量突破',
    nameEn: 'Momentum Breakout',
    description: '等待盘整后放量突破关键位，追涨强势股',
    suitableMarket: '盘整末期 / 方向选择',
    weights: {
      '突破': 0.30,
      '技术指标': 0.25,
      '量价': 0.20,
      '趋势': 0.15,
      '形态': 0.05,
      'CAN_SLIM': 0.05,
    },
    bonusRules: [
      {
        condition: (ctx) => ctx.breakouts.some((b) => b.signal === '买入' || b.signal === '加仓'),
        delta: 10,
        reason: '海龟通道突破信号',
      },
      {
        condition: (ctx) => ctx.volumePrice.volume_ratio >= 1.5,
        delta: 6,
        reason: '量比≥1.5，放量确认突破',
      },
      {
        condition: (ctx) => ctx.volumePrice.volume_ratio < 0.8,
        delta: -8,
        reason: '缩量，突破缺乏量能支持',
      },
      {
        condition: (ctx) => ctx.technical.score >= 70,
        delta: 5,
        reason: '技术指标多头共振',
      },
    ],
  },
  {
    id: 'mean_reversion',
    name: '均值回归',
    nameEn: 'Mean Reversion',
    description: '超跌后在支撑位买入，等待价格回归均值',
    suitableMarket: '震荡市 / 超跌反弹',
    weights: {
      '技术指标': 0.30,
      '形态': 0.25,
      '量价': 0.20,
      '趋势': 0.05,
      '突破': 0.10,
      'CAN_SLIM': 0.10,
    },
    bonusRules: [
      {
        condition: (ctx) => ctx.chipData?.inDenseZone === true,
        delta: 8,
        reason: '价格在筹码密集区，有支撑',
      },
      {
        condition: (ctx) => ctx.chipData != null && ctx.chipData.profitRatio < 0.3,
        delta: 6,
        reason: '获利盘<30%，抛压轻',
      },
      {
        condition: (ctx) => ctx.trend.direction === '上升' && ctx.trend.strength >= 70,
        delta: -10,
        reason: '强势上涨中不适合均值回归',
      },
      {
        condition: (ctx) => {
          const ms = ctx.moduleScores;
          return (ms['技术指标'] ?? 50) < 40 && (ms['形态'] ?? 50) >= 50;
        },
        delta: 5,
        reason: '技术超卖+形态支撑',
      },
    ],
  },
  {
    id: 'canslim_growth',
    name: '价值成长',
    nameEn: 'CANSLIM Growth',
    description: 'O\'Neil 选股法，聚焦盈利增长+机构认可+市场环境',
    suitableMarket: '牛市初期 / 中线持仓',
    weights: {
      'CAN_SLIM': 0.40,
      '趋势': 0.20,
      '量价': 0.15,
      '技术指标': 0.10,
      '突破': 0.10,
      '形态': 0.05,
    },
    bonusRules: [
      {
        condition: (ctx) => ctx.canslim.total >= 75,
        delta: 8,
        reason: 'CANSLIM综合评级优秀',
      },
      {
        condition: (ctx) => ctx.canslim.m_score >= 60,
        delta: 5,
        reason: '大盘环境配合',
      },
      {
        condition: (ctx) => ctx.canslim.m_score < 30,
        delta: -10,
        reason: '大盘环境恶劣，不适合价值成长',
      },
    ],
  },
];

function verdictLabel(score: number): string {
  if (score >= 80) return '高度匹配';
  if (score >= 65) return '较好匹配';
  if (score >= 50) return '一般匹配';
  return '低匹配';
}

/**
 * 对一只股票运行全部战法评分。
 */
export function scoreMultiStrategy(ctx: StrategyContext): MultiStrategyResult {
  const results: StrategyResult[] = [];

  for (const profile of PROFILES) {
    // 加权基础分
    let base = 0;
    for (const [key, weight] of Object.entries(profile.weights)) {
      base += (ctx.moduleScores[key] ?? 50) * weight;
    }

    // 修正
    const reasons: string[] = [];
    let bonus = 0;
    for (const rule of profile.bonusRules) {
      try {
        if (rule.condition(ctx)) {
          bonus += rule.delta;
          reasons.push(`${rule.delta >= 0 ? '+' : ''}${rule.delta} ${rule.reason}`);
        }
      } catch {
        // 条件函数可能因数据缺失抛异常，跳过
      }
    }

    const score = Math.max(0, Math.min(100, Math.round(base + bonus)));
    results.push({
      id: profile.id,
      name: profile.name,
      nameEn: profile.nameEn,
      score,
      verdict: verdictLabel(score),
      reasons,
      suitableMarket: profile.suitableMarket,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  // 推荐文案
  let recommendation: string;
  if (best.score >= 70) {
    recommendation = `当前最适合「${best.name}」策略(${best.score}分)，${best.suitableMarket}`;
  } else if (best.score >= 55) {
    recommendation = `「${best.name}」相对最优(${best.score}分)，但匹配度一般，注意控制仓位`;
  } else {
    recommendation = `四种战法匹配度均较低(最高${best.score}分)，建议观望`;
  }

  return { best, strategies: results, recommendation };
}
