/**
 * 瓦片与元数据存储抽象。IndexedDB 为生产实现,MemoryTileStore 供 Worker 测试
 * 与断点续切逻辑验证。结构化克隆要求所有瓦片为纯类型化数组,可直接跨 Worker 传递。
 */
import type {
  AcceptanceItem,
  AppSettings,
  DesignSurface,
  ElevationTile,
  ImageTile,
  MineSite,
  SurveyPeriod,
  TileJobState,
} from '../core/types';

export interface TileStore {
  putElevation(tile: ElevationTile): Promise<void>;
  putImage(tile: ImageTile): Promise<void>;
  getElevation(key: string): Promise<ElevationTile | undefined>;
  getImage(key: string): Promise<ImageTile | undefined>;
  hasTile(key: string): Promise<boolean>;
  countTiles(periodId: string, layer: 'dem' | 'ortho'): Promise<number>;
  clearPeriod(periodId: string): Promise<void>;

  // 任务状态(断点续切)
  putJob(job: TileJobState): Promise<void>;
  getJob(jobId: string): Promise<TileJobState | undefined>;
  listJobs(): Promise<TileJobState[]>;

  // 业务元数据
  getSites(): Promise<MineSite[]>;
  putSite(site: MineSite): Promise<void>;
  getPeriods(siteId: string): Promise<SurveyPeriod[]>;
  putPeriod(period: SurveyPeriod): Promise<void>;
  getDesigns(periodId: string): Promise<DesignSurface[]>;
  putDesign(design: DesignSurface): Promise<void>;
  getAcceptance(siteId: string): Promise<AcceptanceItem[]>;
  putAcceptance(item: AcceptanceItem): Promise<void>;
  getSettings(): Promise<AppSettings | undefined>;
  putSettings(s: AppSettings): Promise<void>;
}

/** 内存实现:逻辑与 IndexedDB 版完全一致,Node 测试使用 */
export class MemoryTileStore implements TileStore {
  private dem = new Map<string, ElevationTile>();
  private img = new Map<string, ImageTile>();
  private jobs = new Map<string, TileJobState>();
  private sites = new Map<string, MineSite>();
  private periods = new Map<string, SurveyPeriod>();
  private designs = new Map<string, DesignSurface>();
  private acceptance = new Map<string, AcceptanceItem>();
  private settings: AppSettings | undefined;

  async putElevation(t: ElevationTile) { this.dem.set(t.key, t); }
  async putImage(t: ImageTile) { this.img.set(t.key, t); }
  async getElevation(k: string) { return this.dem.get(k); }
  async getImage(k: string) { return this.img.get(k); }
  async hasTile(k: string) { return this.dem.has(k) || this.img.has(k); }
  async countTiles(periodId: string, layer: 'dem' | 'ortho') {
    const m = layer === 'dem' ? this.dem : this.img;
    let n = 0;
    for (const k of m.keys()) if (k.startsWith(`${periodId}/${layer}/`)) n++;
    return n;
  }
  async clearPeriod(periodId: string) {
    for (const k of [...this.dem.keys()]) if (k.startsWith(`${periodId}/`)) this.dem.delete(k);
    for (const k of [...this.img.keys()]) if (k.startsWith(`${periodId}/`)) this.img.delete(k);
  }
  async putJob(j: TileJobState) { this.jobs.set(j.jobId, j); }
  async getJob(id: string) { return this.jobs.get(id); }
  async listJobs() { return [...this.jobs.values()]; }
  async getSites() { return [...this.sites.values()]; }
  async putSite(s: MineSite) { this.sites.set(s.id, s); }
  async getPeriods(siteId: string) { return [...this.periods.values()].filter((p) => p.siteId === siteId); }
  async putPeriod(p: SurveyPeriod) { this.periods.set(p.id, p); }
  async getDesigns(periodId: string) { return [...this.designs.values()].filter((d) => d.periodId === periodId); }
  async putDesign(d: DesignSurface) { this.designs.set(d.id, d); }
  async getAcceptance(siteId: string) { return [...this.acceptance.values()].filter((a) => a.siteId === siteId); }
  async putAcceptance(a: AcceptanceItem) { this.acceptance.set(a.id, a); }
  async getSettings() { return this.settings; }
  async putSettings(s: AppSettings) { this.settings = s; }
}
