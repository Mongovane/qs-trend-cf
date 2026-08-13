# v4.0 原项目分析报告

> 分析对象：`趋势分析实时买卖点工具-v4_0-发行版.zip`（113 个文件，9627 行有效代码）
> 分析方式：逐文件通读源码 + 用原版模块跑合成数据验证行为

---

## 一、文件清单

| 层 | 文件 | 行数 | 性质 |
|---|---|---|---|
| 启动器 | `launcher.py` | 299 | 端口清理 → 许可证校验 → 拉起 app.py → 开浏览器 |
| API | `app.py` | 939 | `ThreadingHTTPServer` :8795，10 个 API + 静态文件服务 |
| 数据 | `data/kline_fetcher.py` | 1068 | 腾讯/新浪/东财三源 fallback |
| 授权 | `license_core.py` | 436 | secp256k1 ECDSA 验签 + Windows 硬件指纹 |
| 授权 | `gen_license.py` | 251 | 卖家侧签发工具 |
| 分析 | `analysis/signal_engine.py` | 433 | 五模块聚合 |
| 分析 | `analysis/chanlun_daily.py` | 547 | 缠论日线 |
| 分析 | `analysis/chanlun_minute.py` | 412 | 缠论分钟 |
| 分析 | `analysis/canslim_module.py` | 368 | CAN SLIM 七维 |
| 分析 | `analysis/pattern_module.py` | 378 | 七种形态识别 |
| 分析 | `analysis/breakout_module.py` | 167 | 海龟交易法则 |
| 分析 | `analysis/volume_price_module.py` | 216 | 量价 + OBV |
| 分析 | `analysis/trend_module.py` | 200 | 趋势 + 趋势线 |
| 分析 | `analysis/_indicators.py` | 141 | 共享指标库 |
| 前端 | `dashboard/index.html` | 3434 | 单文件 vanilla JS + ECharts 5.5 |
| 前端 | `dashboard/activate.html` | 337 | 激活页 |
| 依赖 | `libs/` | ~1.2 MB | requests / urllib3 / certifi / idna / charset_normalizer |

**关键发现**：`analysis/` 全部为**纯 Python 标准库实现**，不依赖 numpy/pandas。
这是本次能够 1:1 移植到 TypeScript 的根本前提——若用了 numpy，工作量会是数倍。

---

## 二、核心调用链

```
GET /api/analyze?symbol=600519&period=day
  │
  ├─ fetch_kline(250, day)          腾讯前复权 → 新浪 → 东财；再用东财补 amount/turnover
  ├─ fetch_quote(symbol)            东财 stock/get, fltt=2
  ├─ fetch_fund_flow(symbol, 30)    东财 fflow/daykline
  ├─ fetch_index_kline("000001",60) 上证指数，供 CANSLIM 的 M 维度
  ├─ fetch_market_breadth()         全市场涨跌家数（59 页并发）
  │
  ├─ run_analysis()                 五模块加权
  │    综合分     = 趋势×25% + CANSLIM×20% + 突破×20% + 量价×20% + 形态×15%（int 截断）
  │    action    = ≥75 强烈买入 / ≥60 买入 / 否则观望
  │    confidence= max(10, int(score×0.8) + 12×达标模块数 − 40)
  │
  ├─ M 分修正                       breadth_ratio 分六档 → m_score ±15
  └─ _apply_signal_optimization()   硬否决 → 软否决 → 五级重评 → M分仓位 → 盈亏比
```

值得注意的是：**第 6~7 步的后处理写在 API 层而非分析层**。原因是 v4.0 的
`analysis/` 曾被 PyArmor 加密，无法修改内部逻辑，只能在外部做补丁。
本次重构保留了相同的执行顺序（`src/analysis/optimizer.ts`），以保证输出一致。

---

## 三、各模块算法还原

### 3.1 趋势模块

`strength` = 五个子项之和，满分 100：

| 子项 | 分值 | 条件 |
|---|---|---|
| `ma20_dir` | 30 | MA20 方向向上（近 5 日斜率 > 基准 0.2%） |
| `ma60_dir` | 25 | MA60 方向向上 |
| `price_vs_ma20` | 15 | 收盘价 > MA20 |
| `price_vs_ma60` | 10 | 收盘价 > MA60（60 日决策线） |
| `resonance` | 20 | 近 20 日涨幅 > 0 |

`direction` 判定只看 MA20：价 > MA20 且 MA20 向上 = 上升；价 < MA20 且 MA20 非向上 = 下降；其余震荡。

### 3.2 量价模块

八象限分类：价格看 8 日涨跌（±2% 阈值），量能看近 3 日均量 vs 前 5 日均量（±30% 阈值）。

| 模式 | 基础置信度 |
|---|---|
| 价涨量增 | 80 |
| 价跌量增 | 75 |
| 价涨量缩 / 价跌量缩 | 60 |
| 价涨量平 | 55 |
| 价平量增 / 价跌量平 | 50 |
| 价平量缩 | 35 |
| 价平量平 | 20 |

再叠加量比修正（−3 ~ +12）与资金流修正（−15 ~ +15），裁剪到 [5, 95]。

### 3.3 突破模块（海龟法则）

```
TR = max(H−L, |H−PDC|, |L−PDC|)
N  = 前 20 日 TR 的 SMA
止损 = 入场价 − 2N（多头）/ 入场价 + 2N（空头）
加仓 = 每上涨 0.5N 加 1 单位，系统一最多 4 次，系统二不加仓
```

系统一用 20 日唐奇安通道 + 10 日高点离场；系统二用 55 日通道 + 20 日高点离场。

### 3.4 CAN SLIM

加权：`C15% + A10% + N25% + S5% + L20% + I15% + M10%`，`int()` 截断。

| 维度 | 数据来源 | 备注 |
|---|---|---|
| C 近期动量 | 20 日 / 5 日涨幅取较大分档 | |
| A 中期趋势 | 120 日涨幅分档 | 需 ≥125 根 |
| N 新高形态 | 距 250 日高点距离 + 杯柄突破 | 突破 120 日高点直接给 100 |
| S 供需 | 量比 | 基准 40 分，浮动很小 |
| L 领涨强度 | 60 日涨幅基础分 + 250 日涨幅奖罚 | |
| I 机构资金 | 主力资金流（**非真实机构持仓**） | 见下方局限性 |
| M 大盘环境 | 上证指数 MA20/MA60 + 上涨天数 | 无指数时回退个股均线 |

### 3.5 缠论

日线与分钟线共用同一套管线：合并 K 线（包含关系按方向取极值）→ 分型 →
笔（端点合并索引差 ≥ 4）→ 中枢（相邻两笔重叠区间）→ MACD 面积背驰 → 一/二/三类买卖点。

MACD 使用 **SMA 种子的 EMA**（EMA12 在索引 12 前恒为 SMA12），这与
通达信默认口径一致，但与标准 MACD（首值即为首个收盘价）不同。移植时已完整保留。

---

## 四、缺陷清单

以下问题在通读源码时发现，均已在 `enhanced` 档位修复；`legacy` 档位原样保留。

### P1 · 三角形形态检测器恒不触发 【已修复】

```python
# pattern_module.py:364
lambda ks: _detect_triangle(window20, price),   # 只传了 20 根

# pattern_module.py:243
def _detect_triangle(klines, price):
    if len(klines) < 30:      # 却要求至少 30 根
        return None           # → 永远返回 None
```

**影响**：形态模块永久少一个检测器，对称/上升/下降三角形从未被识别过，
形态分被系统性低估。修复后改为传入 60 根窗口（市面主流为 30~60 根）。

**验证**：合成的下降行情样本中，修复后成功识别出「下降三角形」并挤掉了
优先级更低的「箱体震荡」，模块分从 49 变为 37——**这说明该缺陷确实一直在
影响真实评分**。

### P2 · CANSLIM M 维度变量重复赋值 【已清理】

```python
# canslim_module.py:202-209
if not index_klines or len(index_klines) < 30:
    src = stock_klines          # 第一次赋值
    src_name = "个股均线(近似)"
else:
    src = index_klines
    src_name = "大盘指数"
src = index_klines if index_klines and len(index_klines) >= 30 else stock_klines  # 又赋一次
```

当前两次赋值结果等价，无实际 bug，但属于危险写法——后续若修改第一个分支
的条件，`src` 与 `src_name` 会静默失配。已合并为单次判定。

### P3 · 圆弧底左侧单调判定漏检 【已修复】

```python
# pattern_module.py:219
left_desc = all(left[i] >= left[i+1] for i in range(len(left) - 2) if left[i] > 0)
#                                                            ^^^ 应为 len(left) - 1
```

少检查最后一对相邻点，会把「左侧最后一段掉头向上」的形态误判为合格圆弧底。

### P4 · DNS 劫持 【架构性改造】

```python
# kline_fetcher.py:39
_PUSH2DELAY_IP = "117.184.45.167"
socket.getaddrinfo = _patched_getaddrinfo   # 把 push2his 强行解析到硬编码 IP
```

两个问题：其一，IP 硬编码，东财换 CDN 即失效；其二，Workers 的 `fetch`
无法覆写 DNS。改为把 `push2delay.eastmoney.com` 放在 host 池首位，
效果等价且不依赖任何底层 hack。

### P5 · 许可证绑定 Windows 硬件 【已移除】

`get_machine_id()` 通过注册表 `MachineGuid` + PowerShell CIM 读取
CPU/主板/BIOS 序列号生成指纹。Web 环境不存在这些概念，且任何前端授权
都能被绕过。按需求已整体移除，改为推荐 Cloudflare Access。

### P6 · 扫描架构无法在 Workers 上运行 【已重新设计】

```python
# app.py:622  全量扫描 ~5400 只 × 4 个请求 ≈ 21600 个 HTTP 请求
with ThreadPoolExecutor(max_workers=20) as executor: ...
```

Workers 单次调用最多 50（免费）/1000（付费）个子请求，且没有常驻后台线程。
改为 KV 驱动的增量状态机，详见 `src/scan/engine.ts` 与 `docs/DEPLOY.md`。

### P7 · 前端 innerHTML 未转义 【已知，未修复】

`index.html` 多处用 `innerHTML` 直接拼接来自数据源的股票名称。
若上游返回被污染的名称，理论上可触发 XSS。风险等级低（数据源为知名财经站点，
且本工具通常单用户使用），但如果你打算公开部署，建议改用 `textContent`。

---

## 五、算法层面的局限性

这些不是 bug，是设计取舍，但使用前应当知情。

1. **CAN SLIM 的 C/A/I 维度是"名不副实"的**
   原版 CAN SLIM 中 C = 季度每股收益增长、A = 年度盈利增长、I = 机构持仓。
   本工具全部用价格动量和资金流近似替代，**没有接入任何财务数据**。
   所以它实际上是一套纯技术面系统，"综合基本面"这个 UI 标签有误导性。

2. **形态识别的可靠性有限**
   代码注释里自己写了"双底可靠性约10%"。形态识别对参数极度敏感，
   窗口改几根、阈值动一个百分点，结果就完全不同。

3. **参数未经回测优化**
   所有阈值（±2%、±30%、55 分、75 分…）都是经验值。没有任何证据表明
   这组参数在 A 股上有正期望。

4. **没有考虑交易成本与滑点**
   盈亏比计算用的是理论价位，未扣除佣金、印花税、冲击成本。
   盈亏比 1.5 的信号扣掉成本后可能已经不划算。

5. **前视偏差风险**
   缠论的笔和中枢需要后续 K 线确认才能定型。最后几笔在实盘中是"未完成"
   状态，历史回看时显得很准，实时使用时会反复变动。

**建议**：在投入真金白银前，用这套引擎跑一遍历史回测，统计信号的
胜率、盈亏比、最大回撤。`legacy` 档位的输出与原版逐字段一致，
可以直接用来复现历史信号做验证。
