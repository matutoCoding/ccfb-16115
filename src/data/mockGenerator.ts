/**
 * 合成采石场测试数据(确定性,无外部依赖)。
 *
 * 场景要素:
 *  - 螺旋凹陷采坑,6 级台阶(平台 + 陡坎交替)
 *  - 东北-西南走向运输道(螺旋贴坡)
 *  - 北壁危岩陡坎(近直立,>70°)
 *  - 坑底积水坑(局部凹地)
 *  三期变化:
 *   P1 原始采坑;P2 上部两级削坡减载 + 坑底部分回填;
 *   P3 继续削坡 + 客土喷播平台(覆土抬高)。
 */
import type { ElevationGrid, ImageGrid } from '../core/types';

export interface MockDataset {
  rows: number;
  cols: number;
  resolution: number;
  originX: number;
  originY: number;
  periods: {
    id: string;
    name: string;
    surveyDate: string;
    dem: ElevationGrid;
    ortho: ImageGrid;
  }[];
}

/** 可复现伪随机(mulberry32) */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BENCH_LEVELS = 6;
const BENCH_H = 12;       // 每级高差 12m
const BENCH_W = 14;       // 平台宽 14m
const SLOPE_W = 8;        // 斜坡段水平宽 8m
const RING_STEP = BENCH_W + SLOPE_W;

/** 采坑中心(格网分数坐标)与各期参数 */
const CENTER = { r: 0.52, c: 0.46 };

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 基础地形:采坑分级曲面。period: 1/2/3 应用不同修复阶段改造 */
function terrainHeight(r: number, c: number, rows: number, cols: number, res: number, period: number): number {
  const cr = CENTER.r * rows;
  const cc = CENTER.c * cols;
  const dr = (r - cr) * res;
  const dc = (c - cc) * res;
  const dist = Math.hypot(dr, dc);
  const ang = Math.atan2(dr, dc);

  // 区域背景:缓丘,向北抬高
  let h = 120 + (rows - r) * res * 0.012 + Math.sin(c * 0.021) * 1.4 + Math.cos(r * 0.017) * 1.1;

  // 采坑半径范围
  const pitR = Math.min(rows, cols) * res * 0.42;
  const t = 1 - Math.min(1, dist / pitR); // 坑心 1 -> 坑外 0
  if (t > 0) {
    // 螺旋相位让运输道螺旋下降
    const spiral = (ang + Math.PI) / (Math.PI * 2);
    const phase = Math.max(0, dist / res + spiral * RING_STEP * 0.0);
    const ringIndex = Math.floor(phase / RING_STEP);
    const within = phase % RING_STEP;
    const benchCount = Math.min(BENCH_LEVELS, Math.floor(pitR / res / RING_STEP) + 1);
    // 坑心 ringIndex=0 即最低一级台阶,越往外级数越高;深度 = 总级数 - 当前级
    const depthIndex = Math.max(0, benchCount - 1 - ringIndex);
    // 平台 vs 斜坡
    const onSlope = within > BENCH_W;
    let pitFloor = h - depthIndex * BENCH_H;
    if (onSlope) {
      // 斜坡段向更高一级台阶爬升
      const u = (within - BENCH_W) / SLOPE_W;
      pitFloor = h - depthIndex * BENCH_H + u * BENCH_H;
    }
    // 坑口平滑过渡
    const edge = smoothstep(0, 14 / res, pitR - dist);
    h = h * (1 - edge) + pitFloor * edge;
  }

  // 运输道:沿东壁螺旋的缓坡廊道,宽度 6m,坡度 ~8%
  const roadTargetR = pitR * 0.55 + roadTargetOffset(ang, pitR);
  const roadDist = Math.abs(dist - roadTargetR);
  if (roadDist < 4 && t > 0.05) {
    const roadH = h - 1.2 * smoothstep(4, 0, roadDist);
    h = roadH;
  }

  // 北壁危岩陡坎:中心正北方向一段近直立面
  const north = Math.abs(ang - Math.PI / 2);
  if (north < 0.28 && dist > pitR * 0.25 && dist < pitR * 0.8) {
    const scarp = 9 * smoothstep(0.28, 0, north) * smoothstep(pitR * 0.25, pitR * 0.35, dist) * smoothstep(pitR * 0.8, pitR * 0.7, dist);
    h += scarp;
  }

  // 坑底积水坑:坑心附近椭圆封闭盆地。
  // 关键:盆内严格常量高程(压平一切背景坡度与噪声)、盆缘连续抬升,D8 才能识别为真洼地。
  const pondD = Math.hypot(dr / 16, dc / 22);
  if (pondD < 1.3 && dist < pitR * 0.34) {
    const floorLevel = h - 4.5;
    if (pondD <= 0.72) {
      h = floorLevel; // 绝对平底蓄水区
    } else {
      // 盆缘:从盆底强制抬升到周围地形以上,保证环绕闭合无溢流缺口
      const rim = smoothstep(0.72, 1.3, pondD);
      const rimHeight = Math.max(h, floorLevel + 2.0);
      h = floorLevel * (1 - rim) + rimHeight * rim;
    }
  }

  // 期次改造
  if (period >= 2) {
    // 上部两级削坡:坑口附近整体降低 2.5~4m(减载)
    const upper = smoothstep(pitR * 0.62, pitR * 0.78, dist) * smoothstep(pitR, pitR * 0.92, dist);
    h -= upper * 3.4;
    // 坑底回填 2m(避开积水盆地,盆地作为永久水处理设施保留)
    const back = smoothstep(pitR * 0.2, pitR * 0.1, dist) * smoothstep(0.9, 1.3, pondD);
    h += back * 2.0;
  }
  if (period >= 3) {
    // 继续削坡 1.8m
    const upper2 = smoothstep(pitR * 0.5, pitR * 0.66, dist) * smoothstep(pitR * 0.85, pitR * 0.78, dist);
    h -= upper2 * 1.8;
    // 客土喷播:中部平台覆土抬高 0.6m(被雨冲掉的局部区域在 ortho 里表现为裸斑)
    const mid = smoothstep(pitR * 0.45, pitR * 0.35, dist) * smoothstep(pitR * 0.75, pitR * 0.65, dist);
    h += mid * 0.6;
  }

  return h;
}

function roadTargetOffset(ang: number, _pitR: number): number {
  // 螺旋:随角度缓慢外扩
  return Math.sin(ang * 2) * 6;
}

export function generateMockDataset(opts: { size?: number; resolution?: number; seed?: number } = {}): MockDataset {
  const size = opts.size ?? 320;
  const resolution = opts.resolution ?? 0.5;
  const rows = size;
  const cols = size;
  const originX = 500000;
  const originY = 3400000;
  const rng = makeRng(opts.seed ?? 20260117);

  const periodMeta = [
    { id: 'p1', name: '2025 年四季度(治理前)', surveyDate: '2025-12-18' },
    { id: 'p2', name: '2026 年一季度(削坡回填)', surveyDate: '2026-03-22' },
    { id: 'p3', name: '2026 年二季度(客土喷播)', surveyDate: '2026-06-25' },
  ];

  const periods = periodMeta.map((meta, pi) => {
    const period = pi + 1;
    const heights = new Float64Array(rows * cols);
    const pitR = Math.min(rows, cols) * resolution * 0.42;
    // 积水盆统一常量高程(在 terrainHeight 之外强制压平,杜绝任何背景坡度残留)
    const basinCells = new Set<number>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const noise = (rng() - 0.5) * 0.25;
        let h = terrainHeight(r, c, rows, cols, resolution, period);
        const cr2 = CENTER.r * rows;
        const cc2 = CENTER.c * cols;
        const dist2 = Math.hypot((r - cr2) * resolution, (c - cc2) * resolution);
        const pondD2 = Math.hypot(((r - cr2) * resolution) / 16, ((c - cc2) * resolution) / 22);
        if (pondD2 <= 0.72 && dist2 < 0.34 * pitR) {
          basinCells.add(r * cols + c);
        } else {
          h += noise;
        }
        heights[r * cols + c] = h;
      }
    }
    // 用盆内最低值作为统一水面/盆底高程,保证盆内零坡度、盆缘环绕更高
    if (basinCells.size > 0) {
      let floor = Infinity;
      for (const idx of basinCells) floor = Math.min(floor, heights[idx]);
      for (const idx of basinCells) heights[idx] = floor;
    }
    const dem: ElevationGrid = { rows, cols, resolution, originX, originY, heights };
    const ortho = synthesizeOrtho(dem, period, rng);
    return { ...meta, dem, ortho };
  });

  return { rows, cols, resolution, originX, originY, periods };
}

/** 由高程 + 坡度合成正射:裸岩灰褐、平台覆土黄、植被绿、水面蓝、冲蚀裸斑 */
function synthesizeOrtho(grid: ElevationGrid, period: number, rng: () => number): ImageGrid {
  const { rows, cols, resolution } = grid;
  const rgba = new Uint8ClampedArray(rows * cols * 4);
  const at = (r: number, c: number) => grid.heights[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
  const cr = CENTER.r * rows;
  const cc = CENTER.c * cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = at(r, c);
      const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * resolution);
      const dy = (at(r + 1, c) - at(r - 1, c)) / (2 * resolution);
      const slopeDeg = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
      const dCenter = Math.hypot(r - cr, c - cc);
      const o = (r * cols + c) * 4;

      let R = 133, G = 122, B = 96; // 默认裸土
      if (slopeDeg > 55) {
        R = 118; G = 108; B = 102;   // 陡崖裸岩
      } else if (slopeDeg < 8) {
        if (dCenter < 36 && h < 60) {
          R = 58; G = 96; B = 138;   // 积水坑水面
        } else {
          R = 176; G = 150; B = 96;  // 平台覆土
        }
      }
      // 治理期植被
      if (period >= 2 && slopeDeg < 25 && dCenter > 30) {
        const veg = 0.35 + 0.3 * rng();
        R = R * (1 - veg) + 64 * veg;
        G = G * (1 - veg) + 142 * veg;
        B = B * (1 - veg) + 72 * veg;
      }
      if (period >= 3 && slopeDeg < 35) {
        const veg = 0.25 * rng();
        R = R * (1 - veg) + 70 * veg;
        G = G * (1 - veg) + 150 * veg;
        B = B * (1 - veg) + 80 * veg;
        // 雨冲裸斑:伪随机条带
        if (rng() < 0.04 && slopeDeg > 10) {
          R = 172; G = 140; B = 92;
        }
      }
      const shade = 0.85 + 0.3 * Math.max(0, -dy);
      rgba[o] = Math.min(255, R * shade + rng() * 10);
      rgba[o + 1] = Math.min(255, G * shade + rng() * 10);
      rgba[o + 2] = Math.min(255, B * shade + rng() * 10);
      rgba[o + 3] = 255;
    }
  }
  return { rows, cols, resolution, originX: grid.originX, originY: grid.originY, rgba };
}
