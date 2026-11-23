/**
 * 切片 Worker:接收整幅 DEM/正射(结构化克隆传输,可 transfer),按瓦片清单
 * 逐片切分并回传。每个瓦片完成即回报,主控持久化到 TileStore;中断后重开
 * 任务时主控只下发未完成的瓦片 —— 断点续切不重做已完成部分。
 */
/// <reference lib="webworker" />
import type { ElevationGrid, ImageGrid, LayerKind } from '../core/types';
import { sliceElevationTile, sliceImageTile } from '../core/tiling';

export interface SliceRequest {
  type: 'start';
  jobId: string;
  periodId: string;
  layer: LayerKind;
  tileSize: number;
  levels: number;
  /** 待切清单 [level, tileRow, tileCol][](已剔除完成项) */
  queue: [number, number, number][];
  dem?: ElevationGrid;
  image?: ImageGrid;
}

export interface SliceProgress {
  type: 'tile';
  jobId: string;
  layer: LayerKind;
  level: number;
  tileRow: number;
  tileCol: number;
  demTile?: ReturnType<typeof sliceElevationTile>;
  imageTile?: ReturnType<typeof sliceImageTile>;
}

export interface SliceDone {
  type: 'done';
  jobId: string;
  processed: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<SliceRequest>) => {
  const req = ev.data;
  if (req.type !== 'start') return;
  let processed = 0;
  for (const [level, tr, tc] of req.queue) {
    if (req.layer === 'dem' && req.dem) {
      const tile = sliceElevationTile(req.dem, level, tr, tc, req.tileSize, req.periodId);
      const msg: SliceProgress = {
        type: 'tile', jobId: req.jobId, layer: 'dem',
        level, tileRow: tr, tileCol: tc, demTile: tile,
      };
      ctx.postMessage(msg, [tile.heights.buffer]);
    } else if (req.layer === 'ortho' && req.image) {
      const tile = sliceImageTile(req.image, level, tr, tc, req.tileSize, req.periodId);
      const msg: SliceProgress = {
        type: 'tile', jobId: req.jobId, layer: 'ortho',
        level, tileRow: tr, tileCol: tc, imageTile: tile,
      };
      ctx.postMessage(msg, [tile.rgba.buffer]);
    }
    processed++;
  }
  const done: SliceDone = { type: 'done', jobId: req.jobId, processed };
  ctx.postMessage(done);
};
