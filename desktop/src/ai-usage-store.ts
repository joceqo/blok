import {tokenCounts} from '../../apps/service-node/src/shell/usage-counts';
import { workspaceKey, type WorkspaceRef } from './workspace-registry';

export type UsageFeature = 'chat' | 'edit' | 'query' | 'index';
export type UsageProvider = 'openai' | 'codex' | 'claude';
export interface UsageRow {
  day: string;
  feature: UsageFeature;
  provider: UsageProvider;
  calls: number;
  measured: number;
  tokens: number;
  model?:string;
  standard?:boolean;
  detailed?:number;
  input?:number;
  output?:number;
  cached?:number;
}
export const utcDay = (date = new Date()): string => date.toISOString().slice(0,10);
export function shiftDay(day: string, offset: number): string {
  const date = new Date(day+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()+offset);
  return utcDay(date);
}

function openCounters(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('blok-ai-usage',2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('daily')) {
        request.result.createObjectStore('daily',{keyPath:['workspace','day','feature','provider']}).createIndex('period',['workspace','day']);
      }
      const store=request.result.createObjectStore('models',{keyPath:['workspace','day','feature','provider','model','tier']});
      store.createIndex('period',['workspace','day']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Read and increment in one readwrite transaction, including across Tauri windows.
export async function recordDeviceUsage(ref: WorkspaceRef, feature: UsageFeature, provider: UsageProvider, value?: unknown, model='', tier='default') {
  try {
    const db = await openCounters();
    try {
      const workspace = workspaceKey(ref);
      const day = utcDay();
      const counts=tokenCounts(typeof value==='number' ? {total_tokens:value} : value);
      await new Promise<void>((resolve,reject) => {
        const tx = db.transaction('models','readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore('models');
        const get = store.get([workspace,day,feature,provider,model,tier]);
        get.onsuccess = () => {
          const row = get.result ?? {workspace,day,feature,provider,model,tier,standard:tier==='default'||tier==='standard',calls:0,tokens:0,measured:0,detailed:0,input:0,output:0,cached:0};
          row.calls++;
          for (const key of Object.keys(counts) as (keyof typeof counts)[]) row[key]+=counts[key];
          store.put(row);
        };
      });
    } finally { db.close(); }
  } catch { console.warn('[ai-usage] Device counter unavailable'); }
}

export async function readDeviceUsage(ref: WorkspaceRef, end: string, days: number): Promise<UsageRow[]> {
  const db = await openCounters();
  try {
    const workspace = workspaceKey(ref);
    const range = IDBKeyRange.bound([workspace,shiftDay(end,1-days)],[workspace,end]);
    const tx=db.transaction(['daily','models']);
    const rows=await Promise.all(['daily','models'].map(name=>new Promise<UsageRow[]>((resolve,reject)=>{
      const request=tx.objectStore(name).index('period').getAll(range);
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    })));
    return rows.flat();
  } finally { db.close(); }
}

