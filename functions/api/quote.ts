/** GET /api/quote?symbol=600000 */
import { errorJson, guard, json, parseSymbol, type Env } from '../../src/util/response';
import { fetchQuote, quoteToDict } from '../../src/data/fetcher';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const q = await fetchQuote(symbol, env);
    return q ? json(quoteToDict(q)) : json({ error: '获取行情失败' });
  });
