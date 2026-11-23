import { describe, it, expect } from 'vitest';
import {
  ringCellSet,
  expectedCellSet,
  ringCorner,
  toroidalAddress,
  planToroidalUpdate,
  applyToroidalUpdate,
  morphWeight,
  morphDecompose,
  coarseBilinear,
  decimateLevel,
  planGpuCache,
  focusIndex,
} from '../src/core/clipmap';

const N = 64;

describe('clipmap 环块覆盖不变量(I1):无重叠、无缝隙', () => {
  it('最细级整块恰好 N² 像元', () => {
    const set = ringCellSet(N, true);
    expect(set.size).toBe(N * N);
    const exp = expectedCellSet(N, true);
    expect(set).toEqual(exp);
  });

  it('非最细级框像元 = 全环减去内部半区,块间无重叠', () => {
    const set = ringCellSet(N, false);
    const exp = expectedCellSet(N, false);
    expect(set.size).toBe(exp.size);
    expect(set).toEqual(exp);
    // 内部半区确实不在框里
    const q = N / 4;
    expect(set.has(`${q + 1}:${q + 1}`)).toBe(false);
    // 外缘在框里
    expect(set.has(`0:0`)).toBe(true);
    expect(set.has(`${N - 1}:${N - 1}`)).toBe(true);
  });

  it('相邻两级在世界范围上严格衔接:细环外缘 = 粗环内缘', () => {
    // 级 l 覆盖半径 N/2 * d_l;级 l+1 内缘半径 N/4 * d_{l+1} = N/4 * 2 d_l = N/2 d_l
    const d = 1;
    const fineOuter = (N / 2) * d;
    const coarseInner = (N / 4) * (2 * d);
    expect(fineOuter).toBe(coarseInner);
  });
});

describe('环形纹理更新:只补新露出的条带', () => {
  it('地址映射是模 N 的双射', () => {
    const seen = new Set<number>();
    for (let g = -10; g < N + 10; g++) {
      const a = toroidalAddress(g, N);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(N);
      seen.add(a);
    }
    expect(seen.size).toBe(N);
  });

  it('单步平移只产生一行/列条带,上传量 O(N) 而非 O(N²)', () => {
    const oldR: [number, number] = [100, 200];
    const newR: [number, number] = [101, 200];
    const strips = planToroidalUpdate(oldR, newR, N);
    expect(strips).toHaveLength(1);
    expect(strips[0].axis).toBe('y');
    expect(strips[0].globalIndices).toEqual([100 + N]);
    // 环形地址 = 全局索引对 N 取模
    expect(strips[0].addresses).toEqual([toroidalAddress(100 + N, N)]);
  });

  it('应用更新后环内任意全局索引都能经环形地址读到采样器的最新值', () => {
    const oldR: [number, number] = [0, 0];
    const newR: [number, number] = [3, -2];
    const sampler = (gr: number, gc: number) => gr * 10000 + gc;
    // 旧环内容:按旧角 [0,0] 填充
    const tex = new Array<number>(N * N);
    for (let ar = 0; ar < N; ar++) for (let ac = 0; ac < N; ac++) tex[ar * N + ac] = sampler(oldR[0] + ar, oldR[1] + ac);
    const writes = applyToroidalUpdate(tex, N, oldR, newR, sampler);
    // 3 行 + 2 列,角部交叉像元重复写;上限 5N
    expect(writes).toBeLessThanOrEqual(5 * N);
    expect(writes).toBeGreaterThan(0);
    // 环纹理按环形地址存放:全局 (gr,gc) -> 纹理 [tor(gr), tor(gc)]
    for (let ar = 0; ar < N; ar++) {
      for (let ac = 0; ac < N; ac++) {
        const gr = newR[0] + ar;
        const gc = newR[1] + ac;
        const tr = toroidalAddress(gr, N);
        const tc = toroidalAddress(gc, N);
        expect(tex[tr * N + tc]).toBe(sampler(gr, gc));
      }
    }
  });

  it('焦点不动时零上传', () => {
    const tex = new Array<number>(N * N).fill(1);
    const writes = applyToroidalUpdate(tex, N, [5, 5], [5, 5], () => 9);
    expect(writes).toBe(0);
  });

  it('环角随焦点索引移动', () => {
    expect(ringCorner(1000, N)).toBe(1000 - N / 2);
    expect(focusIndex(1234.5, 0, 1, 0)).toBe(1234);
    // 级 1 间距 = base res 1 * 2^1 = 2:floor(1234.5 / 2)
    expect(focusIndex(1234.5, 0, 1, 1)).toBe(617);
    expect(focusIndex(1234.5, 100, 1, 1)).toBe(Math.floor((1234.5 - 100) / 2));
  });
});

describe('morph 过渡不变量(I2):外缘顶点精确落在粗格网双线性插值上', () => {
  it('权重在框内缘为 0、外缘为 1、中间单调', () => {
    const f = 1000;
    expect(morphWeight(f + N / 4, f, f, f, N)).toBe(0);
    expect(morphWeight(f + N / 2, f, f, f, N)).toBe(1);
    const w1 = morphWeight(f + N / 4 + 4, f, f, f, N);
    const w2 = morphWeight(f + N / 4 + 8, f, f, f, N);
    expect(w1).toBeGreaterThan(0);
    expect(w2).toBeGreaterThan(w1);
  });

  it('alpha=1 的奇数顶点:粗级 floor+分数分解可精确重建其位置与高程', () => {
    // 细级间距 d,粗级间距 2d。细索引 g=2k+1 -> 粗 floor=k, t=1,
    // 双线性位置 = 粗 k 与 k+1 的中点,恰为细像元 g 的位置。
    // 粗环角取 0,环形地址 = 粗全局索引对 cN 取模;顶点选在环覆盖 [0,cN) 内。
    const corner = 0;
    const gRow = 61; // 奇行:粗 floor 30,t=1,+1 邻居 31
    const gCol = 51; // 奇列:粗 floor 25,t=1,+1 邻居 26
    const dec = morphDecompose(gRow, gCol, 1000, 1000, N);
    expect(dec.coarseFloorRow).toBe(30);
    expect(dec.coarseFloorCol).toBe(25);
    expect(dec.tRow).toBe(1);
    expect(dec.tCol).toBe(1);
    // 粗环:高程为「粗全局索引」的线性函数。
    // morph alpha=1 时细奇顶点(floor=k, t=1)精确落到粗格网 (k+1) 角点上,
    // 与粗环三角形共面 —— 这是无 T 形接缝的几何保证(I2)。
    const cN = N / 2;
    const coarse = new Float32Array(cN * cN);
    for (let r = 0; r < cN; r++) for (let c = 0; c < cN; c++) coarse[r * cN + c] = r * 0.7 + c * 1.3;
    // t=1 双线性退化为粗 (floor+1) 角点值
    const fineValue = (dec.coarseFloorRow + 1) * 0.7 + (dec.coarseFloorCol + 1) * 1.3;
    const v = coarseBilinear(coarse, cN, dec.coarseFloorRow, dec.coarseFloorCol, dec.tRow, dec.tCol, corner, corner);
    expect(v).toBeCloseTo(fineValue, 5);
    // 偶索引 t=0 时退化为粗格网 floor 角点精确取值
    const even = morphDecompose(60, 50, 1000, 1000, N);
    const v0 = coarseBilinear(coarse, cN, even.coarseFloorRow, even.coarseFloorCol, 0, 0, corner, corner);
    expect(v0).toBeCloseTo(30 * 0.7 + 25 * 1.3, 5);
  });

  it('alpha=0 时保留细级原索引(无位移)', () => {
    const f = 1000;
    const g = f + 2; // 框内
    const dec = morphDecompose(g, g, f, f, N);
    expect(dec.alpha).toBe(0);
  });
});

describe('高程金字塔抽稀不变量(I3)', () => {
  it('粗级像元与细级对应点严格相等', () => {
    const rows = 16, cols = 16;
    const l0 = new Float64Array(rows * cols);
    for (let i = 0; i < l0.length; i++) l0[i] = Math.sin(i * 1.7) * 50;
    const l2 = decimateLevel(l0, rows, cols, 2);
    expect(l2.rows).toBe(4);
    expect(l2.cols).toBe(4);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      // 抽稀值以 Float32 存储,与 Float64 源值差一个 float32 舍入(亚毫米,远小于 1cm)
      expect(l2.data[r * 4 + c]).toBeCloseTo(l0[r * 4 * cols + c * 4], 5);
      expect(l2.data[r * 4 + c]).toBe(Math.fround(l0[r * 4 * cols + c * 4]));
    }
  });
});

describe('GPU 缓存预算:分配字节永不超过设置页上限', () => {
  it('预算内取最大层级,totalBytes <= budget', () => {
    const budget = 256 * 1024 * 1024;
    const plan = planGpuCache(budget, N, 12);
    expect(plan.totalBytes).toBeLessThanOrEqual(budget);
    expect(plan.fits).toBe(true);
    const perLevel = N * N * 8;
    expect(plan.levels).toBe(Math.min(12, Math.floor(budget / perLevel)));
  });

  it('预算极小时至少给 1 级且标记 fits=false 由 UI 拒绝/提示', () => {
    const tiny = 1024;
    const plan = planGpuCache(tiny, N, 12);
    expect(plan.levels).toBe(1);
    // 实际不可行:调用方需检查并提示调大预算或缩小 N
    expect(plan.fits).toBe(false);
  });

  it('默认设置下 8 级环缓存占用明确', () => {
    const plan = planGpuCache(256 * 1024 * 1024, N, 8);
    expect(plan.levels).toBe(8);
    expect(plan.totalBytes).toBe(8 * N * N * 8); // 2MB
  });
});
