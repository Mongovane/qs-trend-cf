# -*- coding: utf-8 -*-
"""
PTrade 策略：趋势信号执行器（模拟盘 / 实盘）

═══ 职责划分（请先读这一段）═══

本文件**只负责执行**，不重新实现评分逻辑。原因见 docs/MIGRATION.md D1：
同一套策略维护两份实现，必然会分叉，最后你不知道该信哪个。

  · 历史回测  → 用仓库里的 TypeScript 回测器：`npm run bt`
                （与线上看板共用同一份分析引擎，逐字段一致）
  · 模拟/实盘 → 用本文件，从线上 Cloudflare 接口拉信号后下单

因此本策略在 PTrade 的**回测模式下会拒绝运行**（回测环境无外网）。
如果你确实想在 PTrade 里回测，请把 backtest/ 的结论作为参数来源，
再用 PTrade 自带的因子回测另行验证 —— 两套独立实现互相印证，
比在同一套代码里自我验证可信得多。

═══ 部署 ═══

1. PTrade → 交易 → 新建策略，把本文件内容粘贴进去
2. 修改下方 CONFIG 里的 API_BASE 为你的 Pages 域名
3. 先用**模拟账号**运行，观察至少一个月
4. 每个交易日 09:35 与 14:50 各执行一次调仓

⚠ PTrade 各券商版本 API 略有差异（尤其 get_history 的 fq 参数与
  order_target_value 的行为）。首次运行请开日志逐行核对。
⚠ 自动化交易后果由使用者自行承担。
"""

import json
import datetime

try:
    import urllib.request as urlreq
except ImportError:
    import urllib2 as urlreq  # PTrade 老版本可能是 Python 2

# ══════════════════════ 配置 ══════════════════════
CONFIG = {
    # 你的 Cloudflare Pages 域名
    'API_BASE': 'https://qs-trend-cf.pages.dev',

    # 组合约束
    'MAX_POSITIONS': 5,          # 最大持仓只数
    'PER_POSITION': 0.18,        # 单票目标权重
    'CASH_RESERVE': 0.05,        # 最低保留现金比例

    # 信号门槛 —— 这几个值应当来自 backtest 的样本外检验结果，
    # 不要凭感觉调。默认值只是回测默认参数，未经你自己的数据验证。
    'MIN_SCORE': 62,             # 建仓最低分
    'EXIT_SCORE': 45,            # 离场分数线（滞后带下沿）
    'MIN_HOLD_DAYS': 5,          # 最短持仓，期间不因信号退化离场
    'MAX_HOLD_DAYS': 60,         # 最长持仓

    # 风控
    'STOP_LOSS_PCT': 0.08,       # 兜底止损（接口未给止损价时使用）
    'USE_PLAN_STOP': True,       # 优先使用接口返回的 trade_plan.stop_loss

    # 基准
    'BENCHMARK': '000300.SS',

    # 安全开关：True 时只写日志不下单
    'DRY_RUN': True,
}


# ══════════════════════ 工具 ══════════════════════

def _http_get(url, timeout=25):
    """PTrade 环境的 HTTP GET。回测环境会抛异常，正是我们想要的。"""
    req = urlreq.Request(url, headers={'User-Agent': 'ptrade-qs/1.0'})
    resp = urlreq.urlopen(req, timeout=timeout)
    raw = resp.read()
    if isinstance(raw, bytes):
        raw = raw.decode('utf-8')
    return json.loads(raw)


def to_ptrade_code(code):
    """六位代码 → PTrade 格式。注意 PTrade 上交所用 .SS，而 QMT 用 .SH。"""
    c = str(code).split('.')[0].zfill(6)
    if c[0] in ('5', '6', '9'):
        return c + '.SS'
    return c + '.SZ'


def signal_direction(action):
    """与前后端一致的方向归一。切勿用字符串全等 —— 优化器输出多种买入变体。"""
    a = action or ''
    if '卖出' in a:
        return 'sell'
    if '买入' in a:
        return 'buy'
    if '观望' in a:
        return 'watch'
    return 'other'


# ══════════════════════ PTrade 生命周期 ══════════════════════

def initialize(context):
    g.cfg = CONFIG
    g.entry_info = {}      # code -> {'date':..., 'stop':..., 'bars':int}
    g.last_fetch = None
    g.signals = []
    g.is_backtest = False

    set_benchmark(g.cfg['BENCHMARK'])
    # 费用设置成和 backtest/src/market.ts 一致，否则两边结果无法对账
    set_commission(commission_ratio=0.00025, min_commission=5.0, type='STOCK')
    set_slippage(slippage=0.002)

    # 回测环境探测：拉一次接口，失败即判定为回测并停止
    try:
        _http_get(g.cfg['API_BASE'] + '/api/health', timeout=8)
    except Exception as e:
        g.is_backtest = True
        log.warning('无法访问信号接口（%s）。' % e)
        log.warning('本策略只用于模拟盘/实盘执行；历史回测请使用仓库中的 npm run bt。')

    run_daily(context, morning_rebalance, time='09:35')
    run_daily(context, afternoon_risk_check, time='14:50')
    log.info('初始化完成  DRY_RUN=%s  最大持仓=%d' % (g.cfg['DRY_RUN'], g.cfg['MAX_POSITIONS']))


def before_trading_start(context, data):
    if g.is_backtest:
        return
    # 每日刷新一次信号
    try:
        g.signals = fetch_scan_results()
        log.info('取得候选信号 %d 条' % len(g.signals))
    except Exception as e:
        g.signals = []
        log.error('拉取信号失败: %s' % e)


def handle_data(context, data):
    # 全部逻辑放在 run_daily 的定时任务里，避免逐 bar 重复下单
    pass


def after_trading_end(context, data):
    for code in list(g.entry_info.keys()):
        pos = context.portfolio.positions.get(code)
        if not pos or pos.amount <= 0:
            g.entry_info.pop(code, None)
        else:
            g.entry_info[code]['bars'] = g.entry_info[code].get('bars', 0) + 1

    pv = context.portfolio.portfolio_value
    log.info('收盘 权益=%.0f 现金=%.0f 持仓=%d'
             % (pv, context.portfolio.cash, len([1 for p in context.portfolio.positions.values() if p.amount > 0])))


# ══════════════════════ 信号 ══════════════════════

def fetch_scan_results():
    """读取线上扫描结果。需先在网页触发过一次扫描。"""
    base = g.cfg['API_BASE'].rstrip('/')
    data = _http_get(base + '/api/scan?action=status')
    if data.get('status') != 'done':
        log.info('线上扫描未完成（status=%s progress=%s），本日不新增建仓'
                 % (data.get('status'), data.get('progress')))
        return []
    out = []
    for r in data.get('results') or []:
        action = r.get('daily_action') or r.get('action') or ''
        if signal_direction(action) != 'buy':
            continue
        score = r.get('combined_score') or r.get('daily_score') or 0
        out.append({
            'code': to_ptrade_code(r.get('symbol')),
            'name': r.get('name', ''),
            'score': score,
            'action': action,
            'position_advice': r.get('position_advice', ''),
        })
    out.sort(key=lambda x: -x['score'])
    return out


def fetch_single(code6):
    base = g.cfg['API_BASE'].rstrip('/')
    return _http_get(base + '/api/analyze?symbol=%s' % code6)


# ══════════════════════ 调仓 ══════════════════════

def morning_rebalance(context, data):
    if g.is_backtest:
        return
    sell_check(context, data)
    buy_new(context, data)


def afternoon_risk_check(context, data):
    """尾盘只做风控离场，不新建仓 —— 避免尾盘冲高后接盘。"""
    if g.is_backtest:
        return
    sell_check(context, data)


def sell_check(context, data):
    cfg = g.cfg
    for code, pos in list(context.portfolio.positions.items()):
        if pos.amount <= 0:
            continue
        enable = getattr(pos, 'enable_amount', pos.amount)
        if enable <= 0:
            continue          # T+1：当日买入不可卖

        px = _last_price(data, code, pos)
        if px is None or px <= 0:
            continue

        info = g.entry_info.get(code, {})
        held = info.get('bars', 0)
        stop = info.get('stop', 0)
        reason = None

        if stop and px <= stop:
            reason = '止损 %.2f' % stop
        elif cfg['MAX_HOLD_DAYS'] and held >= cfg['MAX_HOLD_DAYS']:
            reason = '持仓到期 %d 日' % held
        elif held >= cfg['MIN_HOLD_DAYS']:
            # 滞后带：只有跌破 EXIT_SCORE 才离场。
            # 用 MIN_SCORE 同一个门槛做进出，会导致评分在阈值附近抖动
            # 时反复买卖，费用直接吃掉全部收益（回测中 90% 交易属此类）。
            sc = _current_score(code)
            if sc is not None and sc < cfg['EXIT_SCORE']:
                reason = '信号退化 %d 分' % sc

        if reason:
            log.info('卖出 %s %s（%s）' % (code, getattr(pos, 'name', ''), reason))
            if not cfg['DRY_RUN']:
                order_target(code, 0)
            g.entry_info.pop(code, None)


def buy_new(context, data):
    cfg = g.cfg
    holding = [c for c, p in context.portfolio.positions.items() if p.amount > 0]
    slots = cfg['MAX_POSITIONS'] - len(holding)
    if slots <= 0:
        return

    pv = context.portfolio.portfolio_value
    usable = context.portfolio.cash - pv * cfg['CASH_RESERVE']
    target_value = pv * cfg['PER_POSITION']

    for s in g.signals:
        if slots <= 0 or usable < target_value * 0.5:
            break
        code = s['code']
        if code in holding:
            continue
        if s['score'] < cfg['MIN_SCORE']:
            continue

        px = _last_price(data, code, None)
        if px is None or px <= 0:
            log.info('跳过 %s：无行情' % code)
            continue

        # 涨停不追。PTrade 的 data[code] 通常带 high_limit
        hl = _attr(data, code, 'high_limit')
        if hl and px >= hl - 0.001:
            log.info('跳过 %s：已涨停' % code)
            continue

        # 仓位系数跟随优化器建议
        adv = s.get('position_advice', '')
        factor = 1.0
        if '空仓' in adv:
            continue
        elif '轻仓' in adv:
            factor = 0.25
        elif '半仓' in adv:
            factor = 0.5
        value = min(target_value * factor, usable)
        if value < px * 100:
            continue

        stop = px * (1 - cfg['STOP_LOSS_PCT'])
        if cfg['USE_PLAN_STOP']:
            try:
                a = fetch_single(code.split('.')[0])
                plan = ((a or {}).get('signal') or {}).get('trade_plan') or {}
                ps = plan.get('stop_loss') or 0
                if 0 < ps < px:
                    stop = ps
            except Exception:
                pass

        log.info('买入 %s %s 目标金额 %.0f  [%s %d分] 止损 %.2f'
                 % (code, s.get('name', ''), value, s['action'], s['score'], stop))
        if not cfg['DRY_RUN']:
            order_target_value(code, value)
        g.entry_info[code] = {
            'date': str(context.blotter.current_dt.date()
                        if hasattr(context, 'blotter') else datetime.date.today()),
            'stop': stop, 'bars': 0,
        }
        usable -= value
        slots -= 1


# ══════════════════════ 辅助 ══════════════════════

def _attr(data, code, key):
    try:
        d = data[code]
        v = getattr(d, key, None)
        if v is None and hasattr(d, '__getitem__'):
            v = d[key]
        return float(v) if v else None
    except Exception:
        return None


def _last_price(data, code, pos):
    px = _attr(data, code, 'last_price') or _attr(data, code, 'close')
    if px:
        return px
    try:
        return float(get_price(code, count=1, frequency='1d', fields=['close'])['close'][-1])
    except Exception:
        return getattr(pos, 'last_sale_price', None) if pos else None


_score_cache = {}


def _current_score(code):
    """查单票当前评分，同一交易日内缓存，避免频繁打接口。"""
    today = str(datetime.date.today())
    key = (code, today)
    if key in _score_cache:
        return _score_cache[key]
    try:
        a = fetch_single(code.split('.')[0])
        sc = ((a or {}).get('signal') or {}).get('score')
        sc = int(sc) if sc is not None else None
    except Exception:
        sc = None
    _score_cache[key] = sc
    return sc
