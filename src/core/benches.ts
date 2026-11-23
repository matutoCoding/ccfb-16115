/**
 * 台阶自动识别:缓坡像元(平台)连通 + 高程带归并,自下而上编号。
 */
import type { Bench, ElevationGrid } from './types';
import { labelComponents } from './components';

export interface DetectBenchesOptions {
  /** 平台判定坡度(弧度),默认 ~8° */
  flatSlopeRad?: number;
  /** 最小平台像元数 */
  minCells?: number;
  /** 同台阶高程归并容差(米) */
  elevationToleranceM?: number;
}

export function detectBenches(
  grid: ElevationGrid,
  periodId: string,
  slopes: Float32Array,
  opts: DetectBenchesOptions = {},
): Bench[] {
  const flatSlope = opts.flatSlopeRad ?? (8 * Math.PI) / 180;
  const minCells = opts.minCells ?? 64;
  const tol = opts.elevationToleranceM ?? grid.resolution * 2;

  const mask = new Uint8Array(grid.rows * grid.cols);
  for (let i = 0; i < mask.length; i++) mask[i] = slopes[i] <= flatSlope ? 1 : 0;
  const { labels, count } = labelComponents(mask, grid.rows, grid.cols);

  interface Raw {
    label: number;
    meanElev: number;
    cells: number;
  }
  const raws: Raw[] = [];
  for (let l = 1; l <= count; l++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === l) {
        sum += grid.heights[i];
        n++;
      }
    }
    if (n >= minCells) raws.push({ label: l, meanElev: sum / n, cells: n });
  }
  // 高程带归并:均值高程接近的连通块视为同一台阶的不同段
  raws.sort((a, b) => a.meanElev - b.meanElev);
  const groups: Raw[][] = [];
  for (const r of raws) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(r.meanElev - averageElev(g)) <= tol) g.push(r);
    else groups.push([r]);
  }

  const cellArea = grid.resolution * grid.resolution;
  return groups.map((g, idx) => {
    const labelSet = new Set(g.map((x) => x.label));
    const bmask = new Uint8Array(grid.rows * grid.cols);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labelSet.has(labels[i])) {
        bmask[i] = 1;
        sum += grid.heights[i];
        n++;
      }
    }
    return {
      id: `${periodId}-bench-${idx + 1}`,
      periodId,
      index: idx + 1,
      name: `${idx + 1} 号台阶`,
      elevation: sum / Math.max(1, n),
      mask: bmask,
      areaM2: n * cellArea,
    };
  });
}

function averageElev(g: { meanElev: number; cells: number }[]): number {
  let s = 0;
  let n = 0;
  for (const x of g) {
    s += x.meanElev * x.cells;
    n += x.cells;
  }
  return s / Math.max(1, n);
}
