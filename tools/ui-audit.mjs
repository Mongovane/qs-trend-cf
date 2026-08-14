#!/usr/bin/env node
/**
 * 前端交互自动巡检。
 *
 * 前端是 3700 行单文件 vanilla JS，不在 TypeScript 检查范围内，
 * 因此「按钮点不到」「变量重名导致整块脚本 SyntaxError」这类问题
 * 只能靠真实点一遍来发现。本脚本已经抓到过：
 *   - 副图指标工具栏死锁（5 个指标永久不可用）
 *   - _lastSymbol 变量重名导致整页白屏
 *
 * 用法：
 *   npm run dev                    # 另开一个终端跑起本地服务
 *   node tools/ui-audit.mjs http://localhost:8788 600519
 *
 * 依赖：npx playwright install chromium
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8788';
const SYMBOL = process.argv[3] || '600519';

const errors = [];
let failed = 0;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });

  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

  console.log(`巡检目标: ${BASE}  标的: ${SYMBOL}\n`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // 触发一次真实分析，后续所有面板才有数据
  await page.fill('#search-input', SYMBOL).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(6000);

  async function step(desc, fn) {
    const before = errors.length;
    try {
      await fn();
    } catch (e) {
      errors.push(`[action:${desc}] ${String(e.message).split('\n')[0]}`);
    }
    await page.waitForTimeout(500);
    const fresh = errors.slice(before);
    if (fresh.length) {
      failed += 1;
      console.log(`  ✗ ${desc}`);
      fresh.forEach((x) => console.log(`      ${x}`));
    } else {
      console.log(`  ✓ ${desc}`);
    }
  }

  const clickText = (t) => () => page.getByText(t, { exact: true }).first().click({ timeout: 4000 });
  const clickSel = (s) => () => page.locator(s).first().click({ timeout: 4000 });

  console.log('— 视图切换 —');
  for (const v of ['周K', '分时', '日K']) await step(`切到 ${v}`, clickText(v));

  console.log('— 时间范围 —');
  for (const r of ['1月', '半年', '1年', '全部', '3月']) await step(`范围 ${r}`, clickText(r));

  console.log('— 副图指标（曾因死锁全部不可用）—');
  await step('工具栏可见', async () => {
    const vis = await page.locator('#indicator-toolbar').isVisible();
    if (!vis) throw new Error('indicator-toolbar 不可见，指标入口不可达');
  });
  for (const i of ['macd', 'rsi', 'kdj', 'boll', 'wr', 'none']) {
    await step(`指标 ${i}`, clickSel(`.it-btn[data-ind="${i}"]`));
  }

  console.log('— 模式 —');
  await step('小白模式', clickSel('#mt-simple'));
  await step('专业模式', clickSel('#mt-pro'));

  console.log('— 自选 / 历史 —');
  await step('加入自选', clickSel('#star-btn'));
  await step('打开面板', clickSel('#watch-btn'));
  for (const t of ['history', 'overview', 'watch']) {
    await step(`切到 ${t}`, clickSel(`.wp-tab[data-tab="${t}"]`));
  }
  await step('关闭面板', clickSel('#watch-btn'));

  console.log('— 卡片折叠 —');
  await step('折叠', async () => page.locator('.sc-header').nth(3).click());
  await step('展开', async () => page.locator('.sc-header').nth(3).click());

  console.log('— 资金流 —');
  for (const t of ['近30日', '今日实时']) await step(`资金流 ${t}`, clickText(t));

  console.log('— 图表悬停（信号说明面板定位）—');
  await step('悬停 K 线', async () => {
    const box = await page.locator('#kline-chart').boundingBox();
    for (const fx of [0.3, 0.6, 0.85]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5);
      await page.waitForTimeout(250);
    }
  });

  console.log('— 扫描弹窗 —');
  await step('打开扫描', clickSel('#scan-btn'));
  await step('关闭扫描', clickSel('.scan-close'));

  console.log('— 搜索 —');
  await step('搜索关键字', async () => page.fill('#search-input', '茅台'));

  console.log('— 响应式 —');
  await step('窄屏 900px', async () => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(600);
  });
  await step('还原宽屏', async () => page.setViewportSize({ width: 1680, height: 980 }));

  await browser.close();

  console.log(`\n失败步骤: ${failed}   累计错误: ${errors.length}`);
  if (errors.length) {
    console.log('\n全部错误:');
    [...new Set(errors)].forEach((e) => console.log('  ' + e));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
