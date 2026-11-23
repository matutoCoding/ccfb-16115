/** 测绘期次页:数据导入与切片进度(Worker + 断点续切) */
import { h, clear, toast } from '../dom';
import { appStore } from '../../data/appStore';
import { bootstrapDemoData } from '../../data/dataService';

let booting = false;

export function renderPeriodPage(root: HTMLElement) {
  clear(root);
  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h2', {}, '测绘期次'), h('div', { class: 'sub' }, '每期 DEM 与正射在 Worker 切多级瓦片入 IndexedDB,中断刷新后自动续切')),
  );

  const statusTag = (s: string) => {
    if (s === 'ready') return h('span', { class: 'tag ok' }, '切片完成');
    if (s === 'slicing') return h('span', { class: 'tag warn' }, '切片中/可续切');
    return h('span', { class: 'tag info' }, '未开始');
  };

  const rows = appStore.periods.map((p) => {
    const rt = appStore.runtime.get(p.id);
    return h('tr', {},
      h('td', {}, p.name),
      h('td', { class: 'mono' }, p.surveyDate),
      h('td', { class: 'mono' }, `${p.rows}×${p.cols} @ ${p.resolution}m`),
      h('td', {}, statusTag(p.tileStatus)),
      h('td', { class: 'mono' }, (rt ? `${rt.benches.length} 台阶 / ${rt.patches.length} 图斑` : '—')),
      h('td', {}, h('button', {
        class: 'ghost',
        onclick: () => { appStore.activePeriodId = p.id; appStore.emit(); toast(`已切换到 ${p.name}`); },
      }, (appStore.activePeriodId === p.id ? '当前期次' : '设为当前'))),
    );
  });

  const tableContent = rows.length
    ? h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '期次'), h('th', {}, '航飞日期'), h('th', {}, '格网'),
          h('th', {}, '切片状态'), h('th', {}, '分析结果'), h('th', {}, '操作'),
        )),
        h('tbody', {}, ...rows),
      )
    : h('div', { class: 'empty' }, '尚未导入数据');
  const table = h('div', { class: 'card' }, h('h3', {}, '期次列表'), tableContent);
  const barFill = h('div', { style: 'width:0%' });
  const msg = h('div', { class: 'muted mt', style: 'font-size:12.5px' }, '等待开始…');
  const btn = h('button', {
    class: 'primary',
    disabled: booting ? 'true' : null,
    onclick: async () => {
      if (booting) return;
      booting = true;
      btn.setAttribute('disabled', 'true');
      btn.textContent = '处理中…';
      try {
        await bootstrapDemoData((p) => {
          msg.textContent = p.message;
          barFill.style.width = `${(p.ratio * 100).toFixed(1)}%`;
        });
        toast('三期数据与瓦片就绪');
      } catch (e) {
        console.error(e);
        toast('导入失败,详见控制台');
      } finally {
        booting = false;
        renderPeriodPage(root);
      }
    },
  }, (booting ? '处理中…' : '生成并切片演示数据(三期)'));

  const log = h('div', { class: 'card' },
    h('h3', {}, '导入与切片'),
    h('p', { class: 'muted', style: 'margin-top:0' }, '一键生成带 6 级台阶、运输道、危岩陡坎、积水坑的三期演示数据;切片在 Worker 执行,每片完成即落库,中途刷新页面重进本页会从断点继续。'),
    h('div', { class: 'flex' }, btn),
    h('div', { class: 'progress mt' }, barFill),
    msg,
  );

  const resumeNote = h('div', { class: 'card' },
    h('h3', {}, '断点续切说明'),
    h('ul', { style: 'margin:0;padding-left:18px;color:var(--fg-dim);line-height:1.9' },
      h('li', {}, '作业状态 TileJobState 记录每个已完成瓦片 key,持久化在 IndexedDB jobs 库'),
      h('li', {}, 'Worker 崩溃或页面刷新后,inflight 瓦片重新入队,已完成瓦片不重切'),
      h('li', {}, '每个瓦片自带 1 像元 halo,量测双线性插值无需跨瓦片拼接'),
    ),
  );

  root.append(head, table, log, resumeNote);
}
