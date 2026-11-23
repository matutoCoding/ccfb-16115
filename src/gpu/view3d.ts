/**
 * 三维巡查视图:WebGPU clipmap 渲染 + 相机交互 + 原始精度取点。
 *
 * 取点/量测的高程永远来自内存原始 DEM 的双线性插值(core/elevation),
 * 与显示用的多级环缓存完全隔离 —— 显示可以用粗层级,量测绝不降级。
 * 无 WebGPU 时退化为 Canvas2D  hillshade 预览,功能逻辑不变。
 */
import { appStore } from '../data/appStore';
import { createCamera, screenRay, rayTerrainIntersect, type CameraState } from './camera';
import { queryElevation, sampleTerrain, measureProfile } from '../core/elevation';
import type { ElevationGrid } from '../core/types';

export interface PickedInfo {
  x: number;
  y: number;
  height: number;
  slopeDeg: number;
  aspectDeg: number;
}

export class View3D {
  canvas: HTMLCanvasElement;
  cam: CameraState;
  private raf = 0;
  private renderer: import('./renderer').TerrainRenderer | null = null;
  private fallback: FallbackHillshade | null = null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private measurePoints: [number, number][] = [];
  onPick: ((p: PickedInfo | null) => void) | null = null;
  onMeasure: ((m: ReturnType<typeof measureProfile> | null) => void) | null = null;
  /** 最近一次取点的调试信息(含未命中时的射线) */
  lastPickDebug: { ndc: [number, number]; hit: boolean; origin?: number[]; dir?: number[] } | null = null;
  private resizeObs: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const rt = appStore.activeRuntime;
    const dem = rt?.dem;
    const cx = dem ? dem.originX + (dem.cols * dem.resolution) / 2 : 0;
    const cy = dem ? dem.originY + (dem.rows * dem.resolution) / 2 : 0;
    this.cam = createCamera(cx, cy);
    if (dem) {
      // 初始距离按地形跨度自适应,保证整个矿区落在视锥内(仍保留 3000m 上限供缩放)
      const span = Math.max(dem.rows, dem.cols) * dem.resolution;
      this.cam.distance = Math.min(3000, Math.max(60, span * 1.8));
      this.cam.eyeHeight = queryElevation(dem, this.cam.targetX, this.cam.targetY) + this.cam.distance * 0.7;
    }

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.bindInput();
  }

  get dem(): ElevationGrid | undefined {
    return appStore.activeRuntime?.dem;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.cam.aspect = w / h;
    this.fallback?.resize(this.canvas.width, this.canvas.height);
  }

  async start() {
    this.resize();
    const period = appStore.activeRuntime?.period;
    if (appStore.webgpuAvailable && period) {
      try {
        const { TerrainRenderer } = await import('./renderer');
        this.renderer = await TerrainRenderer.create({
          canvas: this.canvas,
          settings: appStore.settings,
          store: appStore.tileStore,
          period,
        });
        // 异步预取瓦片,不阻塞首帧
        void this.renderer.ensureTiles(this.cam.targetX, this.cam.targetY);
      } catch (e) {
        console.warn('WebGPU 初始化失败,回退 hillshade:', e);
        this.renderer = null;
      }
    }
    if (!this.renderer) {
      this.fallback = new FallbackHillshade(this.canvas);
    }
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame() {
    // 贴地:注视点高程始终取原始 DEM
    const dem = this.dem;
    if (dem) {
      const ground = queryElevation(dem, this.cam.targetX, this.cam.targetY);
      const minEye = ground + Math.max(1.5, this.cam.distance * 0.02);
      if (this.cam.eyeHeight < minEye) this.cam.eyeHeight = minEye;
    }
    if (this.renderer) {
      void this.renderer.ensureTiles(this.cam.targetX, this.cam.targetY);
      this.renderer.render(this.cam);
    } else if (this.fallback) {
      this.fallback.render(this.cam, dem ?? null);
    }
  }

  setMode(mode: number) {
    if (this.renderer) this.renderer.setMode(mode);
    this.fallback?.setMode(mode);
  }

  flyTo(x: number, y: number, distance = 120) {
    this.cam.targetX = x;
    this.cam.targetY = y;
    this.cam.distance = distance;
    const dem = this.dem;
    if (dem) this.cam.eyeHeight = queryElevation(dem, x, y) + distance * 0.6;
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) {
        this.handleHover(e);
        return;
      }
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (e.shiftKey) {
        // 平移注视点
        const scale = this.cam.distance * 0.0015;
        this.cam.targetX -= Math.sin(this.cam.azimuth) * dx * scale + Math.cos(this.cam.azimuth) * dy * scale;
        this.cam.targetY -= Math.cos(this.cam.azimuth) * dx * scale - Math.sin(this.cam.azimuth) * dy * scale;
      } else {
        this.cam.azimuth -= dx * 0.005;
        this.cam.elevation = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, this.cam.elevation + dy * 0.004));
      }
    });
    c.addEventListener('pointerup', (e) => {
      this.dragging = false;
      try { c.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      // 3000m -> 20m 连续俯冲
      const factor = Math.exp(e.deltaY * 0.0012);
      this.cam.distance = Math.max(20, Math.min(6000, this.cam.distance * factor));
    }, { passive: false });
    c.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - this.lastX) > 3 || Math.abs(e.clientY - this.lastY) > 3) return;
      this.handleClick(e);
    });
    c.addEventListener('dblclick', () => {
      this.measurePoints = [];
      this.onMeasure?.(null);
    });
  }

  private ndc(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    return [x, y];
  }

  private pick(e: MouseEvent): PickedInfo | null {
    const dem = this.dem;
    if (!dem) return null;
    const [nx, ny] = this.ndc(e);
    const { origin: o, dir } = screenRay(this.cam, nx, ny);
    const hit = rayTerrainIntersect(
      o, dir,
      (x, y) => queryElevation(dem, x, y),
      { minX: dem.originX, minY: dem.originY, maxX: dem.originX + dem.cols * dem.resolution, maxY: dem.originY + dem.rows * dem.resolution },
    );
    this.lastPickDebug = { ndc: [nx, ny], hit: !!hit, origin: [...o], dir: [...dir] };
    if (!hit) return null;
    const s = sampleTerrain(dem, hit[0], hit[1]);
    return { x: hit[0], y: hit[1], height: s.height, slopeDeg: s.slopeDeg, aspectDeg: (s.aspectRad * 180) / Math.PI };
  }

  private handleHover(e: MouseEvent) {
    const p = this.pick(e);
    this.onPick?.(p);
  }

  private handleClick(e: MouseEvent) {
    const p = this.pick(e);
    if (!p) return;
    this.measurePoints.push([p.x, p.y]);
    if (this.measurePoints.length >= 2 && this.dem) {
      const m = measureProfile(this.dem, this.measurePoints);
      this.onMeasure?.(m);
    }
  }

  getMeasurePoints(): [number, number][] {
    return this.measurePoints;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer?.destroy();
  }
}

/**
 * 无 WebGPU 时的兜底:CPU hillshade 俯视图(仍用原始 DEM),
 * 保证在不支持的环境里功能可演示、量测精度不变。
 */
class FallbackHillshade {
  private ctx: CanvasRenderingContext2D;
  private mode = 0;
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }
  resize(_w: number, _h: number) { /* 尺寸读 canvas */ }
  setMode(m: number) { this.mode = m; }

  render(cam: CameraState, dem: ElevationGrid | null) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#171b22';
    ctx.fillRect(0, 0, w, h);
    if (!dem) return;
    const img = ctx.createImageData(w, h);
    const cx = cam.targetX;
    const cy = cam.targetY;
    const span = cam.distance * 1.6;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const wx = cx + ((px / w) - 0.5) * span * cam.aspect;
        const wy = cy + (0.5 - py / h) * span;
        const lx = (wx - dem.originX) / dem.resolution;
        const ly = dem.rows - 1 - (wy - dem.originY) / dem.resolution;
        const r0 = Math.max(0, Math.min(dem.rows - 2, Math.floor(ly)));
        const c0 = Math.max(0, Math.min(dem.cols - 2, Math.floor(lx)));
        const i = r0 * dem.cols + c0;
        const hr = dem.heights[i + dem.cols] - dem.heights[i];
        const hc = dem.heights[i + 1] - dem.heights[i];
        const shade = Math.max(0.25, Math.min(1, 0.6 + (hc - hr) * 0.08));
        const o = (py * w + px) * 4;
        let rr = 110 * shade, gg = 100 * shade, bb = 80 * shade;
        if (this.mode === 1) {
          const deg = (Math.atan(Math.hypot(hc, hr) / dem.resolution) * 180) / Math.PI;
          if (deg < 25) [rr, gg, bb] = [76 * shade, 175 * shade, 80 * shade];
          else if (deg < 45) [rr, gg, bb] = [255 * shade, 193 * shade, 7 * shade];
          else if (deg < 70) [rr, gg, bb] = [255 * shade, 112 * shade, 67 * shade];
          else [rr, gg, bb] = [229 * shade, 57 * shade, 53 * shade];
        }
        img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
