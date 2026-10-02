import { DEFAULT_SETTINGS, type HistoryEntry } from '../shared/types';

function openDb(owner?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(owner ? `novelai-proxy:${owner}` : 'novelai-proxy', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('history', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, owner?: string) {
  const db = await openDb(owner);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('history', mode);
      const req = run(tx.objectStore('history'));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function loadHistory(owner?: string) {
  const entries = await transaction('readonly', store => store.getAll(), owner) as HistoryEntry[];
  return entries.map(entry => ({ ...entry, settings: { ...DEFAULT_SETTINGS, ...entry.settings, defaultNegative: entry.settings.defaultNegative ?? false } })).sort((a, b) => b.createdAt - a.createdAt);
}
export function saveHistory(entry: HistoryEntry, owner?: string) { return transaction('readwrite', store => store.put(entry), owner); }
export function deleteHistory(id: string, owner?: string) { return transaction('readwrite', store => store.delete(id), owner); }
export function clearHistory(owner?: string) { return transaction('readwrite', store => store.clear(), owner); }

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function imageToDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
}
export async function fitImage(source: string, width: number, height: number) {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale, h = image.height * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}
