/** 极简 DOM 构建辅助,避免引入框架 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | null | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'style' && typeof v === 'string') {
      el.setAttribute('style', v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtM3(n: number): string {
  return `${fmt(n, 1)} m³`;
}

export function toast(message: string, duration = 2600): void {
  const t = h('div', { class: 'toast' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), duration);
}
