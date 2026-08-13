/** GET /api/kline?symbol=600000&count=250&period=day */
import { errorJson, guard, json, parseCount, parsePeriod, parseSymbol, type Env } from '../../src/util/response';
import { fetchKline, klineToDict } from '../../src/data/fetcher';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const klines = await fetchKline(
      symbol, { count: parseCount(url, 250, 10000), period: parsePeriod(url) }, env,
    );
    return json({ klines: klines.map(klineToDict) });
  });
