/** 矿区档案页 */
import { h, clear, fmt } from '../dom';
import { appStore } from '../../data/appStore';

export function renderSitePage(root: HTMLElement) {
  clear(root);
  const site = appStore.currentSite;
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '矿区档案'), h('div', { class: 'sub' }, '闭坑露天采石场基础信息与治理范围')),
  );
  if (!site) {
    root.append(head, h('div', { class: 'empty' }, '暂无矿区,请先在数据引导中载入演示数据'));
    return;
  }
  const totalArea = appStore.periods.reduce((s) => s, 0);
  void totalArea;
  const card = h('div', { class: 'card' },
    h('h3', {}, site.name),
    h('div', { class: 'grid-2' },
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, '矿区编号'), h('span', { class: 'mono' }, site.code),
        h('span', { class: 'k' }, '所在地'), h('span', {}, site.location),
        h('span', { class: 'k' }, '修复面积'), h('span', { class: 'mono' }, `${fmt(site.areaKm2, 2)} km²`),
        h('span', { class: 'k' }, '坐标系统'), h('span', {}, site.coordinateSystem),
        h('span', { class: 'k' }, '建档时间'), h('span', {}, new Date(site.createdAt).toLocaleDateString('zh-CN')),
        h('span', { class: 'k' }, '备注'), h('span', {}, site.remark),
      ),
      h('div', {},
        h('div', { class: 'grid-3' },
          stat('测绘期次', String(appStore.periods.length)),
          stat('识别台阶', String(appStore.activeRuntime?.benches.length ?? 0)),
          stat('坡度图斑', String(appStore.activeRuntime?.patches.length ?? 0)),
        ),
        h('div', { class: 'card mt', style: 'margin-bottom:0' },
          h('h3', {}, '季度巡查要求'),
          h('ul', { style: 'margin:0;padding-left:18px;color:var(--fg-dim);line-height:1.9' },
            h('li', {}, '每季度无人机航飞,产出 0.2m DEM 与正射影像'),
            h('li', {}, '削坡减载、客土喷播、危岩清理措施逐期对比核验'),
            h('li', {}, '三维巡查成果随验收台账归档,图斑可定位、可追溯'),
          ),
        ),
      ),
    ),
  );
  root.append(head, card);
}

function stat(lbl: string, num: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, lbl));
}
