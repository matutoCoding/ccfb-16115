/**
 * 切片任务编排:清单生成、断点续切、进度回调。
 * 与 Worker 解耦 —— 核心队列裁剪逻辑 runSliceQueue 是纯函数式管线,
 * Node 测试直接用同步回调验证「中途失败 -> 重开只切剩余瓦片」。
 */
import type { ElevationGrid, ImageGrid, LayerKind, TileJobState, TileLevel } from '../core/types';
import { tileKey } from '../core/types';
import { buildPyramidLevels } from '../core/tiling';
import type { TileStore } from './store';

export function buildJobQueue(levels: TileLevel[]): [number, number, number][] {
  const q: [number, number, number][] = [];
  for (const lv of levels) {
    for (let r = 0; r < lv.tileRows; r++) {
      for (let c = 0; c < lv.tileCols; c++) q.push([lv.level, r, c]);
    }
  }
  return q;
}

/** 断点续切:剔除作业状态中已完成的 key,inflight 视为未完成重新入队 */
export function resumeQueue(fullQueue: [number, number, number][], job: TileJobState, periodId: string, layer: LayerKind): [number, number, number][] {
  const done = new Set<string>();
  for (const keys of Object.values(job.done)) for (const k of keys) done.add(k);
  return fullQueue.filter(([level, r, c]) => !done.has(tileKey(periodId, layer, level, r, c)));
}

export interface SliceHandle {
  promise: Promise<TileJobState>;
  cancel: () => void;
}

export interface SliceOrchestratorDeps {
  createWorker: () => Worker;
}

/**
 * 浏览器路径:起 Worker 切片,每片落库并更新 job 状态。
 * 刷新页面后调用方先从 store 读出 job(status=running),再次调用本函数即续切。
 */
export function startSlicing(
  store: TileStore,
  params: {
    jobId: string;
    periodId: string;
    layer: LayerKind;
    tileSize: number;
    dem?: ElevationGrid;
    image?: ImageGrid;
    existingJob?: TileJobState;
    onProgress?: (done: number, total: number) => void;
  },
  deps: SliceOrchestratorDeps,
): SliceHandle {
  const { jobId, periodId, layer, tileSize } = params;
  const grid = layer === 'dem' ? params.dem : params.image;
  if (!grid) throw new Error('缺少切片输入格网');
  const levels = buildPyramidLevels(grid.rows, grid.cols, tileSize).map((lv) => ({
    ...lv,
    resolution: grid.resolution * 2 ** lv.level,
  }));
  const full = buildJobQueue(levels);
  let cancelled = false;

  const job: TileJobState = params.existingJob ?? {
    jobId,
    periodId,
    layer,
    totalLevels: levels.length,
    done: {},
    inflight: [],
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  job.status = 'running';
  const queue = params.existingJob ? resumeQueue(full, params.existingJob, periodId, layer) : full;
  const total = full.length;

  const worker = deps.createWorker();
  const promise = new Promise<TileJobState>((resolve, reject) => {
    worker.onmessage = async (ev: MessageEvent) => {
      if (cancelled) return;
      const msg = ev.data;
      if (msg.type === 'tile') {
        if (msg.demTile) {
          await store.putElevation(msg.demTile);
          (job.done[msg.level] ??= []).push(msg.demTile.key);
        } else if (msg.imageTile) {
          await store.putImage(msg.imageTile);
          (job.done[msg.level] ??= []).push(msg.imageTile.key);
        }
        job.updatedAt = Date.now();
        await store.putJob({ ...job });
        const doneCount = Object.values(job.done).reduce((s, a) => s + a.length, 0);
        params.onProgress?.(doneCount, total);
      } else if (msg.type === 'done') {
        job.status = 'done';
        job.inflight = [];
        job.updatedAt = Date.now();
        await store.putJob({ ...job });
        worker.terminate();
        resolve(job);
      }
    };
    worker.onerror = (e) => {
      job.status = 'error';
      job.error = e.message;
      job.updatedAt = Date.now();
      store.putJob({ ...job });
      worker.terminate();
      reject(e);
    };
    // 源格网不 transfer:结构化克隆一份给 Worker,保留应用侧原始 DEM/正射
    // (量测与分析依赖它;transfer 会剥离缓冲区导致后续读取崩溃)。
    // 仅 Worker 回传的成品瓦片使用 transfer。
    const payload: Record<string, unknown> = {
      type: 'start', jobId, periodId, layer, tileSize,
      levels: levels.length, queue,
    };
    if (layer === 'dem' && params.dem) {
      payload.dem = params.dem;
    } else if (params.image) {
      payload.image = params.image;
    }
    worker.postMessage(payload);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      worker.terminate();
      job.status = 'pending';
      store.putJob({ ...job });
    },
  };
}
