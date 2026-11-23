/** 设置页:显存缓存预算定死、clipmap 参数、量测容差 */
import { h, clear, toast } from '../dom';
import { appStore } from '../../data/appStore';
import { planGpuCache } from '../../core/clipmap';
import type { AppSettings } from '../../core/types';

export function renderSettingsPage(root: HTMLElement) {
  clear(root);
  const s = { ...appStore.settings };
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '设置'), h('div', { class: 'sub' }, 'GPU 缓存预算在此定死,运行期环缓存分配永不超过该上限')),
  );

  const budgetMb = h('input', { type: 'number', min: '32', step: '32', value: String(s.gpuCacheBudgetBytes / 1024 / 1024) }) as HTMLInputElement;
  const clipN = h('input', { type: 'number', min: '16', step: '16', value: String(s.clipmapSize) }) as HTMLInputElement;
  const clipLevels = h('input', { type: 'number', min: '2', max: '12', value: String(s.clipmapLevels) }) as HTMLInputElement;
  const tileSize = h('input', { type: 'number', min: '64', step: '64', value: String(s.tileSize) }) as HTMLInputElement;
  const tolerance = h('input', { type: 'number', min: '0.001', step: '0.005', value: String(s.queryToleranceM) }) as HTMLInputElement;
  const diffTh = h('input', { type: 'number', min: '0.05', step: '0.05', value: String(s.diffThresholdM) }) as HTMLInputElement;
  const planBox = h('div', { class: 'card' });

  function refreshPlan() {
    const plan = planGpuCache(Number(budgetMb.value) * 1024 * 1024, Number(clipN.value), Number(clipLevels.value));
    clear(planBox);
    planBox.append(
      h('h3', {}, '缓存规划(只读预览)'),
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, '实际层级'), h('span', { class: 'mono' }, `${plan.levels} 级`),
        h('span', { class: 'k' }, '每级字节'), h('span', { class: 'mono' }, `${(plan.bytesPerLevel / 1024).toFixed(1)} KB`),
        h('span', { class: 'k' }, '总分配'), h('span', { class: `mono ${plan.fits ? '' : ''}` }, `${(plan.totalBytes / 1024 / 1024).toFixed(2)} MB`),
        h('span', { class: 'k' }, '预算约束'),
        h('span', {}, plan.fits ? h('span', { class: 'tag ok' }, '满足,totalBytes ≤ budget') : h('span', { class: 'tag danger' }, '预算不足,需调大预算或缩小环边长')),
      ),
    );
  }
  for (const inp of [budgetMb, clipN, clipLevels]) inp.addEventListener('input', refreshPlan);
  refreshPlan();

  const save = h('button', {
    class: 'primary',
    onclick: async () => {
      const next: AppSettings = {
        gpuCacheBudgetBytes: Number(budgetMb.value) * 1024 * 1024,
        clipmapSize: Number(clipN.value),
        clipmapLevels: Number(clipLevels.value),
        tileSize: Number(tileSize.value),
        queryToleranceM: Number(tolerance.value),
        diffThresholdM: Number(diffTh.value),
      };
      const plan = planGpuCache(next.gpuCacheBudgetBytes, next.clipmapSize, next.clipmapLevels);
      if (!plan.fits) {
        toast('预算不足,该配置不会被保存');
        return;
      }
      await appStore.saveSettings(next);
      toast('设置已保存,下一次进入三维巡查生效');
    },
  }, '保存设置');

  const card = h('div', { class: 'card' },
    h('h3', {}, '显存与切片'),
    h('div', { class: 'grid-2' },
      field('GPU 缓存预算 (MB)', budgetMb, '高程 R32 + 影像 RGBA8 环纹理总字节上限'),
      field('Clipmap 环边长 N (像元)', clipN, '必须为 4 的倍数'),
      field('Clipmap 最大层级', clipLevels, '预算不足时自动收缩'),
      field('瓦片大小 (像元)', tileSize, 'IndexedDB 瓦片边长,含 1 像元 halo'),
      field('量测容差 (m)', tolerance, '双线性查询对拍阈值,默认 0.01m'),
      field('差分阈值 (m)', diffTh, '小于该高差视为稳定区'),
    ),
    h('div', { class: 'mt' }, save),
  );

  const diag = h('div', { class: 'card' },
    h('h3', {}, '运行环境'),
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'WebGPU'), h('span', {}, appStore.webgpuAvailable ? h('span', { class: 'tag ok' }, '可用') : h('span', { class: 'tag warn' }, '不可用,自动回退 CPU hillshade')),
      h('span', { class: 'k' }, 'IndexedDB'), h('span', { class: 'mono' }, 'mine-restore-db(瓦片/作业/元数据)'),
      h('span', { class: 'k' }, '量测数据源'), h('span', {}, '内存原始 DEM 双线性插值,与显示层级无关'),
    ),
  );

  root.append(head, card, planBox, diag);
}

function field(label: string, input: HTMLElement, hint: string) {
  return h('label', { style: 'display:block' },
    h('div', { style: 'margin-bottom:5px;font-weight:600' }, label),
    input,
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, hint),
  );
}
