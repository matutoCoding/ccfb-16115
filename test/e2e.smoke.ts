/**
 * 端到端冒烟验证:启动后的完整用户流程。
 * 跑法:npx vite-node test/e2e.smoke.ts(需先起 dev server 在 5199)
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5199/';

async function main() {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-angle=default', '--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. 首页(先清空旧库,保证从干净状态验证完整流程)
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase('mine-restore-db');
    r.onsuccess = () => res();
    r.onerror = () => res();
    r.onblocked = () => res();
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.app-shell');
  console.log('✓ 应用启动,侧边栏渲染');

  // 2. 测绘期次 -> 生成数据
  await page.click('.nav-item:has-text("测绘期次")');
  await page.waitForSelector('text=生成并切片演示数据');
  await page.click('button:has-text("生成并切片演示数据")');
  // 等待三期切片完成(按钮恢复 + 表格出现 3 行)
  await page.waitForSelector('tbody tr', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3, { timeout: 60000 });
  console.log('✓ 三期数据生成并切片,期次表格 3 行');

  // 3. IndexedDB 瓦片与作业状态
  const dbStats = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('mine-restore-db');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const count = (store: string) => new Promise<number>((res) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).count();
      req.onsuccess = () => res(req.result);
    });
    const jobs = await new Promise<any[]>((res) => {
      const tx = db.transaction('jobs', 'readonly');
      const req = tx.objectStore('jobs').getAll();
      req.onsuccess = () => res(req.result);
    });
    return {
      dbs: dbs.map((d) => d.name),
      dem: await count('dem-tiles'),
      ortho: await count('ortho-tiles'),
      jobs: jobs.length,
      allDone: jobs.every((j: any) => j.status === 'done'),
    };
  });
  console.log('✓ IndexedDB:', JSON.stringify(dbStats));
  if (dbStats.dem === 0 || dbStats.ortho === 0) throw new Error('瓦片未入库');
  if (!dbStats.allDone) throw new Error('存在未完成作业');

  // 4. 三维巡查页
  await page.click('.nav-item:has-text("三维巡查")');
  await page.waitForSelector('.viewer canvas');
  await page.waitForTimeout(1500);
  const canvas = page.locator('.viewer canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 100) throw new Error('画布尺寸异常');
  console.log(`✓ 三维视图画布 ${Math.round(box.width)}×${Math.round(box.height)}`);

  // 5. 悬停取高程(原始精度查询):移动后等待面板出现真实数值
  for (let k = 0; k < 10; k++) {
    const fx = 0.42 + 0.03 * k;
    const fy = 0.42 + 0.03 * (k % 3);
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 4 });
    await page.waitForTimeout(180);
  }
  // 等待高程行被真实数值填充(不再是占位符)
  await page.waitForFunction(() => {
    const t = document.querySelector('.pick')?.textContent ?? '';
    return /高程 H\s*[-0-9.,]+\s*m/.test(t) && !t.includes('—');
  }, { timeout: 10000 });
  const picked = await page.locator('.pick').innerText();
  console.log('✓ 取点面板:\n' + picked.split('\n').map((l) => '   ' + l).join('\n'));
  if (picked.includes('—')) throw new Error('取高程未返回数值,原始精度查询可能失效');

  // 5b. 精度硬指标:页面报的高程必须与原始 DEM 双线性参考值 1cm 内一致
  const precisionOk = await page.evaluate(() => {
    const s = (window as any).__appStore;
    const v = (window as any).__view3d;
    const dem = s.activeRuntime.dem;
    const dbg = v.lastPickDebug;
    if (!dbg?.hit) return { ok: false, reason: 'no hit' };
    // 用页面上报的世界坐标反算参考双线性高程
    const text = document.querySelector('.pick')!.textContent!;
    const num = (label: string) => {
      const m = text.match(new RegExp(label + '\\s*([-0-9.,]+)'));
      return m ? Number(m[1].replace(/,/g, '')) : NaN;
    };
    const px = num('坐标 X');
    const py = num('坐标 Y');
    const reported = num('高程 H');
    // 参考双线性(Float64)
    const [rf, cf] = [
      dem.rows - 1 - ((py - dem.originY) / dem.resolution - 0.5),
      (px - dem.originX) / dem.resolution - 0.5,
    ];
    const r0 = Math.floor(rf), c0 = Math.floor(cf), tr = rf - r0, tc = cf - c0;
    const cl = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const H = (r: number, c: number) => dem.heights[cl(r, 0, dem.rows - 1) * dem.cols + cl(c, 0, dem.cols - 1)];
    const ref = (H(r0, c0) * (1 - tc) + H(r0, c0 + 1) * tc) * (1 - tr) + (H(r0 + 1, c0) * (1 - tc) + H(r0 + 1, c0 + 1) * tc) * tr;
    return { ok: Math.abs(reported - ref) <= 0.01, err: Math.abs(reported - ref), reported, ref };
  });
  console.log('✓ 取点精度对拍:', JSON.stringify(precisionOk));
  if (!precisionOk.ok || (precisionOk.err ?? 1) > 0.01) throw new Error('取点高程与原始 DEM 双线性参考超 1cm');

  // 6. 坡度分级
  await page.click('button:has-text("坡度分级")');
  await page.waitForTimeout(300);
  const slopeLegends = await page.locator('.legend-row').count();
  console.log(`✓ 坡度分级图例 ${slopeLegends} 行`);

  // 7. 两期差分
  await page.click('button:has-text("差分统计")');
  await page.waitForTimeout(800);
  const diffNums = await page.locator('.stat .num').allInnerTexts();
  console.log('✓ 差分统计数值:', diffNums.join(' | '));

  // 8. 水文
  await page.click('button:has-text("计算水文")');
  await page.waitForTimeout(1500);
  const hydroText = await page.locator('.card').allInnerTexts();
  const hasPond = hydroText.some((t) => t.includes('积水坑') || t.includes('满库'));
  console.log(hasPond ? '✓ 水文计算产出积水坑库容表' : '⚠ 未检测到积水坑行');

  // 9. 治理设计页
  await page.click('.nav-item:has-text("治理设计")');
  await page.waitForSelector('.viewer canvas');
  await page.waitForTimeout(800);
  // 在画布上点两个点布削坡线
  const dbox = await page.locator('.viewer canvas').boundingBox();
  if (dbox) {
    await page.mouse.click(dbox.x + dbox.width * 0.4, dbox.y + dbox.height * 0.5);
    await page.mouse.click(dbox.x + dbox.width * 0.6, dbox.y + dbox.height * 0.45);
    await page.waitForTimeout(300);
    await page.click('button:has-text("生成设计面并求挖填")');
    await page.waitForSelector('.stat .num', { timeout: 10000 });
    const designNums = await page.locator('.stat .num').allInnerTexts();
    console.log('✓ 设计面挖填:', designNums.join(' | '));
    if (!designNums.length || designNums.every((n) => Number(n.replace(/,/g, '')) <= 0)) {
      throw new Error('设计面挖方量应大于 0');
    }
  }

  // 10. 验收台账页
  await page.click('.nav-item:has-text("验收台账")');
  await page.waitForSelector('tbody tr', { timeout: 15000 });
  // 切换到第三期,验证相对第二期的危岩遗留自动标红
  const periodOptions = await page.locator('.card select option').allInnerTexts();
  if (periodOptions.length >= 3) {
    await page.locator('.card select').first().selectOption({ index: 2 });
    await page.waitForTimeout(600);
  }
  const accRows = await page.locator('tbody tr').count();
  const hazardRows = await page.locator('tbody tr[style*="rgba(239,68,68"]').count();
  console.log(`✓ 验收台账 ${accRows} 行,其中危岩遗留标红 ${hazardRows} 行`);
  if (accRows < 5) throw new Error('台账图斑条目过少,可能分析未生效');
  if (hazardRows < 1) throw new Error('第三期应存在相对第二期的危岩遗留并标红');

  // 11. 设置页
  await page.click('.nav-item:has-text("设置")');
  await page.waitForSelector('text=缓存规划');
  await page.waitForTimeout(300);
  const settingsText = await page.locator('.main').innerText();
  console.log('✓ 设置页含预算约束:', settingsText.includes('totalBytes') || settingsText.includes('预算'));

  // 12. 矿区档案
  await page.click('.nav-item:has-text("矿区档案")');
  await page.waitForSelector('text=青山闭坑露天采石场');
  console.log('✓ 矿区档案页');

  if (errors.length) {
    console.log('\n控制台错误:');
    for (const e of [...new Set(errors)].slice(0, 15)) console.log('  ✗', e.slice(0, 200));
    throw new Error(`存在 ${errors.length} 条控制台错误`);
  }
  console.log('\n全部冒烟流程通过,无控制台错误。');
  await browser.close();
}

main().catch((e) => { console.error('E2E 失败:', e); process.exit(1); });
