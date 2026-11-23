/**
 * Geometry Clipmap 纯逻辑(不依赖 GPU)。
 *
 * 层级 l:格网间距 d_l = res * 2^l,环边长 N(顶点/像元数),焦点为相机在
 * 该层级全局格网上的索引 f_l = floor(focus / d_l),环覆盖全局索引区间
 * [f_l - N/2, f_l + N/2)。
 *
 * 防裂缝三条不变量(均有测试守护):
 *  I1 同级环块并集 = 该级负责的全部像元,块间只在边界共享,无重叠无缝隙;
 *  I2 细环外缘 morph 权重为 1 时,奇数顶点的位置/高程恰好落在粗格网双边
 *     线性插值上,与粗环内缘三角形共面 -> 无 T 形接缝;
 *  I3 高程金字塔用抽稀(decimate)而非平均,粗级采样值与细级对应点严格相等。
 */

export interface RingBlock {
  name: 'full' | 'top' | 'bottom' | 'left' | 'right';
  row0: number;
  row1: number; // 不含
  col0: number;
  col1: number; // 不含
}

/** 本级要渲染的块:最细级整块,其余级只画框(内部被更细的环覆盖) */
export function buildRingBlocks(N: number, finest: boolean): RingBlock[] {
  if (N % 4 !== 0) throw new Error('clipmap N 必须是 4 的倍数');
  if (finest) {
    return [{ name: 'full', row0: 0, row1: N, col0: 0, col1: N }];
  }
  const h = N / 2;
  const q = N / 4;
  return [
    { name: 'top', row0: 0, row1: q, col0: 0, col1: N },
    { name: 'bottom', row0: q + h, row1: N, col0: 0, col1: N },
    { name: 'left', row0: q, row1: q + h, col0: 0, col1: q },
    { name: 'right', row0: q, row1: q + h, col0: q + h, col1: N },
  ];
}

/** 环块覆盖的像元集合(键 `r:c`),用于 I1 测试 */
export function ringCellSet(N: number, finest: boolean): Set<string> {
  const set = new Set<string>();
  for (const b of buildRingBlocks(N, finest)) {
    for (let r = b.row0; r < b.row1; r++) {
      for (let c = b.col0; c < b.col1; c++) set.add(`${r}:${c}`);
    }
  }
  return set;
}

/** 该级理论上应负责的像元(最细级整块,否则框) */
export function expectedCellSet(N: number, finest: boolean): Set<string> {
  const set = new Set<string>();
  const q = N / 4;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const inside = r >= q && r < q + N / 2 && c >= q && c < q + N / 2;
      if (finest || !inside) set.add(`${r}:${c}`);
    }
  }
  return set;
}

/** 环角索引(每轴):焦点索引 f -> 环最小全局索引 R */
export function ringCorner(focusIndex: number, N: number): number {
  return focusIndex - N / 2;
}

/** 全局索引 g 在 N×N 环纹理中的环形地址 */
export function toroidalAddress(g: number, N: number): number {
  const a = g % N;
  return a < 0 ? a + N : a;
}

export interface UpdateStrip {
  axis: 'x' | 'y';
  /** 新进入环的全局索引序列 */
  globalIndices: number[];
  /** 与 globalIndices 一一对应的环形纹理地址 */
  addresses: number[];
}

/**
 * 焦点移动后,计算需要补传的条带(只传新露出的行/列)。
 * oldR/newR 为两轴的环角全局索引 [rowCorner, colCorner]。
 *
 * 环形地址语义:环纹理位置 = toroidalAddress(全局索引, N),即全局索引直接
 * 对 N 取模。环平移后,新进入的全局索引恰好映射到被腾空的环尾地址。
 * addresses 与 globalIndices 一一对应,均为该取模结果。
 */
export function planToroidalUpdate(
  oldR: [number, number],
  newR: [number, number],
  N: number,
): UpdateStrip[] {
  const strips: UpdateStrip[] = [];
  (['y', 'x'] as const).forEach((axis, ai) => {
    const o = oldR[ai];
    const n = newR[ai];
    if (n === o) return;
    const globalIndices: number[] = [];
    const addresses: number[] = [];
    if (n > o) {
      for (let g = o + N; g < n + N; g++) {
        globalIndices.push(g);
        addresses.push(toroidalAddress(g, N));
      }
    } else {
      for (let g = n; g < o; g++) {
        globalIndices.push(g);
        addresses.push(toroidalAddress(g, N));
      }
    }
    strips.push({ axis, globalIndices, addresses });
  });
  return strips;
}

/**
 * 执行一次环形更新(纯数组模拟 GPU 纹理),采样器按全局索引取值。
 * 返回实际写入像元数 —— 测试用它证明移动一步的上传量为 O(N·|Δ|),不是 O(N²)。
 */
export function applyToroidalUpdate<T>(
  texture: T[],
  N: number,
  oldR: [number, number],
  newR: [number, number],
  sampler: (globalRow: number, globalCol: number) => T,
): number {
  if (texture.length !== N * N) throw new Error('环纹理尺寸不符');
  const strips = planToroidalUpdate(oldR, newR, N);
  let writes = 0;
  // 环纹理位置 = 全局索引对 N 取模。读取时同样用 toroidalAddress(全局,N)。
  // 顺序:先行(y)后列(x),双轴同时移动时交叉像元以列条带(最后写)为准,
  // 两者都直接取自 sampler,故交叉点最终仍是最新值。
  const yStrip = strips.find((s) => s.axis === 'y');
  const xStrip = strips.find((s) => s.axis === 'x');
  if (yStrip) {
    for (let k = 0; k < yStrip.globalIndices.length; k++) {
      const gr = yStrip.globalIndices[k];
      const ar = yStrip.addresses[k];
      for (let c = 0; c < N; c++) {
        const gc = newR[1] + c;
        texture[ar * N + toroidalAddress(gc, N)] = sampler(gr, gc);
        writes++;
      }
    }
  }
  if (xStrip) {
    for (let k = 0; k < xStrip.globalIndices.length; k++) {
      const gc = xStrip.globalIndices[k];
      const ac = xStrip.addresses[k];
      for (let r = 0; r < N; r++) {
        const gr = newR[0] + r;
        texture[toroidalAddress(gr, N) * N + ac] = sampler(gr, gc);
        writes++;
      }
    }
  }
  return writes;
}

/**
 * Morph 权重:细环(级 l)顶点向粗环(级 l+1)过渡的程度。
 * 框内缘(dmax=N/4)为 0,外缘(dmax=N/2)为 1,整框平滑过渡。
 */
export function morphWeight(globalRow: number, globalCol: number, focusRow: number, focusCol: number, N: number): number {
  const dmax = Math.max(Math.abs(globalRow - focusRow), Math.abs(globalCol - focusCol));
  const inner = N / 4;
  const outer = N / 2;
  if (dmax <= inner) return 0;
  if (dmax >= outer) return 1;
  return (dmax - inner) / (outer - inner);
}

export interface MorpedVertex {
  /** 粗格网 floor 索引与插值分数(每轴) */
  coarseFloorRow: number;
  coarseFloorCol: number;
  tRow: number;
  tCol: number;
  alpha: number;
}

/**
 * 细级顶点(级 l,间距 d)映射到粗级(间距 2d)的分解。
 * 全局索引 g:粗 floor = floor(g/2),分数 t = g mod 2。
 * alpha=1 时奇数顶点精确落在粗格网双线性插值位置(I2)。
 */
export function morphDecompose(
  globalRow: number,
  globalCol: number,
  focusRow: number,
  focusCol: number,
  N: number,
): MorpedVertex {
  return {
    coarseFloorRow: Math.floor(globalRow / 2),
    coarseFloorCol: Math.floor(globalCol / 2),
    tRow: globalRow % 2,
    tCol: globalCol % 2,
    alpha: morphWeight(globalRow, globalCol, focusRow, focusCol, N),
  };
}

/**
 * 粗环双线性高程。入参为粗级全局 floor 索引与插值分数。
 * 环纹理位置 = 全局索引对 coarseN 取模(与 planToroidalUpdate 同一语义);
 * cornerRow/Col 仅用于把 +1 邻居 clamp 在环覆盖的全局范围内。
 */
export function coarseBilinear(
  coarse: ArrayLike<number>,
  coarseN: number,
  floorRow: number,
  floorCol: number,
  tRow: number,
  tCol: number,
  cornerRow: number,
  cornerCol: number,
): number {
  const addr = (gr: number, gc: number) =>
    toroidalAddress(gr, coarseN) * coarseN + toroidalAddress(gc, coarseN);
  const r0 = clampIndex(floorRow, cornerRow, cornerRow + coarseN - 1);
  const c0 = clampIndex(floorCol, cornerCol, cornerCol + coarseN - 1);
  const r1 = clampIndex(floorRow + 1, cornerRow, cornerRow + coarseN - 1);
  const c1 = clampIndex(floorCol + 1, cornerCol, cornerCol + coarseN - 1);
  const h00 = coarse[addr(r0, c0)];
  const h01 = coarse[addr(r0, c1)];
  const h10 = coarse[addr(r1, c0)];
  const h11 = coarse[addr(r1, c1)];
  const a = h00 * (1 - tCol) + h01 * tCol;
  const b = h10 * (1 - tCol) + h11 * tCol;
  return a * (1 - tRow) + b * tRow;
}

function clampIndex(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 高程金字塔抽稀:级 l 的 (r,c) 取级 0 的 (r*2^l, c*2^l)。
 * 抽稀保证粗级值与细级对应点严格相等(I3);影像金字塔另用平均。
 */
export function decimateLevel(level0: ArrayLike<number>, rows: number, cols: number, level: number): {
  rows: number;
  cols: number;
  data: Float32Array;
} {
  const step = 2 ** level;
  const lr = Math.ceil(rows / step);
  const lc = Math.ceil(cols / step);
  const data = new Float32Array(lr * lc);
  for (let r = 0; r < lr; r++) {
    for (let c = 0; c < lc; c++) {
      data[r * lc + c] = level0[r * step * cols + c * step];
    }
  }
  return { rows: lr, cols: lc, data };
}

export interface CachePlan {
  levels: number;
  N: number;
  /** 每级字节数(高程 R32 + 影像 RGBA8,各 N²) */
  bytesPerLevel: number;
  totalBytes: number;
  fits: boolean;
}

/**
 * 按设置页定死的显存预算规划环缓存:在预算内取最大层级数。
 * 引擎实际分配字节数以本函数返回值为准,测试保证 totalBytes <= budget。
 */
export function planGpuCache(budgetBytes: number, N: number, maxLevels: number): CachePlan {
  const bytesPerLevel = N * N * 4 + N * N * 4;
  let levels = Math.min(maxLevels, Math.floor(budgetBytes / bytesPerLevel));
  if (levels < 1) levels = 1;
  const totalBytes = levels * bytesPerLevel;
  return { levels, N, bytesPerLevel, totalBytes, fits: totalBytes <= budgetBytes };
}

/** 焦点世界坐标 -> 某级全局格网索引 */
export function focusIndex(worldFocus: number, gridOrigin: number, resolution: number, level: number): number {
  const d = resolution * 2 ** level;
  return Math.floor((worldFocus - gridOrigin) / d);
}
