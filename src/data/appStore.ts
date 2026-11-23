/**
 * 应用级状态仓库:全局单例,页面与三维视图共享。
 * 瓦片持久化走 TileStore;原始 DEM/正射格网只在内存(量测与分析的精度来源)。
 */
import type {
  AcceptanceItem,
  AppSettings,
  Bench,
  DesignSurface,
  ElevationGrid,
  ImageGrid,
  MapPatch,
  MineSite,
  SurveyPeriod,
} from '../core/types';
import { DEFAULT_SETTINGS } from '../core/types';
import type { TileStore } from './store';
import { IndexedDbTileStore } from './idbStore';
import { MemoryTileStore } from './store';

export interface PeriodRuntime {
  period: SurveyPeriod;
  dem: ElevationGrid;
  ortho: ImageGrid;
  benches: Bench[];
  patches: MapPatch[];
  slopeClasses?: Uint8Array;
}

type Listener = () => void;

class AppStore {
  tileStore: TileStore;
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  sites: MineSite[] = [];
  currentSite: MineSite | null = null;
  periods: SurveyPeriod[] = [];
  runtime = new Map<string, PeriodRuntime>();
  designs: DesignSurface[] = [];
  acceptance: AcceptanceItem[] = [];
  activePeriodId: string | null = null;
  comparePeriodId: string | null = null;
  /** 切片进度 periodId -> 0..1 */
  sliceProgress = new Map<string, number>();
  webgpuAvailable = typeof navigator !== 'undefined' && !!navigator.gpu;
  private listeners = new Set<Listener>();

  constructor() {
    this.tileStore = typeof indexedDB === 'undefined' ? new MemoryTileStore() : new IndexedDbTileStore();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  async loadSettings() {
    const s = await this.tileStore.getSettings();
    if (s) this.settings = s;
    this.emit();
  }

  async saveSettings(s: AppSettings) {
    this.settings = s;
    await this.tileStore.putSettings(s);
    this.emit();
  }

  async loadSites() {
    this.sites = await this.tileStore.getSites();
    if (this.sites.length === 0) {
      const seed: MineSite = {
        id: 'site-demo',
        name: '青山闭坑露天采石场',
        code: 'CK-2025-007',
        areaKm2: 4.6,
        location: '华东某县生态修复片区',
        coordinateSystem: 'CGCS2000 3°带 Gauss-Krüger',
        createdAt: Date.now(),
        remark: '硬要求季度三维巡查试点矿区',
      };
      await this.tileStore.putSite(seed);
      this.sites = [seed];
    }
    this.currentSite = this.sites[0];
    this.emit();
  }

  async loadPeriods() {
    if (!this.currentSite) return;
    this.periods = await this.tileStore.getPeriods(this.currentSite.id);
    this.acceptance = await this.tileStore.getAcceptance(this.currentSite.id);
    this.emit();
  }

  async upsertPeriod(p: SurveyPeriod) {
    await this.tileStore.putPeriod(p);
    await this.loadPeriods();
  }

  setRuntime(rt: PeriodRuntime) {
    this.runtime.set(rt.period.id, rt);
    if (!this.activePeriodId) this.activePeriodId = rt.period.id;
    this.emit();
  }

  get activeRuntime(): PeriodRuntime | undefined {
    return this.activePeriodId ? this.runtime.get(this.activePeriodId) : undefined;
  }

  async saveDesign(d: DesignSurface) {
    await this.tileStore.putDesign(d);
    if (this.currentSite) {
      const all: DesignSurface[] = [];
      for (const p of this.periods) all.push(...(await this.tileStore.getDesigns(p.id)));
      this.designs = all;
    }
    this.emit();
  }

  async saveAcceptance(item: AcceptanceItem) {
    await this.tileStore.putAcceptance(item);
    if (this.currentSite) this.acceptance = await this.tileStore.getAcceptance(this.currentSite.id);
    this.emit();
  }

  setSliceProgress(periodId: string, v: number) {
    this.sliceProgress.set(periodId, v);
    this.emit();
  }
}

export const appStore = new AppStore();
