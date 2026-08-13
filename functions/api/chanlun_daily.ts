/** GET /api/chanlun_daily?symbol=600000&count=250&period=day */
import { errorJson, guard, json, parseCount, parsePeriod, parseSymbol, type Env } from '../../src/util/response';
import { fetchKline } from '../../src/data/fetcher';
import { analyzeChanlunDaily, dailyResultToDict } from '../../src/analysis/chanlunDaily';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const symbol = parseSymbol(url);
    if (!symbol) return errorJson('缺少symbol参数');
    const klines = await fetchKline(
      symbol, { count: parseCount(url, 250, 10000), period: parsePeriod(url), enrich: false }, env,
    );
    if (!klines.length || klines.length < 10) {
      return json({ error: `K线数据不足（仅${klines.length}根）` });
    }
    const result = analyzeChanlunDaily(
      klines.map((k) => k.date),
      klines.map((k) => k.open),
      klines.map((k) => k.close),
      klines.map((k) => k.high),
      klines.map((k) => k.low),
      klines.map((k) => k.volume),
    );
    return json(dailyResultToDict(result));
  });
