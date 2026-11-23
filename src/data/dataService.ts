/**
 * 数据引导:生成模拟采石场三期数据 -> Worker 切片入库 -> 坡度/台阶分析 ->
 * 填充应用仓库。所有重活在 Worker,UI 只接进度回调。
 */
import { generateMockDataset } from './mockGenerator';
import { appStore } from './appStore';
import { startSlicing } from './slicing';
import { analyzeSlopes } from '../core/slope';
import { detectBenches } from '../core/benches';
import { slopeGrid } from '../core/elevation';
import type { SurveyPeriod, TileJobState } from '../core/types';
import { tileKey } from '../core/types';

export interface BootstrapProgress {
  phase: 'generate' | 'slice-dem' | 'slice-ortho' | 'analyze' | 'done';
  periodName: string;
  ratio: number;
  message: string;
}

export async function bootstrapDemoData(onProgress: (p: BootstrapProgress) => void): Promise<void> {
  if (appStore.runtime.size > 0) return;
  onProgress({ phase: 'generate', periodName: '', ratio: 0, message: '生成三期采石场 DEM 与正射…' });
  const dataset = generateMockDataset({ size: 320, resolution: 0.5 });
  const site = appStore.currentSite!;

  for (let i = 0; i < dataset.periods.length; i++) {
    const p = dataset.periods[i];
    const period: SurveyPeriod = {
      id: p.id,
      siteId: site.id,
      name: p.name,
      surveyDate: p.surveyDate,
      resolution: dataset.resolution,
      rows: dataset.rows,
      cols: dataset.cols,
      originX: dataset.originX,
      originY: dataset.originY,
      tileStatus: 'slicing',
      remark: i === 0 ? '无人机 0.2m DEM(演示降采样到 0.5m)' : '季度复查',
    };

    onProgress({ phase: 'slice-dem', periodName: p.name, ratio: 0, message: `${p.name}:DEM 切片…` });
    await sliceLayer(period.id, 'dem', p.dem, (ratio) =>
      onProgress({ phase: 'slice-dem', periodName: p.name, ratio, message: `${p.name}:DEM 切片 ${(ratio * 100).toFixed(0)}%` }),
    );
    onProgress({ phase: 'slice-ortho', periodName: p.name, ratio: 0, message: `${p.name}:正射切片…` });
    await sliceLayer(period.id, 'ortho', p.ortho, (ratio) =>
      onProgress({ phase: 'slice-ortho', periodName: p.name, ratio, message: `${p.name}:正射切片 ${(ratio * 100).toFixed(0)}%` }),
    );

    period.tileStatus = 'ready';
    await appStore.upsertPeriod(period);

    onProgress({ phase: 'analyze', periodName: p.name, ratio: 0, message: `${p.name}:坡度分级与台阶识别…` });
    const slopes = slopeGrid(p.dem);
    const slopeResult = analyzeSlopes(p.dem, p.id, { minPatchCells: 24 });
    const benches = detectBenches(p.dem, p.id, slopes, { minCells: 32, elevationToleranceM: 2 });
    appStore.setRuntime({
      period,
      dem: p.dem,
      ortho: p.ortho,
      benches,
      patches: slopeResult.patches,
      slopeClasses: slopeResult.classes,
    });
    onProgress({ phase: 'analyze', periodName: p.name, ratio: 1, message: `${p.name}:分析完成` });
  }
  onProgress({ phase: 'done', periodName: '', ratio: 1, message: '三期数据就绪' });
}

async function sliceLayer(
  periodId: string,
  layer: 'dem' | 'ortho',
  grid: { rows: number; cols: number },
  onRatio: (r: number) => void,
): Promise<void> {
  const jobId = `job-${periodId}-${layer}`;
  const existing = await appStore.tileStore.getJob(jobId);
  if (existing?.status === 'done') {
    onRatio(1);
    return;
  }
  const tileSize = appStore.settings.tileSize;
  const handle = startSlicing(
    appStore.tileStore,
    {
      jobId,
      periodId,
      layer,
      tileSize,
      dem: layer === 'dem' ? (grid as never as import('../core/types').ElevationGrid) : undefined,
      image: layer === 'ortho' ? (grid as never as import('../core/types').ImageGrid) : undefined,
      existingJob: existing ?? undefined,
      onProgress: (done, total) => onRatio(done / total),
    },
    { createWorker: () => new Worker(new URL('../workers/sliceWorker.ts', import.meta.url), { type: 'module' }) },
  );
  await handle.promise;
}

/** 供设置页查看的作业状态汇总 */
export async function listJobs(): Promise<TileJobState[]> {
  return appStore.tileStore.listJobs();
}

export { tileKey };
