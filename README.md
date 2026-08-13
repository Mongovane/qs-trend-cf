# 趋势分析实时买卖点工具 · Cloudflare Pages 版 (v5.0)

由 Windows 本地 Python 桌面工具 (v4.0) 重构而来的**全边缘部署**版本：静态看板托管在
Cloudflare Pages，全部分析逻辑以 TypeScript 运行在 Pages Functions（Workers 运行时）。
零服务器、零运维，GitHub 推送即部署。

> ⚠️ **风险提示**：本工具输出的是基于历史价量数据的技术指标计算结果，**不是投资建议**。
> 任何评分、买卖点、仓位建议都只是算法对历史模式的描述，不构成对未来走势的预测。
> 上线使用前请自行做历史回测验证，投资决策及其后果由使用者自行承担。

---

## 目录

- [它是什么](#它是什么)
- [快速开始](#快速开始)
- [架构](#架构)
- [评分体系](#评分体系)
- [API](#api)
- [配置项](#配置项)
- [与 v4.0 的差异](#与-v40-的差异)
- [一致性回归测试](#一致性回归测试)
- [文档](#文档)

---

## 它是什么

输入一个 A 股代码，输出：

- **五+一模块综合评分**与买卖建议（强烈买入 / 买入 / 谨慎买入 / 观望）
- **交易计划**：入场价、止损、目标价、盈亏比、仓位建议
- **缠论分析**：日线/周线的分型、笔、中枢、背驰、一二三类买卖点
- **实时行情**：K 线、分时、盘中 1 分钟级资金流
- **全市场扫描**：日 K + 周 K 双周期共振选股

---

## 快速开始

```bash
git clone https://github.com/<你的账号>/qs-trend-cf.git
cd qs-trend-cf
npm install
npm run dev          # http://localhost:8788
```

部署到 Cloudflare Pages 请看 **[docs/DEPLOY.md](docs/DEPLOY.md)**（含 KV 绑定、
GitHub Actions 密钥配置、免费版配额换算表）。

---

## 架构

```
GitHub ──push──▶ GitHub Actions ──wrangler──▶ Cloudflare Pages
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          │                                           │
                    public/  静态看板                        functions/  Pages Functions
                    (ECharts 单页)                           (TypeScript, Workers 运行时)
                          │                                           │
                          └──────── /api/* 同源调用 ─────────────────▶│
                                                                      │
                                            ┌─────────────────────────┼──────────────┐
                                            ▼                         ▼              ▼
                                   src/analysis/ 分析引擎     src/data/ 数据层    SCAN_KV
                                   (9 个模块，纯计算)         (腾讯/新浪/东财)   (扫描状态)
```

**目录职责**

| 路径 | 内容 |
|---|---|
| `public/` | 静态资源。Pages 构建输出目录，`index.html` 为单文件看板 |
| `functions/api/` | 10 个 API 路由，薄适配层，只做参数解析与序列化 |
| `src/analysis/` | 分析引擎：趋势/量价/形态/突破/CANSLIM/技术指标/缠论/信号聚合/后处理 |
| `src/data/` | 数据层：多源 fallback、host 池轮换、双层缓存 |
| `src/scan/` | 扫描状态机（KV 驱动的增量执行） |
| `src/util/` | Python 语义数值层、响应工具 |
| `tests/` | Python ↔ TypeScript 一致性回归 |
| `tools/` | 基准数据生成脚本 |

---

## 评分体系

两个可切换档位，由 `SCORING_PROFILE` 环境变量控制。

### `enhanced`（默认，六模块）

在原版五模块之外新增**技术指标共振层**，并修复了 v4.0 的三个算法缺陷。

| 模块 | 权重 | 内容 |
|---|---|---|
| 趋势 | 20% | MA20/MA60 方向与位置、均线共振、上升趋势线 |
| **技术指标** | **20%** | **新增：12 项主流指标共振** |
| 量价 | 18% | 量价八象限、OBV、资金流、放量涨停、量能突破 |
| 突破 | 15% | 海龟法则系统一(20日)/系统二(55日)唐奇安通道 |
| CAN SLIM | 15% | C/A/N/S/L/I/M 七维度 + 杯柄形态 |
| 形态 | 12% | 头肩、双顶双底、三角形、箱体、旗形、跳空、圆弧底 |

**技术指标层**包含的 12 项（均采用行业通行参数）：

| 指标 | 参数 | 作用 |
|---|---|---|
| MACD | 12,26,9 | 金叉/死叉、柱体放缩 |
| DMI / ADX | 14 | 趋势方向与强度 |
| 均线排列 | 5/10/20/60 | 多头/空头排列判定 |
| KDJ | 9,3,3 | 超买超卖、金叉死叉 |
| SuperTrend | 10, 3× | 趋势跟踪与动态止损位 |
| RSI | 14 (Wilder) | 相对强弱 |
| MFI | 14 | 量价加权资金流 |
| BOLL | 20, 2σ | 通道位置、带宽收敛 |
| CCI | 14 | 顺势偏离度 |
| WR | 14 | 威廉超买超卖 |
| VWAP | 20 日滚动 | 成本线 |
| ATR | 14 (Wilder) | 波动率与仓位约束 |

每项给出 −12 ~ +12 的偏移，按**实际参与数量归一**后叠加到 50 分中枢——
上市不足 60 日的新股不会因为指标缺失被系统性压低。

### `legacy`（v4.0 完全复刻）

五模块权重 `趋势25% + CANSLIM20% + 突破20% + 量价20% + 形态15%`，
且保留 v4.0 的全部原始行为（含三个已知缺陷）。**该档位经 55 项自动化测试
验证与原 Python 版逐字段一致**，用于结果比对与历史信号复现。

### 后处理（两档位共用）

综合分产出后，还会依次执行：

1. **硬否决** —— 跌破 MA20 / 价跌量增 / OBV 下降 → 直接降为观望
2. **软否决** —— MA20 向下 / 受压 60 日线 → 降一级
3. **五级重评** —— 按分数 + 置信度 + 达标模块数重新分档
4. **M 分仓位管理** —— 大盘 M 分 < 40 强制轻仓并降级
5. **盈亏比检查** —— 盈亏比 < 1.0 直接否决入场

---

## API

全部为 `GET`，同源路径 `/api/*`。

| 路由 | 参数 | 返回 |
|---|---|---|
| `/api/health` | `probe=1` 可选 | 健康状态；`probe=1` 时逐个探测上游数据源并返回耗时 |
| `/api/analyze` | `symbol`, `period` | 行情 + 信号 + K线 + 资金流 + 大盘环境 |
| `/api/quote` | `symbol` | 实时行情 |
| `/api/kline` | `symbol`, `count`, `period` | K 线数组 |
| `/api/minute` | `symbol` | 当日分时 |
| `/api/search` | `keyword` | 股票搜索 |
| `/api/realtime_flow` | `symbol` | 盘中 1 分钟级累计资金流 |
| `/api/chanlun_daily` | `symbol`, `count`, `period` | 分型/笔/中枢/买卖点 + 图表叠加层 |
| `/api/chanlun_minute` | `symbol` | 5 分钟缠论 |
| `/api/scan` | `action=start\|status\|reset` | 全市场扫描；无 `action` 时推进一批 |

**部署后第一件事**：访问 `/api/health?probe=1` 确认三个上游数据源可达。

---

## 配置项

在 Cloudflare Pages 控制台 → Settings → Environment variables 配置：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SCORING_PROFILE` | `enhanced` | 评分档位，可选 `legacy` |
| `SCAN_UNIVERSE` | `500` | 扫描股票池大小（按成交额降序） |
| `SCAN_BATCH_SIZE` | `8` | 每次轮询推进的股票数。**免费版勿超过 12** |
| `BREADTH_MAX_PAGES` | `10` | 市场宽度抓取页数（每页 100 只）。免费版建议 ≤ 12 |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 上游请求超时 |
| `UPSTREAM_PROXY_BASE` | 未设置 | 可选反向代理前缀，用于边缘节点直连不通的情况 |

**KV 绑定**：扫描功能需要绑定一个 KV Namespace，变量名必须为 `SCAN_KV`。

---

## 与 v4.0 的差异

| 项 | v4.0 (本地 Python) | v5.0 (Cloudflare) |
|---|---|---|
| 运行环境 | Windows + Python 3.8+ | 全球边缘节点，浏览器即可访问 |
| 依赖 | 内置 1.2MB `libs/` | 零运行时依赖 |
| 许可证 | secp256k1 + 硬件指纹绑定 | **已移除**，改用 Cloudflare Access 保护私有部署 |
| DNS 劫持 | monkey-patch `getaddrinfo` | host 池顺序重试（Workers 无法改 DNS） |
| 缓存 | 进程内 dict | isolate 内存 + Cache API 双层 |
| 扫描 | 20 线程一次扫完 ~5400 只 | KV 增量状态机，分批推进 |
| 并发 | `ThreadPoolExecutor` | `mapLimit` 受控并发 |
| 算法缺陷 | 3 处 | 已修复（`legacy` 档位可复现原行为） |
| 技术指标 | MA/OBV/MACD/唐奇安 | **+12 项主流指标** |

修复的三个缺陷详见 **[docs/ANALYSIS.md](docs/ANALYSIS.md)**。

---

## 一致性回归测试

`legacy` 档位必须与原版 Python 逐字段一致，由自动化测试强制保证：

```bash
# 1. 把 v4.0 原项目放到 ./reference/（已被 .gitignore 忽略）
# 2. 用原版 Python 模块生成基准数据
npm run golden

# 3. 比对 TypeScript 移植版
npm test
```

测试覆盖 6 组确定性合成行情（上升/下降/震荡/跳空/短历史），
对趋势、量价、突破、CANSLIM、缠论、信号引擎逐字段断言，共 55 项。

移植过程中最容易出错的是**数值语义差异**，已在 `src/util/pynum.ts` 统一处理：

| Python | JavaScript 默认 | 本项目 |
|---|---|---|
| `round()` 四舍六入五取偶（对精确十进制展开） | `Math.round()` half-up | `pyRound()` |
| `int()` 向 0 截断 | `Math.floor()` 向下 | `pyInt()` |
| `//` 向下取整除 | `/` | `floorDiv()` |
| `f"{x:.2f}"` half-even | `toFixed()` | `fmt()` |
| `list.sort()` 稳定排序 | 引擎相关 | `stableSortByDate()` |

> 若用 `Math.round(x * 100) / 100` 实现 `pyRound`，海龟法则的 N 值会偏差
> 0.0001，进而使止损价、盈亏比、乃至最终买卖建议全部改变。这类问题在
> 移植中极难靠肉眼发现，只能靠回归测试兜住。

---

## 文档

- **[docs/ANALYSIS.md](docs/ANALYSIS.md)** — v4.0 原项目逐文件分析、算法还原、缺陷清单
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — 部署步骤、KV 配置、免费版配额换算
- **[docs/MIGRATION.md](docs/MIGRATION.md)** — 迁移决策记录与取舍说明

---

## 许可

本项目为原 v4.0 工具的架构重构。使用前请确认你拥有原项目的合法使用权。
数据来源为公开行情接口，请遵守各数据源的使用条款与频率限制。
