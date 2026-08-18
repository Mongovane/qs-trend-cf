/** GET /api/health —— 健康检查；?probe=1 时逐个探测上游数据源。 */
import { json, guard, type Env } from '../../src/util/response';
import { getJson, getJsonEastmoney, EM_UT, QUOTE_HOSTS, TENCENT_KLINE } from '../../src/data/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const base = {
      status: 'ok',
      time: new Date().toISOString(),
      scoring_profile: env.SCORING_PROFILE === 'legacy' ? 'legacy' : 'enhanced',
      scan_kv: env.SCAN_KV ? 'bound' : 'missing',
      upstream_proxy: env.UPSTREAM_PROXY_BASE ? 'configured' : 'direct',
      config: {
        scan_universe: env.SCAN_UNIVERSE || '500',
        scan_batch_size: env.SCAN_BATCH_SIZE || '8',
      },
    };

    if (url.searchParams.get('probe') !== '1') return json(base);

    const probes: Record<string, unknown> = {};

    const t0 = Date.now();
    const em = await getJsonEastmoney('/api/qt/stock/get', {
      secid: '1.600000', fields: 'f43,f58', fltt: '2', invt: '2', ut: EM_UT,
    }, QUOTE_HOSTS, env);
    probes.eastmoney_quote = { ok: !!em?.data, ms: Date.now() - t0, name: em?.data?.f58 ?? null };

    const t1 = Date.now();
    const tx = await getJson(
      `${TENCENT_KLINE}?param=${encodeURIComponent('sh600000,day,,,5,qfq')}`, env, 'https://gu.qq.com/',
    );
    probes.tencent_kline = { ok: tx?.code === 0, ms: Date.now() - t1 };

    const t2 = Date.now();
    const sina = await getJson(
      'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=5',
      env, 'https://finance.sina.com.cn/',
    );
    probes.sina_kline = { ok: Array.isArray(sina) && sina.length > 0, ms: Date.now() - t2 };

    return json({ ...base, probes });
  });
