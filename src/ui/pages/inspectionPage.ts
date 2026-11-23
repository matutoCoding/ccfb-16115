/**
 * 三维巡查页:clipmap 三维视图 + 原始精度查询 + 量测 + 两期对比 + 坡度图斑。
 */
import { h, clear, fmt, toast } from '../dom';
import { appStore } from '../../data/appStore';
import { View3D, type PickedInfo } from '../../gpu/view3d';
import { SLOPE_CLASSES } from '../../core/types';
import { diffGrids, diffByBenches, diffColorRamp } from '../../core/diff';
import { detectPonds, pondStorage, flowAccumulation, catchmentAreaAt, benchInnerDrainage } from '../../core/hydrology';

let view: View3D | null = null;

export function renderInspectionPage(root: HTMLElement) {
  clear(root);
  const rt = appStore.activeRuntime;
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '三维巡查'), h('div', { class: 'sub' }, 'geometry clipmap 嵌套环跟随相机;取高程与量测永远走原始 DEM 双线性插值')),
  );
  root.append(head);

  if (!rt) {
    root.append(h('div', { class: 'empty' }, '请先在「测绘期次」生成并切片演示数据'));
    return;
  }
  const cur = rt;

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const viewer = h('div', { class: 'viewer' }, canvas);
  const hud = h('div', { class: 'hud' },
    h('span', { class: 'tag info' }, appStore.webgpuAvailable ? 'WebGPU clipmap' : 'CPU 预览'),
    h('span', { class: 'muted' }, '左键旋转 · Shift+拖拽平移 · 滚轮俯冲(3000m→20m) · 单击量测 · 双击清空'),
  );
  const pickBox = h('div', { class: 'pick' },
    h('div', { class: 'muted', style: 'margin-bottom:6px' }, '原始精度查询(双线性)'),
    row('高程 H', '—'), row('坡度', '—'), row('坡向', '—'), row('坐标 X', '—'), row('坐标 Y', '—'),
  );
  viewer.append(hud, pickBox);

  // 侧栏
  const periodSel = h('select', {}, ...appStore.periods.map((p) => h('option', { value: p.id, selected: p.id === rt.period.id ? 'true' : null }, p.name))) as HTMLSelectElement;
  periodSel.addEventListener('change', () => { appStore.activePeriodId = periodSel.value; appStore.emit(); });

  const modeBtns = [
    ['影像模式', 0], ['坡度分级', 1],
  ].map(([label, m]) => h('button', {
    class: Number(m) === 0 ? 'primary' : '',
    onclick: () => { view?.setMode(Number(m)); toast(String(label)); },
  }, String(label)));

  // 坡度分级统计
  const slopeStats = SLOPE_CLASSES.map((info) => {
    const dem = rt.dem;
    let area = 0;
    const cell = dem.resolution * dem.resolution;
    if (rt.slopeClasses) for (let i = 0; i < rt.slopeClasses.length; i++) if (rt.slopeClasses[i] === info.cls) area += cell;
    return h('div', { class: 'legend-row' },
      h('span', { class: 'swatch', style: `background:rgb(${info.color.join(',')})` }),
      h('span', { style: 'flex:1' }, `${info.label} · ${info.measure}`),
      h('span', { class: 'mono' }, `${fmt(area, 0)} m²`),
    );
  });

  // 两期对比
  const compareSel = h('select', {}, ...appStore.periods.filter((p) => p.id !== rt.period.id).map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
  const diffSummary = h('div', {});
  const benchDiffTable = h('div', { style: 'max-height:240px;overflow:auto' });

  function runDiff() {
    const oldRt = appStore.runtime.get(cur.period.id);
    const newRt = appStore.runtime.get(compareSel.value);
    if (!oldRt || !newRt) return;
    const d = diffGrids(oldRt.dem, newRt.dem, appStore.settings.diffThresholdM);
    clear(diffSummary);
    diffSummary.append(
      h('div', { class: 'grid-2' },
        h('div', { class: 'stat' }, h('div', { class: 'num', style: 'color:var(--danger)' }, fmt(d.cutM3, 0)), h('div', { class: 'lbl' }, '削方 m³')),
        h('div', { class: 'stat' }, h('div', { class: 'num', style: 'color:var(--accent-2)' }, fmt(d.fillM3, 0)), h('div', { class: 'lbl' }, '回填 m³')),
      ),
    );
    const stats = diffByBenches(d, newRt.benches);
    clear(benchDiffTable);
    benchDiffTable.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '台阶'), h('th', {}, '削方 m³'), h('th', {}, '回填 m³'), h('th', {}, '净 m³'))),
      h('tbody', {}, ...stats.map((s) => h('tr', {},
        h('td', {}, s.benchName),
        h('td', { class: 'mono' }, fmt(s.cutM3, 0)),
        h('td', { class: 'mono' }, fmt(s.fillM3, 0)),
        h('td', { class: 'mono' }, fmt(s.netM3, 0)),
      ))),
    ));
    // 差分着色色带说明
    toast('差分统计完成,红=削方 蓝=回填(色带见下)');
  }

  // 卷帘
  const swipeRange = h('input', { type: 'range', min: '0', max: '100', value: '50' }) as HTMLInputElement;
  const swipeInfo = h('div', { class: 'muted', style: 'font-size:12px' }, '拖动滑块对比两期正射(当前期在上层)');

  // 水文
  const hydroBox = h('div', {});
  function runHydro() {
    const dem = cur.dem;
    const acc = flowAccumulation(dem);
    const ponds = detectPonds(dem, 16);
    const rows2 = ponds.map((p) => {
      const spill = pondStorage(dem, p.mask, p.spillElevation, p.spillElevation);
      const half = pondStorage(dem, p.mask, p.spillElevation, (p.minElevation + p.spillElevation) / 2);
      // 坑心汇水面积
      let sr = 0, sc = 0, n = 0;
      for (let i = 0; i < p.mask.length; i++) if (p.mask[i]) { sr += Math.floor(i / dem.cols); sc += i % dem.cols; n++; }
      sr /= Math.max(1, n); sc /= Math.max(1, n);
      const wx = dem.originX + (sc + 0.5) * dem.resolution;
      const wy = dem.originY + (dem.rows - 1 - sr + 0.5) * dem.resolution;
      const catchM2 = catchmentAreaAt(dem, acc, wx, wy);
      return h('tr', {},
        h('td', {}, p.id),
        h('td', { class: 'mono' }, fmt(p.spillElevation - p.minElevation, 2)),
        h('td', { class: 'mono' }, fmt(catchM2, 0)),
        h('td', { class: 'mono' }, fmt(half.volumeM3, 0)),
        h('td', { class: 'mono' }, fmt(spill.volumeM3, 0)),
        h('td', {}, h('button', { class: 'ghost', onclick: () => view?.flyTo(wx, wy, 90) }, '飞至')),
      );
    });
    clear(hydroBox);
    hydroBox.append(
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '积水坑'), h('th', {}, '水深m'), h('th', {}, '汇水m²'), h('th', {}, '半库 m³'), h('th', {}, '满库 m³'), h('th', {}, ''))),
        h('tbody', {}, ...(rows2.length ? rows2 : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, '未检测到封闭积水坑'))])),
      ),
    );
    // 台阶内侧排水沟走线(第一条台阶演示)
    const bench = cur.benches[0];
    if (bench) {
      let sr = 0, sc = 0, n = 0;
      for (let i = 0; i < bench.mask.length; i++) if (bench.mask[i]) { sr += Math.floor(i / dem.cols); sc += i % dem.cols; n++; }
      const centroid: [number, number] = [
        dem.originX + (sc / Math.max(1, n) + 0.5) * dem.resolution,
        dem.originY + (dem.rows - 1 - sr / Math.max(1, n) + 0.5) * dem.resolution,
      ];
      const line = benchInnerDrainage(dem, bench.mask, centroid).slice(0, 200);
      hydroBox.append(h('div', { class: 'muted mt', style: 'font-size:12.5px' },
        `${bench.name} 内侧排水沟走线 ${line.length} 个折点,沿台阶内侧贴坡布置`));
    }
  }

  const side = h('div', { class: 'side-panel' },
    h('div', { class: 'card' }, h('h3', {}, '当前期次'), periodSel),
    h('div', { class: 'card' }, h('h3', {}, '显示模式'), h('div', { class: 'flex wrap gap-sm' }, ...modeBtns)),
    h('div', { class: 'card' }, h('h3', {}, '坡度分级与措施'), ...slopeStats,
      h('button', { class: 'ghost mt', onclick: () => flyLargestPatch() }, '飞到最大图斑')),
    h('div', { class: 'card' },
      h('h3', {}, '两期对比'),
      h('div', { class: 'flex gap-sm' }, compareSel, h('button', { class: 'primary', onclick: runDiff }, '差分统计')),
      h('div', { class: 'mt' }, diffSummary),
      h('div', { class: 'mt' }, benchDiffTable),
      h('div', { class: 'mt' }, h('div', { class: 'muted mb', style: 'font-size:12px' }, '卷帘对比'), swipeRange, swipeInfo),
    ),
    h('div', { class: 'card' }, h('h3', {}, '水文:汇水/排水沟/库容'), h('button', { onclick: runHydro }, '计算水文'), h('div', { class: 'mt' }, hydroBox)),
  );

  const layout = h('div', { class: 'viewer-layout' }, viewer, side);
  root.append(layout);

  // 启动三维
  view = new View3D(canvas);
  view.onPick = (p: PickedInfo | null) => {
    if (!p) return;
    const vals = pickBox.querySelectorAll('.v');
    const set = (i: number, t: string) => { if (vals[i]) vals[i].textContent = t; };
    set(0, `${fmt(p.height, 3)} m`);
    set(1, `${fmt(p.slopeDeg, 2)}°`);
    set(2, `${fmt(p.aspectDeg, 1)}°`);
    set(3, fmt(p.x, 2));
    set(4, fmt(p.y, 2));
  };
  view.onMeasure = (m) => {
    if (!m) return;
    toast(`水平 ${fmt(m.horizontalM, 2)}m · 表面 ${fmt(m.surfaceM, 2)}m · 高差 ${fmt(m.verticalM, 2)}m`, 4000);
  };
  void view.start();
  (window as unknown as { __view3d: View3D }).__view3d = view;

  function flyLargestPatch() {
    const patch = cur.patches[0];
    if (!patch) return toast('暂无图斑');
    view?.flyTo(patch.centroid[0], patch.centroid[1], 100);
  }
}

function row(label: string, value: string) {
  return h('div', { class: 'row' }, h('span', { class: 'muted' }, label), h('span', { class: 'v' }, value));
}

// 供其它模块复用差分色带
export { diffColorRamp };
