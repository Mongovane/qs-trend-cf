/** GET /api/realtime_flow?symbol=600000 —— 盘中1分钟级累计资金流 */
import { errorJson, guard, json, parseSymbol, type Env } from '../../src/util/response';
import { fetchRealtimeFlow } from '../../src/data/fetcher';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const flows = await fetchRealtimeFlow(symbol, env);
    if (!flows.length) return json({ error: '暂无实时资金流数据（非交易日或盘前）', flows: [] });
    const last = flows[flows.length - 1];
    return json({
      symbol,
      flows: flows.map((f) => ({
        time: f.time, main_net: f.main_net, super_large_net: f.super_large_net,
        large_net: f.large_net, medium_net: f.medium_net, small_net: f.small_net,
      })),
      summary: {
        main_net: last.main_net,
        super_large_net: last.super_large_net,
        large_net: last.large_net,
        medium_net: last.medium_net,
        small_net: last.small_net,
      },
      time_range: `${flows[0].time} ~ ${flows[flows.length - 1].time}`,
    });
  });
