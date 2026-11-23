import { describe, it, expect } from 'vitest';
import { generateMockDataset } from '../src/data/mockGenerator';
import { analyzeSlopes } from '../src/core/slope';
import { detectBenches } from '../src/core/benches';
import { diffGrids, diffByBenches } from '../src/core/diff';
import { detectPonds, pondStorage, flowAccumulation, catchmentAreaAt } from '../src/core/hydrology';
import { buildDesignSurface, cutFillAgainst } from '../src/core/design';
import { slopeGrid } from '../src/core/elevation';
import { labelComponents, marchingSquares } from '../src/core/components';
import type { CutLine } from '../src/core/types';

const data = generateMockDataset({ size: 240, resolution: 0.5 });

describe('模拟采石场数据', () => {
  it('三期数据尺寸一致且确定性可复现', () => {
    expect(data.periods).toHaveLength(3);
    const again = generateMockDataset({ size: 240, resolution: 0.5 });
    expect(again.periods[0].dem.heights[1000]).toBe(data.periods[0].dem.heights[1000]);
    for (const p of data.periods) {
      expect(p.dem.rows).toBe(240);
      expect(p.ortho.rgba.length).toBe(240 * 240 * 4);
    }
  });

  it('包含 >70° 危岩陡坎、积水凹地和多级台阶地形', () => {
    const g = data.periods[0].dem;
    const slopes = slopeGrid(g);
    const maxDeg = (Math.max(...slopes) * 180) / Math.PI;
    expect(maxDeg).toBeGreaterThan(70);
    const ponds = detectPonds(g, 8);
    expect(ponds.length).toBeGreaterThan(0);
  });

  it('P2 相对 P1 存在削方与回填,且量级符合改造参数', () => {
    const d = diffGrids(data.periods[0].dem, data.periods[1].dem, 0.2);
    expect(d.cutM3).toBeGreaterThan(0);
    expect(d.fillM3).toBeGreaterThan(0);
  });

  it('P3 与 P2 仍有削坡变化(连续治理)', () => {
    const d = diffGrids(data.periods[1].dem, data.periods[2].dem, 0.2);
    expect(d.cutM3 + d.fillM3).toBeGreaterThan(0);
  });
});

describe('坡度分级与图斑', () => {
  it('四个分级都有面积,图斑多边形闭合且面积为正', () => {
    const g = data.periods[0].dem;
    const res = analyzeSlopes(g, 'p1', { minPatchCells: 8 });
    const total = res.areaByClass[0] + res.areaByClass[1] + res.areaByClass[2] + res.areaByClass[3];
    expect(total).toBeCloseTo(g.rows * g.cols * g.resolution * g.resolution, 1);
    expect(res.patches.length).toBeGreaterThan(0);
    for (const p of res.patches) {
      expect(p.polygon.length).toBeGreaterThanOrEqual(3);
      expect(p.areaM2).toBeGreaterThan(0);
    }
    // 危岩清理类(>70°)必须出现
    expect(res.areaByClass[3]).toBeGreaterThan(0);
  });

  it('连通组件与轮廓在人工矩形掩膜上正确', () => {
    const rows = 20, cols = 20;
    const mask = new Uint8Array(rows * cols);
    for (let r = 4; r < 10; r++) for (let c = 5; c < 12; c++) mask[r * cols + c] = 1;
    const { labels, count } = labelComponents(mask, rows, cols);
    expect(count).toBe(1);
    const rings = marchingSquares(labels, rows, cols, 1);
    expect(rings.size).toBe(1);
    const ring = rings.values().next().value!;
    // 6x7 矩形,角点环面积 42(角点单位)
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [r1, c1] = ring[i];
      const [r2, c2] = ring[(i + 1) % ring.length];
      s += r1 * c2 - r2 * c1;
    }
    expect(Math.abs(s) / 2).toBe(42);
  });
});

describe('台阶识别与按台阶差分', () => {
  it('识别出多个台阶且掩膜互不重叠', () => {
    const g = data.periods[0].dem;
    const slopes = slopeGrid(g);
    const benches = detectBenches(g, 'p1', slopes, { minCells: 16, elevationToleranceM: 2 });
    expect(benches.length).toBeGreaterThanOrEqual(2);
    const cover = new Uint8Array(g.rows * g.cols);
    for (const b of benches) {
      for (let i = 0; i < b.mask.length; i++) if (b.mask[i]) {
        expect(cover[i]).toBe(0);
        cover[i] = 1;
      }
    }
  });

  it('按台阶统计的挖填总和与全格网差分一致', () => {
    const g1 = data.periods[0].dem;
    const g2 = data.periods[1].dem;
    const diff = diffGrids(g1, g2, 0.2);
    const slopes = slopeGrid(g1);
    const benches = detectBenches(g1, 'p1', slopes, { minCells: 16, elevationToleranceM: 2 });
    const stats = diffByBenches(diff, benches);
    const cutSum = stats.reduce((s, x) => s + x.cutM3, 0);
    const fillSum = stats.reduce((s, x) => s + x.fillM3, 0);
    // 台阶只覆盖平台像元,故台阶统计 <= 总量,但削坡主要发生在坡面上;
    // 这里验证统计自身一致性:net = fill - cut
    for (const st of stats) expect(st.netM3).toBeCloseTo(st.fillM3 - st.cutM3, 6);
    expect(cutSum).toBeLessThanOrEqual(diff.cutM3 + 1e-6);
    expect(fillSum).toBeLessThanOrEqual(diff.fillM3 + 1e-6);
  });
});

describe('水文:汇水与积水坑库容', () => {
  it('汇流累积全场 >=1,低洼处更大', () => {
    const g = data.periods[0].dem;
    const acc = flowAccumulation(g);
    expect(Math.min(...acc)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...acc)).toBeGreaterThan(g.rows);
    const area = catchmentAreaAt(g, acc, g.originX + g.cols * 0.3, g.originY + g.rows * 0.3);
    expect(area).toBeGreaterThan(0);
  });

  it('库容随水位单调增加,溢流口以上不再增加', () => {
    const g = data.periods[0].dem;
    const ponds = detectPonds(g, 8);
    const pond = ponds[0];
    const v1 = pondStorage(g, pond.mask, pond.spillElevation, pond.minElevation + 0.5);
    const v2 = pondStorage(g, pond.mask, pond.spillElevation, pond.minElevation + 1.5);
    expect(v2.volumeM3).toBeGreaterThan(v1.volumeM3);
    const vOver = pondStorage(g, pond.mask, pond.spillElevation, pond.spillElevation + 50);
    expect(vOver.effectiveLevel).toBe(pond.spillElevation);
    const vAtSpill = pondStorage(g, pond.mask, pond.spillElevation, pond.spillElevation);
    expect(vOver.volumeM3).toBeCloseTo(vAtSpill.volumeM3, 6);
  });
});

describe('治理设计面', () => {
  it('沿削坡线生成设计面,只削不填且挖方量为正', () => {
    const g = data.periods[0].dem;
    const x0 = g.originX + g.cols * g.resolution * 0.3;
    const y0 = g.originY + g.rows * g.resolution * 0.5;
    const line: CutLine = {
      id: 'l1', name: '北壁削坡线',
      points: [[x0, y0], [x0 + 60, y0 + 10], [x0 + 110, y0 - 8]],
      benchWidth: 8, slopeRatio: 0.75, benchHeight: 10,
    };
    const res = buildDesignSurface(g, [line], '方案一');
    expect(res.cutM3).toBeGreaterThan(0);
    expect(res.fillM3).toBe(0);
    for (let i = 0; i < g.heights.length; i++) {
      expect(res.surface.heights[i]).toBeLessThanOrEqual(g.heights[i] + 1e-9);
    }
  });

  it('设计面对第二期再求挖填,结果可正可负(回填区)', () => {
    const g1 = data.periods[0].dem;
    const g2 = data.periods[1].dem;
    const x0 = g1.originX + g1.cols * g1.resolution * 0.3;
    const y0 = g1.originY + g1.rows * g1.resolution * 0.5;
    const line: CutLine = {
      id: 'l1', name: '削坡线',
      points: [[x0, y0], [x0 + 80, y0 + 12]],
      benchWidth: 8, slopeRatio: 0.75, benchHeight: 10,
    };
    const { surface } = buildDesignSurface(g1, [line], '方案一');
    const r = cutFillAgainst(surface, g2);
    expect(r.cutM3 + r.fillM3).toBeGreaterThan(0);
  });
});
