/**
 * 缠论分钟线分析。移植自 analysis/chanlun_minute.py。
 * 管线：5分钟K线聚合 → 合并 → 分型 → 笔 → MACD背驰 → 一类买卖点。
 */
import { clamp, fmt, pyRound, sum } from '../util/pynum';

export interface MinuteKline {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface MergedKline {
  time_start: string;
  time_end: string;
  high: number;
  low: number;
  direction: number;
  raw_count: number;
}

export interface Fractal {
  index: number;
  type: 'top' | 'bottom';
  price: number;
  time: string;
}

export interface Stroke {
  direction: 'up' | 'down';
  start_price: number;
  end_price: number;
  start_time: string;
  end_time: string;
  start_idx: number;
  end_idx: number;
  macd_area: number;
  has_divergence: boolean;
}

export interface ChanlunSignal {
  type: string;
  price: number;
  time: string;
  description: string;
  confidence: number;
}

export interface ChanlunMinuteResult {
  kline_count: number;
  fractal_count: number;
  fractals: Fractal[];
  stroke_count: number;
  strokes: Stroke[];
  signals: ChanlunSignal[];
  macd_dif: number[];
  macd_dea: number[];
  macd_bar: number[];
  current_state: string;
  summary: string;
  description: string;
}

function toMinutes(t: string): number {
  const [hh, mm] = t.split(':');
  return Number(hh) * 60 + Number(mm);
}

function makeKline(
  times: readonly string[],
  prices: readonly number[],
  volumes: readonly number[],
  group: readonly number[],
): MinuteKline {
  const gTimes = group.map((i) => times[i]);
  const gPrices = group.map((i) => prices[i]);
  return {
    time: gTimes[gTimes.length - 1],
    open: gPrices[0],
    close: gPrices[gPrices.length - 1],
    high: Math.max(...gPrices),
    low: Math.min(...gPrices),
    volume: sum(group.map((i) => volumes[i] ?? 0)),
  };
}

/** 将分钟数据按 5 分钟区间聚合为 5 分钟 K 线。 */
export function construct5minKlines(
  times: readonly string[],
  prices: readonly number[],
  volumes: readonly number[],
): MinuteKline[] {
  const klines: MinuteKline[] = [];
  const n = times.length;
  if (n === 0) return klines;

  let group: number[] = [];
  let groupStartMinute = toMinutes(times[0]);
  for (let i = 0; i < n; i++) {
    const curMinute = toMinutes(times[i]);
    if (group.length && curMinute - toMinutes(times[i - 1]) !== 1) {
      klines.push(makeKline(times, prices, volumes, group));
      group = [];
      groupStartMinute = curMinute;
    }
    if (!group.length) groupStartMinute = curMinute;
    group.push(i);
    if (curMinute - groupStartMinute === 4 || (i === n - 1 && group.length)) {
      klines.push(makeKline(times, prices, volumes, group));
      group = [];
    }
  }
  return klines;
}

/** EMA：前 n 个值保持为 SMA(n)，之后按 EMA 递推。 */
function emaSmaSeed(seq: readonly number[], n: number): number[] {
  if (!seq.length) return [];
  const k = 2 / (n + 1);
  const seed = sum(seq.slice(0, n)) / n;
  const out: number[] = new Array(Math.min(n, seq.length)).fill(seed);
  for (let i = n; i < seq.length; i++) {
    out.push(seq[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

/** SMA 种子 EMA 的 MACD 计算。 */
export function calcMacd(klines: readonly MinuteKline[]): [number[], number[], number[]] {
  const closes = klines.map((k) => k.close);
  const ema12 = emaSmaSeed(closes, 12);
  const ema26 = emaSmaSeed(closes, 26);
  const len = Math.min(ema12.length, ema26.length);
  const dif: number[] = [];
  for (let i = 0; i < len; i++) dif.push(ema12[i] - ema26[i]);
  const dea = emaSmaSeed(dif, 9);
  const barLen = Math.min(dif.length, dea.length);
  const bar: number[] = [];
  for (let i = 0; i < barLen; i++) bar.push((dif[i] - dea[i]) * 2);
  return [dif, dea, bar];
}

/** 合并 K 线：包含关系按当前方向取极值。 */
export function mergeKlines(klines: readonly MinuteKline[]): MergedKline[] {
  if (!klines.length) return [];
  const merged: MergedKline[] = [];
  let cur: MergedKline = {
    time_start: klines[0].time, time_end: klines[0].time,
    high: klines[0].high, low: klines[0].low, direction: 0, raw_count: 1,
  };
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const contained = (h <= cur.high && l >= cur.low) || (h >= cur.high && l <= cur.low);
    if (!contained) {
      merged.push(cur);
      const direction = h > cur.high ? 1 : -1;
      cur = { time_start: klines[i].time, time_end: klines[i].time, high: h, low: l, direction, raw_count: 1 };
    } else {
      let newHigh: number;
      let newLow: number;
      if (cur.direction === 1) { newHigh = Math.max(h, cur.high); newLow = Math.max(l, cur.low); }
      else if (cur.direction === -1) { newHigh = Math.min(h, cur.high); newLow = Math.min(l, cur.low); }
      else { newHigh = Math.max(h, cur.high); newLow = Math.min(l, cur.low); }
      cur = {
        time_start: cur.time_start, time_end: klines[i].time,
        high: newHigh, low: newLow, direction: cur.direction, raw_count: cur.raw_count + 1,
      };
    }
  }
  merged.push(cur);
  return merged;
}

/** 在合并 K 线上识别顶/底分型。 */
export function findFractals(merged: readonly MergedKline[]): Fractal[] {
  const fractals: Fractal[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const left = merged[i - 1];
    const cur = merged[i];
    const right = merged[i + 1];
    if (cur.high > left.high && cur.high > right.high) {
      fractals.push({ index: i, type: 'top', price: cur.high, time: cur.time_end });
    } else if (cur.low < left.low && cur.low < right.low) {
      fractals.push({ index: i, type: 'bottom', price: cur.low, time: cur.time_end });
    }
  }
  return fractals;
}

/** 在分型序列上构建笔（端点索引差 >= 4）。 */
export function findStrokes(fractals: readonly Fractal[]): Stroke[] {
  const strokes: Stroke[] = [];
  const n = fractals.length;
  if (n === 0) return strokes;

  let start = fractals[0];
  let startPos = 0;
  let direction: 'up' | 'down' = start.type === 'top' ? 'down' : 'up';
  let end: Fractal | null = null;
  let endPos = 0;
  let j = 1;
  while (j < n) {
    const f = fractals[j];
    if (f.type === start.type) {
      if (end !== null) {
        strokes.push({
          direction, start_price: start.price, end_price: end.price,
          start_time: start.time, end_time: end.time,
          start_idx: startPos, end_idx: endPos, macd_area: 0, has_divergence: false,
        });
        start = end;
        startPos = endPos;
        direction = direction === 'down' ? 'up' : 'down';
        end = null;
      } else {
        if ((direction === 'down' && f.price > start.price) ||
            (direction === 'up' && f.price < start.price)) {
          start = f;
          startPos = j;
        }
        j += 1;
      }
    } else {
      if (f.index - start.index >= 4) {
        end = f;
        endPos = j;
      }
      j += 1;
    }
  }
  if (end !== null) {
    strokes.push({
      direction, start_price: start.price, end_price: (end as Fractal).price,
      start_time: start.time, end_time: (end as Fractal).time,
      start_idx: startPos, end_idx: endPos, macd_area: 0, has_divergence: false,
    });
  }
  return strokes;
}

/** 计算每笔 MACD 面积并标注背驰（就地修改）。 */
export function detectDivergence(
  strokes: Stroke[],
  macdBar: readonly number[],
  klines: readonly MinuteKline[],
): void {
  const timeToIdx = new Map<string, number>();
  klines.forEach((k, i) => timeToIdx.set(k.time, i));

  for (const st of strokes) {
    const si = timeToIdx.get(st.start_time);
    const ei = timeToIdx.get(st.end_time);
    if (si === undefined || ei === undefined) {
      st.macd_area = 0;
      st.has_divergence = false;
      continue;
    }
    let area = 0;
    for (let i = si; i <= ei && i < macdBar.length; i++) area += Math.abs(macdBar[i]);
    st.macd_area = area;
  }

  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    let prev: Stroke | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (strokes[j].direction === st.direction) { prev = strokes[j]; break; }
    }
    if (prev === null) { st.has_divergence = false; continue; }
    const areaLess = st.macd_area < prev.macd_area;
    const newExtreme =
      st.direction === 'down' ? st.end_price < prev.end_price : st.end_price > prev.end_price;
    st.has_divergence = areaLess && newExtreme;
  }
}

function signalConfidence(area: number, prevArea: number): number {
  if (prevArea <= 0) return 55;
  const ratio = area / prevArea;
  return clamp(Math.trunc(pyRound(100 - 40 * ratio, 0)), 55, 90);
}

export function getSignalTypeName(sigType: string): string {
  return ({ buy1: '一类买点', sell1: '一类卖点' } as Record<string, string>)[sigType] ?? sigType;
}

/** 从背驰笔生成一类买卖点信号。 */
export function generateSignals(strokes: readonly Stroke[]): ChanlunSignal[] {
  const signals: ChanlunSignal[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    if (!st.has_divergence) continue;
    let prev: Stroke | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (strokes[j].direction === st.direction) { prev = strokes[j]; break; }
    }
    if (prev === null) continue;
    const conf = signalConfidence(st.macd_area, prev.macd_area);
    const isUp = st.direction === 'up';
    signals.push({
      type: isUp ? 'sell1' : 'buy1',
      price: st.end_price,
      time: st.end_time,
      description: isUp
        ? `一类卖点：顶背驰，MACD面积${fmt(st.macd_area, 2)}较前笔衰减，多头力度衰竭`
        : `一类买点：底背驰，MACD面积${fmt(st.macd_area, 2)}较前笔衰减，空头力度衰竭`,
      confidence: conf,
    });
  }
  return signals;
}

function describeState(
  strokes: readonly Stroke[],
  signals: readonly ChanlunSignal[],
  fractalCount: number,
): [string, string, string] {
  if (!strokes.length) {
    return ['笔形成中', '暂无买卖信号', `共${fractalCount}个分型、0笔。笔形成中`];
  }
  const lastStroke = strokes[strokes.length - 1];
  const isUp = lastStroke.direction === 'up';
  const directionCn = isUp ? '向上' : '向下';
  const bullCn = isUp ? '多头' : '空头';
  const latest = signals.length ? signals[signals.length - 1] : null;

  let state: string;
  let summary: string;
  if (lastStroke.has_divergence) {
    state = isUp ? '向上笔顶背驰，注意一类卖点风险' : '向下笔底背驰，注意一类买点风险';
    if (latest) state += `，最近${latest.type}信号在${latest.time}`;
    summary = latest ? `最新信号：${getSignalTypeName(latest.type)}@${fmt(latest.price, 2)}` : '暂无买卖信号';
  } else {
    state = `处于${directionCn}笔中，${bullCn}延续`;
    if (latest) {
      state += `，最近${latest.type}信号在${latest.time}`;
      summary = `最新信号：${getSignalTypeName(latest.type)}@${fmt(latest.price, 2)}`;
    } else {
      summary = '暂无买卖信号';
    }
  }

  const description = signals.length
    ? `共${fractalCount}个分型、${strokes.length}笔、${signals.length}个信号。${state}`
    : `共${fractalCount}个分型、${strokes.length}笔。${state}`;
  return [state, summary, description];
}

/** 分钟缠论完整分析管线。 */
export function analyzeChanlunMinute(
  times: readonly string[],
  prices: readonly number[],
  volumes: readonly number[],
): ChanlunMinuteResult {
  const klines = construct5minKlines(times, prices, volumes);
  const merged = mergeKlines(klines);
  const fractals = findFractals(merged);
  const strokes = findStrokes(fractals);
  const [dif, dea, bar] = calcMacd(klines);
  detectDivergence(strokes, bar, klines);
  const signals = generateSignals(strokes);
  const [state, summary, description] = describeState(strokes, signals, fractals.length);
  return {
    kline_count: klines.length,
    fractal_count: fractals.length,
    fractals,
    stroke_count: strokes.length,
    strokes,
    signals,
    macd_dif: dif,
    macd_dea: dea,
    macd_bar: bar,
    current_state: state,
    summary,
    description,
  };
}

/** 序列化为 API 响应字典。 */
export function signalsToDict(result: ChanlunMinuteResult): Record<string, unknown> {
  return {
    kline_count: result.kline_count,
    fractal_count: result.fractal_count,
    stroke_count: result.stroke_count,
    current_state: result.current_state,
    summary: result.summary,
    description: result.description,
    signals: result.signals.map((s) => ({
      type: s.type,
      type_name: getSignalTypeName(s.type),
      price: pyRound(s.price, 2),
      time: s.time,
      description: s.description,
      confidence: s.confidence,
    })),
    fractals: result.fractals.map((f) => ({
      type: f.type,
      type_name: f.type === 'top' ? '顶分型' : '底分型',
      price: pyRound(f.price, 2),
      time: f.time,
    })),
    strokes: result.strokes.map((s) => ({
      direction: s.direction,
      start_price: pyRound(s.start_price, 2),
      end_price: pyRound(s.end_price, 2),
      start_time: s.start_time,
      end_time: s.end_time,
      macd_area: pyRound(s.macd_area, 4),
      has_divergence: s.has_divergence,
    })),
    macd_bar: result.macd_bar.map((x) => pyRound(x, 6)),
  };
}
