/**
 * 治理设计面生成与挖填平衡计算。
 *
 * 设计语义:沿削坡线所在台阶,按「平台宽 benchWidth + 坡比 1:slopeRatio、
 * 每级台段高 benchHeight」从现状地形向下修坡。平台高程由削坡线处现状高程
 * 锚定,坡面在相邻平台间按坡比线性过渡。设计面与现状同格网,可直接走
 * 同一套 clipmap 显示。
 */
import type { CutLine, DesignSurface, ElevationGrid } from './types';
import { queryElevation } from './elevation';

export interface DesignBuildResult {
  surface: DesignSurface;
  cutM3: number;
  fillM3: number;
  /** 每像元挖填深度(设计 - 现状):负挖正填 */
  delta: Float64Array;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { dist: number; t: number } {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * vx;
  const qy = ay + t * vy;
  return { dist: Math.hypot(px - qx, py - qy), t };
}

function distanceToPolyline(x: number, y: number, pts: [number, number][]): { dist: number; segIndex: number } {
  let best = { dist: Infinity, segIndex: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distanceToSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (r.dist < best.dist) best = { dist: r.dist, segIndex: i };
  }
  return best;
}

/**
 * 构建设计面。每条削坡线定义一条治理带:
 *  - 带内按到线的水平距离 d 划分平台(宽 W)与斜坡段(水平长 n·H);
 *  - 平台高程 = 锚点高程 - 级数*H;斜坡段在两级平台间线性插值;
 *  - 设计面取「现状高程」与「修坡目标高程」的较低者(只削不填,符合削坡治理);
 *  - 多条线取目标高程最低值。
 */
export function buildDesignSurface(grid: ElevationGrid, cutLines: CutLine[], name: string): DesignBuildResult {
  const designed = new Float64Array(grid.heights); // 默认维持现状
  const target = new Float64Array(grid.rows * grid.cols).fill(Infinity);
  const { rows, cols, resolution, originX, originY } = grid;

  for (const line of cutLines) {
    if (line.points.length < 2) continue;
    const W = line.benchWidth;
    const n = line.slopeRatio;
    const H = line.benchHeight;
    const period = W + n * H;
    // 锚点:折线中点处现状高程
    const midSeg = Math.floor((line.points.length - 1) / 2);
    const ax = (line.points[midSeg][0] + line.points[midSeg + 1][0]) / 2;
    const ay = (line.points[midSeg][1] + line.points[midSeg + 1][1]) / 2;
    const anchorH = queryElevation(grid, ax, ay);
    // 影响半径:5 级台阶
    const radius = period * 5;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = originX + (c + 0.5) * resolution;
        const y = originY + (rows - 1 - r + 0.5) * resolution;
        const { dist } = distanceToPolyline(x, y, line.points);
        if (dist > radius) continue;
        const phase = dist % period;
        const level = Math.floor(dist / period);
        let zTarget: number;
        if (phase <= W) {
          // 平台
          zTarget = anchorH - level * H;
        } else {
          // 斜坡段:从本平台线性降到下一级平台
          const u = (phase - W) / (n * H);
          zTarget = anchorH - level * H - u * H;
        }
        const idx = r * cols + c;
        target[idx] = Math.min(target[idx], zTarget);
      }
    }
  }

  const delta = new Float64Array(grid.rows * grid.cols);
  for (let i = 0; i < target.length; i++) {
    if (!Number.isFinite(target[i])) {
      delta[i] = 0;
      continue;
    }
    const z = Math.min(grid.heights[i], target[i]);
    designed[i] = z;
    delta[i] = z - grid.heights[i]; // <=0
  }

  const surface: DesignSurface = {
    id: `design-${Date.now()}`,
    name,
    periodId: '',
    cutLines,
    heights: designed,
    rows,
    cols,
    resolution,
    originX,
    originY,
    createdAt: Date.now(),
  };
  const cellArea = resolution * resolution;
  let cut = 0;
  let fill = 0;
  for (const d of delta) {
    if (d < 0) cut += -d * cellArea;
    else if (d > 0) fill += d * cellArea;
  }
  return { surface, cutM3: cut, fillM3: fill, delta };
}

/** 设计面与任意现状期次重新求挖填(设计面复用到其它期次) */
export function cutFillAgainst(surface: DesignSurface, grid: ElevationGrid): { cutM3: number; fillM3: number; delta: Float64Array } {
  if (surface.rows !== grid.rows || surface.cols !== grid.cols) throw new Error('设计面与现状格网不匹配');
  const delta = new Float64Array(grid.rows * grid.cols);
  const cellArea = grid.resolution * grid.resolution;
  let cut = 0;
  let fill = 0;
  for (let i = 0; i < delta.length; i++) {
    delta[i] = surface.heights[i] - grid.heights[i];
    if (delta[i] < 0) cut += -delta[i] * cellArea;
    else if (delta[i] > 0) fill += delta[i] * cellArea;
  }
  return { cutM3: cut, fillM3: fill, delta };
}
