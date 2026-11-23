/**
 * 坡度分级与图斑自动圈定。
 * 分级:<25° 挂网喷播 / 25–45° 植生袋 / 45–70° 鱼鳞坑 / >70° 危岩清理。
 */
import type { ElevationGrid, MapPatch, SlopeClass } from './types';
import { SLOPE_CLASSES } from './types';
import { slopeGrid, polygonArea } from './elevation';
import { labelComponents, marchingSquares } from './components';

export interface SlopeAnalysisResult {
  /** 每像元类别 */
  classes: Uint8Array;
  /** 每像元坡度(弧度) */
  slopes: Float32Array;
  patches: MapPatch[];
  /** 各分级统计面积 m² */
  areaByClass: Record<SlopeClass, number>;
}

export function classifySlope(slopeRad: Float32Array): Uint8Array {
  const out = new Uint8Array(slopeRad.length);
  for (let i = 0; i < slopeRad.length; i++) {
    const deg = (slopeRad[i] * 180) / Math.PI;
    if (deg < 25) out[i] = 0;
    else if (deg < 45) out[i] = 1;
    else if (deg < 70) out[i] = 2;
    else out[i] = 3;
  }
  return out;
}

/** 格网角点坐标 -> 世界坐标(角点 (r,c) 对应原点偏移) */
function cornerToWorld(grid: ElevationGrid, rCorner: number, cCorner: number): [number, number] {
  const x = grid.originX + cCorner * grid.resolution;
  const y = grid.originY + (grid.rows - rCorner) * grid.resolution;
  return [x, y];
}

export function analyzeSlopes(
  grid: ElevationGrid,
  periodId: string,
  opts: { minPatchCells?: number } = {},
): SlopeAnalysisResult {
  const minPatchCells = opts.minPatchCells ?? 16;
  const slopes = slopeGrid(grid);
  const classes = classifySlope(slopes);
  const areaByClass: Record<SlopeClass, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const cellArea = grid.resolution * grid.resolution;
  for (let i = 0; i < classes.length; i++) areaByClass[classes[i] as SlopeClass] += cellArea;

  const patches: MapPatch[] = [];
  for (const info of SLOPE_CLASSES) {
    const mask = new Uint8Array(classes.length);
    for (let i = 0; i < classes.length; i++) mask[i] = classes[i] === info.cls ? 1 : 0;
    const { labels } = labelComponents(mask, grid.rows, grid.cols);
    const rings = marchingSquares(labels, grid.rows, grid.cols, minPatchCells);
    const cellCount = new Map<number, number>();
    const sumR = new Map<number, number>();
    const sumC = new Map<number, number>();
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (!l) continue;
      cellCount.set(l, (cellCount.get(l) ?? 0) + 1);
      sumR.set(l, (sumR.get(l) ?? 0) + Math.floor(i / grid.cols));
      sumC.set(l, (sumC.get(l) ?? 0) + (i % grid.cols));
    }
    for (const [lab, ring] of rings) {
      const worldPoly = ring.map(([r, c]) => cornerToWorld(grid, r, c));
      const area = polygonArea(worldPoly);
      const n = cellCount.get(lab) ?? 1;
      const cr = (sumR.get(lab) ?? 0) / n;
      const cc = (sumC.get(lab) ?? 0) / n;
      const [cx, cy] = cornerToWorld(grid, cr + 0.5, cc + 0.5);
      patches.push({
        id: `${periodId}-slope-${info.cls}-${lab}`,
        periodId,
        cls: info.cls,
        polygon: worldPoly,
        areaM2: area,
        centroid: [cx, cy],
      });
    }
  }
  patches.sort((a, b) => b.areaM2 - a.areaM2);
  return { classes, slopes, patches, areaByClass };
}
