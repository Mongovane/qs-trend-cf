/** GET /api/minute?symbol=600000 */
import { errorJson, guard, json, parseSymbol, type Env } from '../../src/util/response';
import { fetchMinute } from '../../src/data/fetcher';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const md = await fetchMinute(symbol, env);
    if (!md) return json({ error: '获取分时数据失败' });
    return json({
      symbol,
      name: md.name,
      pre_close: md.pre_close,
      high: md.high,
      low: md.low,
      times: md.times,
      prices: md.prices,
      avg_prices: md.avg_prices,
      volumes: md.volumes,
    });
  });
