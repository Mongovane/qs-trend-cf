/**
 * 全A股扫描引擎（Cloudflare 版重新设计）。
 *
 * 原版在本地开机 20 线程一次性扫完 ~5400 只股票，单次约 21600 个 HTTP 请求。
 * Cloudflare Workers 免费版限制：单次调用最多 50 个子请求、10ms CPU。
 * 因此改为 **KV 驱动的增量状态机**：
 *
 *   /api/scan?action=start   初始化：拉取成交额前 N 只 → 写入 KV → status=running
 *   /api/scan                每次调用推进「一批」→ 返回进度（前端原有 2s 轮询正好驱动）
 *
 * 阶段：
 *   stage=daily   日K扫描，逐批推进
 *   stage=weekly  对日K命中的股票做周K验证
 *   stage=done    输出 combined_score 前 20
 *
 * 每批默认 8 只 × 3 个子请求（K线/行情/资金流，扫描时关闭 enrich）= 24 个子请求，
 * 稳稳落在免费版 50 个的配额内。
 */
import type { Kline, MarketBreadth } from '../types';
import type { FetchEnv } from '../data/http';
import { fetchIndexKline, fetchMarketBreadth, fetchTopAShares } from '../data/fetcher';
import { analyzeSymbol } from '../analysis/pipeline';
import type { ScoringProfile } from '../analysis/signalEngine';
import { pyRound } from '../util/pynum';

const BUY_ACTIONS = new Set(['强烈买入', '买入', '谨慎买入']);
const STATE_KEY = 'scan:state';
const LOCK_MS = 25_000;

export interface ScanCandidate {
  code: string;
  name: string;
  price: number;
  pct: number;
}

export interface DailyHit {
  symbol: string;
  name: string;
  price: number;
  daily_pct: number;
  action: string;
  score: number;
  confidence: number;
  position_advice: string;
  risk_reward: number;
  veto_reason: string;
  m_score: number;
  risk_notes: string[];
  module_scores: Record<string, number>;
}

export interface DualHit extends Record<string, unknown> {
  symbol: string;
  name: string;
  price: number;
  daily_pct: number;
  daily_action: string;
  daily_score: number;
  daily_confidence: number;
  weekly_action: string;
  weekly_score: number;
  weekly_confidence: number;
  combined_score: number;
  position_advice: string;
  risk_reward: number;
  veto_reason: string;
  m_score: number;
  risk_notes: string[];
}

export interface ScanState {
  status: 'idle' | 'running' | 'done' | 'error';
  stage: string;
  phase: 'daily' | 'weekly' | 'finished';
  progress: number;
  total: number;
  scanned: number;
  found: number;
  results: DualHit[];
  error: string;
  start_time: number;
  elapsed: number;
  cursor: number;
  candidates: ScanCandidate[];
  daily_hits: DailyHit[];
  dual_hits: DualHit[];
  lock_until: number;
  /** 缓存的共享上下文，避免每批重复抓取 */
  index_cached: boolean;
}

const IDLE_STATE: ScanState = {
  status: 'idle', stage: '', phase: 'daily', progress: 0,
  total: 0, scanned: 0, found: 0, results: [], error: '',
  start_time: 0, elapsed: 0, cursor: 0,
  candidates: [], daily_hits: [], dual_hits: [], lock_until: 0, index_cached: false,
};

export interface ScanEnv extends FetchEnv {
  SCAN_KV?: KVNamespace;
  SCAN_UNIVERSE?: string;
  SCAN_BATCH_SIZE?: string;
  BREADTH_MAX_PAGES?: string;
}

function universeSize(env: ScanEnv): number {
  const v = Number(env.SCAN_UNIVERSE ?? '500');
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5800) : 500;
}

function batchSize(env: ScanEnv): number {
  const v = Number(env.SCAN_BATCH_SIZE ?? '8');
  return Number.isFinite(v) && v > 0 ? Math.min(v, 40) : 8;
}

async function readState(env: ScanEnv): Promise<ScanState> {
  if (!env.SCAN_KV) return { ...IDLE_STATE };
  const raw = await env.SCAN_KV.get(STATE_KEY, 'json');
  return raw ? ({ ...IDLE_STATE, ...(raw as ScanState) }) : { ...IDLE_STATE };
}

async function writeState(env: ScanEnv, state: ScanState): Promise<void> {
  if (!env.SCAN_KV) return;
  // 过期时间 2 小时，避免僵尸状态长期占用
  await env.SCAN_KV.put(STATE_KEY, JSON.stringify(state), { expirationTtl: 7200 });
}

/** 对外暴露的进度视图（不含内部游标与候选池，避免响应体过大）。 */
export function publicView(state: ScanState): Record<string, unknown> {
  const elapsed =
    state.status === 'running' && state.start_time
      ? pyRound((Date.now() - state.start_time) / 1000, 1)
      : state.elapsed;
  return {
    status: state.status,
    stage: state.stage,
    progress: state.progress,
    total: state.total,
    scanned: state.scanned,
    found: state.found,
    results: state.results,
    error: state.error,
    elapsed,
  };
}

/** 初始化扫描。 */
export async function startScan(env: ScanEnv): Promise<Record<string, unknown>> {
  if (!env.SCAN_KV) {
    return { status: 'error', error: '未绑定 SCAN_KV，扫描功能不可用。请在 Pages 项目中创建并绑定 KV Namespace。' };
  }
  const current = await readState(env);
  if (current.status === 'running' && Date.now() < current.lock_until + 120_000) {
    return { status: 'running', message: '扫描进行中，请等待...' };
  }

  const limit = universeSize(env);
  const list = await fetchTopAShares(limit, env);
  if (!list.length) {
    const errState: ScanState = { ...IDLE_STATE, status: 'error', error: '获取A股列表失败' };
    await writeState(env, errState);
    return { status: 'error', error: '获取A股列表失败' };
  }

  // 预过滤：排除 ST / 退市 / 停牌
  const candidates: ScanCandidate[] = list
    .filter((s) => !s.name.includes('ST') && !s.name.includes('退') && s.price > 0)
    .map((s) => ({ code: s.code, name: s.name, price: s.price, pct: s.pct }));

  const state: ScanState = {
    ...IDLE_STATE,
    status: 'running',
    phase: 'daily',
    stage: `日K扫描(${candidates.length}只)...`,
    total: candidates.length,
    start_time: Date.now(),
    candidates,
  };
  await writeState(env, state);
  return { status: 'started', message: '扫描已启动', total: candidates.length };
}

/** 推进一批。前端每次轮询 /api/scan 时调用。 */
export async function stepScan(env: ScanEnv, profile: ScoringProfile): Promise<Record<string, unknown>> {
  const state = await readState(env);
  if (state.status !== 'running') return publicView(state);

  const now = Date.now();
  if (now < state.lock_until) return publicView(state); // 并发轮询保护
  state.lock_until = now + LOCK_MS;
  await writeState(env, state);

  // 共享上下文：指数 K 线与市场宽度（内部有缓存，多批复用）
  let indexKlines: Kline[] | null = null;
  let breadth: MarketBreadth | null = null;
  try {
    indexKlines = await fetchIndexKline('000001', 60, env);
  } catch { /* 忽略 */ }
  try {
    breadth = await fetchMarketBreadth(env);
  } catch { /* 忽略 */ }

  const size = batchSize(env);

  if (state.phase === 'daily') {
    const batch = state.candidates.slice(state.cursor, state.cursor + size);
    for (const c of batch) {
      try {
        const r = await analyzeSymbol(
          { symbol: c.code, period: 'day', profile, indexKlines, breadth, enrich: false, lite: true },
          env,
        );
        if (r.ok && r.signal && BUY_ACTIONS.has(r.signal.action)) {
          state.daily_hits.push({
            symbol: c.code,
            name: c.name || (r.quote ? r.quote.name : ''),
            price: r.quote ? r.quote.price : c.price,
            daily_pct: c.pct,
            action: r.signal.action,
            score: r.signal.score,
            confidence: r.signal.confidence,
            position_advice: r.signal.position_advice ?? '',
            risk_reward: r.signal.risk_reward ?? 0,
            veto_reason: r.signal.veto_reason ?? '',
            m_score: r.signal.canslim ? r.signal.canslim.m_score : 50,
            risk_notes: r.signal.risk_notes ?? [],
            module_scores: r.signal.module_scores ?? {},
          });
        }
      } catch { /* 单只失败跳过 */ }
    }
    state.cursor += batch.length;
    state.scanned = state.cursor;
    state.found = state.daily_hits.length;
    state.progress = pyRound((state.cursor / Math.max(state.total, 1)) * 50, 1);
    state.stage = `日K扫描(${state.cursor}/${state.total})...`;

    if (state.cursor >= state.candidates.length) {
      state.phase = 'weekly';
      state.cursor = 0;
      state.scanned = 0;
      state.total = state.daily_hits.length;
      state.stage = `周K验证(${state.daily_hits.length}只)...`;
      state.candidates = []; // 释放空间，避免 KV value 过大
    }
  } else if (state.phase === 'weekly') {
    const batch = state.daily_hits.slice(state.cursor, state.cursor + size);
    for (const d of batch) {
      try {
        const r = await analyzeSymbol(
          { symbol: d.symbol, period: 'week', profile, indexKlines, breadth, enrich: false, lite: true },
          env,
        );
        if (r.ok && r.signal && BUY_ACTIONS.has(r.signal.action)) {
          state.dual_hits.push({
            symbol: d.symbol,
            name: d.name,
            price: d.price,
            daily_pct: d.daily_pct,
            daily_action: d.action,
            daily_score: d.score,
            daily_confidence: d.confidence,
            weekly_action: r.signal.action,
            weekly_score: r.signal.score,
            weekly_confidence: r.signal.confidence,
            combined_score: d.score + r.signal.score,
            position_advice: d.position_advice,
            risk_reward: d.risk_reward,
            veto_reason: d.veto_reason,
            m_score: d.m_score,
            risk_notes: d.risk_notes,
          });
        }
      } catch { /* 单只失败跳过 */ }
    }
    state.cursor += batch.length;
    state.scanned = state.cursor;
    state.found = state.dual_hits.length;
    state.progress = pyRound(50 + (state.cursor / Math.max(state.total, 1)) * 50, 1);
    state.stage = `周K验证(${state.cursor}/${state.total})...`;

    if (state.cursor >= state.daily_hits.length) {
      state.dual_hits.sort((a, b) => b.combined_score - a.combined_score);
      state.results = state.dual_hits.slice(0, 20);
      state.status = 'done';
      state.phase = 'finished';
      state.progress = 100;
      state.elapsed = pyRound((Date.now() - state.start_time) / 1000, 1);
      state.stage = `完成: ${state.dual_hits.length}只双周期买入，取前${state.results.length}`;
      state.daily_hits = [];
      state.dual_hits = [];
    }
  }

  state.lock_until = 0;
  await writeState(env, state);
  return publicView(state);
}

/** 查询当前状态（不推进）。 */
export async function statusScan(env: ScanEnv): Promise<Record<string, unknown>> {
  return publicView(await readState(env));
}

/** 重置扫描状态。 */
export async function resetScan(env: ScanEnv): Promise<Record<string, unknown>> {
  await writeState(env, { ...IDLE_STATE });
  return { status: 'idle', message: '已重置' };
}
