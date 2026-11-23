/** 治理设计页:削坡线 + 平台宽/坡比 -> 设计面 -> 挖填计算,设计面走同一 clipmap */
import { h, clear, fmt, toast } from '../dom';
import { appStore } from '../../data/appStore';
import { View3D } from '../../gpu/view3d';
import { buildDesignSurface, cutFillAgainst } from '../../core/design';
import type { CutLine } from '../../core/types';

let view: View3D | null = null;

export function renderDesignPage(root: HTMLElement) {
  clear(root);
  const rt = appStore.activeRuntime;
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '治理设计'), h('div', { class: 'sub' }, '在三维上布置削坡线,按平台宽与坡比实时生成设计面并求挖填;设计面与现状共用 clipmap 显示')),
  );
  root.append(head);
  if (!rt) {
    root.append(h('div', { class: 'empty' }, '请先在「测绘期次」生成数据'));
    return;
  }

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const viewer = h('div', { class: 'viewer' }, canvas,
    h('div', { class: 'hud' }, h('span', { class: 'tag info' }, '在地形上单击添加削坡线节点,双击结束一条线')),
  );

  const benchWidth = h('input', { type: 'number', value: '8', min: '2', step: '0.5' }) as HTMLInputElement;
  const slopeRatio = h('input', { type: 'number', value: '0.75', min: '0.1', step: '0.05' }) as HTMLInputElement;
  const benchHeight = h('input', { type: 'number', value: '10', min: '2', step: '1' }) as HTMLInputElement;
  const lineName = h('input', { value: '北壁削坡线' }) as HTMLInputElement;

  const resultBox = h('div', {});
  const points: [number, number][] = [];

  const side = h('div', { class: 'side-panel' },
    h('div', { class: 'card' },
      h('h3', {}, '削坡参数'),
      field('线名', lineName),
      field('填平台宽度 (m)', benchWidth),
      field('坡比 1:n(垂直:水平)', slopeRatio),
      field('每级台段高 (m)', benchHeight),
      h('div', { class: 'flex gap-sm mt' },
        h('button', {
          onclick: () => { points.length = 0; toast('已清空节点,在三维视图重新单击布点'); },
        }, '清空节点'),
        h('button', {
          class: 'primary',
          onclick: () => {
            if (points.length < 2) return toast('至少在地形上单击两个点');
            const line: CutLine = {
              id: `line-${Date.now()}`,
              name: lineName.value || '削坡线',
              points: [...points],
              benchWidth: Number(benchWidth.value),
              slopeRatio: Number(slopeRatio.value),
              benchHeight: Number(benchHeight.value),
            };
            const res = buildDesignSurface(rt.dem, [line], '治理方案一');
            res.surface.periodId = rt.period.id;
            const against = cutFillAgainst(res.surface, rt.dem);
            clear(resultBox);
            resultBox.append(
              h('div', { class: 'grid-2' },
                h('div', { class: 'stat' }, h('div', { class: 'num', style: 'color:var(--danger)' }, fmt(res.cutM3, 0)), h('div', { class: 'lbl' }, '设计挖方 m³')),
                h('div', { class: 'stat' }, h('div', { class: 'num' }, fmt(against.cutM3, 0)), h('div', { class: 'lbl' }, '对当前期次挖方 m³')),
              ),
              h('div', { class: 'muted mt', style: 'font-size:12.5px' },
                `设计面 ${res.surface.rows}×${res.surface.cols} 格网,只削不填;可切换期次重新求挖填。设计面高程格网与现状同构,复用同一套 clipmap 环渲染。`),
              h('button', {
                class: 'primary mt',
                onclick: async () => {
                  await appStore.saveDesign(res.surface);
                  toast('设计面已入库');
                },
              }, '保存设计面'),
            );
            // 用设计面替换内存 DEM 驱动三维显示(同一 View3D/clipmap 管线)
            const designRuntime = {
              ...rt,
              dem: { ...rt.dem, heights: res.surface.heights },
            };
            appStore.setRuntime(designRuntime);
            toast('已切换到设计面三维显示');
          },
        }, '生成设计面并求挖填'),
      ),
    ),
    h('div', { class: 'card' }, h('h3', {}, '计算结果'), resultBox),
    h('div', { class: 'card' },
      h('h3', {}, '已保存设计面'),
      h('div', { id: 'design-list' }, ...appStore.designs.map((d) =>
        h('div', { class: 'legend-row' }, h('span', { style: 'flex:1' }, d.name), h('span', { class: 'mono muted' }, new Date(d.createdAt).toLocaleDateString('zh-CN'))),
      )),
    ),
  );

  root.append(h('div', { class: 'viewer-layout' }, viewer, side));

  view = new View3D(canvas);
  view.onPick = (p) => {
    if (!p) return;
    points.push([p.x, p.y]);
    toast(`已添加 ${points.length} 个削坡线节点`);
  };
  void view.start();
}

function field(label: string, input: HTMLElement) {
  return h('label', { style: 'display:block;margin-bottom:10px' },
    h('div', { style: 'margin-bottom:4px;font-weight:600;font-size:13px' }, label), input);
}
