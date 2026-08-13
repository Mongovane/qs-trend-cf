/**
 * Python ↔ TypeScript 一致性回归测试。
 *
 * tests/golden.json 由 tools/gen_golden.py 使用原版 Python 模块生成。
 * 本测试把同样的输入喂给 TS 移植版，逐字段比对。
 *
 * 注意：engine 部分使用 legacy 档位比对（与原版五模块权重一致）；
 * enhanced 档位是本次新增的增强层，不参与一致性约束，仅做健全性检查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, 'golden.json');

const mod = await import('./build/bundle.mjs');
const {
  analyzeTrend, analyzeVolumePrice, analyzePatterns, analyzeBreakout,
  analyzeCanslim, runAnalysis, analyzeChanlunDaily, dailyResultToDict,
  analyzeTechnical, pyRound, pyInt,
} = mod;

const KEY_TOL = 1e-9;

function approx(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(
      Math.abs(a - b) <= Math.max(KEY_TOL, Math.abs(b) * 1e-9),
      `${path}: ${a} !== ${b}`,
    );
    return;
  }
  assert.deepEqual(a, b, path);
}

test('pynum: Python round() 语义（四舍六入五取偶）', () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(-2.5), -2);
  assert.equal(pyRound(-3.5), -4);
  assert.equal(pyRound(0.5), 0);
  assert.equal(pyRound(1.5), 2);
  assert.equal(pyRound(2.675, 2), 2.67); // 二进制表示实际为 2.67499...
  assert.equal(pyInt(-3.7), -3);
  assert.equal(pyInt(3.7), 3);
});

if (!existsSync(goldenPath)) {
  test('golden fixtures 缺失', () => {
    assert.fail('未找到 tests/golden.json，请先运行 tools/gen_golden.py');
  });
} else {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));

  for (const [name, c] of Object.entries(golden.cases)) {
    const klines = c.input.klines;
    const index = c.input.index;
    const flows = c.input.flows;
    const last = klines[klines.length - 1];
    const quote = {
      symbol: '000000', name: 'TEST', price: last.close, pct: last.pct, change: 0,
      high: last.high, low: last.low, open: last.open,
      pre_close: klines[klines.length - 2].close,
      volume: last.volume, amount: last.amount, turnover: last.turnover,
    };

    test(`[${name}] 趋势模块`, () => {
      const r = analyzeTrend(klines);
      assert.equal(r.direction, c.trend.direction);
      assert.equal(r.strength, c.trend.strength);
      assert.equal(r.stage, c.trend.stage);
      assert.deepEqual(r.ma_scores, c.trend.ma_scores);
      assert.deepEqual(r.signals, c.trend.signals);
      if (c.trend.trendline === null) assert.equal(r.trendline, null);
      else {
        approx(r.trendline.slope, c.trend.trendline.slope, 'trendline.slope');
        approx(r.trendline.current_price, c.trend.trendline.current_price, 'trendline.price');
        assert.deepEqual(r.trendline.points, c.trend.trendline.points);
      }
    });

    test(`[${name}] 量价模块`, () => {
      const r = analyzeVolumePrice(klines, quote, flows);
      assert.equal(r.pattern, c.volume_price.pattern);
      assert.equal(r.direction, c.volume_price.direction);
      assert.equal(r.confidence, c.volume_price.confidence);
      approx(r.volume_ratio, c.volume_price.volume_ratio, 'volume_ratio');
      assert.equal(r.obv_trend, c.volume_price.obv_trend);
      assert.deepEqual(r.signals, c.volume_price.signals);
    });

    test(`[${name}] 突破模块`, () => {
      const r = analyzeBreakout(klines);
      assert.equal(r.length, c.breakouts.length);
      r.forEach((b, i) => {
        const g = c.breakouts[i];
        assert.equal(b.system, g.system);
        assert.equal(b.signal, g.signal, `${name}/${g.system} signal`);
        approx(b.current_n, g.current_n, 'current_n');
        approx(b.stop_loss, g.stop_loss, 'stop_loss');
        approx(b.entry_price ?? 0, g.entry_price ?? 0, 'entry_price');
        assert.equal(b.position_units, g.position_units, `${name}/${g.system} units`);
        approx(b.channel_high, g.channel_high, 'channel_high');
        approx(b.channel_low, g.channel_low, 'channel_low');
        approx(b.next_add_price ?? 0, g.next_add_price ?? 0, 'next_add_price');
      });
    });

    test(`[${name}] CANSLIM 模块`, () => {
      const r = analyzeCanslim(klines, quote, flows, index);
      assert.equal(r.c_score, c.canslim.c, 'C');
      assert.equal(r.a_score, c.canslim.a, 'A');
      assert.equal(r.n_score, c.canslim.n, 'N');
      assert.equal(r.s_score, c.canslim.s, 'S');
      assert.equal(r.l_score, c.canslim.l, 'L');
      assert.equal(r.i_score, c.canslim.i, 'I');
      assert.equal(r.m_score, c.canslim.m, 'M');
      assert.equal(r.total, c.canslim.total, 'total');
      assert.equal(r.grade, c.canslim.grade, 'grade');
      assert.deepEqual(r.signals, c.canslim.signals);
      assert.deepEqual(r.cup_handle, c.canslim.cup_handle);
    });

    test(`[${name}] 缠论日线`, () => {
      const r = dailyResultToDict(analyzeChanlunDaily(
        klines.map((k) => k.date), klines.map((k) => k.open), klines.map((k) => k.close),
        klines.map((k) => k.high), klines.map((k) => k.low), klines.map((k) => k.volume),
      ));
      assert.equal(r.merged_count, c.chanlun_daily.merged_count, 'merged');
      assert.equal(r.fractal_count, c.chanlun_daily.fractal_count, 'fractals');
      assert.equal(r.stroke_count, c.chanlun_daily.stroke_count, 'strokes');
      assert.equal(r.zhongshu_count, c.chanlun_daily.zhongshu_count, 'zhongshu');
      assert.deepEqual(r.signals, c.chanlun_daily.signals);
      assert.deepEqual(r.strokes, c.chanlun_daily.strokes);
    });

    test(`[${name}] 信号引擎 (legacy 档位须与原版完全一致)`, () => {
      const r = runAnalysis(klines, quote, flows, index, 'legacy');
      assert.equal(r.score, c.engine_legacy.score, 'score');
      assert.equal(r.action, c.engine_legacy.action, 'action');
      assert.equal(r.confidence, c.engine_legacy.confidence, 'confidence');
      assert.equal(r.risk_level, c.engine_legacy.risk_level, 'risk_level');
      assert.deepEqual(r.module_scores, c.engine_legacy.module_scores);
      assert.deepEqual(r.buy_signals, c.engine_legacy.buy_signals);
      assert.deepEqual(r.sell_signals, c.engine_legacy.sell_signals);
      assert.deepEqual(r.trade_plan, c.engine_legacy.trade_plan);
      assert.deepEqual(r.key_levels, c.engine_legacy.key_levels);
    });

    test(`[${name}] 形态模块 (含 FIX-P1/P3，仅做健全性检查)`, () => {
      const r = analyzePatterns(klines);
      assert.ok(Array.isArray(r) && r.length <= 3);
      for (const p of r) {
        assert.ok(['看涨', '看跌', '中性'].includes(p.direction));
        assert.ok(p.confidence >= 0 && p.confidence <= 100);
      }
    });

    test(`[${name}] 技术指标层 (新增)`, () => {
      const r = analyzeTechnical(klines);
      assert.ok(r.score >= 0 && r.score <= 100, `score out of range: ${r.score}`);
      assert.ok(r.contributors > 0, 'no indicator contributed');
      assert.ok(Number.isInteger(r.score));
      for (const [k, v] of Object.entries(r.values)) {
        if (v !== null) assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
      }
    });

    test(`[${name}] enhanced 档位健全性`, () => {
      const r = runAnalysis(klines, quote, flows, index, 'enhanced');
      assert.ok(r.score >= 0 && r.score <= 100);
      assert.ok(['强烈买入', '买入', '观望'].includes(r.action));
      assert.ok(r.technical !== null);
      assert.equal(r.module_scores['技术指标'], r.technical.score);
      assert.equal(r.scoring_profile, 'enhanced');
    });
  }
}
