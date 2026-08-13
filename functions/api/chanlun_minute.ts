/** GET /api/chanlun_minute?symbol=600000 */
import { errorJson, guard, json, parseSymbol, type Env } from '../../src/util/response';
import { fetchMinute } from '../../src/data/fetcher';
import { analyzeChanlunMinute, signalsToDict } from '../../src/analysis/chanlunMinute';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const md = await fetchMinute(symbol, env);
    if (!md || !md.prices.length) return json({ error: '获取分时数据失败' });
    return json(signalsToDict(analyzeChanlunMinute(md.times, md.prices, md.volumes)));
  });
