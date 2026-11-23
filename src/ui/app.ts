/** 应用主框架与页面路由 */
import { h, clear } from './dom';
import { appStore } from '../data/appStore';
import { renderSitePage } from './pages/sitePage';
import { renderPeriodPage } from './pages/periodPage';
import { renderInspectionPage } from './pages/inspectionPage';
import { renderDesignPage } from './pages/designPage';
import { renderAcceptancePage } from './pages/acceptancePage';
import { renderSettingsPage } from './pages/settingsPage';

export type PageId = 'site' | 'period' | 'inspection' | 'design' | 'acceptance' | 'settings';

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: 'site', label: '矿区档案', icon: '⛰' },
  { id: 'period', label: '测绘期次', icon: '🛰' },
  { id: 'inspection', label: '三维巡查', icon: '🧭' },
  { id: 'design', label: '治理设计', icon: '✏' },
  { id: 'acceptance', label: '验收台账', icon: '📋' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

let current: PageId = 'site';

export function navigate(page: PageId) {
  current = page;
  render();
}

export function render() {
  const root = document.getElementById('app')!;
  clear(root);
  const shell = h('div', { class: 'app-shell' });

  const navItems = NAV.map((n) =>
    h('div', {
      class: `nav-item ${current === n.id ? 'active' : ''}`,
      onclick: () => navigate(n.id),
    }, h('span', { class: 'ico' }, n.icon), n.label),
  );

  const sidebar = h('div', { class: 'sidebar' },
    h('div', { class: 'brand' }, '矿山复绿三维巡查', h('small', {}, '与治理设计系统 · WebGPU')),
    ...navItems,
    h('div', { class: 'foot' },
      appStore.webgpuAvailable ? 'WebGPU 已就绪' : 'WebGPU 不可用 · CPU 预览',
      h('div', { style: 'margin-top:6px' }, `环缓存预算 ${(appStore.settings.gpuCacheBudgetBytes / 1024 / 1024).toFixed(0)} MB`),
    ),
  );

  const main = h('div', { class: 'main' });
  const renderers: Record<PageId, () => void> = {
    site: () => renderSitePage(main),
    period: () => renderPeriodPage(main),
    inspection: () => renderInspectionPage(main),
    design: () => renderDesignPage(main),
    acceptance: () => renderAcceptancePage(main),
    settings: () => renderSettingsPage(main),
  };
  renderers[current]();

  shell.append(sidebar, main);
  root.append(shell);
}

/**
 * 全局订阅不做整页重渲染(会与导航竞争、并销毁三维画布)。
 * 数据变化后需要刷新的页面,在自身动作末尾显式调用对应 render*。
 * 这里仅保留订阅入口,供未来的轻量徽标更新使用。
 */
appStore.subscribe(() => {
  // 导航状态由 navigate() 显式驱动;此处刻意不调用 render()。
});
