/**
 * 两期 DEM 差分与按台阶挖填统计。
 */
import type { Bench, ElevationGrid } from './types';
import { clamp } from './elevation';

export interface DiffResult {
  /** new - old,每像元 */
  delta: Float64Array;
  /** 分类:1 削方(负值<-阈值) 2 回填(正值>阈值) 0 稳定 */
  kind: Uint8Array;
  cutM3: number;
  fillM3: number;
  cellArea: number;
}

export function diffGrids(oldG: ElevationGrid, newG: ElevationGrid, thresholdM: number): DiffResult {
  if (oldG.rows !== newG.rows || oldG.cols !== newG.cols) {
    throw new Error('差分两期格网尺寸不一致');
  }
  const n = oldG.rows * oldG.cols;
  const delta = new Float64Array(n);
  const kind = new Uint8Array(n);
  let cut = 0;
  let fill = 0;
  const cellArea = oldG.resolution * oldG.resolution;
  for (let i = 0; i < n; i++) {
    const d = newG.heights[i] - oldG.heights[i];
    delta[i] = d;
    if (d < -thresholdM) {
      kind[i] = 1;
      cut += -d * cellArea;
    } else if (d > thresholdM) {
      kind[i] = 2;
      fill += d * cellArea;
    }
  }
  return { delta, kind, cutM3: cut, fillM3: fill, cellArea };
}

export interface BenchDiffStat {
  benchId: string;
  benchName: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  areaM2: number;
  maxCutM: number;
  maxFillM: number;
}

/** 按台阶掩膜拆分差分统计 */
export function diffByBenches(diff: DiffResult, benches: Bench[]): BenchDiffStat[] {
  return benches.map((b) => {
    let cut = 0, fill = 0, area = 0, maxCut = 0, maxFill = 0;
    for (let i = 0; i < b.mask.length; i++) {
      if (!b.mask[i]) continue;
      area += diff.cellArea;
      const d = diff.delta[i];
      if (diff.kind[i] === 1) {
        cut += -d * diff.cellArea;
        maxCut = Math.max(maxCut, -d);
      } else if (diff.kind[i] === 2) {
        fill += d * diff.cellArea;
        maxFill = Math.max(maxFill, d);
      }
    }
    return {
      benchId: b.id,
      benchName: b.name,
      cutM3: cut,
      fillM3: fill,
      netM3: fill - cut,
      areaM2: area,
      maxCutM: maxCut,
      maxFillM: maxFill,
    };
  });
}

/** 差分着色(RGB):蓝=回填,红=削方,灰=稳定,色深随量级 */
export function diffColorRamp(d: number, threshold: number, maxMag: number): [number, number, number] {
  const mag = clamp(Math.abs(d) / Math.max(maxMag, 1e-6), 0, 1);
  if (d < -threshold) return [220 - 80 * (1 - mag), 60, 50];
  if (d > threshold) return [40, 110, 220 - 80 * (1 - mag)];
  return [150, 150, 150];
}
