/**
 * A股交易时钟。
 *
 * 量比的市场通行定义是**时间归一化**的：
 *   量比 = (当日累计成交量 ÷ 已开市分钟数) ÷ (过去5日平均每分钟成交量)
 *
 * 原实现直接用「当日累计量 ÷ 5日全天均量」，等于拿开盘 5 分钟的量去比全天的量。
 * 后果是每个交易日 14:00 之前，几乎所有股票的量比都低于 1，
 * 「量能不足」这条告警会对 100% 的标的误报。
 */

/** 全天连续竞价分钟数：9:30-11:30 + 13:00-15:00 */
export const FULL_SESSION_MINUTES = 240;

/** 取北京时间的「今日已开市分钟数」。非交易时段返回 240（按全天处理）。 */
export function elapsedTradingMinutes(now: Date = new Date()): number {
  // Workers 运行在 UTC，统一换算到东八区
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return FULL_SESSION_MINUTES;

  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const AM_OPEN = 9 * 60 + 30;
  const AM_CLOSE = 11 * 60 + 30;
  const PM_OPEN = 13 * 60;
  const PM_CLOSE = 15 * 60;

  if (mins < AM_OPEN) return FULL_SESSION_MINUTES;   // 盘前：按全天比较
  if (mins <= AM_CLOSE) return Math.max(1, mins - AM_OPEN);
  if (mins < PM_OPEN) return 120;                     // 午休
  if (mins <= PM_CLOSE) return Math.min(FULL_SESSION_MINUTES, 120 + (mins - PM_OPEN));
  return FULL_SESSION_MINUTES;                        // 收盘后
}

/** 是否处于连续竞价时段。 */
export function isTradingNow(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
}
