/**
 * 多级瓦片切片与瓦片路径的原始精度查询。
 *
 * 每个瓦片自带 1 像元 halo:任意图内点做双线性插值所需的 4 个邻点都落在
 * 同一瓦片中,查询无需跨瓦片拼接。量测只允许访问 level 0(原始分辨率)。
 */
import type { ElevationGrid, ElevationTile, ImageGrid, ImageTile, TileLevel } from './types';
import { tileKey, worldToGrid } from './types';
import { clamp } from './elevation';

export function buildPyramidLevels(rows: number, cols: number, tileSize: number): TileLevel[] {
  const levels: TileLevel[] = [];
  let r = rows;
  let c = cols;
  let level = 0;
  while (true) {
    levels.push({
      level,
      resolution: 0, // 由调用方按 base resolution * 2^level 填
      rows: r,
      cols: c,
      tileSize,
      tileRows: Math.ceil(r / tileSize),
      tileCols: Math.ceil(c / tileSize),
    });
    if (r <= tileSize && c <= tileSize) break;
    r = Math.ceil(r / 2);
    c = Math.ceil(c / 2);
    level++;
  }
  return levels;
}

/** 切片任务总瓦片数(用于进度百分比) */
export function totalTileCount(levels: TileLevel[]): number {
  return levels.reduce((s, l) => s + l.tileRows * l.tileCols, 0);
}

/** 粗级像元对应的细级 2x2 窗口(右/下越界时收缩) */
function fineWindow(gr: number, gc: number, fineRows: number, fineCols: number): [number, number, number, number] {
  const r0 = gr * 2;
  const c0 = gc * 2;
  const r1 = Math.min(r0 + 1, fineRows - 1);
  const c1 = Math.min(c0 + 1, fineCols - 1);
  return [r0, c0, r1, c1];
}

/** 取某层级某点的高程(层级数据即时抽稀,Worker 中逐瓦片调用) */
export function samplePyramidHeight(grid: ElevationGrid, level: number, gr: number, gc: number): number {
  const step = 2 ** level;
  const r = Math.min(gr * step, grid.rows - 1);
  const c = Math.min(gc * step, grid.cols - 1);
  return grid.heights[r * grid.cols + c];
}

function levelDims(rows: number, cols: number, level: number): [number, number] {
  const step = 2 ** level;
  return [Math.ceil(rows / step), Math.ceil(cols / step)];
}

export function sliceElevationTile(grid: ElevationGrid, level: number, tr: number, tc: number, tileSize: number, periodId: string): ElevationTile {
  const [lrows, lcols] = levelDims(grid.rows, grid.cols, level);
  const innerR0 = tr * tileSize;
  const innerC0 = tc * tileSize;
  const innerRows = Math.min(tileSize, lrows - innerR0);
  const innerCols = Math.min(tileSize, lcols - innerC0);
  const dR0 = Math.max(0, innerR0 - 1);
  const dC0 = Math.max(0, innerC0 - 1);
  const dR1 = Math.min(lrows, innerR0 + innerRows + 1);
  const dC1 = Math.min(lcols, innerC0 + innerCols + 1);
  const rows = dR1 - dR0;
  const cols = dC1 - dC0;
  const heights = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = samplePyramidHeight(grid, level, dR0 + r, dC0 + c);
    }
  }
  return {
    key: tileKey(periodId, 'dem', level, tr, tc),
    periodId, level, tileRow: tr, tileCol: tc,
    rows, cols, innerRows, innerCols,
    dataStartRow: dR0, dataStartCol: dC0, heights,
  };
}

export function sliceImageTile(image: ImageGrid, level: number, tr: number, tc: number, tileSize: number, periodId: string): ImageTile {
  const step = 2 ** level;
  const lrows = Math.ceil(image.rows / step);
  const lcols = Math.ceil(image.cols / step);
  const innerR0 = tr * tileSize;
  const innerC0 = tc * tileSize;
  const innerRows = Math.min(tileSize, lrows - innerR0);
  const innerCols = Math.min(tileSize, lcols - innerC0);
  const dR0 = Math.max(0, innerR0 - 1);
  const dC0 = Math.max(0, innerC0 - 1);
  const dR1 = Math.min(lrows, innerR0 + innerRows + 1);
  const dC1 = Math.min(lcols, innerC0 + innerCols + 1);
  const rows = dR1 - dR0;
  const cols = dC1 - dC0;
  const rgba = new Uint8ClampedArray(rows * cols * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gr = dR0 + r;
      const gc = dC0 + c;
      // 影像金字塔:2x2 平均(halo 同样处理)
      const [fr0, fc0, fr1, fc1] = fineWindow(gr, gc, image.rows, image.cols);
      let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
      for (let fr = fr0; fr <= fr1; fr++) {
        for (let fc = fc0; fc <= fc1; fc++) {
          const i = (fr * image.cols + fc) * 4;
          ar += image.rgba[i]; ag += image.rgba[i + 1]; ab += image.rgba[i + 2]; aa += image.rgba[i + 3];
          n++;
        }
      }
      const o = (r * cols + c) * 4;
      rgba[o] = ar / n; rgba[o + 1] = ag / n; rgba[o + 2] = ab / n; rgba[o + 3] = aa / n;
    }
  }
  return {
    key: tileKey(periodId, 'ortho', level, tr, tc),
    periodId, level, tileRow: tr, tileCol: tc,
    rows, cols, innerRows, innerCols,
    dataStartRow: dR0, dataStartCol: dC0, rgba,
  };
}

export type TileLookup = (level: number, tr: number, tc: number) => ElevationTile | undefined;

/**
 * 从 level-0 瓦片做双线性高程查询。
 * 与 elevation.queryElevation 使用完全相同的 clamp 规则,存储为 Float32
 * 带来的舍入在亚毫米级,测试以 1cm 容差对拍。
 */
export function queryElevationFromTiles(
  meta: { rows: number; cols: number; originX: number; originY: number; resolution: number; tileSize: number },
  lookup: TileLookup,
  x: number,
  y: number,
): { height: number; inside: boolean } {
  const [rf, cf] = worldToGrid(meta, x, y);
  const inside = rf >= 0 && rf <= meta.rows - 1 && cf >= 0 && cf <= meta.cols - 1;
  const r0 = Math.floor(rf);
  const c0 = Math.floor(cf);
  const tr = rf - r0;
  const tc = cf - c0;
  const rLo = clamp(r0, 0, meta.rows - 1);
  const rHi = clamp(r0 + 1, 0, meta.rows - 1);
  const cLo = clamp(c0, 0, meta.cols - 1);
  const cHi = clamp(c0 + 1, 0, meta.cols - 1);

  const read = (gr: number, gc: number): number => {
    const tR = Math.floor(gr / meta.tileSize);
    const tC = Math.floor(gc / meta.tileSize);
    const tile = lookup(0, tR, tC);
    if (!tile) throw new Error(`瓦片缺失 L0 R${tR} C${tC}`);
    const lr = gr - tile.dataStartRow;
    const lc = gc - tile.dataStartCol;
    return tile.heights[lr * tile.cols + lc];
  };

  const h00 = read(rLo, cLo);
  const h01 = read(rLo, cHi);
  const h10 = read(rHi, cLo);
  const h11 = read(rHi, cHi);
  const h0 = h00 * (1 - tc) + h01 * tc;
  const h1 = h10 * (1 - tc) + h11 * tc;
  return { height: h0 * (1 - tr) + h1 * tr, inside };
}
