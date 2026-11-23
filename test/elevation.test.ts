import { describe, it, expect } from 'vitest';
import type { ElevationGrid } from '../src/core/types';
import { queryElevation, sampleTerrain, measureProfile, clamp } from '../src/core/elevation';

function makeGrid(rows = 8, cols = 10, res = 1, ox = 100, oy = 200): ElevationGrid {
  const heights = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 10 + r * 2 + c * 0.5 + Math.sin(r * c + 1) * 3;
  return { rows, cols, resolution: res, originX: ox, originY: oy, heights };
}

describe('双线性插值参考实现', () => {
  it('像元中心返回该像元高程', () => {
    const g = makeGrid();
    const r = 3, c = 4;
    const x = g.originX + (c + 0.5) * g.resolution;
    const y = g.originY + (g.rows - 1 - r + 0.5) * g.resolution;
    expect(queryElevation(g, x, y)).toBeCloseTo(g.heights[r * g.cols + c], 12);
  });

  it('四个角点双线性加权正确(独立手写参考)', () => {
    const g = makeGrid();
    const r0 = 2, c0 = 5;
    const tr = 0.3, tc = 0.7;
    const rf = r0 + tr, cf = c0 + tc;
    const x = g.originX + (cf + 0.5) * g.resolution;
    const y = g.originY + (g.rows - 1 - rf + 0.5) * g.resolution;
    const h00 = g.heights[r0 * g.cols + c0];
    const h01 = g.heights[r0 * g.cols + c0 + 1];
    const h10 = g.heights[(r0 + 1) * g.cols + c0];
    const h11 = g.heights[(r0 + 1) * g.cols + c0 + 1];
    const expectH = (h00 * (1 - tc) + h01 * tc) * (1 - tr) + (h10 * (1 - tc) + h11 * tc) * tr;
    expect(queryElevation(g, x, y)).toBeCloseTo(expectH, 12);
  });

  it('范围外 clamp 到边缘不抛异常', () => {
    const g = makeGrid();
    const v = queryElevation(g, g.originX - 50, g.originY - 50);
    expect(Number.isFinite(v)).toBe(true);
    const s = sampleTerrain(g, g.originX - 50, g.originY + 2);
    expect(s.inside).toBe(false);
  });

  it('平面地形坡度恒为 0,斜坡坡度等于设计角', () => {
    const flat: ElevationGrid = { rows: 6, cols: 6, resolution: 1, originX: 0, originY: 0, heights: new Float64Array(36).fill(42) };
    const s = sampleTerrain(flat, 2.5, 2.5);
    expect(s.slopeDeg).toBeCloseTo(0, 10);
    // 每米升高 0.5 -> 坡度 atan(0.5)
    const slope = new Float64Array(36);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) slope[r * 6 + c] = c * 0.5;
    const ramp: ElevationGrid = { ...flat, heights: slope };
    const s2 = sampleTerrain(ramp, 2.5, 2.5);
    expect(s2.slopeDeg).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 6);
  });

  it('量测剖面在平面上表面距离=水平距离,坡面上=斜边', () => {
    const flat: ElevationGrid = { rows: 10, cols: 10, resolution: 1, originX: 0, originY: 0, heights: new Float64Array(100).fill(10) };
    const m = measureProfile(flat, [[1, 1], [5, 4]]);
    expect(m.horizontalM).toBeCloseTo(5, 6);
    expect(m.surfaceM).toBeCloseTo(5, 6);
    const slope = new Float64Array(100);
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) slope[r * 10 + c] = c;
    const ramp: ElevationGrid = { ...flat, heights: slope };
    const m2 = measureProfile(ramp, [[1.5, 5.5], [4.5, 5.5]]);
    expect(m2.surfaceM).toBeCloseTo(Math.hypot(3, 3), 4);
  });

  it('clamp 边界行为', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
