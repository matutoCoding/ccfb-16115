/**
 * WebGPU clipmap 地形渲染器。
 *
 * 数据源是切片后的瓦片金字塔(经 TileStore 异步加载,内存 LRU 缓存)。
 * RingSampler 把「全局金字塔索引」翻译成瓦片内 halo 寻址;缺瓦片时回退到
 * 最近可用层级,保证视口内始终有地表。
 *
 * 量测不走这里:渲染只负责显示,任何高程/坡度查询都走 core/elevation 的
 * 原始 DEM 双线性路径(由应用层注入 heightQuery)。
 */
import type { TileStore } from '../data/store';
import type { AppSettings, ElevationTile, ImageTile, SurveyPeriod } from '../core/types';
import { TERRAIN_WGSL, LINE_WGSL } from './shaders';
import { GpuRingCache, type RingSampler } from './ringCache';
import { buildRingMeshes, TERRAIN_VERTEX_BUFFER_LAYOUT, type RingMesh } from './mesh';
import { viewProj, type CameraState } from './camera';

const LEVEL_UNIFORM_SIZE = 48; // 12 个 f32
const GLOBAL_UNIFORM_SIZE = 80;

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  settings: AppSettings;
  store: TileStore;
  period: SurveyPeriod;
}

export class TerrainRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private cache: GpuRingCache;
  private meshes: RingMesh[];
  private settings: AppSettings;
  private store: TileStore;
  private period: SurveyPeriod;
  private pipeline: GPURenderPipeline;
  private linePipeline: GPURenderPipeline;
  private globalBuffer: GPUBuffer;
  private levelBuffers: GPUBuffer[] = [];
  private coarseBuffers: GPUBuffer[] = [];
  private bindGroups: GPUBindGroup[] = [];
  private globalBindGroup: GPUBindGroup;
  private lineBuffer: GPUBuffer;
  private lineCount = 0;

  // 瓦片内存 LRU
  private demCache = new Map<string, ElevationTile>();
  private imgCache = new Map<string, ImageTile>();
  private demCacheBytes = 0;
  private imgCacheBytes = 0;
  private readonly lruBytes = 96 * 1024 * 1024;

  mode = 0;
  morphEnabled = 1;
  lastWrites: { perLevelWrites: number[]; totalWrites: number } | null = null;

  private constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, opts: RendererOptions) {
    this.device = device;
    this.context = context;
    this.settings = opts.settings;
    this.store = opts.store;
    this.period = opts.period;

    this.cache = new GpuRingCache(device, opts.settings, {
      rows: opts.period.rows,
      cols: opts.period.cols,
      resolution: opts.period.resolution,
    });
    this.meshes = buildRingMeshes(device, this.cache.ringSize, this.cache.levelCount);

    this.globalBuffer = device.createBuffer({ size: GLOBAL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lineBuffer = device.createBuffer({ size: 1024 * 1024, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    const module = device.createShaderModule({ code: TERRAIN_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [TERRAIN_VERTEX_BUFFER_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const lineModule = device.createShaderModule({ code: LINE_WGSL });
    this.linePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: lineModule,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module: lineModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.buildBindGroups();
    this.globalBindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globalBuffer } }],
    });
  }

  static async create(opts: RendererOptions): Promise<TerrainRenderer> {
    if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到可用 GPU 适配器');
    const device = await adapter.requestDevice();
    const context = opts.canvas.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    return new TerrainRenderer(device, context, format, opts);
  }

  get budgetBytes() { return this.settings.gpuCacheBudgetBytes; }
  get allocatedBytes() { return this.cache.bytesAllocated; }
  get withinBudget() { return this.cache.withinBudget; }
  get uploadedBytes() { return this.cache.uploadedBytes; }
  get uploadCount() { return this.cache.uploadCount; }

  private buildBindGroups() {
    for (let lvl = 0; lvl < this.cache.levelCount; lvl++) {
      const ring = this.cache.ring(lvl);
      const ub = this.device.createBuffer({ size: LEVEL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.levelBuffers.push(ub);
      const coarseLvl = Math.min(lvl + 1, this.cache.levelCount - 1);
      const coarseRing = this.cache.ring(coarseLvl);
      const cub = this.device.createBuffer({ size: LEVEL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.coarseBuffers.push(cub);
      const bg = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: ub } },
          { binding: 1, resource: ring.heightTex.createView() },
          { binding: 2, resource: ring.imageTex.createView() },
          { binding: 3, resource: { buffer: cub } },
          { binding: 4, resource: coarseRing.heightTex.createView() },
        ],
      });
      this.bindGroups.push(bg);
    }
  }

  private writeLevelUniform(buffer: GPUBuffer, level: number, corner: [number, number], focus: [number, number]) {
    const data = new Float32Array(LEVEL_UNIFORM_SIZE / 4);
    const res = this.period.resolution * 2 ** level;
    data.set([
      corner[0], corner[1], focus[0], focus[1],
      res, this.period.originX, this.period.originY, this.period.rows,
      0, 0, 0, 0,
    ]);
    this.device.queue.writeBuffer(buffer, 0, data);
  }

  /** 瓦片采样器:全局金字塔索引 -> 瓦片 halo 内寻址 */
  private makeSampler(): RingSampler {
    const ts = this.settings.tileSize;
    const period = this.period;
    void period;
    return {
      height: (gr, gc, level) => {
        const tr = Math.floor(gr / ts);
        const tc = Math.floor(gc / ts);
        const tile = this.lookupDem(level, tr, tc);
        if (!tile) return this.fallbackHeight(gr, gc, level);
        const lr = gr - tile.dataStartRow;
        const lc = gc - tile.dataStartCol;
        if (lr < 0 || lr >= tile.rows || lc < 0 || lc >= tile.cols) return this.fallbackHeight(gr, gc, level);
        return tile.heights[lr * tile.cols + lc];
      },
      image: (gr, gc, level) => {
        const tr = Math.floor(gr / ts);
        const tc = Math.floor(gc / ts);
        const tile = this.lookupImg(level, tr, tc);
        if (!tile) return [128, 128, 128, 255];
        const lr = gr - tile.dataStartRow;
        const lc = gc - tile.dataStartCol;
        if (lr < 0 || lr >= tile.rows || lc < 0 || lc >= tile.cols) return [128, 128, 128, 255];
        const o = (lr * tile.cols + lc) * 4;
        return [tile.rgba[o], tile.rgba[o + 1], tile.rgba[o + 2], tile.rgba[o + 3]];
      },
    };
  }

  private fallbackHeight(gr: number, gc: number, level: number): number {
    // 逐级降层,直到找到已缓存瓦片
    for (let dl = 1; level - dl >= 0; dl++) {
      const l = level - dl;
      const step = 2 ** dl;
      const tr = Math.floor(gr / step / this.settings.tileSize);
      const tc = Math.floor(gc / step / this.settings.tileSize);
      const tile = this.lookupDem(l, tr, tc);
      if (tile) {
        const lr = Math.floor(gr / step) - tile.dataStartRow;
        const lc = Math.floor(gc / step) - tile.dataStartCol;
        if (lr >= 0 && lr < tile.rows && lc >= 0 && lc < tile.cols) {
          return tile.heights[lr * tile.cols + lc];
        }
      }
    }
    return 0;
  }

  private lookupDem(level: number, tr: number, tc: number): ElevationTile | undefined {
    const key = `${this.period.id}/dem/L${level}/R${tr}/C${tc}`;
    return this.demCache.get(key);
  }
  private lookupImg(level: number, tr: number, tc: number): ImageTile | undefined {
    const key = `${this.period.id}/ortho/L${level}/R${tr}/C${tc}`;
    return this.imgCache.get(key);
  }

  /** 预取当前焦点各级环覆盖的瓦片到内存缓存(异步、非阻塞) */
  async ensureTiles(focusWorldX: number, focusWorldY: number): Promise<void> {
    const N = this.cache.ringSize;
    const jobs: Promise<void>[] = [];
    for (let lvl = 0; lvl < this.cache.levelCount; lvl++) {
      const d = this.period.resolution * 2 ** lvl;
      const fr = Math.floor((focusWorldY - this.period.originY) / d);
      const fc = Math.floor((focusWorldX - this.period.originX) / d);
      const r0 = fr - N / 2;
      const c0 = fc - N / 2;
      const ts = this.settings.tileSize;
      const trMin = Math.max(0, Math.floor(r0 / ts));
      const trMax = Math.floor((r0 + N) / ts);
      const tcMin = Math.max(0, Math.floor(c0 / ts));
      const tcMax = Math.floor((c0 + N) / ts);
      for (let tr = trMin; tr <= trMax; tr++) {
        for (let tc = tcMin; tc <= tcMax; tc++) {
          jobs.push(this.loadDemTile(lvl, tr, tc), this.loadImgTile(lvl, tr, tc));
        }
      }
    }
    await Promise.all(jobs);
  }

  private async loadDemTile(level: number, tr: number, tc: number): Promise<void> {
    const key = `${this.period.id}/dem/L${level}/R${tr}/C${tc}`;
    if (this.demCache.has(key)) return;
    const tile = await this.store.getElevation(key);
    if (!tile) return;
    this.demCache.set(key, tile);
    this.demCacheBytes += tile.heights.byteLength;
    this.evictDem();
  }

  private async loadImgTile(level: number, tr: number, tc: number): Promise<void> {
    const key = `${this.period.id}/ortho/L${level}/R${tr}/C${tc}`;
    if (this.imgCache.has(key)) return;
    const tile = await this.store.getImage(key);
    if (!tile) return;
    this.imgCache.set(key, tile);
    this.imgCacheBytes += tile.rgba.byteLength;
    this.evictImg();
  }

  private evictDem() {
    while (this.demCacheBytes + this.imgCacheBytes > this.lruBytes && this.demCache.size > 4) {
      const oldest = this.demCache.keys().next().value as string;
      this.demCacheBytes -= this.demCache.get(oldest)?.heights.byteLength ?? 0;
      this.demCache.delete(oldest);
    }
  }

  private evictImg() {
    while (this.demCacheBytes + this.imgCacheBytes > this.lruBytes && this.imgCache.size > 4) {
      const oldest = this.imgCache.keys().next().value as string;
      this.imgCacheBytes -= this.imgCache.get(oldest)?.rgba.byteLength ?? 0;
      this.imgCache.delete(oldest);
    }
  }

  setMode(mode: number) { this.mode = mode; }

  updateLines(points: [number, number, number][]) {
    if (points.length < 2) { this.lineCount = 0; return; }
    const verts: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      verts.push(...points[i], ...points[i + 1]);
    }
    const data = new Float32Array(verts);
    if (data.byteLength > this.lineBuffer.size) return;
    this.device.queue.writeBuffer(this.lineBuffer, 0, data);
    this.lineCount = (points.length - 1) * 2;
  }

  render(cam: CameraState) {
    // 1. 更新环缓存(只补条带)
    const sampler = this.makeSampler();
    this.lastWrites = this.cache.update(
      cam.targetX, cam.targetY,
      this.period.originX, this.period.originY,
      this.period.resolution, sampler,
    );

    // 2. 全局 uniform
    const viewProjMat = viewProj(cam).m;
    const guData = new Float32Array(GLOBAL_UNIFORM_SIZE / 4);
    guData.set(viewProjMat, 0);
    guData[16] = 0; guData[17] = 0; guData[18] = cam.eyeHeight + cam.distance;
    guData[19] = 0.4; guData[20] = 0.3; guData[21] = 0.86;
    guData[23] = this.mode;
    guData[24] = this.morphEnabled;
    this.device.queue.writeBuffer(this.globalBuffer, 0, guData);

    // 3. 各级 uniform
    for (let lvl = 0; lvl < this.cache.levelCount; lvl++) {
      const ring = this.cache.ring(lvl);
      const d = this.period.resolution * 2 ** lvl;
      const fr = Math.floor((cam.targetY - this.period.originY) / d);
      const fc = Math.floor((cam.targetX - this.period.originX) / d);
      this.writeLevelUniform(this.levelBuffers[lvl], lvl, ring.corner, [fr, fc]);
      const coarseLvl = Math.min(lvl + 1, this.cache.levelCount - 1);
      this.writeLevelUniform(this.coarseBuffers[lvl], coarseLvl, this.cache.ring(coarseLvl).corner, [
        Math.floor((cam.targetY - this.period.originY) / (this.period.resolution * 2 ** coarseLvl)),
        Math.floor((cam.targetX - this.period.originX) / (this.period.resolution * 2 ** coarseLvl)),
      ]);
    }

    // 4. 录制
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const depth = this.device.createTexture({
      size: [this.context.canvas.width, this.context.canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0.09, g: 0.11, b: 0.14, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.globalBindGroup);
    // 从最粗级向细级画,细级覆盖中心
    for (let lvl = this.cache.levelCount - 1; lvl >= 0; lvl--) {
      pass.setBindGroup(1, this.bindGroups[lvl]);
      const mesh = this.meshes[lvl];
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      pass.drawIndexed(mesh.indexCount);
    }
    if (this.lineCount > 0) {
      pass.setPipeline(this.linePipeline);
      pass.setVertexBuffer(0, this.lineBuffer);
      pass.draw(this.lineCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    depth.destroy();
  }

  destroy() {
    this.cache.destroy();
    for (const m of this.meshes) {
      m.vertexBuffer.destroy();
      m.indexBuffer.destroy();
    }
    this.globalBuffer.destroy();
    this.lineBuffer.destroy();
  }
}
