/**
 * 缠论日线/周线分析。移植自 analysis/chanlun_daily.py。
 * 管线：合并K线 → 分型 → 笔 → 中枢 → MACD背驰 → 买卖点信号。
 */
import { clamp, fmt, pyRound, sum } from '../util/pynum';

export interface MergedDailyKline {
  date_start: string;
  date_end: string;
  high: number;
  low: number;
  direction: number;
  raw_count: number;
}

export interface DailyFractal {
  index: number;
  type: 'top' | 'bottom';
  price: number;
  date: string;
}

export interface DailyStroke {
  direction: 'up' | 'down';
  start_price: number;
  end_price: number;
  start_date: string;
  end_date: string;
  start_idx: number;
  end_idx: number;
  macd_area: number;
  has_divergence: boolean;
}

export interface Zhongshu {
  start_date: string;
  end_date: string;
  zg: number;
  zd: number;
  zz: number;
  stroke_start_idx: number;
  stroke_end_idx: number;
  is_broken: boolean;
  break_direction: string;
}

export interface ChanlunDailySignal {
  type: string;
  price: number;
  date: string;
  description: string;
  confidence: number;
}

export interface ChanlunDailyResult {
  kline_count: number;
  merged_count: number;
  fractal_count: number;
  stroke_count: number;
  zhongshu_count: number;
  fractals: DailyFractal[];
  strokes: DailyStroke[];
  zhongshus: Zhongshu[];
  signals: ChanlunDailySignal[];
  macd_dif: number[];
  macd_dea: number[];
  macd_bar: number[];
  current_state: string;
  summary: string;
  description: string;
  chart_signals: Record<string, unknown>[];
  chart_fractals: Record<string, unknown>[];
  chart_zhongshus: Record<string, unknown>[];
  chart_strokes: Record<string, unknown>[];
}

/**
 * MACD(12,26,9)，以 SMA12/SMA26 作为 EMA 初值。
 * EMA12 在索引 12 前保持 SMA12 恒定；EMA26 在索引 26 前保持 SMA26 恒定；
 * DEA 在索引 9 前保持 SMA9(dif) 恒定。
 */
export function calcDailyMacd(closes: readonly number[]): [number[], number[], number[]] {
  const n = closes.length;
  if (n === 0) return [[], [], []];
  const s12 = sum(closes.slice(0, 12)) / 12;
  const s26 = sum(closes.slice(0, 26)) / 26;
  const ema12 = new Array<number>(n).fill(s12);
  const ema26 = new Array<number>(n).fill(s26);
  for (let i = 12; i < n; i++) ema12[i] = ema12[i - 1] + (closes[i] - ema12[i - 1]) * (2 / 13);
  for (let i = 26; i < n; i++) ema26[i] = ema26[i - 1] + (closes[i] - ema26[i - 1]) * (2 / 27);
  const dif = new Array<number>(n);
  for (let i = 0; i < n; i++) dif[i] = ema12[i] - ema26[i];
  const sDea = sum(dif.slice(0, 9)) / 9;
  const dea = new Array<number>(n).fill(sDea);
  for (let i = 9; i < n; i++) dea[i] = dea[i - 1] + (dif[i] - dea[i - 1]) * (2 / 10);
  const bar = new Array<number>(n);
  for (let i = 0; i < n; i++) bar[i] = (dif[i] - dea[i]) * 2;
  return [dif, dea, bar];
}

/** 合并K线：包含关系按当前方向取极值。 */
export function mergeDailyKlines(
  dates: readonly string[],
  highs: readonly number[],
  lows: readonly number[],
): MergedDailyKline[] {
  if (dates.length === 0) return [];
  const merged: MergedDailyKline[] = [];
  let cur: MergedDailyKline = {
    date_start: dates[0], date_end: dates[0],
    high: highs[0], low: lows[0], direction: 0, raw_count: 1,
  };
  for (let i = 1; i < dates.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const contained = (h <= cur.high && l >= cur.low) || (h >= cur.high && l <= cur.low);
    if (!contained) {
      merged.push(cur);
      const direction = h > cur.high ? 1 : -1;
      cur = { date_start: dates[i], date_end: dates[i], high: h, low: l, direction, raw_count: 1 };
    } else {
      let newHigh: number;
      let newLow: number;
      if (cur.direction === 1) {
        newHigh = Math.max(h, cur.high);
        newLow = Math.max(l, cur.low);
      } else if (cur.direction === -1) {
        newHigh = Math.min(h, cur.high);
        newLow = Math.min(l, cur.low);
      } else {
        newHigh = Math.max(h, cur.high);
        newLow = Math.min(l, cur.low);
      }
      cur = {
        date_start: cur.date_start, date_end: dates[i],
        high: newHigh, low: newLow,
        direction: cur.direction, raw_count: cur.raw_count + 1,
      };
    }
  }
  merged.push(cur);
  return merged;
}

/** 在合并K线上识别顶/底分型。 */
export function findDailyFractals(merged: readonly MergedDailyKline[]): DailyFractal[] {
  const fractals: DailyFractal[] = [];
  const n = merged.length;
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) continue;
    const left = merged[i - 1];
    const cur = merged[i];
    const right = merged[i + 1];
    if (cur.high > left.high && cur.high > right.high) {
      fractals.push({ index: i, type: 'top', price: cur.high, date: cur.date_end });
    } else if (cur.low < left.low && cur.low < right.low) {
      fractals.push({ index: i, type: 'bottom', price: cur.low, date: cur.date_end });
    }
  }
  return fractals;
}

/** 在分型序列上构建笔。端点索引差 >= 4 才可成为终点。 */
export function findDailyStrokes(fractals: readonly DailyFractal[]): DailyStroke[] {
  const strokes: DailyStroke[] = [];
  const n = fractals.length;
  if (n === 0) return strokes;

  let start = fractals[0];
  let startPos = 0;
  let direction: 'up' | 'down' = start.type === 'top' ? 'down' : 'up';
  let end: DailyFractal | null = null;
  let endPos = 0;
  let j = 1;
  while (j < n) {
    const f = fractals[j];
    if (f.type === start.type) {
      if (end !== null) {
        strokes.push({
          direction, start_price: start.price, end_price: end.price,
          start_date: start.date, end_date: end.date,
          start_idx: startPos, end_idx: endPos,
          macd_area: 0, has_divergence: false,
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
      direction, start_price: start.price, end_price: (end as DailyFractal).price,
      start_date: start.date, end_date: (end as DailyFractal).date,
      start_idx: startPos, end_idx: endPos,
      macd_area: 0, has_divergence: false,
    });
  }
  return strokes;
}

/** 构建中枢：相邻两笔重叠区间，成对推进，落空时单步推进。 */
export function findZhongshus(strokes: readonly DailyStroke[]): Zhongshu[] {
  const zhongshus: Zhongshu[] = [];
  const n = strokes.length;
  let i = 0;
  while (i + 2 < n) {
    const a = strokes[i];
    const b = strokes[i + 1];
    const zd = Math.max(Math.min(a.start_price, a.end_price), Math.min(b.start_price, b.end_price));
    const zg = Math.min(Math.max(a.start_price, a.end_price), Math.max(b.start_price, b.end_price));
    if (zd < zg) {
      zhongshus.push({
        start_date: a.start_date, end_date: b.end_date,
        zg, zd, zz: (zg + zd) / 2,
        stroke_start_idx: i, stroke_end_idx: i + 1,
        is_broken: false, break_direction: '',
      });
      i += 2;
    } else {
      i += 1;
    }
  }

  for (const z of zhongshus) {
    for (let k = z.stroke_end_idx + 1; k < strokes.length; k++) {
      const s = strokes[k];
      if (s.direction === 'up' && s.end_price > z.zg) {
        z.is_broken = true;
        z.break_direction = 'up';
        z.end_date = s.start_date;
        break;
      }
      if (s.direction === 'down' && s.end_price < z.zd) {
        z.is_broken = true;
        z.break_direction = 'down';
        z.end_date = s.start_date;
        break;
      }
    }
  }
  return zhongshus;
}

/** 计算每笔 MACD 面积并标注背驰（就地修改）。 */
export function detectDailyDivergence(
  strokes: DailyStroke[],
  macdBar: readonly number[],
  dates: readonly string[],
): void {
  const dateToIdx = new Map<string, number>();
  dates.forEach((d, i) => {
    if (!dateToIdx.has(d)) dateToIdx.set(d, i);
    else dateToIdx.set(d, i); // 与 Python dict comprehension 一致：后出现的覆盖先出现的
  });

  for (const st of strokes) {
    const si = dateToIdx.get(st.start_date);
    const ei = dateToIdx.get(st.end_date);
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
    let prev: DailyStroke | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (strokes[j].direction === st.direction) {
        prev = strokes[j];
        break;
      }
    }
    if (prev === null) {
      st.has_divergence = false;
      continue;
    }
    const areaLess = st.macd_area < prev.macd_area;
    const newExtreme =
      st.direction === 'down' ? st.end_price < prev.end_price : st.end_price > prev.end_price;
    st.has_divergence = areaLess && newExtreme;
  }
}

/** 背驰置信度 = clamp(round(94.5 - 35 * 面积比), 55, 92)。 */
function divergenceConfidence(strokes: readonly DailyStroke[], idx: number, direction: string): number {
  const st = strokes[idx];
  let prev: DailyStroke | null = null;
  for (let j = idx - 1; j >= 0; j--) {
    if (strokes[j].direction === direction) {
      prev = strokes[j];
      break;
    }
  }
  if (prev === null || prev.macd_area <= 0) return 55;
  const ratio = st.macd_area / prev.macd_area;
  const raw = 94.5 - 35 * ratio;
  return clamp(Math.trunc(pyRound(raw, 0)), 55, 92);
}

const SIGNAL_STYLE: Record<string, { symbol: string; rotate: number; position: string; color: string }> = {
  buy1: { symbol: 'triangle', rotate: 0, position: 'bottom', color: '#E24B4A' },
  buy2: { symbol: 'triangle', rotate: 0, position: 'bottom', color: '#D85A30' },
  buy3: { symbol: 'triangle', rotate: 0, position: 'bottom', color: '#BA7517' },
  sell1: { symbol: 'pin', rotate: 180, position: 'top', color: '#639922' },
  sell2: { symbol: 'pin', rotate: 180, position: 'top', color: '#3B6D11' },
  sell3: { symbol: 'pin', rotate: 180, position: 'top', color: '#27500A' },
};

/** 稳定排序（Python list.sort 为稳定排序）。 */
function stableSortByDate<T extends { date: string }>(arr: T[]): T[] {
  return arr
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (a.v.date < b.v.date ? -1 : a.v.date > b.v.date ? 1 : a.i - b.i))
    .map((x) => x.v);
}

/** 生成买卖点信号。顺序：一类点 + 二类买 + 二类卖 + 三类卖 + 三类买。 */
export function generateDailySignals(
  strokes: readonly DailyStroke[],
  zhongshus: readonly Zhongshu[],
): ChanlunDailySignal[] {
  let type1: ChanlunDailySignal[] = [];
  let buy2List: ChanlunDailySignal[] = [];
  let sell2List: ChanlunDailySignal[] = [];
  let buy3List: ChanlunDailySignal[] = [];
  let sell3List: ChanlunDailySignal[] = [];

  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    if (!st.has_divergence) continue;
    if (st.direction === 'down') {
      type1.push({
        type: 'buy1', price: st.end_price, date: st.end_date,
        confidence: divergenceConfidence(strokes, i, 'down'),
        description: `一类买点：日线底背驰，MACD面积${fmt(st.macd_area, 1)}较前笔衰减，空头力度衰竭`,
      });
    } else {
      type1.push({
        type: 'sell1', price: st.end_price, date: st.end_date,
        confidence: divergenceConfidence(strokes, i, 'up'),
        description: `一类卖点：日线顶背驰，MACD面积${fmt(st.macd_area, 1)}较前笔衰减，多头力度衰竭`,
      });
    }
  }
  type1 = stableSortByDate(type1);

  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    if (!st.has_divergence) continue;
    const idx2 = i + 2;
    if (idx2 < strokes.length) {
      const nxt = strokes[idx2];
      if (st.direction === 'down' && nxt.direction === 'down' && nxt.end_price > st.end_price) {
        buy2List.push({
          type: 'buy2', price: nxt.end_price, date: nxt.end_date, confidence: 70,
          description: `二类买点：一类买点后反弹再回落，未破前低${fmt(st.end_price, 2)}`,
        });
      } else if (st.direction === 'up' && nxt.direction === 'up' && nxt.end_price < st.end_price) {
        sell2List.push({
          type: 'sell2', price: nxt.end_price, date: nxt.end_date, confidence: 70,
          description: `二类卖点：一类卖点后回落再反弹，未破前高${fmt(st.end_price, 2)}`,
        });
      }
    }
  }
  buy2List = stableSortByDate(buy2List);
  sell2List = stableSortByDate(sell2List);

  for (const z of zhongshus) {
    if (!z.is_broken) continue;
    const recessIdx = z.stroke_end_idx + 2;
    if (recessIdx >= strokes.length) continue;
    const retro = strokes[recessIdx];
    if (z.break_direction === 'up') {
      if (retro.direction === 'down' && retro.end_price > z.zg) {
        buy3List.push({
          type: 'buy3', price: retro.end_price, date: retro.end_date, confidence: 75,
          description: `三类买点：中枢[${fmt(z.zd, 2)}-${fmt(z.zg, 2)}]向上突破后回踩，未回到中枢内`,
        });
      }
    } else if (retro.direction === 'up' && retro.end_price < z.zd) {
      sell3List.push({
        type: 'sell3', price: retro.end_price, date: retro.end_date, confidence: 75,
        description: `三类卖点：中枢[${fmt(z.zd, 2)}-${fmt(z.zg, 2)}]向下突破后反弹，未回到中枢内`,
      });
    }
  }
  sell3List = stableSortByDate(sell3List);
  buy3List = stableSortByDate(buy3List);

  return [...type1, ...buy2List, ...sell2List, ...sell3List, ...buy3List];
}

export function getSignalTypeName(sigType: string): string {
  return (
    {
      buy1: '一类买点', buy2: '二类买点', buy3: '三类买点',
      sell1: '一类卖点', sell2: '二类卖点', sell3: '三类卖点',
    } as Record<string, string>
  )[sigType] ?? sigType;
}

function describeState(
  strokes: readonly DailyStroke[],
  zhongshus: readonly Zhongshu[],
  signals: readonly ChanlunDailySignal[],
  fractalCount: number,
): [string, string, string] {
  const lastStroke = strokes.length ? strokes[strokes.length - 1] : null;
  const isUp = !!(lastStroke && lastStroke.direction === 'up');
  const directionCn = isUp ? '向上' : '向下';
  const bullCn = isUp ? '多头' : '空头';

  let zsText: string;
  if (zhongshus.length) {
    const lastZ = zhongshus[zhongshus.length - 1];
    if (lastZ.is_broken) zsText = lastZ.break_direction === 'up' ? '已向上突破' : '已向下突破';
    else zsText = `[${fmt(lastZ.zd, 2)}-${fmt(lastZ.zg, 2)}]震荡中`;
  } else {
    zsText = '无中枢';
  }

  const latest = signals.length ? signals[signals.length - 1] : null;
  let state = `处于${directionCn}笔中，${bullCn}延续，最近中枢${zsText}`;
  let summary: string;
  if (latest) {
    const typeCn = getSignalTypeName(latest.type);
    state += `，最新信号：${typeCn}@${fmt(latest.price, 2)}`;
    summary = `最新信号：${typeCn}@${fmt(latest.price, 2)}(${latest.date})`;
  } else {
    state += '，无信号';
    summary = '无信号';
  }

  const description =
    `共${fractalCount}个分型、${strokes.length}笔、${zhongshus.length}个中枢、${signals.length}个信号。${state}`;
  return [state, summary, description];
}

function buildChartOverlay(
  fractals: readonly DailyFractal[],
  strokes: readonly DailyStroke[],
  zhongshus: readonly Zhongshu[],
  signals: readonly ChanlunDailySignal[],
): [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]] {
  const chartFractals = fractals.map((f) => ({
    coord: [f.date, f.price],
    symbol: 'circle',
    symbolSize: 7,
    itemStyle: {
      color: 'transparent',
      borderColor: f.type === 'top' ? '#A32D2D' : '#3B6D11',
      borderWidth: 1.5,
    },
    fractal_type: f.type,
  }));

  const chartStrokes = strokes.map((s) => ({
    coords: [[s.start_date, s.start_price], [s.end_date, s.end_price]],
    lineStyle: {
      color: s.direction === 'down' ? '#639922' : '#E24B4A',
      width: 1.5,
      type: s.has_divergence ? 'dashed' : 'solid',
    },
    has_divergence: s.has_divergence,
  }));

  const chartZhongshus = zhongshus.map((z) => ({
    xAxis: [z.start_date, z.end_date],
    yAxis: [z.zd, z.zg],
    itemStyle: {
      color: 'rgba(83, 74, 183, 0.08)',
      borderColor: 'rgba(83, 74, 183, 0.4)',
    },
    broken: z.is_broken,
    break_direction: z.break_direction,
    zg: z.zg,
    zd: z.zd,
  }));

  const chartSignals = signals.map((s) => {
    const style = SIGNAL_STYLE[s.type] ?? SIGNAL_STYLE.buy1;
    const typeCn = getSignalTypeName(s.type);
    return {
      coord: [s.date, s.price],
      symbol: style.symbol,
      symbolRotate: style.rotate,
      symbolSize: 14,
      itemStyle: { color: style.color, opacity: 0.9 },
      label: {
        show: true, position: style.position, formatter: typeCn,
        fontSize: 10, color: style.color,
      },
      type_name: typeCn,
      date: s.date,
      price: pyRound(s.price, 2),
      confidence: s.confidence,
      description: s.description,
    };
  });

  return [chartSignals, chartFractals, chartZhongshus, chartStrokes];
}

/** 日线缠论完整分析管线。 */
export function analyzeChanlunDaily(
  dates: readonly string[],
  _opens: readonly number[],
  closes: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
  _volumes: readonly number[],
): ChanlunDailyResult {
  const merged = mergeDailyKlines(dates, highs, lows);
  const fractals = findDailyFractals(merged);
  const strokes = findDailyStrokes(fractals);
  const zhongshus = findZhongshus(strokes);
  const [dif, dea, bar] = calcDailyMacd(closes);
  detectDailyDivergence(strokes, bar, dates);
  const signals = generateDailySignals(strokes, zhongshus);
  const [state, summary, description] = describeState(strokes, zhongshus, signals, fractals.length);
  const [cs, cf, cz, cst] = buildChartOverlay(fractals, strokes, zhongshus, signals);
  return {
    kline_count: dates.length,
    merged_count: merged.length,
    fractal_count: fractals.length,
    stroke_count: strokes.length,
    zhongshu_count: zhongshus.length,
    fractals, strokes, zhongshus, signals,
    macd_dif: dif, macd_dea: dea, macd_bar: bar,
    current_state: state, summary, description,
    chart_signals: cs, chart_fractals: cf, chart_zhongshus: cz, chart_strokes: cst,
  };
}

/** 序列化为 API 响应字典（字段与 Python daily_result_to_dict 一致）。 */
export function dailyResultToDict(result: ChanlunDailyResult): Record<string, unknown> {
  return {
    kline_count: result.kline_count,
    merged_count: result.merged_count,
    fractal_count: result.fractal_count,
    stroke_count: result.stroke_count,
    zhongshu_count: result.zhongshu_count,
    fractals: result.fractals.map((f) => ({
      type: f.type,
      type_name: f.type === 'top' ? '顶分型' : '底分型',
      price: pyRound(f.price, 2),
      date: f.date,
    })),
    strokes: result.strokes.map((s) => ({
      direction: s.direction,
      start_price: pyRound(s.start_price, 2),
      end_price: pyRound(s.end_price, 2),
      start_date: s.start_date,
      end_date: s.end_date,
      macd_area: pyRound(s.macd_area, 2),
      has_divergence: s.has_divergence,
    })),
    zhongshus: result.zhongshus.map((z) => ({
      start_date: z.start_date,
      end_date: z.end_date,
      zg: pyRound(z.zg, 2),
      zd: pyRound(z.zd, 2),
      zz: pyRound(z.zz, 2),
      is_broken: z.is_broken,
      break_direction: z.break_direction,
    })),
    signals: result.signals.map((s) => ({
      type: s.type,
      type_name: getSignalTypeName(s.type),
      price: pyRound(s.price, 2),
      date: s.date,
      confidence: s.confidence,
      description: s.description,
    })),
    current_state: result.current_state,
    summary: result.summary,
    description: result.description,
    chart_signals: result.chart_signals,
    chart_fractals: result.chart_fractals,
    chart_zhongshus: result.chart_zhongshus,
    chart_strokes: result.chart_strokes,
  };
}
