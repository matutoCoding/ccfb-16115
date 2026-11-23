/**
 * 水文分析:D8 汇流、汇水面积、台阶内侧排水沟走线、积水坑库容。
 */
import type { ElevationGrid } from './types';
import { labelComponents } from './components';

/** D8 流向(最陡下坡),返回每像元邻居偏移索引(-1 = 无出流,即洼地/边界) */
export function d8FlowDirection(grid: ElevationGrid): Int32Array {
  const { rows, cols, heights, resolution } = grid;
  const dir = new Int32Array(rows * cols).fill(-1);
  const d8: [number, number, number][] = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const h = heights[idx];
      let best = -1;
      let bestGrad = 0;
      for (const [dr, dc, distFactor] of d8) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const nIdx = rr * cols + cc;
        const grad = (h - heights[nIdx]) / (resolution * distFactor);
        if (grad > bestGrad) {
          bestGrad = grad;
          best = nIdx;
        }
      }
      dir[idx] = best;
    }
  }
  return dir;
}

/**
 * 汇流累积(按高程降序处理,D8 保证只流向更低像元,无需迭代)。
 * 累积值单位:像元数;乘 cellArea 即汇水面积。
 */
export function flowAccumulation(grid: ElevationGrid): Float64Array {
  const { rows, cols, heights } = grid;
  const order = new Int32Array(rows * cols);
  for (let i = 0; i < order.length; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => heights[b] - heights[a]);
  const dir = d8FlowDirection(grid);
  const acc = new Float64Array(rows * cols).fill(1);
  for (const idx of sorted) {
    const d = dir[idx];
    if (d >= 0) acc[d] += acc[idx];
  }
  return acc;
}

/** 指定点(世界坐标)的汇水面积 m² */
export function catchmentAreaAt(grid: ElevationGrid, acc: Float64Array, x: number, y: number): number {
  const c = Math.round((x - grid.originX) / grid.resolution - 0.5);
  const r = Math.round(grid.rows - 1 - ((y - grid.originY) / grid.resolution - 0.5));
  if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) return 0;
  return acc[r * grid.cols + c] * grid.resolution * grid.resolution;
}

/**
 * 积水坑识别:局部凹地连通域(被高像元包围的低区),返回各坑像元掩膜与
 * 溢流口高程(坑缘最低像元高程)。
 */
export function detectPonds(grid: ElevationGrid, minCells = 16): {
  id: string;
  mask: Uint8Array;
  spillElevation: number;
  minElevation: number;
  cells: number;
}[] {
  const { rows, cols, heights } = grid;
  const dir = d8FlowDirection(grid);
  const sink = new Uint8Array(rows * cols);
  for (let i = 0; i < dir.length; i++) if (dir[i] < 0) sink[i] = 1;
  const { labels, count } = labelComponents(sink, rows, cols);
  const ponds: { id: string; mask: Uint8Array; spillElevation: number; minElevation: number; cells: number }[] = [];
  for (let l = 1; l <= count; l++) {
    const mask = new Uint8Array(rows * cols);
    let cells = 0;
    let min = Infinity;
    let spill = Infinity;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== l) continue;
      mask[i] = 1;
      cells++;
      min = Math.min(min, heights[i]);
      const r = Math.floor(i / cols);
      const c = i % cols;
      // 坑缘:邻接非坑像元中的最低高程
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const ni = rr * cols + cc;
        if (labels[ni] !== l) spill = Math.min(spill, heights[ni]);
      }
    }
    if (cells >= minCells && Number.isFinite(spill)) {
      ponds.push({ id: `pond-${l}`, mask, spillElevation: spill, minElevation: min, cells });
    }
  }
  return ponds;
}

/**
 * 给定水位线的蓄水量:坑内所有低于水位的像元累积水体积。
 * 水位超过溢流口时按溢流口截断(水量再大也会漫出)。
 */
export function pondStorage(grid: ElevationGrid, pondMask: Uint8Array, spillElevation: number, waterLevel: number): {
  effectiveLevel: number;
  volumeM3: number;
  surfaceAreaM2: number;
} {
  const level = Math.min(waterLevel, spillElevation);
  let volume = 0;
  let area = 0;
  const cellArea = grid.resolution * grid.resolution;
  for (let i = 0; i < pondMask.length; i++) {
    if (!pondMask[i]) continue;
    const h = grid.heights[i];
    if (h < level) {
      volume += (level - h) * cellArea;
      area += cellArea;
    }
  }
  return { effectiveLevel: level, volumeM3: volume, surfaceAreaM2: area };
}

/**
 * 台阶内侧排水沟走线:在台阶掩膜中找靠近采坑中心一侧的边界像元并串成折线。
 * 采坑中心取整个台阶组掩膜的质心;输出世界坐标折线。
 */
export function benchInnerDrainage(
  grid: ElevationGrid,
  benchMask: Uint8Array,
  pitCentroid: [number, number],
): [number, number][] {
  const { rows, cols, resolution, originX, originY } = grid;
  const [pcR, pcC] = worldToCell(grid, pitCentroid[0], pitCentroid[1]);
  // 内侧边界:台阶像元,且朝坑心方向相邻非台阶像元
  const boundary = new Set<number>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!benchMask[i]) continue;
      const towardR = Math.sign(pcR - r);
      const towardC = Math.sign(pcC - c);
      const rr = r + towardR;
      const cc = c + towardC;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || !benchMask[rr * cols + cc]) {
        boundary.add(i);
      }
    }
  }
  if (boundary.size < 2) return [];
  // 最近邻串接(贪心),再转世界坐标
  const remaining = new Set(boundary);
  const start = remaining.values().next().value as number;
  const order = [start];
  remaining.delete(start);
  while (remaining.size) {
    const last = order[order.length - 1];
    const lr = Math.floor(last / cols);
    const lc = last % cols;
    let best = -1;
    let bestD = Infinity;
    for (const cand of remaining) {
      const cr = Math.floor(cand / cols);
      const cc = cand % cols;
      const d = (cr - lr) ** 2 + (cc - lc) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best < 0 || bestD > 4) break; // 断开则结束本条线
    order.push(best);
    remaining.delete(best);
  }
  return order.map((i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return [
      originX + (c + 0.5) * resolution,
      originY + (rows - 1 - r + 0.5) * resolution,
    ];
  });
}

function worldToCell(grid: ElevationGrid, x: number, y: number): [number, number] {
  const c = Math.round((x - grid.originX) / grid.resolution - 0.5);
  const r = Math.round(grid.rows - 1 - ((y - grid.originY) / grid.resolution - 0.5));
  return [r, c];
}
