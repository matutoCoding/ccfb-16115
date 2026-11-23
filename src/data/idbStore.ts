/**
 * IndexedDB 生产存储。库名 mine-restore-db,对象库:
 * dem-tiles / ortho-tiles(主键 key)、jobs、meta(主键类型 + 业务 id 复合)。
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
import type { TileStore } from './store';

const DB_NAME = 'mine-restore-db';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('dem-tiles')) db.createObjectStore('dem-tiles', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('ortho-tiles')) db.createObjectStore('ortho-tiles', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'jobId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function metaId(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export class IndexedDbTileStore implements TileStore {
  private dbPromise: Promise<IDBDatabase>;
  constructor() {
    this.dbPromise = openDb();
  }

  private async db(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  async putElevation(t: ElevationTile): Promise<void> {
    const db = await this.db();
    await tx(db, 'dem-tiles', 'readwrite', (s) => s.put(t));
  }
  async putImage(t: ImageTile): Promise<void> {
    const db = await this.db();
    await tx(db, 'ortho-tiles', 'readwrite', (s) => s.put(t));
  }
  async getElevation(key: string): Promise<ElevationTile | undefined> {
    const db = await this.db();
    return tx(db, 'dem-tiles', 'readonly', (s) => s.get(key) as IDBRequest<ElevationTile | undefined>);
  }
  async getImage(key: string): Promise<ImageTile | undefined> {
    const db = await this.db();
    return tx(db, 'ortho-tiles', 'readonly', (s) => s.get(key) as IDBRequest<ImageTile | undefined>);
  }
  async hasTile(key: string): Promise<boolean> {
    const db = await this.db();
    const n = await tx(db, 'dem-tiles', 'readonly', (s) => s.count(key));
    if (n > 0) return true;
    const n2 = await tx(db, 'ortho-tiles', 'readonly', (s) => s.count(key));
    return n2 > 0;
  }
  async countTiles(periodId: string, layer: 'dem' | 'ortho'): Promise<number> {
    const db = await this.db();
    const storeName = layer === 'dem' ? 'dem-tiles' : 'ortho-tiles';
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const st = t.objectStore(storeName);
      const range = IDBKeyRange.bound(`${periodId}/${layer}/`, `${periodId}/${layer}` + '￿');
      const req = st.count(range);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async clearPeriod(periodId: string): Promise<void> {
    const db = await this.db();
    for (const storeName of ['dem-tiles', 'ortho-tiles'] as const) {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction(storeName, 'readwrite');
        const st = t.objectStore(storeName);
        const range = IDBKeyRange.bound(`${periodId}/`, `${periodId}/` + '￿');
        const req = st.delete(range);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }

  async putJob(job: TileJobState): Promise<void> {
    const db = await this.db();
    await tx(db, 'jobs', 'readwrite', (s) => s.put(job));
  }
  async getJob(jobId: string): Promise<TileJobState | undefined> {
    const db = await this.db();
    return tx(db, 'jobs', 'readonly', (s) => s.get(jobId) as IDBRequest<TileJobState | undefined>);
  }
  async listJobs(): Promise<TileJobState[]> {
    const db = await this.db();
    return tx(db, 'jobs', 'readonly', (s) => s.getAll() as IDBRequest<TileJobState[]>);
  }

  private async putMeta(kind: string, id: string, payload: unknown): Promise<void> {
    const db = await this.db();
    await tx(db, 'meta', 'readwrite', (s) => s.put({ id: metaId(kind, id), payload }));
  }
  private async getMetaList<T>(kind: string): Promise<T[]> {
    const db = await this.db();
    const all = await tx(db, 'meta', 'readonly', (s) => s.getAll() as IDBRequest<{ id: string; payload: T }[]>);
    return all.filter((m) => m.id.startsWith(`${kind}:`)).map((m) => m.payload);
  }

  async getSites(): Promise<MineSite[]> { return this.getMetaList<MineSite>('site'); }
  async putSite(s: MineSite): Promise<void> { return this.putMeta('site', s.id, s); }
  async getPeriods(siteId: string): Promise<SurveyPeriod[]> {
    const all = await this.getMetaList<SurveyPeriod>('period');
    return all.filter((p) => p.siteId === siteId);
  }
  async putPeriod(p: SurveyPeriod): Promise<void> { return this.putMeta('period', p.id, p); }
  async getDesigns(periodId: string): Promise<DesignSurface[]> {
    const all = await this.getMetaList<DesignSurface>('design');
    return all.filter((d) => d.periodId === periodId);
  }
  async putDesign(d: DesignSurface): Promise<void> { return this.putMeta('design', d.id, d); }
  async getAcceptance(siteId: string): Promise<AcceptanceItem[]> {
    const all = await this.getMetaList<AcceptanceItem>('acceptance');
    return all.filter((a) => a.siteId === siteId);
  }
  async putAcceptance(a: AcceptanceItem): Promise<void> { return this.putMeta('acceptance', a.id, a); }
  async getSettings(): Promise<AppSettings | undefined> {
    const db = await this.db();
    const row = await tx(db, 'meta', 'readonly', (s) => s.get(metaId('settings', 'global')) as IDBRequest<{ payload: AppSettings } | undefined>);
    return row?.payload;
  }
  async putSettings(s: AppSettings): Promise<void> { return this.putMeta('settings', 'global', s); }
}
