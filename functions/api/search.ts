/** GET /api/search?keyword=贵州 */
import { errorJson, guard, json, type Env } from '../../src/util/response';
import { searchStock } from '../../src/data/fetcher';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const keyword = (url.searchParams.get('keyword') ?? '').trim();
    if (!keyword) return errorJson('缺少keyword参数');
    const results = await searchStock(keyword, 10, env);
    return json({ results });
  });
