/**
 * GET /api/scan            —— 推进一批并返回进度（前端 2s 轮询驱动）
 * GET /api/scan?action=start  —— 启动扫描
 * GET /api/scan?action=status —— 仅查询，不推进
 * GET /api/scan?action=reset  —— 重置
 */
import { guard, json, scoringProfile, type Env } from '../../src/util/response';
import { resetScan, startScan, statusScan, stepScan } from '../../src/scan/engine';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) =>
  guard(async () => {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? 'step';

    if (action === 'start') return json(await startScan(env));
    if (action === 'status') return json(await statusScan(env));
    if (action === 'reset') return json(await resetScan(env));

    if (!env.SCAN_KV) {
      return json({
        status: 'error',
        stage: '',
        progress: 0, total: 0, scanned: 0, found: 0, results: [], elapsed: 0,
        error: '扫描功能需要绑定 KV Namespace（变量名 SCAN_KV）。详见 docs/DEPLOY.md。',
      });
    }
    return json(await stepScan(env, scoringProfile(env)));
  });
