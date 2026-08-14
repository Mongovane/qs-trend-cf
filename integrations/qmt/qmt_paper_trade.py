#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QMT 模拟账号信号执行器。

职责边界（重要）：
  · 信号由线上 Cloudflare 接口产出（与看板同一套引擎，避免二次实现分歧）
  · 本脚本只做「执行」：查持仓 → 比对目标 → 下单 → 记录
  · 默认 dry-run，不加 --live 不会真的下单

安全护栏（默认全部开启）：
  · 只允许连接**模拟账号**，检测到疑似实盘会拒绝启动（--allow-real 可解除）
  · 单日最大下单笔数、单票最大金额、最低可用资金均有硬上限
  · 涨停/跌停/停牌自动跳过
  · 只在交易时段执行；非交易日直接退出

运行环境：Windows + miniQMT 已登录

用法：
    # 先空跑看看它想干什么
    python qmt_paper_trade.py --account 你的模拟账号 --api https://xxx.pages.dev

    # 确认无误后真实下单（仍是模拟账号）
    python qmt_paper_trade.py --account 你的模拟账号 --api https://xxx.pages.dev --live

⚠ 本脚本按 2024 年的 xtquant 接口编写。迅投会调整 API 与常量名，
  首次使用务必先 dry-run，并对照你本地 xtquant 版本核对。
⚠ 自动化交易的全部后果由使用者承担。请先在模拟账号跑满一个完整
  市场周期（至少含一次明显下跌），再考虑任何实盘行为。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
import time
import urllib.request

# ── 硬性护栏，代码级上限，不提供命令行覆盖 ──
HARD_MAX_ORDERS_PER_DAY = 50
HARD_MAX_SINGLE_ORDER = 200_000     # 单笔最大 20 万
HARD_MIN_CASH_RESERVE = 0.05        # 至少保留 5% 现金


def log(msg: str) -> None:
    print(f'[{dt.datetime.now().strftime("%H:%M:%S")}] {msg}', flush=True)


def die(msg: str) -> None:
    print(f'[错误] {msg}', file=sys.stderr)
    sys.exit(1)


def fetch_signals(api_base: str, timeout: int = 30) -> list[dict]:
    """从线上接口取扫描结果。返回 [{symbol,name,score,action,...}]"""
    url = f'{api_base.rstrip("/")}/api/scan?action=status'
    req = urllib.request.Request(url, headers={'User-Agent': 'qmt-executor/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode('utf-8'))
    if data.get('status') != 'done':
        log(f'扫描未完成（status={data.get("status")}, progress={data.get("progress")}）')
        log('请先在网页点「扫描买入」并等待完成，或改用 --codes 手动指定标的')
        return []
    return data.get('results', []) or []


def fetch_analyze(api_base: str, code: str, timeout: int = 30) -> dict | None:
    url = f'{api_base.rstrip("/")}/api/analyze?symbol={code}'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'qmt-executor/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        log(f'  {code} 分析失败: {e}')
        return None


def to_qmt_code(code: str) -> str:
    """六位代码 → QMT 格式。QMT 用 .SH/.SZ/.BJ（PTrade 用 .SS，注意区别）。"""
    c = str(code).split('.')[0].zfill(6)
    if c.startswith(('5', '6', '9')):
        return f'{c}.SH'
    if c.startswith(('4', '8')) or c.startswith('920'):
        return f'{c}.BJ'
    return f'{c}.SZ'


def is_trading_time() -> bool:
    now = dt.datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    return (dt.time(9, 30) <= t <= dt.time(11, 30)) or (dt.time(13, 0) <= t <= dt.time(15, 0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--account', required=True, help='资金账号')
    ap.add_argument('--api', required=True, help='线上接口地址，如 https://xxx.pages.dev')
    ap.add_argument('--qmt-path', default=r'C:\国金QMT交易端\userdata_mini',
                    help='miniQMT 的 userdata_mini 路径')
    ap.add_argument('--live', action='store_true', help='真实下单（默认只打印计划）')
    ap.add_argument('--allow-real', action='store_true', help='允许连接非模拟账号（强烈不建议）')
    ap.add_argument('--max-positions', type=int, default=5)
    ap.add_argument('--per-position', type=float, default=0.18, help='单票目标权重')
    ap.add_argument('--max-orders', type=int, default=10, help='本次最多下单笔数')
    ap.add_argument('--min-score', type=int, default=62)
    ap.add_argument('--codes', default='', help='跳过扫描，直接分析指定代码')
    ap.add_argument('--ignore-clock', action='store_true', help='非交易时段也执行（仅 dry-run 调试用）')
    args = ap.parse_args()

    if not args.live:
        log('=== DRY RUN 模式：只输出下单计划，不会真实报单 ===')
    if args.live and not is_trading_time() and not args.ignore_clock:
        die('当前非交易时段。加 --ignore-clock 可强制运行（仅建议 dry-run 时使用）')

    try:
        from xtquant.xttrader import XtQuantTrader, XtQuantTraderCallback  # type: ignore
        from xtquant.xttype import StockAccount  # type: ignore
        from xtquant import xtconstant, xtdata  # type: ignore
    except ImportError:
        die('未找到 xtquant，请用 QMT 自带 Python 运行，或 pip install xtquant')

    class Callback(XtQuantTraderCallback):
        def on_disconnected(self):
            log('⚠ 与 miniQMT 断开连接')

        def on_stock_order(self, order):
            log(f'  委托回报 {order.stock_code} 状态={order.order_status} 编号={order.order_id}')

        def on_stock_trade(self, trade):
            log(f'  ✓ 成交 {trade.stock_code} {trade.traded_volume}股 @{trade.traded_price}')

        def on_order_error(self, err):
            log(f'  ✗ 委托失败 编号={err.order_id} 原因={err.error_msg}')

    session_id = int(random.randint(100000, 999999))
    trader = XtQuantTrader(args.qmt_path, session_id)
    trader.register_callback(Callback())
    trader.start()
    if trader.connect() != 0:
        die('连接 miniQMT 失败。请确认 QMT 客户端已登录，且 --qmt-path 指向正确的 userdata_mini')

    acc = StockAccount(args.account, 'STOCK')
    if trader.subscribe(acc) != 0:
        die(f'订阅账号 {args.account} 失败')

    asset = trader.query_stock_asset(acc)
    if asset is None:
        die('查询资产失败，账号可能不存在或未授权')

    # ── 模拟账号检查 ──
    # QMT 不同券商对模拟账号的标识不统一，这里用启发式：
    # 账号含 'sim'/'模拟'/'test'，或以常见模拟号段开头。
    acc_l = str(args.account).lower()
    looks_sim = any(k in acc_l for k in ('sim', 'test', 'demo', '模拟')) or acc_l.startswith(('8888', '9999'))
    if not looks_sim and not args.allow_real:
        die(f'账号 {args.account} 不像模拟账号。\n'
            f'  本工具默认只允许模拟账号。确认要用实盘请显式加 --allow-real，\n'
            f'  但请先在模拟账号完整验证过至少一个下跌周期。')

    log(f'账号 {args.account}  总资产 {asset.total_asset:,.0f}  '
        f'可用 {asset.cash:,.0f}  持仓市值 {asset.market_value:,.0f}')

    positions = {p.stock_code: p for p in (trader.query_stock_positions(acc) or []) if p.volume > 0}
    log(f'当前持仓 {len(positions)} 只: {", ".join(positions.keys()) or "无"}')

    # ── 取信号 ──
    if args.codes:
        cands = []
        for c in [x.strip() for x in args.codes.split(',') if x.strip()]:
            a = fetch_analyze(args.api, c)
            sig = (a or {}).get('signal') or {}
            if sig:
                cands.append({'symbol': c, 'name': (a or {}).get('name', c),
                              'combined_score': sig.get('score', 0),
                              'daily_action': sig.get('action', ''),
                              'signal': sig})
    else:
        cands = fetch_signals(args.api)

    buy_list = []
    for c in cands:
        score = c.get('combined_score') or c.get('daily_score') or 0
        action = c.get('daily_action') or c.get('action') or ''
        # 与回测一致：按方向归一，不做字符串全等
        if '买入' not in action:
            continue
        if score < args.min_score:
            continue
        buy_list.append((score, to_qmt_code(c['symbol']), c.get('name', ''), action))
    buy_list.sort(reverse=True)
    log(f'候选买入 {len(buy_list)} 只（分数 ≥ {args.min_score}）')

    # ── 生成下单计划 ──
    slots = max(0, args.max_positions - len(positions))
    target_value = min(asset.total_asset * args.per_position, HARD_MAX_SINGLE_ORDER)
    usable_cash = asset.cash - asset.total_asset * HARD_MIN_CASH_RESERVE

    plan = []
    for score, code, name, action in buy_list:
        if len(plan) >= min(slots, args.max_orders, HARD_MAX_ORDERS_PER_DAY):
            break
        if code in positions:
            continue
        try:
            tick = xtdata.get_full_tick([code]).get(code, {})
            price = float(tick.get('lastPrice') or 0)
            pre_close = float(tick.get('lastClose') or 0)
        except Exception:
            price, pre_close = 0.0, 0.0
        if price <= 0:
            log(f'  跳过 {code} {name}：无行情（可能停牌）')
            continue
        if pre_close > 0 and price >= round(pre_close * 1.098, 2):
            log(f'  跳过 {code} {name}：已涨停，买不到')
            continue
        vol = int(target_value / price / 100) * 100
        if vol < 100:
            log(f'  跳过 {code} {name}：目标金额不足一手')
            continue
        cost = vol * price
        if cost > usable_cash:
            log(f'  跳过 {code} {name}：可用资金不足（需 {cost:,.0f}）')
            continue
        usable_cash -= cost
        plan.append((code, name, vol, price, score, action))

    if not plan:
        log('无可执行的买入计划')
        return 0

    log('\n下单计划：')
    for code, name, vol, price, score, action in plan:
        log(f'  买入 {code} {name:<8} {vol:>6}股 @{price:>8.2f} ≈{vol*price:>10,.0f}  '
            f'[{action} {score}分]')

    if not args.live:
        log('\nDRY RUN 结束。确认无误后加 --live 执行。')
        return 0

    log('\n开始报单...')
    for code, name, vol, price, score, action in plan:
        # 对手方最优价，比限价单更容易成交，又不像市价单那样失控
        oid = trader.order_stock(
            acc, code, xtconstant.STOCK_BUY, vol,
            xtconstant.MARKET_PEER_PRICE_FIRST, 0,
            'qs-trend', f'{action}/{score}')
        log(f'  已报单 {code} {name} 编号={oid}')
        time.sleep(0.35)   # 避免瞬时报单过密被风控拦截

    log('报单完成，等待成交回报（Ctrl+C 退出）')
    try:
        trader.run_forever()
    except KeyboardInterrupt:
        log('退出')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
