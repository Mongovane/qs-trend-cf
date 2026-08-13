# 部署指南

从零到线上，约 15 分钟。

---

## 0. 前置条件

- 一个 Cloudflare 账号（免费版即可）
- 一个 GitHub 账号
- 本地 Node.js ≥ 20

---

## 1. 创建 GitHub 仓库

```bash
cd qs-trend-cf
git init
git add .
git commit -m "feat: Cloudflare Pages 版趋势分析工具 v5.0"
git branch -M main
git remote add origin https://github.com/<你的账号>/qs-trend-cf.git
git push -u origin main
```

> `.gitignore` 已排除 `node_modules/`、`.wrangler/`、`.dev.vars`、`tests/build/`。
> 若你把 v4.0 原项目放在 `reference/` 用于回归测试，记得确认它也被忽略
> （默认未忽略，请按需在 `.gitignore` 追加 `reference/`）。

---

## 2. 创建 Pages 项目

Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**

选择刚推送的仓库，构建配置：

| 项 | 值 |
|---|---|
| Framework preset | `None` |
| Build command | `npm ci && npm run typecheck` |
| Build output directory | `public` |
| Root directory | `/` |

`functions/` 目录会被 Pages **自动编译**，无需额外配置。

---

## 3. 创建并绑定 KV（扫描功能必需）

```bash
npx wrangler kv namespace create SCAN_KV
```

输出形如：

```
🌀 Creating namespace with title "qs-trend-SCAN_KV"
✨ Success!
{ binding = "SCAN_KV", id = "a1b2c3d4e5f6..." }
```

然后在 Pages 项目 → **Settings** → **Functions** → **KV namespace bindings** 添加：

- Variable name: `SCAN_KV`
- KV namespace: 选择刚创建的那个

> 不绑定 KV 时，除 `/api/scan` 外的所有功能正常工作，扫描会返回明确的提示信息。

---

## 4. 配置环境变量

Pages 项目 → **Settings** → **Environment variables** → **Production**：

| 变量 | 推荐值（免费版） | 说明 |
|---|---|---|
| `SCORING_PROFILE` | `enhanced` | 评分档位 |
| `SCAN_UNIVERSE` | `500` | 扫描股票池 |
| `SCAN_BATCH_SIZE` | `8` | 每批股票数 |
| `BREADTH_MAX_PAGES` | `10` | 市场宽度页数 |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 上游超时 |

---

## 5. 配置 GitHub Actions（可选，用于自动部署）

若你希望由 Actions 而非 Pages 内置 CI 部署，在 GitHub 仓库
**Settings → Secrets and variables → Actions** 添加：

| 类型 | 名称 | 获取方式 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → 使用 **Edit Cloudflare Workers** 模板 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 控制台右侧栏 Account ID |
| Variable | `CF_PAGES_PROJECT` | Pages 项目名（默认 `qs-trend`） |

`.github/workflows/deploy.yml` 会在推送 `main` 时执行
类型检查 → 回归测试 → 部署，任一步失败即中止。

---

## 6. 部署后自检

```bash
curl https://<你的项目>.pages.dev/api/health?probe=1
```

期望输出：

```json
{
  "status": "ok",
  "scoring_profile": "enhanced",
  "scan_kv": "bound",
  "upstream_proxy": "direct",
  "probes": {
    "eastmoney_quote": { "ok": true, "ms": 210, "name": "浦发银行" },
    "tencent_kline":   { "ok": true, "ms": 180 },
    "sina_kline":      { "ok": true, "ms": 320 }
  }
}
```

**如果三个 probe 都是 `ok: false`** —— 说明 Cloudflare 边缘节点无法直连境内
行情接口。这是本次迁移**最大的不确定性**，见下方专门章节。

---

## 上游可达性问题

原版跑在用户自己的 Windows 机器上（境内 IP），而 Cloudflare Pages Functions
跑在全球任意边缘节点。东财、腾讯、新浪的行情接口对境外 IP 存在**限流、
降级甚至直接拒绝**的可能，且各节点表现不一致。

本项目已内置的缓解措施：

1. **多源 fallback** —— 腾讯 → 新浪 → 东财，任一可达即可出数据
2. **host 池轮换** —— 东财每类接口配置 3~5 个备选域名
3. **诊断端点** —— `/api/health?probe=1` 可随时确认哪一源出了问题
4. **代理兜底** —— 配置 `UPSTREAM_PROXY_BASE` 后所有上游请求改走代理

### 配置代理兜底

若探测全红，需要自建一个位于境内或可正常访问这些接口的转发服务，
接口约定为 `GET {UPSTREAM_PROXY_BASE}/{urlencoded_target_url}`：

```
UPSTREAM_PROXY_BASE = https://your-proxy.example.com/fetch
```

实际请求会变成：

```
https://your-proxy.example.com/fetch/https%3A%2F%2Fpush2.eastmoney.com%2Fapi%2F...
```

代理侧只需解码后原样转发并回传响应体即可。

---

## 免费版配额换算

这是决定 `SCAN_UNIVERSE` / `SCAN_BATCH_SIZE` 取值的核心约束。

### Workers Free 关键限制

| 限制 | 免费版 | 付费版 |
|---|---|---|
| 单次调用子请求数 | **50** | 1000 |
| 单次调用 CPU 时间 | **10 ms**（不含 I/O 等待） | 30 s |
| 每日请求数 | 100,000 | 按量计费 |
| KV 每日读 | 100,000 | 按量计费 |
| KV 每日写 | **1,000** | 按量计费 |

### 各接口的子请求消耗

| 接口 | 子请求数 | 说明 |
|---|---|---|
| `/api/quote` | 1~4 | host 池重试 |
| `/api/kline` | 1~4 | 多源 fallback + enrich |
| `/api/analyze` | 5~18 | K线+enrich+行情+资金流+指数+宽度(≤10) |
| `/api/scan` 每批 | `批量 × 3 + 2` | 扫描关闭 enrich |

### 扫描配额推演（默认配置）

```
SCAN_UNIVERSE=500, SCAN_BATCH_SIZE=8

单批子请求  = 8 只 × 3 (K线/行情/资金流) + 指数 1 + 宽度 0(命中缓存) ≈ 26  < 50  ✅
日K批次数   = 500 / 8 = 63 批
周K批次数   ≈ 命中数(约 40~90) / 8 ≈ 6~12 批
总批次      ≈ 70~75 批
前端轮询    = 2 秒/批 → 约 150 秒 ≈ 2.5 分钟   ✅ 与 UI 文案一致
KV 写入     = 每批 1 次 ≈ 75 次/轮扫描
每日可扫    = 1000 / 75 ≈ 13 轮                ⚠️ 免费版 KV 写入是真正的瓶颈
```

**结论**：默认配置下免费版每天可完整扫描约 **13 次**，其余功能不受影响。

### 想扫更多怎么办

| 目标 | 做法 | 代价 |
|---|---|---|
| 扫全市场 5400 只 | `SCAN_UNIVERSE=5400` | 批次数 ×11，KV 写入超限，需付费版 |
| 加快扫描 | `SCAN_BATCH_SIZE=16` | 单批 50 子请求，**免费版会触顶**，需付费版 |
| 降低 KV 写入 | 调大 `SCAN_BATCH_SIZE` | 同上 |
| 提高宽度精度 | `BREADTH_MAX_PAGES=59` | `/api/analyze` 子请求超 50，需付费版 |

升级到 Workers Paid（$5/月）后，建议配置：

```
SCAN_UNIVERSE      = 5400
SCAN_BATCH_SIZE    = 60
BREADTH_MAX_PAGES  = 59
```

---

## 保护私有部署

原版的 secp256k1 硬件绑定授权已移除。若不希望公开访问，推荐用
**Cloudflare Access**（免费版含 50 个席位），零代码改动：

Cloudflare Zero Trust → **Access** → **Applications** → **Add an application**
→ Self-hosted → 域名填 `<你的项目>.pages.dev` → 策略选 Email OTP 或
指定邮箱白名单。

这比应用层自建授权更安全，也不会被前端 JS 绕过。

---

## 常见问题

**Q: 看板打开空白，控制台报 `echarts is not defined`**
A: ECharts CDN 被拦截。`index.html` 已内置 jsdelivr → unpkg → cdnjs 三级回退；
若三者都不可达，把 `echarts.min.js` 下载到 `public/vendor/` 并改为本地引用。

**Q: `/api/scan` 一直卡在同一个进度**
A: 前端每 2 秒轮询才推进一批，**必须保持页面打开**。若关闭页面，
状态会保留在 KV（2 小时过期），重新打开继续推进。

**Q: 扫描结果为空**
A: 双周期共振是相当严格的条件，空头行情下命中 0 只是正常的。
可先用 `/api/scan?action=status` 确认 `found` 字段。

**Q: 想恢复和 v4.0 完全一致的评分**
A: 设置 `SCORING_PROFILE=legacy`。该档位有 55 项自动化测试保证逐字段一致。

**Q: 本地开发时 KV 怎么办**
A: `npm run dev` 已带 `--kv SCAN_KV`，wrangler 会在本地模拟一个 KV。
