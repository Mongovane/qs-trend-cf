#!/usr/bin/env python3
"""Python ↔ TypeScript 一致性回归：生成基准输出（golden fixtures）。

用法：
    python3 tools/gen_golden.py <原项目根目录> [输出文件]

会用确定性的合成 K 线数据（不依赖网络）驱动原版 Python 分析模块，
把每个模块的输出写成 JSON，供 `npm test` 中的 TS 端逐字段比对。

之所以用合成数据而非真实行情：真实行情每天都在变，无法作为回归基准；
合成数据覆盖了上升/下降/震荡/跳空/双底等典型形态，能触发绝大多数分支。
"""
from __future__ import annotations

import json
import math
import os
import sys


def make_series(seed: int, n: int, mode: str) -> list[dict]:
    """确定性伪随机 K 线生成器（与 TS 端 makeSeries 保持逐位一致）。"""
    state = seed & 0xFFFFFFFF

    def rnd() -> float:
        nonlocal state
        # xorshift32，Python 与 JS 位运算结果一致
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        return state / 4294967296.0

    klines = []
    price = 20.0
    for i in range(n):
        if mode == "up":
            drift = 0.0035
        elif mode == "down":
            drift = -0.0030
        elif mode == "shock":
            drift = 0.010 if (i // 20) % 2 == 0 else -0.010
        else:
            drift = 0.0
        noise = (rnd() - 0.5) * 0.03
        price = max(1.0, price * (1 + drift + noise))
        rng = price * (0.008 + rnd() * 0.02)
        open_ = price - rng * (rnd() - 0.5)
        close = price
        high = max(open_, close) + rng * rnd()
        low = min(open_, close) - rng * rnd()
        vol = 50000 + math.floor(rnd() * 150000)
        k = {
            "date": f"{2023 + i // 250}-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}",
            "open": round(open_, 3),
            "close": round(close, 3),
            "high": round(high, 3),
            "low": round(low, 3),
            "volume": float(vol),
            "amount": round(close * vol * 100, 2),
            "pct": 0.0,
            "turnover": round(rnd() * 5, 2),
        }
        if klines:
            prev = klines[-1]["close"]
            k["pct"] = round((k["close"] - prev) / prev * 100, 2)
        klines.append(k)
    return klines


def make_flows(seed: int, n: int) -> list[dict]:
    state = seed & 0xFFFFFFFF

    def rnd() -> float:
        nonlocal state
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        return state / 4294967296.0

    flows = []
    for i in range(n):
        base = (rnd() - 0.45) * 2e8
        flows.append({
            "date": f"2025-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}",
            "main_net": round(base, 2),
            "small_net": round(base * -0.3, 2),
            "medium_net": round(base * -0.2, 2),
            "large_net": round(base * 0.4, 2),
            "super_large_net": round(base * 0.6, 2),
            "main_pct": round((rnd() - 0.5) * 10, 2),
        })
    return flows


CASES = [
    ("up250", 12345, 250, "up"),
    ("down250", 777, 250, "down"),
    ("flat250", 20240101, 250, "flat"),
    ("shock250", 98765, 250, "shock"),
    ("up120", 555, 120, "up"),
    ("short60", 4242, 60, "up"),
]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = os.path.abspath(sys.argv[1])
    out_path = sys.argv[2] if len(sys.argv) > 2 else "tests/golden.json"

    sys.path.insert(0, root)
    libs = os.path.join(root, "libs")
    if os.path.isdir(libs):
        sys.path.insert(0, libs)

    from data.kline_fetcher import Kline, Quote, FundFlow  # noqa: E402
    from analysis.trend_module import analyze_trend  # noqa: E402
    from analysis.volume_price_module import analyze_volume_price  # noqa: E402
    from analysis.pattern_module import analyze_patterns  # noqa: E402
    from analysis.breakout_module import analyze_breakout  # noqa: E402
    from analysis.canslim_module import analyze_canslim  # noqa: E402
    from analysis.signal_engine import run_analysis  # noqa: E402
    from analysis.chanlun_daily import analyze_chanlun_daily, daily_result_to_dict  # noqa: E402

    golden: dict = {"cases": {}}

    for name, seed, n, mode in CASES:
        raw = make_series(seed, n, mode)
        klines = [Kline(**{k: v for k, v in r.items()}) for r in raw]
        idx_raw = make_series(31337, 60, "up")
        index_klines = [Kline(**{k: v for k, v in r.items()}) for r in idx_raw]
        flows_raw = make_flows(seed + 1, 30)
        flows = [FundFlow(date=f["date"], main_net=f["main_net"],
                          super_large_net=f["super_large_net"], large_net=f["large_net"],
                          medium_net=f["medium_net"], small_net=f["small_net"],
                          main_pct=f["main_pct"]) for f in flows_raw]
        last = klines[-1]
        quote = Quote(symbol="000000", name="TEST", price=last.close, pct=last.pct,
                      change=0.0, high=last.high, low=last.low, open=last.open,
                      pre_close=klines[-2].close, volume=last.volume,
                      amount=last.amount, turnover=last.turnover)

        trend = analyze_trend(klines)
        vp = analyze_volume_price(klines, quote, flows)
        patterns = analyze_patterns(klines)
        breakouts = analyze_breakout(klines)
        canslim = analyze_canslim(klines, quote, flows, index_klines)
        engine = run_analysis(klines, quote, flows, index_klines)
        chan = daily_result_to_dict(analyze_chanlun_daily(
            [k.date for k in klines], [k.open for k in klines], [k.close for k in klines],
            [k.high for k in klines], [k.low for k in klines], [k.volume for k in klines]))

        golden["cases"][name] = {
            "input": {"seed": seed, "n": n, "mode": mode,
                      "klines": raw, "flows": flows_raw,
                      "index": idx_raw},
            "trend": {"direction": trend.direction, "strength": trend.strength,
                      "stage": trend.stage, "ma_scores": trend.ma_scores,
                      "trendline": trend.trendline, "signals": trend.signals},
            "volume_price": {"pattern": vp.pattern, "direction": vp.direction,
                             "confidence": vp.confidence, "volume_ratio": vp.volume_ratio,
                             "obv_trend": vp.obv_trend, "signals": vp.signals},
            "patterns": [{"name": p.name, "direction": p.direction, "confidence": p.confidence,
                          "status": p.status, "target_price": p.target_price,
                          "key_levels": p.key_levels} for p in patterns],
            "breakouts": [{"system": b.system, "signal": b.signal, "current_n": b.current_n,
                           "stop_loss": b.stop_loss, "entry_price": b.entry_price,
                           "position_units": b.position_units, "channel_high": b.channel_high,
                           "channel_low": b.channel_low, "next_add_price": b.next_add_price}
                          for b in breakouts],
            "canslim": {"c": canslim.c_score, "a": canslim.a_score, "n": canslim.n_score,
                        "s": canslim.s_score, "l": canslim.l_score, "i": canslim.i_score,
                        "m": canslim.m_score, "total": canslim.total, "grade": canslim.grade,
                        "cup_handle": canslim.cup_handle, "signals": canslim.signals},
            "engine_legacy": {"action": engine.action, "score": engine.score,
                              "confidence": engine.confidence, "risk_level": engine.risk_level,
                              "module_scores": engine.module_scores,
                              "buy_signals": engine.buy_signals,
                              "sell_signals": engine.sell_signals,
                              "trade_plan": engine.trade_plan,
                              "key_levels": engine.key_levels},
            "chanlun_daily": {"merged_count": chan["merged_count"],
                              "fractal_count": chan["fractal_count"],
                              "stroke_count": chan["stroke_count"],
                              "zhongshu_count": chan["zhongshu_count"],
                              "signals": chan["signals"],
                              "strokes": chan["strokes"]},
        }

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False, indent=1)
    print(f"wrote {out_path}: {len(golden['cases'])} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
