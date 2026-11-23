/**
 * 验收台账页:按台阶与图斑列措施/面积/完成期次/照片位置;
 * 点行三维飞至;上期标记危岩、本期仍在的图斑自动标红。
 */
import { h, clear, toast } from '../dom';
import { appStore } from '../../data/appStore';
import type { AcceptanceItem, MapPatch } from '../../core/types';
import { SLOPE_CLASSES } from '../../core/types';
import { View3D } from '../../gpu/view3d';
import { queryElevation } from '../../core/elevation';

let view: View3D | null = null;

/**
 * 危岩遗留判定:取当前期与上一期的 >70° 图斑,质心距离小于一个图斑半径
 * 即视为同一处危岩仍未清理。台账条目 hazardCarried 由本函数标记。
 */
export function detectCarriedHazards(prevPatches: MapPatch[], curPatches: MapPatch[]): Set<string> {
  const carried = new Set<string>();
  const prevHaz = prevPatches.filter((p) => p.cls === 3);
  const curHaz = curPatches.filter((p) => p.cls === 3);
  for (const cur of curHaz) {
    const radius = Math.sqrt(cur.areaM2 / Math.PI);
    for (const prev of prevHaz) {
      const d = Math.hypot(cur.centroid[0] - prev.centroid[0], cur.centroid[1] - prev.centroid[1]);
      if (d <= Math.max(radius, 8)) {
        carried.add(cur.id);
        break;
      }
    }
  }
  return carried;
}

export function renderAcceptancePage(root: HTMLElement) {
  clear(root);
  const rt = appStore.activeRuntime;
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '验收台账'), h('div', { class: 'sub' }, '措施按台阶与坡度图斑归档;上期危岩本期仍在的条目自动标红,点行三维飞至现场')),
  );
  root.append(head);
  if (!rt) {
    root.append(h('div', { class: 'empty' }, '请先在「测绘期次」生成数据'));
    return;
  }

  // 期次切换:默认当前期,可选择任一期查看其相对上一期的危岩遗留
  const periodSel = h('select', {}, ...appStore.periods.map((p) =>
    h('option', { value: p.id, selected: p.id === rt.period.id ? 'true' : null }, p.name),
  )) as HTMLSelectElement;
  const selCard = h('div', { class: 'card', style: 'padding:12px 18px' },
    h('div', { class: 'flex', style: 'justify-content:space-between' },
      h('div', {}, h('strong', {}, '台账期次:'), ' ', periodSel),
      h('span', { class: 'muted', style: 'font-size:12.5px' }, '切换到期次后,系统自动与上一期比对危岩图斑'),
    ),
  );
  periodSel.addEventListener('change', () => {
    appStore.activePeriodId = periodSel.value;
    renderAcceptancePage(root);
  });
  root.append(selCard);
  // 重新读取切换后的 runtime
  const cur = appStore.activeRuntime ?? rt;

  // 找上一期
  const idx = appStore.periods.findIndex((p) => p.id === cur.period.id);
  const prevRt = idx > 0 ? appStore.runtime.get(appStore.periods[idx - 1].id) : undefined;
  const carried = prevRt ? detectCarriedHazards(prevRt.patches, cur.patches) : new Set<string>();

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const viewer = h('div', { class: 'viewer' }, canvas,
    h('div', { class: 'hud' }, h('span', { class: 'tag danger' }, `危岩遗留 ${carried.size} 处`), h('span', { class: 'muted' }, '点击台账行飞至图斑')),
  );

  // 由图斑+台阶生成/合并台账条目
  const benchAt = (x: number, y: number): string => {
    for (const b of cur.benches) {
      // 质心反查像元
      const c = Math.round((x - cur.dem.originX) / cur.dem.resolution - 0.5);
      const r = Math.round(cur.dem.rows - 1 - ((y - cur.dem.originY) / cur.dem.resolution - 0.5));
      const i = r * cur.dem.cols + c;
      if (b.mask[i]) return b.name;
    }
    return '未归属台阶';
  };

  const existing = new Map(appStore.acceptance.map((a) => [a.patchId, a]));
  const rows = cur.patches.slice(0, 60).map((patch) => {
    const info = SLOPE_CLASSES[patch.cls];
    const benchName = benchAt(patch.centroid[0], patch.centroid[1]);
    const isHazard = carried.has(patch.id);
    const saved = existing.get(patch.id);
    const item: AcceptanceItem = saved ?? {
      id: `acc-${patch.id}`,
      siteId: appStore.currentSite!.id,
      benchId: benchName,
      benchName,
      patchId: patch.id,
      measure: info.measure,
      areaM2: patch.areaM2,
      periodId: cur.period.id,
      periodName: cur.period.name,
      photoPositions: [],
      hazardCarried: isHazard,
      status: isHazard ? 'rework' : 'pending',
      remark: isHazard ? '上期危岩未清理,本期仍在' : '',
    };
    if (isHazard) {
      item.hazardCarried = true;
      item.status = 'rework';
      item.remark = '上期危岩未清理,本期仍在';
    }
    return h('tr', {
      style: isHazard ? 'background:rgba(239,68,68,.12)' : '',
      onclick: () => {
        view?.flyTo(patch.centroid[0], patch.centroid[1], 80);
        toast(`飞至 ${info.measure} 图斑`);
      },
    },
      h('td', {}, item.benchName),
      h('td', {}, h('span', { class: 'swatch', style: `background:rgb(${info.color.join(',')})` }), info.measure),
      h('td', { class: 'mono' }, `${item.areaM2.toFixed(1)}`),
      h('td', {}, item.periodName),
      h('td', { class: 'mono' }, `${item.photoPositions.length} 张`),
      h('td', {}, statusTag(item.status, isHazard)),
      h('td', {}, h('button', {
        class: 'ghost',
        onclick: async (e) => {
          e.stopPropagation();
          const z = queryElevation(cur.dem, patch.centroid[0], patch.centroid[1]);
          item.photoPositions.push([patch.centroid[0], patch.centroid[1], z]);
          await appStore.saveAcceptance(item);
          toast(`已记录照片拍摄位置 (${patch.centroid[0].toFixed(1)}, ${patch.centroid[1].toFixed(1)}, H=${z.toFixed(2)})`);
          renderAcceptancePage(root);
        },
      }, '登记照片位置')),
    );
  });

  const tableCard = h('div', { class: 'card' },
    h('h3', {}, `台账条目(${rows.length},取面积前 60 个图斑)`),
    h('div', { style: 'max-height:48%;overflow:auto' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '台阶'), h('th', {}, '措施'), h('th', {}, '面积 m²'), h('th', {}, '完成期次'), h('th', {}, '照片'), h('th', {}, '状态'), h('th', {}, '操作'))),
        h('tbody', {}, ...rows),
      ),
    ),
  );

  const summary = h('div', { class: 'card' },
    h('h3', {}, '措施工作量汇总'),
    h('div', { class: 'grid-3' }, ...SLOPE_CLASSES.map((info) => {
      const area = cur.patches.filter((p) => p.cls === info.cls).reduce((s, p) => s + p.areaM2, 0);
      return h('div', { class: 'stat' }, h('div', { class: 'num' }, area.toFixed(0)), h('div', { class: 'lbl' }, `${info.measure} m²`));
    })),
  );

  const layout = h('div', { class: 'viewer-layout', style: 'grid-template-columns:1fr 380px' },
    viewer,
    h('div', { class: 'side-panel' }, summary, tableCard),
  );
  root.append(layout);

  view = new View3D(canvas);
  void view.start();
}

function statusTag(status: string, hazard: boolean) {
  if (hazard || status === 'rework') return h('span', { class: 'tag danger' }, '返工(危岩遗留)');
  if (status === 'done') return h('span', { class: 'tag ok' }, '已完成');
  return h('span', { class: 'tag warn' }, '待整改');
}
