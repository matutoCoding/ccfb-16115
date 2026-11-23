import './ui/styles.css';
import { appStore } from './data/appStore';
import { render } from './ui/app';

// 调试与端到端验证探针(只读用途)
if (typeof window !== 'undefined') {
  (window as unknown as { __appStore: typeof appStore }).__appStore = appStore;
}

async function main() {
  await appStore.loadSettings();
  await appStore.loadSites();
  await appStore.loadPeriods();
  render();
}

main().catch((e) => {
  console.error(e);
  document.getElementById('app')!.innerHTML =
    `<div style="padding:40px;color:#ef4444;font-family:sans-serif">启动失败:${String(e)}</div>`;
});
