import type { ProductPackageResponse, TransferItem } from '../types/store';

const DB_NAME = 'sideload-persistent-v1';
const DB_VERSION = 1;
const STORE_TRANSFERS = 'transfers';
const STORE_CHUNKS = 'chunks';
const STORE_CATALOG = 'catalog';

export interface StoredChunk {
  id: string; // `${transferId}:${index}`
  transferId: string;
  index: number;
  offset: number;
  size: number;
  data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRANSFERS)) {
        const ts = db.createObjectStore(STORE_TRANSFERS, { keyPath: 'id' });
        ts.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const cs = db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
        cs.createIndex('transferId', 'transferId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CATALOG)) {
        db.createObjectStore(STORE_CATALOG, { keyPath: 'productId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}

export async function getStorageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return {
        usage: est.usage ?? 0,
        quota: est.quota ?? 0,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export async function getAllTransfers(): Promise<TransferItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSFERS, 'readonly');
    const store = tx.objectStore(STORE_TRANSFERS);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as TransferItem[]) || [];
      items.sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putTransfer(item: TransferItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSFERS, 'readwrite');
    tx.objectStore(STORE_TRANSFERS).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteTransferAndChunks(transferId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_TRANSFERS, STORE_CHUNKS], 'readwrite');
    tx.objectStore(STORE_TRANSFERS).delete(transferId);
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const idx = chunkStore.index('transferId');
    const cursorReq = idx.openKeyCursor(IDBKeyRange.only(transferId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteChunksForTransfer(transferId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const idx = chunkStore.index('transferId');
    const cursorReq = idx.openKeyCursor(IDBKeyRange.only(transferId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveChunk(chunk: StoredChunk): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    tx.objectStore(STORE_CHUNKS).put(chunk);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getChunksForTransfer(transferId: string): Promise<StoredChunk[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const idx = tx.objectStore(STORE_CHUNKS).index('transferId');
    const req = idx.getAll(IDBKeyRange.only(transferId));
    req.onsuccess = () => {
      const chunks = (req.result as StoredChunk[]) || [];
      chunks.sort((a, b) => a.index - b.index);
      resolve(chunks);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getDownloadedByteCount(transferId: string): Promise<{ bytes: number; nextIndex: number }> {
  const chunks = await getChunksForTransfer(transferId);
  let bytes = 0;
  let nextIndex = 0;
  for (const ch of chunks) {
    if (ch.index === nextIndex && ch.offset === bytes) {
      bytes += ch.size;
      nextIndex++;
    } else {
      break;
    }
  }
  return { bytes, nextIndex };
}

export async function assembleTransferBlob(transferId: string, mimeType = 'application/octet-stream'): Promise<Blob | null> {
  const chunks = await getChunksForTransfer(transferId);
  if (chunks.length === 0) return null;
  return new Blob(
    chunks.map((c) => c.data),
    { type: mimeType }
  );
}

export async function saveCatalogEntry(entry: ProductPackageResponse): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readwrite');
    tx.objectStore(STORE_CATALOG).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllCatalogEntries(): Promise<ProductPackageResponse[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readonly');
    const req = tx.objectStore(STORE_CATALOG).getAll();
    req.onsuccess = () => {
      const list = (req.result as ProductPackageResponse[]) || [];
      list.sort((a, b) => b.fetchedAt - a.fetchedAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteCatalogEntry(productId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CATALOG, 'readwrite');
    tx.objectStore(STORE_CATALOG).delete(productId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
