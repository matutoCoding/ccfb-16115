/**
 * GPU 环形缓存:每级一对 R32 高程纹理 + RGBA8 影像纹理(N×N)。
 *
 * 硬性约束:
 *  - 总字节数由 planGpuCache 在设置页预算内规划,本类实际分配不超过预算;
 *  - 焦点移动只 writeTexture 新露出的行/列条带,不整块重传;
 *  - 纹理采样按 toroidal(全局 mod N)寻址,与 core/clipmap 同语义。
 */
import { planToroidalUpdate, planGpuCache, focusIndex, type CachePlan } from '../core/clipmap';
import type { AppSettings } from '../core/types';

export interface RingSampler {
  height: (globalRow: number, globalCol: number, level: number) => number;
  image: (globalRow: number, globalCol: number, level: number) => [number, number, number, number];
}

interface GpuRing {
  level: number;
  resolution: number;
  heightTex: GPUTexture;
  imageTex: GPUTexture;
  /** 当前环角全局索引 [row, col] */
  corner: [number, number];
  /** 该层级全局格网尺寸 */
  gridRows: number;
  gridCols: number;
}

export class GpuRingCache {
  readonly plan: CachePlan;
  readonly budgetBytes: number;
  private rings: GpuRing[] = [];
  private device: GPUDevice;
  private allocatedBytes = 0;
  /** 累计上传字节与次数(设置页/诊断展示) */
  uploadedBytes = 0;
  uploadCount = 0;

  constructor(device: GPUDevice, settings: AppSettings, gridMeta: { rows: number; cols: number; resolution: number }) {
    this.device = device;
    this.budgetBytes = settings.gpuCacheBudgetBytes;
    this.plan = planGpuCache(this.budgetBytes, settings.clipmapSize, settings.clipmapLevels);
    const N = this.plan.N;
    for (let lvl = 0; lvl < this.plan.levels; lvl++) {
      const heightTex = device.createTexture({
        label: `dem-ring-L${lvl}`,
        size: [N, N],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const imageTex = device.createTexture({
        label: `ortho-ring-L${lvl}`,
        size: [N, N],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.rings.push({
        level: lvl,
        resolution: gridMeta.resolution * 2 ** lvl,
        heightTex,
        imageTex,
        corner: [Number.NaN, Number.NaN],
        gridRows: Math.ceil(gridMeta.rows / 2 ** lvl),
        gridCols: Math.ceil(gridMeta.cols / 2 ** lvl),
      });
      this.allocatedBytes += this.plan.bytesPerLevel;
    }
  }

  get bytesAllocated(): number {
    return this.allocatedBytes;
  }

  /** 分配字节数永远不超过设置页预算 */
  get withinBudget(): boolean {
    return this.allocatedBytes <= this.budgetBytes;
  }

  get levelCount(): number {
    return this.rings.length;
  }

  get ringSize(): number {
    return this.plan.N;
  }

  ring(l: number): GpuRing {
    return this.rings[l];
  }

  /**
   * 按焦点世界坐标更新所有环。首次填充整块(角从 NaN 初始化),之后只传条带。
   * 返回每级实际写入像元数,供诊断验证增量更新。
   */
  update(
    focusWorldX: number,
    focusWorldY: number,
    originX: number,
    originY: number,
    baseResolution: number,
    sampler: RingSampler,
  ): { perLevelWrites: number[]; totalWrites: number } {
    const N = this.plan.N;
    const perLevelWrites: number[] = [];
    let totalWrites = 0;

    for (const ring of this.rings) {
      const d = baseResolution * 2 ** ring.level;
      const fr = focusIndex(focusWorldY, originY, d, ring.level);
      const fc = focusIndex(focusWorldX, originX, d, ring.level);
      const newCorner: [number, number] = [fr - N / 2, fc - N / 2];
      let writes = 0;

      if (Number.isNaN(ring.corner[0])) {
        this.fillBlock(ring, newCorner[0], newCorner[1], N, sampler);
        writes = N * N * 2;
      } else {
        const strips = planToroidalUpdate(ring.corner, newCorner, N);
        for (const s of strips) {
          if (s.axis === 'y') {
            for (let k = 0; k < s.globalIndices.length; k++) {
              this.writeRowStrip(ring, s.globalIndices[k], s.addresses[k], N, sampler);
              writes += N * 2;
            }
          } else {
            for (let k = 0; k < s.globalIndices.length; k++) {
              this.writeColStrip(ring, s.globalIndices[k], s.addresses[k], N, sampler);
              writes += N * 2;
            }
          }
        }
      }
      ring.corner = newCorner;
      perLevelWrites.push(writes);
      totalWrites += writes;
    }
    return { perLevelWrites, totalWrites };
  }

  private clampGrid(ring: GpuRing, gr: number, gc: number): [number, number] {
    return [Math.max(0, Math.min(ring.gridRows - 1, gr)), Math.max(0, Math.min(ring.gridCols - 1, gc))];
  }

  private fillBlock(ring: GpuRing, r0: number, c0: number, N: number, sampler: RingSampler) {
    const hData = new Float32Array(N * N);
    const iData = new Uint8Array(N * N * 4);
    for (let ar = 0; ar < N; ar++) {
      for (let ac = 0; ac < N; ac++) {
        const [gr, gc] = this.clampGrid(ring, r0 + ar, c0 + ac);
        hData[ar * N + ac] = sampler.height(gr, gc, ring.level);
        const [rr, gg, bb, aa] = sampler.image(gr, gc, ring.level);
        const o = (ar * N + ac) * 4;
        iData[o] = rr; iData[o + 1] = gg; iData[o + 2] = bb; iData[o + 3] = aa;
      }
    }
    this.uploadHeight(ring, hData, N, N, 0, 0);
    this.uploadImage(ring, iData, N, N, 0, 0);
  }

  private writeRowStrip(ring: GpuRing, globalRow: number, addrRow: number, N: number, sampler: RingSampler) {
    const hData = new Float32Array(N);
    const iData = new Uint8Array(N * 4);
    const c0 = ring.corner[1];
    for (let ac = 0; ac < N; ac++) {
      const [gr, gc] = this.clampGrid(ring, globalRow, c0 + ac);
      hData[ac] = sampler.height(gr, gc, ring.level);
      const [rr, gg, bb, aa] = sampler.image(gr, gc, ring.level);
      iData[ac * 4] = rr; iData[ac * 4 + 1] = gg; iData[ac * 4 + 2] = bb; iData[ac * 4 + 3] = aa;
    }
    this.uploadHeight(ring, hData, N, 1, 0, addrRow);
    this.uploadImage(ring, iData, N, 1, 0, addrRow);
  }

  private writeColStrip(ring: GpuRing, globalCol: number, addrCol: number, N: number, sampler: RingSampler) {
    const hData = new Float32Array(N);
    const iData = new Uint8Array(N * 4);
    const r0 = ring.corner[0];
    for (let ar = 0; ar < N; ar++) {
      const [gr, gc] = this.clampGrid(ring, r0 + ar, globalCol);
      hData[ar] = sampler.height(gr, gc, ring.level);
      const [rr, gg, bb, aa] = sampler.image(gr, gc, ring.level);
      iData[ar * 4] = rr; iData[ar * 4 + 1] = gg; iData[ar * 4 + 2] = bb; iData[ar * 4 + 3] = aa;
    }
    this.uploadHeight(ring, hData, 1, N, addrCol, 0);
    this.uploadImage(ring, iData, 1, N, addrCol, 0);
  }

  private uploadHeight(ring: GpuRing, data: Float32Array, w: number, h: number, x: number, y: number) {
    const buf = new Float32Array(data.length);
    buf.set(data);
    this.device.queue.writeTexture(
      { texture: ring.heightTex, origin: { x, y } },
      buf.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );
    this.uploadedBytes += buf.byteLength;
    this.uploadCount++;
  }

  private uploadImage(ring: GpuRing, data: Uint8Array, w: number, h: number, x: number, y: number) {
    const buf = new Uint8Array(data.length);
    buf.set(data);
    this.device.queue.writeTexture(
      { texture: ring.imageTex, origin: { x, y } },
      buf.buffer,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );
    this.uploadedBytes += buf.byteLength;
    this.uploadCount++;
  }

  destroy() {
    for (const r of this.rings) {
      r.heightTex.destroy();
      r.imageTex.destroy();
    }
    this.rings = [];
  }
}
