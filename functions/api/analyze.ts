/** GET /api/analyze?symbol=600000&period=day —— 全量分析 */
import {
  errorJson, guard, json, parsePeriod, parseSymbol, scoringProfile, type Env,
} from '../../src/util/response';
import { fetchIndexKline, fetchMarketBreadth } from '../../src/data/fetcher';
import { analyzeSymbol, buildAnalyzeResponse, buildMarketEnv } from '../../src/analysis/pipeline';
import type { Kline, MarketBreadth } from '../../src/types';
import { fetchSectorComparison } from '../../src/data/sector';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const period = parsePeriod(url);

    // 大盘上下文并行获取，任一失败都降级为 null（与原版 try/except 行为一致）
    const [indexKlines, breadth] = await Promise.all([
      fetchIndexKline('000001', 60, env).catch(() => null as Kline[] | null),
      fetchMarketBreadth(env).catch(() => null as MarketBreadth | null),
    ]);

    const outcome = await analyzeSymbol(
      { symbol, period, profile: scoringProfile(env), indexKlines, breadth },
      env,
    );
    if (!outcome.ok) return json({ error: outcome.error });

    // 板块对比（不阻塞主流程，失败降级为 null）
    let sector = null;
    try {
      const kl = outcome.klines;
      const pct20 = kl.length >= 21
        ? ((kl[kl.length-1].close - kl[kl.length-21].close) / kl[kl.length-21].close) * 100
        : undefined;
      sector = await fetchSectorComparison(symbol, pct20, env);
    } catch { /* 板块接口失败不影响主分析 */ }

    const resp = buildAnalyzeResponse(outcome, buildMarketEnv(indexKlines, breadth), breadth);
    (resp as Record<string, unknown>).sector = sector;
    return json(resp);
  });
