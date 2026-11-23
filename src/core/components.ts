/**
 * 栅格连通组件与边界追踪(8 邻域,纯 TS)。
 */

/** 8 邻域连通标记(两遍 + 并查集),返回标签数组(0=背景)与组件数 */
export function labelComponents(mask: Uint8Array, rows: number, cols: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(rows * cols);
  const parent: number[] = [0];
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  let next = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!mask[idx]) continue;
      const nbr: number[] = [];
      for (let dr = -1; dr <= 0; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc >= 0) break;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const lab = labels[rr * cols + cc];
          if (lab) nbr.push(lab);
        }
      }
      if (c > 0 && labels[idx - 1]) nbr.push(labels[idx - 1]);
      if (nbr.length === 0) {
        labels[idx] = next;
        parent[next] = next;
        next++;
      } else {
        labels[idx] = find(nbr[0]);
        for (let k = 1; k < nbr.length; k++) union(nbr[0], nbr[k]);
      }
    }
  }
  const remap = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    let compact = remap.get(root);
    if (compact === undefined) {
      compact = ++count;
      remap.set(root, compact);
    }
    labels[i] = compact;
  }
  return { labels, count };
}

/**
 * Marching Squares 式外轮廓提取:收集每个组件像元的暴露边(有向,组件内部
 * 恒在边左侧),再首尾串接成环。输出为格网角点坐标:像元 (r,c) 占据角点
 * r..r+1 × c..c+1。取最长环为外轮廓(忽略孔洞)。
 */
export function marchingSquares(
  labels: Int32Array,
  rows: number,
  cols: number,
  minCells: number,
): Map<number, [number, number][]> {
  const sizes = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);
  }
  const at = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return 0;
    return labels[r * cols + c];
  };
  const result = new Map<number, [number, number][]>();

  for (const [lab, size] of sizes) {
    if (size < minCells) continue;
    const byStart = new Map<string, [number, number]>();
    const addEdge = (a: [number, number], b: [number, number]) => {
      byStart.set(`${a[0]},${a[1]}`, b);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (at(r, c) !== lab) continue;
        if (at(r - 1, c) !== lab) addEdge([r, c], [r, c + 1]);           // 上
        if (at(r + 1, c) !== lab) addEdge([r + 1, c + 1], [r + 1, c]);   // 下
        if (at(r, c - 1) !== lab) addEdge([r + 1, c], [r, c]);           // 左
        if (at(r, c + 1) !== lab) addEdge([r, c + 1], [r + 1, c + 1]);   // 右
      }
    }
    const used = new Set<string>();
    const rings: [number, number][][] = [];
    for (const startKey of byStart.keys()) {
      if (used.has(startKey)) continue;
      const first = startKey.split(',').map(Number) as [number, number];
      const ring: [number, number][] = [];
      let cur = first;
      let guard = 0;
      const edgeCount = byStart.size;
      while (guard++ < edgeCount + 2) {
        const k = `${cur[0]},${cur[1]}`;
        const nxt = byStart.get(k);
        if (!nxt) break;
        ring.push(cur);
        used.add(`${cur[0]},${cur[1]}>${nxt[0]},${nxt[1]}`);
        cur = nxt;
        if (cur[0] === first[0] && cur[1] === first[1]) break;
      }
      if (ring.length >= 3) rings.push(ring);
    }
    rings.sort((p, q) => q.length - p.length);
    if (rings[0]) result.set(lab, rings[0]);
  }
  return result;
}
