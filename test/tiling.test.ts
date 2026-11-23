import { describe, it, expect } from 'vitest';
import type { ElevationGrid, ImageGrid } from '../src/core/types';
import { queryElevation } from '../src/core/elevation';
import {
  buildPyramidLevels,
  sliceElevationTile,
  sliceImageTile,
  queryElevationFromTiles,
  totalTileCount,
} from '../src/core/tiling';
import { MemoryTileStore } from '../src/data/store';
import { buildJobQueue, resumeQueue } from '../src/data/slicing';
import type { TileJobState } from '../src/core/types';

function makeGrid(rows = 300, cols = 260, res = 0.5): ElevationGrid {
  const heights = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    heights[r * cols + c] = 50 + Math.sin(r * 0.1) * 4 + Math.cos(c * 0.07) * 3 + (r + c) * 0.05;
  }
  return { rows, cols, resolution: res, originX: 500000, originY: 3400000, heights };
}

describe('瓦片金字塔结构', () => {
  it('层级 halving 直到单瓦片', () => {
    const levels = buildPyramidLevels(300, 260, 256);
    expect(levels[0]).toMatchObject({ level: 0, tileRows: 2, tileCols: 2 });
    expect(levels[1].rows).toBe(150);
    expect(levels[1].cols).toBe(130);
    const last = levels[levels.length - 1];
    expect(last.rows).toBeLessThanOrEqual(256);
    expect(last.cols).toBeLessThanOrEqual(256);
    expect(totalTileCount(levels)).toBe(levels.reduce((s, l) => s + l.tileRows * l.tileCols, 0));
  });

  it('边缘瓦片带 halo 且尺寸收缩正确', () => {
    const g = makeGrid();
    const tile = sliceElevationTile(g, 0, 1, 1, 256, 'p1');
    // 右下角:inner = 300-256=44 行,260-256=4 列;halo 只在左上方向外扩
    expect(tile.innerRows).toBe(44);
    expect(tile.innerCols).toBe(4);
    expect(tile.rows).toBe(45); // 上 halo + 44
    expect(tile.cols).toBe(5);  // 左 halo + 4
  });

  it('内部瓦片为 (tileSize+2) 见方', () => {
    const g = makeGrid();
    const tile = sliceElevationTile(g, 0, 0, 0, 256, 'p1');
    expect(tile.rows).toBe(257);
    expect(tile.cols).toBe(257);
    expect(tile.dataStartRow).toBe(0);
    expect(tile.dataStartCol).toBe(0);
  });

  it('粗级瓦片值为 level0 抽稀点(Float32 舍入)', () => {
    const g = makeGrid();
    const tile = sliceElevationTile(g, 2, 0, 0, 256, 'p1');
    expect(tile.heights[1 * tile.cols + 1]).toBeCloseTo(g.heights[4 * g.cols + 4], 6);
  });

  it('影像瓦片 RGBA 长度与均值降采样', () => {
    const rgba = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) rgba.set([100, 120, 140, 255], i * 4);
    const img: ImageGrid = { rows: 64, cols: 64, resolution: 1, originX: 0, originY: 0, rgba };
    const t = sliceImageTile(img, 1, 0, 0, 256, 'p1');
    expect(t.rgba.length).toBe(t.rows * t.cols * 4);
    expect(t.rgba[0]).toBe(100);
    expect(t.rgba[3]).toBe(255);
  });
});

describe('瓦片路径双线性查询:与原始 DEM 参考实现 1cm 对拍', () => {
  const g = makeGrid();
  const tileSize = 256;
  const levels = buildPyramidLevels(g.rows, g.cols, tileSize);
  const store = new MemoryTileStore();
  const all: ReturnType<typeof sliceElevationTile>[] = [];
  for (const lv of levels) {
    for (let r = 0; r < lv.tileRows; r++) for (let c = 0; c < lv.tileCols; c++) {
      all.push(sliceElevationTile(g, lv.level, r, c, tileSize, 'p1'));
    }
  }
  const lookup = (level: number, tr: number, tc: number) =>
    all.find((t) => t.level === level && t.tileRow === tr && t.tileCol === tc);

  it('随机 500 点全部在 1cm 容差内(含瓦片边界两侧)', () => {
    let maxErr = 0;
    for (let k = 0; k < 500; k++) {
      const x = g.originX + Math.random() * (g.cols - 2) * g.resolution + g.resolution;
      const y = g.originY + Math.random() * (g.rows - 2) * g.resolution + g.resolution;
      const ref = queryElevation(g, x, y);
      const got = queryElevationFromTiles(
        { rows: g.rows, cols: g.cols, originX: g.originX, originY: g.originY, resolution: g.resolution, tileSize },
        lookup,
        x,
        y,
      );
      const err = Math.abs(ref - got.height);
      maxErr = Math.max(maxErr, err);
      expect(err).toBeLessThan(0.01);
    }
    // Float32 存储的实际舍入应远小于 1cm
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('恰好落在瓦片分界线上的点不跨瓦片拼接也正确', () => {
    const boundaryC = 256;
    const x = g.originX + (boundaryC + 0.5) * g.resolution;
    const y = g.originY + 100 * g.resolution;
    const ref = queryElevation(g, x, y);
    const got = queryElevationFromTiles(
      { rows: g.rows, cols: g.cols, originX: g.originX, originY: g.originY, resolution: g.resolution, tileSize },
      lookup,
      x,
      y,
    );
    expect(Math.abs(ref - got.height)).toBeLessThan(0.01);
  });

  it('store 持久化瓦片数量与清单一致', async () => {
    for (const t of all) await store.putElevation(t);
    expect(await store.countTiles('p1', 'dem')).toBe(all.length);
    const back = await store.getElevation(all[0].key);
    expect(back?.heights.length).toBe(all[0].heights.length);
    await store.clearPeriod('p1');
    expect(await store.countTiles('p1', 'dem')).toBe(0);
  });
});

describe('断点续切:刷新后只切未完成瓦片', () => {
  const g = makeGrid(600, 500, 0.5);
  const levels = buildPyramidLevels(g.rows, g.cols, 256);
  const full = buildJobQueue(levels);

  it('完整队列覆盖全部层级全部瓦片', () => {
    expect(full.length).toBe(totalTileCount(levels));
  });

  it('模拟切到 40% 中断,恢复队列恰好是剩余 60% 且无重无漏', () => {
    const job: TileJobState = {
      jobId: 'j1', periodId: 'p1', layer: 'dem', totalLevels: levels.length,
      done: {}, inflight: [], status: 'running', createdAt: 0, updatedAt: 0,
    };
    const cut = Math.floor(full.length * 0.4);
    for (let i = 0; i < cut; i++) {
      const [lv, r, c] = full[i];
      const key = `p1/dem/L${lv}/R${r}/C${c}`;
      (job.done[lv] ??= []).push(key);
    }
    const rest = resumeQueue(full, job, 'p1', 'dem');
    expect(rest.length).toBe(full.length - cut);
    const allKeys = new Set([...Object.values(job.done).flat(), ...rest.map(([lv, r, c]) => `p1/dem/L${lv}/R${r}/C${c}`)]);
    expect(allKeys.size).toBe(full.length);
  });

  it('inflight 瓦片崩溃后重新入队', () => {
    const job: TileJobState = {
      jobId: 'j2', periodId: 'p1', layer: 'dem', totalLevels: levels.length,
      done: { 0: ['p1/dem/L0/R0/C0'] }, inflight: ['p1/dem/L0/R0/C1'],
      status: 'running', createdAt: 0, updatedAt: 0,
    };
    const rest = resumeQueue(full, job, 'p1', 'dem');
    const keys = rest.map(([lv, r, c]) => `p1/dem/L${lv}/R${r}/C${c}`);
    expect(keys).toContain('p1/dem/L0/R0/C1');
    expect(keys).not.toContain('p1/dem/L0/R0/C0');
  });
});
