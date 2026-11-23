/**
 * 全局核心类型定义 —— 纯数据,不依赖 DOM / WebGPU,可在 Node 测试中使用。
 */

/** 规则格网高程模型(原始精度,Float64 计算用) */
export interface ElevationGrid {
  /** 行数(纬度/行方向) */
  rows: number;
  /** 列数(经度/列方向) */
  cols: number;
  /** 格网间距,米 */
  resolution: number;
  /** 左下角原点 X(投影坐标,米) */
  originX: number;
  /** 左下角原点 Y(投影坐标,米) */
  originY: number;
  /** 长度 rows*cols,行优先,行 0 为最大 Y(北侧) */
  heights: Float64Array;
}

/** 正射影像格网(RGBA) */
export interface ImageGrid {
  rows: number;
  cols: number;
  resolution: number;
  originX: number;
  originY: number;
  /** 长度 rows*cols*4,0..255 */
  rgba: Uint8ClampedArray;
}

/** 瓦片金字塔层级 */
export interface TileLevel {
  level: number;
  /** 该层级分辨率 = 原始 resolution * 2^level */
  resolution: number;
  rows: number;
  cols: number;
  tileSize: number;
  /** 行方向瓦片数 */
  tileRows: number;
  /** 列方向瓦片数 */
  tileCols: number;
}

/** 一个切好的高程瓦片(自带 1 像元 halo,保证双线性查询不跨瓦片拼接) */
export interface ElevationTile {
  key: string;
  periodId: string;
  level: number;
  tileRow: number;
  tileCol: number;
  /** 含 halo 的边长(边缘瓦片可能小于 tileSize+2) */
  rows: number;
  cols: number;
  /** 不含 halo 的有效边长 */
  innerRows: number;
  innerCols: number;
  /** halo 内数据对应父格网的起始行 */
  dataStartRow: number;
  dataStartCol: number;
  heights: Float32Array;
}

/** 影像瓦片 */
export interface ImageTile {
  key: string;
  periodId: string;
  level: number;
  tileRow: number;
  tileCol: number;
  rows: number;
  cols: number;
  innerRows: number;
  innerCols: number;
  dataStartRow: number;
  dataStartCol: number;
  rgba: Uint8ClampedArray;
}

export type LayerKind = 'dem' | 'ortho';

/** 切片任务进度(IndexedDB 持久化,支持断点续切) */
export interface TileJobState {
  jobId: string;
  periodId: string;
  layer: LayerKind;
  totalLevels: number;
  /** 已完成瓦片 key 集合,按 level 分组 */
  done: Record<number, string[]>;
  /** 正在处理中的瓦片 key(崩溃恢复时重新入队) */
  inflight: string[];
  status: 'pending' | 'running' | 'done' | 'error';
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** 矿区档案 */
export interface MineSite {
  id: string;
  name: string;
  code: string;
  areaKm2: number;
  location: string;
  coordinateSystem: string;
  createdAt: number;
  remark: string;
}

/** 测绘期次 */
export interface SurveyPeriod {
  id: string;
  siteId: string;
  name: string;
  surveyDate: string;
  resolution: number;
  rows: number;
  cols: number;
  originX: number;
  originY: number;
  /** 切片状态 */
  tileStatus: 'none' | 'slicing' | 'ready' | 'error';
  tileJobId?: string;
  remark: string;
}

/** 台阶(从地形自动识别 + 人工命名) */
export interface Bench {
  id: string;
  periodId: string;
  index: number;
  name: string;
  /** 台阶平台代表高程 */
  elevation: number;
  /** 掩膜:rows*cols 的 Uint8,1 表示属于该台阶 */
  mask: Uint8Array;
  areaM2: number;
}

/** 坡度分级 */
export type SlopeClass = 0 | 1 | 2 | 3;

export interface SlopeClassInfo {
  cls: SlopeClass;
  label: string;
  rangeDeg: [number, number];
  measure: string;
  color: [number, number, number];
}

/** 图斑 */
export interface MapPatch {
  id: string;
  periodId: string;
  cls: SlopeClass;
  /** 多边形外环(投影坐标) */
  polygon: [number, number][];
  areaM2: number;
  centroid: [number, number];
}

/** 削坡设计线 */
export interface CutLine {
  id: string;
  name: string;
  /** 三维投影坐标点列 */
  points: [number, number][];
  /** 填平台宽度 m */
  benchWidth: number;
  /** 坡比 1:n(垂直:水平) */
  slopeRatio: number;
  /** 每级台阶高度 m */
  benchHeight: number;
}

/** 设计面 */
export interface DesignSurface {
  id: string;
  name: string;
  periodId: string;
  cutLines: CutLine[];
  /** 设计高程格网(与参照期次同格网) */
  heights: Float64Array;
  rows: number;
  cols: number;
  resolution: number;
  originX: number;
  originY: number;
  createdAt: number;
}

/** 挖填统计(按台阶) */
export interface CutFillStat {
  benchId: string;
  benchName: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  areaM2: number;
}

/** 验收台账条目 */
export interface AcceptanceItem {
  id: string;
  siteId: string;
  benchId: string;
  benchName: string;
  patchId?: string;
  measure: string;
  areaM2: number;
  /** 完成期次 */
  periodId: string;
  periodName: string;
  /** 照片拍摄位置(投影坐标 + 高程) */
  photoPositions: [number, number, number][];
  /** 危岩遗留标记:上期标记、本期仍在 */
  hazardCarried: boolean;
  status: 'pending' | 'done' | 'rework';
  remark: string;
}

/** 全局设置 */
export interface AppSettings {
  /** GPU 缓存总预算(字节) */
  gpuCacheBudgetBytes: number;
  /** 每级 clipmap 环边长(顶点数) */
  clipmapSize: number;
  clipmapLevels: number;
  /** 瓦片大小 */
  tileSize: number;
  /** 量测双线性容差(米),默认 0.01 */
  queryToleranceM: number;
  /** 差分着色阈值(米) */
  diffThresholdM: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  gpuCacheBudgetBytes: 256 * 1024 * 1024,
  clipmapSize: 64,
  clipmapLevels: 8,
  tileSize: 256,
  queryToleranceM: 0.01,
  diffThresholdM: 0.2,
};

export const SLOPE_CLASSES: SlopeClassInfo[] = [
  { cls: 0, label: '缓坡 <25°', rangeDeg: [0, 25], measure: '挂网喷播', color: [76, 175, 80] },
  { cls: 1, label: '中坡 25–45°', rangeDeg: [25, 45], measure: '植生袋', color: [255, 193, 7] },
  { cls: 2, label: '陡坡 45–70°', rangeDeg: [45, 70], measure: '鱼鳞坑', color: [255, 112, 67] },
  { cls: 3, label: '险坡 >70°', rangeDeg: [70, 90], measure: '危岩清理', color: [229, 57, 53] },
];

export function tileKey(periodId: string, layer: LayerKind, level: number, r: number, c: number): string {
  return `${periodId}/${layer}/L${level}/R${r}/C${c}`;
}

export function gridIndex(grid: { rows: number; cols: number }, r: number, c: number): number {
  return r * grid.cols + c;
}

export function gridToWorld(grid: { originX: number; originY: number; rows: number; resolution: number }, r: number, c: number): [number, number] {
  return [grid.originX + (c + 0.5) * grid.resolution, grid.originY + (grid.rows - 1 - r + 0.5) * grid.resolution];
}

export function worldToGrid(grid: { originX: number; originY: number; rows: number; cols: number; resolution: number }, x: number, y: number): [number, number] {
  const c = (x - grid.originX) / grid.resolution - 0.5;
  const r = grid.rows - 1 - ((y - grid.originY) / grid.resolution - 0.5);
  return [r, c];
}
