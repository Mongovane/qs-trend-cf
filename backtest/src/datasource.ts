/**
 * 回测数据加载。
 *
 * 支持三种来源：
 *  1. QMT 导出：backtest/data/<code>.csv  （用 integrations/qmt/export_history.py 生成）
 *  2. 通用 CSV：表头需含 date,open,high,low,close,volume[,amount,turnover]
 *  3. JSON：{"symbol","name","klines":[...]}
 *
 * 沙箱内无法访问行情源，因此还提供 synthesize() 生成确定性合成数据，
 * 用于验证引擎本身是否正确 —— 但**合成数据上的收益率没有任何意义**。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { Kline } from '../../src/types';
import type { SymbolData } from './engine';

function parseCsv(text: string): Kline[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const ci = {
    date: col('date') >= 0 ? col('date') : col('time'),
    open: col('open'), high: col('high'), low: col('low'), close: col('close'),
    volume: col('volume') >= 0 ? col('volume') : col('vol'),
    amount: col('amount'), turnover: col('turnover'),
  };
  if (ci.date < 0 || ci.close < 0) return [];

  const out: Kline[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length <= ci.close) continue;
    const raw = String(p[ci.date]).trim();
    // 兼容 20240102 / 2024-01-02 / 2024-01-02 15:00:00
    let date = raw;
    if (/^\d{8}$/.test(raw)) date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    else if (raw.includes(' ')) date = raw.split(' ')[0];

    const num = (idx: number) => (idx >= 0 && p[idx] !== undefined ? Number(p[idx]) : 0);
    const k: Kline = {
      date,
      open: num(ci.open), high: num(ci.high), low: num(ci.low), close: num(ci.close),
      volume: num(ci.volume), amount: num(ci.amount), pct: 0, turnover: num(ci.turnover),
    };
    if (!Number.isFinite(k.close) || k.close <= 0) continue;
    if (out.length) {
      const prev = out[out.length - 1].close;
      k.pct = prev ? Math.round(((k.close - prev) / prev) * 10000) / 100 : 0;
    }
    out.push(k);
  }
  return out;
}

/** 从目录加载全部标的。文件名（去扩展名）即代码，可用 name-map.json 补名称。 */
export function loadDirectory(dir: string): SymbolData[] {
  if (!existsSync(dir)) return [];
  let nameMap: Record<string, string> = {};
  const mapPath = join(dir, 'name-map.json');
  if (existsSync(mapPath)) {
    try { nameMap = JSON.parse(readFileSync(mapPath, 'utf-8')); } catch { /* 忽略 */ }
  }

  const out: SymbolData[] = [];
  for (const f of readdirSync(dir)) {
    const ext = extname(f).toLowerCase();
    const stem = basename(f, ext);
    if (stem === 'name-map' || stem.startsWith('.')) continue;
    const full = join(dir, f);
    try {
      if (ext === '.csv') {
        const kl = parseCsv(readFileSync(full, 'utf-8'));
        if (kl.length >= 60) {
          const code = stem.replace(/\.(SH|SZ|SS|BJ)$/i, '');
          out.push({ symbol: code, name: nameMap[code] ?? nameMap[stem] ?? code, klines: kl });
        }
      } else if (ext === '.json') {
        const j = JSON.parse(readFileSync(full, 'utf-8'));
        if (Array.isArray(j.klines) && j.klines.length >= 60) {
          out.push({ symbol: String(j.symbol ?? stem), name: String(j.name ?? stem), klines: j.klines, flows: j.flows });
        }
      }
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

export function loadBenchmark(path: string): Kline[] {
  if (!existsSync(path)) return [];
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return parseCsv(readFileSync(path, 'utf-8'));
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(j) ? j : (j.klines ?? []);
  } catch { return []; }
}

/**
 * 确定性合成行情，仅用于验证引擎逻辑（xorshift32，跨语言可复现）。
 * ⚠ 合成数据没有真实市场的自相关与截面结构，
 *   在其上得到的任何收益指标都不能用来判断策略优劣。
 */
export function synthesize(count: number, bars: number, seed = 20240101): SymbolData[] {
  let state = seed >>> 0;
  const rnd = () => {
    state ^= (state << 13) >>> 0; state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0; state >>>= 0;
    return state / 4294967296;
  };

  const dates: string[] = [];
  const d = new Date(Date.UTC(2021, 0, 4));
  while (dates.length < bars) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const out: SymbolData[] = [];
  for (let s = 0; s < count; s++) {
    const boardPick = rnd();
    const code = boardPick < 0.6
      ? String(600000 + Math.floor(rnd() * 800)).padStart(6, '0')
      : boardPick < 0.85
        ? String(2 + Math.floor(rnd() * 900)).padStart(6, '0')
        : String(300000 + Math.floor(rnd() * 900));
    const klines: Kline[] = [];
    let price = 5 + rnd() * 45;
    // 每只股票一个持续性漂移 + 周期，制造可被趋势策略捕捉的结构
    const drift = (rnd() - 0.48) * 0.0025;
    const cycle = 40 + Math.floor(rnd() * 120);
    const vol = 0.014 + rnd() * 0.022;
    for (let i = 0; i < bars; i++) {
      const seasonal = Math.sin((i / cycle) * Math.PI * 2) * 0.0022;
      const shock = (rnd() - 0.5) * vol * 2;
      price = Math.max(1, price * (1 + drift + seasonal + shock));
      const rng = price * (0.006 + rnd() * 0.02);
      const o = price - rng * (rnd() - 0.5);
      const c = price;
      const h = Math.max(o, c) + rng * rnd();
      const l = Math.min(o, c) - rng * rnd();
      const v = Math.round(30000 + rnd() * 500000);
      const k: Kline = {
        date: dates[i],
        open: +o.toFixed(2), close: +c.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2),
        volume: v, amount: +(c * v * 100).toFixed(0), pct: 0, turnover: +(rnd() * 5).toFixed(2),
      };
      if (klines.length) {
        const prev = klines[klines.length - 1].close;
        k.pct = prev ? +(((k.close - prev) / prev) * 100).toFixed(2) : 0;
      }
      klines.push(k);
    }
    out.push({ symbol: code, name: `合成${s + 1}`, klines });
  }
  return out;
}

/** 用成分股等权合成一条基准指数。 */
export function syntheticBenchmark(universe: readonly SymbolData[]): Kline[] {
  if (!universe.length) return [];
  const dates = universe[0].klines.map((k) => k.date);
  const base = new Map<string, number>();
  for (const s of universe) base.set(s.symbol, s.klines[0].close);
  return dates.map((date, i) => {
    let acc = 0;
    let n = 0;
    for (const s of universe) {
      const k = s.klines[i];
      const b = base.get(s.symbol)!;
      if (k && b) { acc += k.close / b; n += 1; }
    }
    const idx = n ? (acc / n) * 1000 : 1000;
    return { date, open: idx, close: idx, high: idx, low: idx, volume: 0, amount: 0, pct: 0, turnover: 0 };
  });
}
