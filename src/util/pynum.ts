/**
 * Python 语义的数值工具。
 *
 * 移植关键点（这些差异会直接改变评分结果，必须显式处理）：
 *  - Python `round()` 采用 banker's rounding（四舍六入五取偶），JS `Math.round()` 为 half-up；
 *  - Python `int()` 向 0 截断，JS `Math.floor()` 对负数向下取整；
 *  - Python `//` 为向下取整除法；
 *  - Python f-string `{x:.2f}` 亦为 half-even，JS `toFixed()` 行为不同。
 */

/**
 * 等价于 Python round(x, digits)（四舍六入五取偶）。
 *
 * 实现要点：**不能**用 `Math.round(x * 10**d) / 10**d`——乘法本身会引入
 * Python 端不存在的浮点误差（例：round(2.675, 2) Python 得 2.67，
 * 乘法法得 2.68；round(TR均值, 4) 会因此整体偏差 0.0001）。
 *
 * 正确做法是对 double 的**精确十进制展开**做舍入：
 *  1. toFixed 在非平局时即为正确舍入，直接采用；
 *  2. 仅当 x 的精确值在第 d+1 位恰好是 5 且其后全为 0（真正的平局）时，
 *     才按「取偶」规则处理。用 toFixed(d+16) 检查尾部是否全零来判定平局。
 */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  const d = Math.trunc(digits);
  if (d < 0) {
    const m = 10 ** -d;
    return pyRound(x / m, 0) * m;
  }
  // toFixed 在 |x| >= 1e21 时退化为指数表示，且 d+16 需落在 [0,100]
  if (Math.abs(x) >= 1e21 || d + 16 > 100) return x;

  const probe = x.toFixed(d + 16);
  const dot = probe.indexOf('.');
  const frac = dot === -1 ? '' : probe.slice(dot + 1);
  const tieDigit = frac[d];
  const tail = frac.slice(d + 1);
  const isTie = tieDigit === '5' && /^0*$/.test(tail);

  if (!isTie) {
    const out = Number(x.toFixed(d));
    return Object.is(out, -0) ? 0 : out;
  }

  // 精确平局 → 取偶
  const truncated = Number(d === 0 ? probe.slice(0, dot) : probe.slice(0, dot + 1 + d));
  const lastDigit = d === 0
    ? Math.abs(truncated) % 10
    : Number(frac[d - 1] ?? '0');
  if (lastDigit % 2 === 0) return Object.is(truncated, -0) ? 0 : truncated;
  const step = (x >= 0 ? 1 : -1) / 10 ** d;
  const out = Number((truncated + step).toFixed(d));
  return Object.is(out, -0) ? 0 : out;
}

/** 等价于 Python int(x)：向 0 截断。 */
export function pyInt(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const t = Math.trunc(x);
  return Object.is(t, -0) ? 0 : t;
}

/** 等价于 Python a // b：向下取整除法。 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** 等价于 Python f"{x:.Nf}"：先 half-even 再定长输出。 */
export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return String(x);
  return pyRound(x, digits).toFixed(digits);
}

/** 带符号的百分比格式化，等价于 Python f"{x:+.2f}"。 */
export function fmtSigned(x: number, digits = 2): string {
  const s = fmt(x, digits);
  return x >= 0 && !s.startsWith('+') ? `+${s}` : s;
}

/** Python max(lo, min(hi, x)) 的显式版本。 */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 安全 float 转换，对应 kline_fetcher._to_float。 */
export function toFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '-' || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** 数组求和。 */
export function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

/** 数组均值（空数组返回 0）。 */
export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

/** 等价于 Python 的 seq[a:b]，支持负索引与越界裁剪。 */
export function slice<T>(xs: readonly T[], start?: number, end?: number): T[] {
  return xs.slice(start, end);
}

/** 百分比变化，对应 analysis._indicators.pct_change。 */
export function pctChange(start: number, end: number): number {
  if (!start) return 0;
  return ((end - start) / start) * 100;
}
