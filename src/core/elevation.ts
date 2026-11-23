/**
 * 高程查询与地形分析 —— 全部基于原始精度格网,Float64 计算。
 *
 * 硬指标:任意世界坐标查询结果必须等于原始 DEM 的双线性插值(容差 1cm)。
 * 瓦片路径的查询(queryElevationFromTiles)与这里的参考实现(queryElevation)
 * 在测试中逐点对拍,保证显示用的粗层级永远不会参与量测。
 */
import type { ElevationGrid } from './types';
import { worldToGrid } from './types';

export interface SampleResult {
  /** 双线性插值高程 */
  height: number;
  /** 是否落在有效范围内(范围外返回边缘值并标记) */
  inside: boolean;
  /** 解析坡度(弧度),来自双线性曲面的连续梯度 */
  slopeRad: number;
  slopeDeg: number;
  /** 坡向(弧度,自北顺时针) */
  aspectRad: number;
}

/** 原始 DEM 双线性插值 —— 参考实现,所有其它路径必须与它一致 */
export function queryElevation(grid: ElevationGrid, x: number, y: number): number {
  const [rf, cf] = worldToGrid(grid, x, y);
  const r0 = Math.floor(rf);
  const c0 = Math.floor(cf);
  const tr = rf - r0;
  const tc = cf - c0;

  const rLo = clamp(r0, 0, grid.rows - 1);
  const rHi = clamp(r0 + 1, 0, grid.rows - 1);
  const cLo = clamp(c0, 0, grid.cols - 1);
  const cHi = clamp(c0 + 1, 0, grid.cols - 1);

  const h00 = grid.heights[rLo * grid.cols + cLo];
  const h01 = grid.heights[rLo * grid.cols + cHi];
  const h10 = grid.heights[rHi * grid.cols + cLo];
  const h11 = grid.heights[rHi * grid.cols + cHi];

  const h0 = h00 * (1 - tc) + h01 * tc;
  const h1 = h10 * (1 - tc) + h11 * tc;
  return h0 * (1 - tr) + h1 * tr;
}

/** 完整采样:高程 + 坡度 + 坡向,坡度取双线性曲面的解析梯度 */
export function sampleTerrain(grid: ElevationGrid, x: number, y: number): SampleResult {
  const [rf, cf] = worldToGrid(grid, x, y);
  const inside = rf >= 0 && rf <= grid.rows - 1 && cf >= 0 && cf <= grid.cols - 1;
  const r0 = Math.floor(rf);
  const c0 = Math.floor(cf);
  const tr = rf - r0;
  const tc = cf - c0;

  const rLo = clamp(r0, 0, grid.rows - 1);
  const rHi = clamp(r0 + 1, 0, grid.rows - 1);
  const cLo = clamp(c0, 0, grid.cols - 1);
  const cHi = clamp(c0 + 1, 0, grid.cols - 1);

  const h00 = grid.heights[rLo * grid.cols + cLo];
  const h01 = grid.heights[rLo * grid.cols + cHi];
  const h10 = grid.heights[rHi * grid.cols + cLo];
  const h11 = grid.heights[rHi * grid.cols + cHi];

  // 双线性: h = h00(1-tr)(1-tc)+h01(1-tr)tc+h10 tr(1-tc)+h11 tr tc
  const h0 = h00 * (1 - tc) + h01 * tc;
  const h1 = h10 * (1 - tc) + h11 * tc;
  const height = h0 * (1 - tr) + h1 * tr;

  // 对分数行列的偏导
  const dhdr = (h10 * (1 - tc) + h11 * tc) - (h00 * (1 - tc) + h01 * tc);
  const dhdc = (h01 * (1 - tr) + h11 * tr) - (h00 * (1 - tr) + h10 * tr);

  // 行方向对应世界 -Y,列方向对应世界 +X,格网间距 res
  const dzdx = dhdc / grid.resolution;
  const dzdy = -dhdr / grid.resolution;
  const grad = Math.hypot(dzdx, dzdy);
  const slopeRad = Math.atan(grad);
  // 坡向:自北顺时针。北 = +Y
  let aspectRad = Math.atan2(dzdx, dzdy);
  if (aspectRad < 0) aspectRad += Math.PI * 2;

  return { height, inside, slopeRad, slopeDeg: (slopeRad * 180) / Math.PI, aspectRad };
}

/** Horn 三阶加权坡度(整格网批量,用于坡度分级图斑) */
export function slopeGrid(grid: ElevationGrid): Float32Array {
  const out = new Float32Array(grid.rows * grid.cols);
  const { rows, cols, heights, resolution } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rm = r > 0 ? r - 1 : r;
      const rp = r < rows - 1 ? r + 1 : r;
      const cm = c > 0 ? c - 1 : c;
      const cp = c < cols - 1 ? c + 1 : c;
      const a = heights[rm * cols + cm];
      const b = heights[rm * cols + c];
      const d = heights[rm * cols + cp];
      const f = heights[r * cols + cp];
      const g = heights[rp * cols + cp];
      const h = heights[rp * cols + c];
      const i = heights[rp * cols + cm];
      const e = heights[r * cols + cm];
      const dzdx = ((d + 2 * f + g) - (a + 2 * e + i)) / (8 * resolution);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + d)) / (8 * resolution);
      out[r * cols + c] = Math.atan(Math.hypot(dzdx, dzdy));
    }
  }
  return out;
}

/** 沿世界坐标折线做三维距离量测,严格逐段用原始 DEM 双线性插值 */
export function measureProfile(grid: ElevationGrid, worldPoints: [number, number][]): {
  horizontalM: number;
  surfaceM: number;
  verticalM: number;
  samples: { x: number; y: number; h: number; dist: number }[];
} {
  const samples: { x: number; y: number; h: number; dist: number }[] = [];
  let horizontalM = 0;
  let surfaceM = 0;
  let prev: { x: number; y: number; h: number } | null = null;
  const step = grid.resolution / 2;

  for (let p = 0; p < worldPoints.length; p++) {
    const [x, y] = worldPoints[p];
    if (p === 0) {
      const h = queryElevation(grid, x, y);
      samples.push({ x, y, h, dist: 0 });
      prev = { x, y, h };
      continue;
    }
    const [px, py] = worldPoints[p - 1];
    const segLen = Math.hypot(x - px, y - py);
    const n = Math.max(1, Math.ceil(segLen / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const sx = px + (x - px) * t;
      const sy = py + (y - py) * t;
      const sh = queryElevation(grid, sx, sy);
          horizontalM += Math.hypot(sx - prev!.x, sy - prev!.y);
      surfaceM += Math.hypot(sx - prev!.x, sy - prev!.y, sh - prev!.h);
      samples.push({ x: sx, y: sy, h: sh, dist: horizontalM });
      prev = { x: sx, y: sy, h: sh };
    }
  }
  const hs = samples[0]?.h ?? 0;
  const he = samples[samples.length - 1]?.h ?? 0;
  return { horizontalM, surfaceM, verticalM: he - hs, samples };
}

/** 多边形面积(鞋带公式,投影坐标) */
export function polygonArea(poly: [number, number][]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 两点双线性一致性辅助:把格网分数坐标反算世界坐标(供测试用) */
export function fractionalCellToWorld(
  grid: ElevationGrid,
  rFloat: number,
  cFloat: number,
): [number, number] {
  const x = grid.originX + (cFloat + 0.5) * grid.resolution;
  const y = grid.originY + (grid.rows - 1 - rFloat + 0.5) * grid.resolution;
  return [x, y];
}
