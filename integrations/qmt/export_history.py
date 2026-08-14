#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从迅投 QMT 导出历史日线，供 backtest/ 使用。

为什么要用 QMT 的数据而不是网络接口：
  1. 前复权口径统一，且带停牌/退市标记，回测结果才有意义
  2. 免费网络接口的历史数据经常缺失除权处理，会凭空造出跳空
  3. QMT 数据与你未来实盘下单的数据源一致，避免「回测一套、实盘一套」

运行环境：Windows + miniQMT 已登录（QMT 客户端需保持运行）

用法：
    python export_history.py --start 20200101 --top 300
    python export_history.py --codes 600519.SH,000858.SZ --start 20180101

产出：
    backtest/data/<code>.csv        个股日线
    backtest/data/name-map.json     代码→名称（ST 判定需要）
    backtest/benchmark.csv          沪深300 指数

注意：本脚本按 QMT 2024 年的 xtquant 接口编写。迅投会调整 API，
若报错请对照你本地 xtquant 版本的文档核对参数名。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backtest', 'data')
BENCH_PATH = os.path.join(OUT_DIR, '..', 'benchmark.csv')

FIELDS = ['open', 'high', 'low', 'close', 'volume', 'amount']


def die(msg: str) -> None:
    print(f'[错误] {msg}', file=sys.stderr)
    sys.exit(1)


def load_xtdata():
    try:
        from xtquant import xtdata  # type: ignore
        return xtdata
    except ImportError:
        die('未找到 xtquant。请确认：\n'
            '  1. 已安装 QMT 客户端，并在「设置 → 模型交易 → Python」中启用\n'
            '  2. 用 QMT 自带的 Python 运行本脚本，或 pip install xtquant\n'
            '  3. QMT 客户端处于登录状态')


def pick_universe(xtdata, args) -> list[str]:
    """选股票池：显式指定 > 板块成分 > 按成交额取前 N。"""
    if args.codes:
        return [c.strip() for c in args.codes.split(',') if c.strip()]

    sector = args.sector or '沪深A股'
    codes = xtdata.get_stock_list_in_sector(sector)
    if not codes:
        die(f'板块「{sector}」为空。可先运行 xtdata.get_sector_list() 查看可用板块名')

    # 剔除 ST、退市、北交所（涨跌幅30%规则不同，单独回测更稳妥）
    keep = []
    for c in codes:
        try:
            d = xtdata.get_instrument_detail(c) or {}
        except Exception:
            d = {}
        name = d.get('InstrumentName', '') or ''
        if 'ST' in name or '退' in name:
            continue
        if c.endswith('.BJ'):
            continue
        keep.append(c)

    if not args.top or args.top >= len(keep):
        return keep

    # 按最近一段成交额排序取前 N —— 与线上 /api/scan 的选池口径保持一致
    print(f'按成交额筛选前 {args.top} 只（共 {len(keep)} 只候选）...')
    xtdata.download_history_data2(keep, period='1d', start_time=args.rank_start, end_time='')
    data = xtdata.get_market_data_ex(
        ['amount'], keep, period='1d', start_time=args.rank_start, end_time='', dividend_type='none')
    ranked = []
    for c in keep:
        df = data.get(c)
        if df is None or len(df) == 0:
            continue
        try:
            ranked.append((float(df['amount'].tail(20).mean()), c))
        except Exception:
            continue
    ranked.sort(reverse=True)
    return [c for _, c in ranked[:args.top]]


def write_csv(path: str, df) -> int:
    rows = 0
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write('date,open,high,low,close,volume,amount\n')
        for idx, row in df.iterrows():
            # xtdata 的索引为 'YYYYMMDD' 字符串
            date = str(idx)
            try:
                o, h, l, c = float(row['open']), float(row['high']), float(row['low']), float(row['close'])
                v = float(row.get('volume', 0) or 0)
                a = float(row.get('amount', 0) or 0)
            except Exception:
                continue
            # 停牌日 QMT 返回 0，保留为 0 让回测引擎识别为停牌
            if c <= 0:
                continue
            f.write(f'{date},{o:.4f},{h:.4f},{l:.4f},{c:.4f},{v:.0f},{a:.0f}\n')
            rows += 1
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='20200101', help='起始日 YYYYMMDD')
    ap.add_argument('--end', default='', help='结束日，空为至今')
    ap.add_argument('--codes', default='', help='逗号分隔的代码，如 600519.SH,000858.SZ')
    ap.add_argument('--sector', default='沪深A股')
    ap.add_argument('--top', type=int, default=200, help='按成交额取前 N 只，0 为全部')
    ap.add_argument('--rank-start', default='20240101', help='排序用的成交额统计起点')
    ap.add_argument('--benchmark', default='000300.SH', help='基准指数代码')
    args = ap.parse_args()

    xtdata = load_xtdata()
    os.makedirs(OUT_DIR, exist_ok=True)

    codes = pick_universe(xtdata, args)
    print(f'股票池 {len(codes)} 只，下载 {args.start} 起的日线...')

    # download_history_data2 是补数据到本地，get_market_data_ex 才是读取
    xtdata.download_history_data2(codes, period='1d', start_time=args.start, end_time=args.end)
    # dividend_type='front' = 前复权，必须与线上 /api/kline 的 fqt=1 口径一致
    data = xtdata.get_market_data_ex(
        FIELDS, codes, period='1d',
        start_time=args.start, end_time=args.end, dividend_type='front')

    name_map: dict[str, str] = {}
    ok = 0
    for c in codes:
        df = data.get(c)
        if df is None or len(df) < 60:
            continue
        code_plain = c.split('.')[0]
        n = write_csv(os.path.join(OUT_DIR, f'{code_plain}.csv'), df)
        if n < 60:
            continue
        try:
            detail = xtdata.get_instrument_detail(c) or {}
            name_map[code_plain] = detail.get('InstrumentName', code_plain)
        except Exception:
            name_map[code_plain] = code_plain
        ok += 1
        if ok % 25 == 0:
            print(f'  已导出 {ok} 只...')

    with open(os.path.join(OUT_DIR, 'name-map.json'), 'w', encoding='utf-8') as f:
        json.dump(name_map, f, ensure_ascii=False, indent=1)

    # 基准
    xtdata.download_history_data2([args.benchmark], period='1d', start_time=args.start, end_time=args.end)
    bench = xtdata.get_market_data_ex(
        FIELDS, [args.benchmark], period='1d',
        start_time=args.start, end_time=args.end, dividend_type='none')
    bdf = bench.get(args.benchmark)
    if bdf is not None and len(bdf):
        write_csv(os.path.abspath(BENCH_PATH), bdf)
        print(f'基准 {args.benchmark} → {os.path.abspath(BENCH_PATH)}')

    print(f'\n完成：{ok} 只标的写入 {os.path.abspath(OUT_DIR)}')
    print('\n下一步：')
    print('  npm run bt -- run --data backtest/data --benchmark backtest/benchmark.csv')
    print('  npm run bt:wf -- --data backtest/data --benchmark backtest/benchmark.csv')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
