import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExportedQueueItem,
  PackageFile,
  QueueExportPayload,
  TransferItem,
  TransferMode,
  TransferStatus,
} from '../types/store';
import {
  computeSha256FromBlob,
  computeSha256FromChunks,
  normalizeSha256,
} from '../utils/hash';
import {
  playCompletionChime,
  playErrorTone,
  sendCompletionNotification,
  startTitleFlash,
  unlockAudio,
} from '../utils/notifications';
import {
  assembleTransferBlob,
  deleteChunksForTransfer,
  deleteTransferAndChunks,
  getAllTransfers,
  getChunksForTransfer,
  getDownloadedByteCount,
  getStorageUsage,
  putTransfer,
  requestPersistentStorage,
  saveChunk,
} from '../utils/queueDb';
import {
  buildProxyDownloadUrl,
  sanitizeFileName,
  sanitizePackageUrl,
} from '../utils/urlSanitizer';

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per resumable slice
const MAX_CONCURRENT = 2;

export interface CompletionFlashEvent {
  id: string;
  fileName: string;
  appTitle: string;
  at: number;
}

interface BackgroundFetchRegistrationLike extends EventTarget {
  id: string;
  downloaded: number;
  downloadTotal: number;
  result: '' | 'success' | 'failure';
  failureReason: string;
  abort: () => Promise<boolean>;
}

interface ServiceWorkerRegistrationWithBgFetch extends ServiceWorkerRegistration {
  backgroundFetch?: {
    fetch: (
      id: string,
      requests: RequestInfo[],
      options?: {
        title?: string;
        icons?: Array<{ src: string; sizes?: string; type?: string }>;
        downloadTotal?: number;
      }
    ) => Promise<BackgroundFetchRegistrationLike>;
    get: (id: string) => Promise<BackgroundFetchRegistrationLike | undefined>;
  };
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = sanitizeFileName(fileName);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function triggerDirectSanitizedDownload(rawUrl: string, fileName: string): boolean {
  const sanitized = sanitizePackageUrl(rawUrl);
  if (!sanitized.ok) return false;
  const proxyUrl = buildProxyDownloadUrl(sanitized.url, fileName);
  const a = document.createElement('a');
  a.href = proxyUrl;
  a.download = sanitizeFileName(fileName);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

export function useTransferManager(options: {
  soundMuted: boolean;
  onToast?: (kind: 'success' | 'error' | 'info', msg: string) => void;
}) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [holdQueue, setHoldQueue] = useState<boolean>(
    () => typeof window !== 'undefined' && localStorage.getItem('sideload.holdQueue') === '1'
  );
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null);
  const [isPersistentGranted, setIsPersistentGranted] = useState(false);
  const [completionFlash, setCompletionFlash] = useState<CompletionFlashEvent | null>(null);
  const [verifyingProgress, setVerifyingProgress] = useState<Record<string, number>>({});

  const toggleHoldQueue = useCallback(() => {
    setHoldQueue((prev) => {
      const next = !prev;
      localStorage.setItem('sideload.holdQueue', next ? '1' : '0');
      onToastRef.current?.(
        'info',
        next
          ? 'Queue staging enabled — new downloads wait for rename/review before starting.'
          : 'Auto-start enabled — new downloads begin immediately.'
      );
      return next;
    });
  }, []);

  const transfersRef = useRef<TransferItem[]>([]);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeRunnersRef = useRef<Set<string>>(new Set());
  const soundMutedRef = useRef(options.soundMuted);
  soundMutedRef.current = options.soundMuted;

  const onToastRef = useRef(options.onToast);
  onToastRef.current = options.onToast;

  const supportsBackgroundFetch =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'BackgroundFetchManager' in window;

  const refreshStorageEstimate = useCallback(async () => {
    const est = await getStorageUsage();
    if (est) setStorageInfo(est);
  }, []);

  const upsertTransferState = useCallback((updated: TransferItem) => {
    setTransfers((prev) => {
      const idx = prev.findIndex((t) => t.id === updated.id);
      const next =
        idx >= 0
          ? prev.map((t) => (t.id === updated.id ? updated : t))
          : [updated, ...prev];
      transfersRef.current = next;
      return next;
    });
    void putTransfer(updated);
  }, []);

  const notifyCompletion = useCallback(
    async (item: TransferItem) => {
      playCompletionChime(soundMutedRef.current);
      startTitleFlash(`✓ Complete: ${item.fileName}`);
      setCompletionFlash({
        id: item.id,
        fileName: item.fileName,
        appTitle: item.appTitle,
        at: Date.now(),
      });
      const verifiedSuffix =
        item.verificationStatus === 'verified' ? ' (SHA-256 verified)' : '';
      onToastRef.current?.('success', `Downloaded ${item.fileName}${verifiedSuffix}`);
      await sendCompletionNotification(
        `Sideload: ${item.appTitle}`,
        `${item.fileName} finished downloading${verifiedSuffix} and is ready.`
      );
    },
    []
  );

  const verifyTransferChunks = useCallback(
    async (item: TransferItem, overrideExpectedRaw?: string | null): Promise<TransferItem> => {
      const normalizedOverride =
        overrideExpectedRaw !== undefined ? normalizeSha256(overrideExpectedRaw) : undefined;
      const expected =
        normalizedOverride !== undefined
          ? normalizedOverride
          : normalizeSha256(item.expectedSha256 ?? null);

      const verifyingItem: TransferItem = {
        ...item,
        expectedSha256: expected,
        verificationStatus: 'verifying',
        verificationError: null,
        updatedAt: Date.now(),
      };
      upsertTransferState(verifyingItem);
      setVerifyingProgress((prev) => ({ ...prev, [item.id]: 0 }));

      try {
        let computed: string | null = null;
        const onProg = (pct: number) => {
          setVerifyingProgress((prev) =>
            prev[item.id] === pct ? prev : { ...prev, [item.id]: pct }
          );
        };

        const chunks = await getChunksForTransfer(item.id);
        if (chunks.length > 0) {
          computed = await computeSha256FromChunks(
            chunks.map((c) => c.data),
            onProg
          );
        } else if (item.mode === 'bgfetch' && item.bgFetchId && 'caches' in window) {
          const cache = await caches.open('sideload-offline-packages');
          const proxyUrl = buildProxyDownloadUrl(item.sanitizedUrl, item.fileName);
          const match = await cache.match(proxyUrl);
          if (match) {
            const blob = await match.blob();
            computed = await computeSha256FromBlob(blob, onProg);
          }
        }

        if (!computed) {
          const errored: TransferItem = {
            ...verifyingItem,
            verificationStatus: 'error',
            verificationError: 'Package payload chunks not found in local IndexedDB storage.',
            verifiedAt: Date.now(),
            updatedAt: Date.now(),
          };
          upsertTransferState(errored);
          return errored;
        }

        const now = Date.now();
        let nextStatus: TransferItem['verificationStatus'] = 'computed';
        let verError: string | null = null;

        if (expected) {
          if (computed === expected) {
            nextStatus = 'verified';
          } else {
            nextStatus = 'mismatch';
            verError =
              'SHA-256 mismatch — package payload may have been corrupted during transfer.';
          }
        }

        const resultItem: TransferItem = {
          ...verifyingItem,
          expectedSha256: expected,
          computedSha256: computed,
          verificationStatus: nextStatus,
          verifiedAt: now,
          verificationError: verError,
          updatedAt: now,
        };
        upsertTransferState(resultItem);
        return resultItem;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'SHA-256 verification failed';
        const failed: TransferItem = {
          ...verifyingItem,
          verificationStatus: 'error',
          verificationError: msg,
          verifiedAt: Date.now(),
          updatedAt: Date.now(),
        };
        upsertTransferState(failed);
        return failed;
      } finally {
        setVerifyingProgress((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }
    },
    [upsertTransferState]
  );

  const runResumableTransfer = useCallback(
    async (item: TransferItem) => {
      if (activeRunnersRef.current.has(item.id)) return;
      activeRunnersRef.current.add(item.id);

      const controller = new AbortController();
      controllersRef.current.set(item.id, controller);

      let current = {
        ...item,
        status: 'downloading' as const,
        error: null,
        updatedAt: Date.now(),
      };
      upsertTransferState(current);

      try {
        const sanitized = sanitizePackageUrl(current.sanitizedUrl || current.rawUrl);
        if (!sanitized.ok) {
          throw new Error(`Invalid URL: ${sanitized.error}`);
        }

        const proxyUrl = buildProxyDownloadUrl(sanitized.url, current.fileName);

        // Determine total size if unknown
        let totalSize = current.sizeBytes;
        if (!totalSize || totalSize <= 0) {
          const headRes = await fetch(proxyUrl, {
            method: 'HEAD',
            signal: controller.signal,
          });
          if (headRes.ok) {
            const len = Number(headRes.headers.get('content-length') || '0');
            if (len > 0) totalSize = len;
          }
        }

        // Resume from exact verified IndexedDB byte offset
        const { bytes: existingBytes, nextIndex: startChunkIndex } =
          await getDownloadedByteCount(current.id);
        let offset = existingBytes;
        let chunkIndex = startChunkIndex;

        current = {
          ...current,
          sizeBytes: totalSize,
          bytesDownloaded: offset,
          updatedAt: Date.now(),
        };
        upsertTransferState(current);

        // Already fully downloaded in IndexedDB?
        if (totalSize > 0 && offset >= totalSize) {
          const blob = await assembleTransferBlob(current.id);
          if (blob) {
            const done: TransferItem = {
              ...current,
              status: 'completed',
              bytesDownloaded: totalSize,
              speedBps: 0,
              etaSeconds: 0,
              verificationStatus: 'verifying',
              completedAt: Date.now(),
              updatedAt: Date.now(),
            };
            upsertTransferState(done);
            const verified = await verifyTransferChunks(done);
            if (verified.verificationStatus === 'mismatch') {
              playErrorTone(soundMutedRef.current);
              onToastRef.current?.(
                'error',
                `SHA-256 mismatch for ${verified.fileName} — package may be corrupted.`
              );
            } else {
              triggerBlobDownload(blob, verified.fileName);
              await notifyCompletion(verified);
            }
            void refreshStorageEstimate();
            return;
          }
        }

        let lastTickTime = performance.now();
        let lastTickBytes = offset;
        let emaSpeed = 0;

        while (true) {
          if (controller.signal.aborted) break;

          const rangeEnd =
            totalSize > 0
              ? Math.min(offset + CHUNK_SIZE - 1, totalSize - 1)
              : offset + CHUNK_SIZE - 1;

          const res = await fetch(proxyUrl, {
            headers: {
              Range: `bytes=${offset}-${rangeEnd}`,
            },
            signal: controller.signal,
          });

          if (res.status === 416) {
            // Range not satisfiable -> reached EOF
            break;
          }

          if (!res.ok) {
            let errText = `HTTP ${res.status}`;
            try {
              const errJson = (await res.json()) as { error?: string };
              if (errJson?.error) errText = errJson.error;
            } catch {
              // ignore
            }
            throw new Error(errText);
          }

          // Check if server returned full 200 stream (without range slicing)
          if (res.status === 200 && res.body) {
            const contentLen = Number(res.headers.get('content-length') || '0');
            if (contentLen > 0) totalSize = contentLen;

            const reader = res.body.getReader();
            let buffer = new Uint8Array(0);
            offset = 0;
            chunkIndex = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                const merged = new Uint8Array(buffer.byteLength + value.byteLength);
                merged.set(buffer, 0);
                merged.set(value, buffer.byteLength);
                buffer = merged;

                while (buffer.byteLength >= CHUNK_SIZE) {
                  const slice = buffer.slice(0, CHUNK_SIZE);
                  buffer = buffer.slice(CHUNK_SIZE);
                  await saveChunk({
                    id: `${current.id}:${chunkIndex}`,
                    transferId: current.id,
                    index: chunkIndex,
                    offset,
                    size: slice.byteLength,
                    data: slice.buffer,
                  });
                  offset += slice.byteLength;
                  chunkIndex++;
                }

                const nowPerf = performance.now();
                const dt = (nowPerf - lastTickTime) / 1000;
                const liveBytes = offset + buffer.byteLength;
                if (dt >= 0.25) {
                  const instSpeed = (liveBytes - lastTickBytes) / dt;
                  emaSpeed = emaSpeed === 0 ? instSpeed : emaSpeed * 0.6 + instSpeed * 0.4;
                  lastTickTime = nowPerf;
                  lastTickBytes = liveBytes;
                  const eta =
                    totalSize > 0 && emaSpeed > 0
                      ? Math.max(0, Math.round((totalSize - liveBytes) / emaSpeed))
                      : null;
                  current = {
                    ...current,
                    sizeBytes: totalSize || liveBytes,
                    bytesDownloaded: liveBytes,
                    speedBps: Math.max(0, Math.round(emaSpeed)),
                    etaSeconds: eta,
                    updatedAt: Date.now(),
                  };
                  upsertTransferState(current);
                }
              }
            }

            if (buffer.byteLength > 0) {
              await saveChunk({
                id: `${current.id}:${chunkIndex}`,
                transferId: current.id,
                index: chunkIndex,
                offset,
                size: buffer.byteLength,
                data: buffer.buffer,
              });
              offset += buffer.byteLength;
            }
            break;
          }

          // Standard 206 Partial Content slice
          const contentRange = res.headers.get('content-range');
          if (contentRange) {
            const m = contentRange.match(/\/(\d+)$/);
            if (m) totalSize = parseInt(m[1], 10);
          }

          const arrBuf = await res.arrayBuffer();
          if (arrBuf.byteLength === 0) break;

          await saveChunk({
            id: `${current.id}:${chunkIndex}`,
            transferId: current.id,
            index: chunkIndex,
            offset,
            size: arrBuf.byteLength,
            data: arrBuf,
          });

          offset += arrBuf.byteLength;
          chunkIndex++;

          const nowPerf = performance.now();
          const dt = Math.max(0.05, (nowPerf - lastTickTime) / 1000);
          const instSpeed = (offset - lastTickBytes) / dt;
          emaSpeed = emaSpeed === 0 ? instSpeed : emaSpeed * 0.5 + instSpeed * 0.5;
          lastTickTime = nowPerf;
          lastTickBytes = offset;

          const eta =
            totalSize > 0 && emaSpeed > 0
              ? Math.max(0, Math.round((totalSize - offset) / emaSpeed))
              : null;

          current = {
            ...current,
            sizeBytes: totalSize || offset,
            bytesDownloaded: offset,
            speedBps: Math.max(0, Math.round(emaSpeed)),
            etaSeconds: eta,
            updatedAt: Date.now(),
          };
          upsertTransferState(current);

          if (totalSize > 0 && offset >= totalSize) {
            break;
          }
          if (arrBuf.byteLength < CHUNK_SIZE && totalSize === 0) {
            totalSize = offset;
            break;
          }
        }

        if (controller.signal.aborted) {
          return;
        }

        const blob = await assembleTransferBlob(current.id);
        if (!blob || blob.size === 0) {
          throw new Error('Transfer completed with empty payload.');
        }

        const completed: TransferItem = {
          ...current,
          sizeBytes: totalSize || blob.size,
          bytesDownloaded: blob.size,
          status: 'completed',
          speedBps: 0,
          etaSeconds: 0,
          verificationStatus: 'verifying',
          completedAt: Date.now(),
          updatedAt: Date.now(),
        };
        upsertTransferState(completed);

        const verified = await verifyTransferChunks(completed);
        if (verified.verificationStatus === 'mismatch') {
          playErrorTone(soundMutedRef.current);
          onToastRef.current?.(
            'error',
            `SHA-256 mismatch for ${verified.fileName} — package may be corrupted. Re-download recommended.`
          );
        } else {
          triggerBlobDownload(blob, verified.fileName);
          await notifyCompletion(verified);
        }
        void refreshStorageEstimate();
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Download interrupted';
        const latest = transfersRef.current.find((t) => t.id === current.id) || current;
        const failed: TransferItem = {
          ...latest,
          status: navigator.onLine ? 'error' : 'interrupted',
          speedBps: 0,
          etaSeconds: null,
          error: navigator.onLine
            ? message
            : 'Network offline — transfer paused and saved for resume.',
          updatedAt: Date.now(),
        };
        upsertTransferState(failed);
        playErrorTone(soundMutedRef.current);
        onToastRef.current?.('error', `${current.fileName}: ${failed.error}`);
      } finally {
        controllersRef.current.delete(item.id);
        activeRunnersRef.current.delete(item.id);
      }
    },
    [notifyCompletion, refreshStorageEstimate, upsertTransferState, verifyTransferChunks]
  );

  // Queue scheduler: promote queued transfers up to MAX_CONCURRENT
  useEffect(() => {
    const activeCount = transfers.filter(
      (t) => t.status === 'downloading' && t.mode === 'resumable'
    ).length;
    if (activeCount >= MAX_CONCURRENT) return;

    const slots = MAX_CONCURRENT - activeCount;
    const nextQueued = transfers
      .filter((t) => t.status === 'queued' && t.mode === 'resumable')
      .slice(-slots)
      .reverse();

    for (const item of nextQueued) {
      if (!activeRunnersRef.current.has(item.id)) {
        void runResumableTransfer(item);
      }
    }
  }, [transfers, runResumableTransfer]);

  // Load persisted queue from IndexedDB on startup & mark crashed/closed downloading items as interrupted
  useEffect(() => {
    let mounted = true;
    (async () => {
      const persisted = await requestPersistentStorage();
      if (mounted) setIsPersistentGranted(persisted);

      const loaded = await getAllTransfers();
      const reconciled: TransferItem[] = [];
      for (const t of loaded) {
        if (t.status === 'downloading' && t.mode === 'resumable') {
          const { bytes } = await getDownloadedByteCount(t.id);
          const interrupted: TransferItem = {
            ...t,
            bytesDownloaded: bytes,
            status: 'interrupted',
            speedBps: 0,
            etaSeconds: null,
            error: 'Session interrupted — ready to resume from saved progress.',
            updatedAt: Date.now(),
          };
          await putTransfer(interrupted);
          reconciled.push(interrupted);
        } else {
          reconciled.push(t);
        }
      }

      if (mounted) {
        transfersRef.current = reconciled;
        setTransfers(reconciled);
        void refreshStorageEstimate();
      }
    })();

    return () => {
      mounted = false;
    };
  }, [refreshStorageEstimate]);

  // Listen to Service Worker background fetch events
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'BGFETCH_SUCCESS' && data.id) {
        const match = transfersRef.current.find((t) => t.bgFetchId === data.id);
        if (match) {
          const done: TransferItem = {
            ...match,
            status: 'completed',
            bytesDownloaded: match.sizeBytes || match.bytesDownloaded,
            speedBps: 0,
            etaSeconds: 0,
            verificationStatus: 'verifying',
            completedAt: Date.now(),
            updatedAt: Date.now(),
          };
          upsertTransferState(done);
          const verified = await verifyTransferChunks(done);
          if (verified.verificationStatus === 'mismatch') {
            playErrorTone(soundMutedRef.current);
            onToastRef.current?.(
              'error',
              `SHA-256 mismatch for ${verified.fileName} — background download may be corrupted.`
            );
          } else {
            await notifyCompletion(verified);
          }
        }
      } else if (data.type === 'BGFETCH_FAIL' && data.id) {
        const match = transfersRef.current.find((t) => t.bgFetchId === data.id);
        if (match) {
          const failed: TransferItem = {
            ...match,
            status: 'interrupted',
            speedBps: 0,
            etaSeconds: null,
            error: data.failureReason || 'Background fetch interrupted',
            updatedAt: Date.now(),
          };
          upsertTransferState(failed);
        }
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [notifyCompletion, upsertTransferState]);

  // Auto-mark interrupted if browser loses connectivity mid-download, and auto-resume when back online
  useEffect(() => {
    const handleOnline = () => {
      const resumable = transfersRef.current.filter(
        (t) => t.status === 'interrupted' && t.error?.includes('Network offline')
      );
      for (const item of resumable) {
        upsertTransferState({
          ...item,
          status: 'queued',
          error: null,
          updatedAt: Date.now(),
        });
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [upsertTransferState]);

  const enqueuePackage = useCallback(
    async (
      file: PackageFile,
      meta: { productId: string; appTitle: string; iconUrl: string | null },
      preferredMode: TransferMode = 'resumable'
    ) => {
      unlockAudio();

      const sanitized = sanitizePackageUrl(file.url);
      if (!sanitized.ok) {
        onToastRef.current?.('error', `Blocked invalid URL: ${sanitized.error}`);
        return;
      }

      if (preferredMode === 'native') {
        const ok = triggerDirectSanitizedDownload(sanitized.url, file.fileName);
        if (ok) {
          onToastRef.current?.('info', `Started browser native download for ${file.fileName}`);
        }
        return;
      }

      const id = `${meta.productId}-${file.id}-${Date.now()}`;
      const now = Date.now();

      // Background Fetch delegation when requested and supported
      if (preferredMode === 'bgfetch' && supportsBackgroundFetch) {
        try {
          const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistrationWithBgFetch;
          if (reg.backgroundFetch) {
            const bgId = `sideload-${id}`;
            const proxyUrl = buildProxyDownloadUrl(sanitized.url, file.fileName);
            const bgReg = await reg.backgroundFetch.fetch(bgId, [proxyUrl], {
              title: `${meta.appTitle} — ${file.fileName}`,
              icons: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
              downloadTotal: file.sizeBytes > 0 ? file.sizeBytes : undefined,
            });

            const normalizedExpected = normalizeSha256(file.sha256);
            const bgItem: TransferItem = {
              id,
              productId: meta.productId,
              appTitle: meta.appTitle,
              iconUrl: meta.iconUrl,
              fileName: sanitizeFileName(file.fileName),
              sanitizedUrl: sanitized.url,
              rawUrl: file.rawUrl,
              type: file.type,
              arch: file.arch,
              version: file.version,
              sizeBytes: file.sizeBytes,
              bytesDownloaded: 0,
              status: 'downloading',
              mode: 'bgfetch',
              speedBps: 0,
              etaSeconds: null,
              error: null,
              bgFetchId: bgId,
              expectedSha256: normalizedExpected,
              computedSha256: null,
              verificationStatus: 'unverified',
              verifiedAt: null,
              verificationError: null,
              createdAt: now,
              updatedAt: now,
              completedAt: null,
            };
            upsertTransferState(bgItem);

            bgReg.addEventListener('progress', () => {
              const latest = transfersRef.current.find((t) => t.id === id);
              if (latest && latest.status === 'downloading') {
                upsertTransferState({
                  ...latest,
                  bytesDownloaded: bgReg.downloaded,
                  sizeBytes: bgReg.downloadTotal || latest.sizeBytes,
                  updatedAt: Date.now(),
                });
              }
            });

            onToastRef.current?.(
              'info',
              `Background transfer started for ${file.fileName}. You can safely leave the app.`
            );
            return;
          }
        } catch (err) {
          console.warn('BackgroundFetch unavailable, falling back to persistent resumable queue:', err);
        }
      }

      // Check if an active/paused transfer for the same file already exists
      const safeFileName = sanitizeFileName(file.fileName);
      const existing = transfersRef.current.find(
        (t) =>
          (t.sanitizedUrl === sanitized.url ||
            (t.fileName === safeFileName && t.productId === meta.productId)) &&
          (t.status === 'downloading' ||
            t.status === 'queued' ||
            t.status === 'paused' ||
            t.status === 'interrupted')
      );
      if (existing) {
        if (existing.status === 'paused' || existing.status === 'interrupted') {
          if (holdQueue) {
            onToastRef.current?.(
              'info',
              `${existing.fileName} is staged in queue for rename/review`
            );
          } else {
            upsertTransferState({
              ...existing,
              sanitizedUrl: sanitized.url,
              status: 'queued',
              error: null,
              updatedAt: now,
            });
            onToastRef.current?.('info', `Resuming ${existing.fileName} from saved progress`);
          }
        } else {
          onToastRef.current?.('info', `${existing.fileName} is already in your transfer queue`);
        }
        return;
      }

      const normalizedExpected = normalizeSha256(file.sha256);
      const newItem: TransferItem = {
        id,
        productId: meta.productId,
        appTitle: meta.appTitle,
        iconUrl: meta.iconUrl,
        fileName: safeFileName,
        sanitizedUrl: sanitized.url,
        rawUrl: file.rawUrl,
        type: file.type,
        arch: file.arch,
        version: file.version,
        sizeBytes: file.sizeBytes,
        bytesDownloaded: 0,
        status: holdQueue ? 'paused' : 'queued',
        mode: 'resumable',
        speedBps: 0,
        etaSeconds: null,
        error: null,
        bgFetchId: null,
        expectedSha256: normalizedExpected,
        computedSha256: null,
        verificationStatus: 'unverified',
        verifiedAt: null,
        verificationError: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      upsertTransferState(newItem);
    },
    [holdQueue, supportsBackgroundFetch, upsertTransferState]
  );

  const enqueueBatch = useCallback(
    async (
      files: PackageFile[],
      meta: { productId: string; appTitle: string; iconUrl: string | null },
      mode: TransferMode = 'resumable'
    ) => {
      unlockAudio();
      for (const file of files) {
        await enqueuePackage(file, meta, mode);
      }
      onToastRef.current?.(
        'info',
        holdQueue && mode === 'resumable'
          ? `Staged ${files.length} package${files.length === 1 ? '' : 's'} in queue (ready to rename)`
          : `Queued ${files.length} package${files.length === 1 ? '' : 's'} for download`
      );
    },
    [enqueuePackage, holdQueue]
  );

  const pauseTransfer = useCallback(
    (id: string) => {
      const ctrl = controllersRef.current.get(id);
      if (ctrl) ctrl.abort();
      const item = transfersRef.current.find((t) => t.id === id);
      if (item) {
        upsertTransferState({
          ...item,
          status: 'paused',
          speedBps: 0,
          etaSeconds: null,
          updatedAt: Date.now(),
        });
      }
    },
    [upsertTransferState]
  );

  const resumeTransfer = useCallback(
    (id: string) => {
      unlockAudio();
      const item = transfersRef.current.find((t) => t.id === id);
      if (item) {
        upsertTransferState({
          ...item,
          status: 'queued',
          error: null,
          updatedAt: Date.now(),
        });
      }
    },
    [upsertTransferState]
  );

  const resumeAllInterrupted = useCallback(() => {
    unlockAudio();
    const list = transfersRef.current.filter(
      (t) => t.status === 'interrupted' || t.status === 'paused' || t.status === 'error'
    );
    for (const item of list) {
      upsertTransferState({
        ...item,
        status: 'queued',
        error: null,
        updatedAt: Date.now(),
      });
    }
  }, [upsertTransferState]);

  const pauseAll = useCallback(() => {
    for (const item of transfersRef.current) {
      if (item.status === 'downloading' || item.status === 'queued') {
        const ctrl = controllersRef.current.get(item.id);
        if (ctrl) ctrl.abort();
        upsertTransferState({
          ...item,
          status: 'paused',
          speedBps: 0,
          etaSeconds: null,
          updatedAt: Date.now(),
        });
      }
    }
  }, [upsertTransferState]);

  const cancelTransfer = useCallback(
    async (id: string) => {
      const ctrl = controllersRef.current.get(id);
      if (ctrl) ctrl.abort();

      const item = transfersRef.current.find((t) => t.id === id);
      if (item?.bgFetchId && supportsBackgroundFetch) {
        try {
          const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistrationWithBgFetch;
          const bg = await reg.backgroundFetch?.get(item.bgFetchId);
          await bg?.abort();
        } catch {
          // ignore
        }
      }

      setTransfers((prev) => {
        const next = prev.filter((t) => t.id !== id);
        transfersRef.current = next;
        return next;
      });
      await deleteTransferAndChunks(id);
      void refreshStorageEstimate();
    },
    [refreshStorageEstimate, supportsBackgroundFetch]
  );

  const saveCompletedFile = useCallback(async (item: TransferItem) => {
    if (item.mode === 'bgfetch' && item.bgFetchId && 'caches' in window) {
      const cache = await caches.open('sideload-offline-packages');
      const proxyUrl = buildProxyDownloadUrl(item.sanitizedUrl, item.fileName);
      const match = await cache.match(proxyUrl);
      if (match) {
        const blob = await match.blob();
        triggerBlobDownload(blob, item.fileName);
        return;
      }
    }

    const blob = await assembleTransferBlob(item.id);
    if (blob && blob.size > 0) {
      triggerBlobDownload(blob, item.fileName);
      return;
    }

    // Fallback to sanitized proxy download
    triggerDirectSanitizedDownload(item.sanitizedUrl, item.fileName);
  }, []);

  const clearCompleted = useCallback(async () => {
    const completed = transfersRef.current.filter((t) => t.status === 'completed');
    setTransfers((prev) => {
      const next = prev.filter((t) => t.status !== 'completed');
      transfersRef.current = next;
      return next;
    });
    for (const item of completed) {
      await deleteTransferAndChunks(item.id);
    }
    void refreshStorageEstimate();
  }, [refreshStorageEstimate]);

  const renameTransfers = useCallback(
    (updates: Array<{ id: string; fileName: string }>, startAfter = false) => {
      if (updates.length === 0) return;
      if (startAfter) unlockAudio();

      const updateMap = new Map<string, string>();
      for (const u of updates) {
        const clean = sanitizeFileName(u.fileName);
        if (clean) updateMap.set(u.id, clean);
      }
      if (updateMap.size === 0) return;

      const now = Date.now();
      let renamedCount = 0;
      let startedCount = 0;
      const toPersist: TransferItem[] = [];

      const nextList = transfersRef.current.map((item) => {
        const newName = updateMap.get(item.id);
        if (!newName) return item;
        if (item.status === 'downloading' || item.status === 'completed') {
          return item;
        }
        const nameChanged = newName !== item.fileName;
        if (nameChanged) renamedCount++;
        const shouldStart = startAfter && item.status !== 'queued';
        if (shouldStart || (startAfter && item.status === 'queued')) {
          startedCount++;
        }
        const updated: TransferItem = {
          ...item,
          fileName: newName,
          status: startAfter ? 'queued' : item.status,
          error: startAfter ? null : item.error,
          updatedAt: now,
        };
        toPersist.push(updated);
        return updated;
      });

      if (toPersist.length === 0) return;

      transfersRef.current = nextList;
      setTransfers(nextList);
      for (const item of toPersist) {
        void putTransfer(item);
      }

      if (startAfter) {
        onToastRef.current?.(
          'success',
          `Renamed ${renamedCount || toPersist.length} file${
            (renamedCount || toPersist.length) === 1 ? '' : 's'
          } and started ${startedCount} download${startedCount === 1 ? '' : 's'}`
        );
      } else if (renamedCount > 0) {
        onToastRef.current?.(
          'success',
          `Renamed ${renamedCount} queued file${renamedCount === 1 ? '' : 's'}`
        );
      } else {
        onToastRef.current?.('info', 'Filenames already match the target names.');
      }
    },
    []
  );

  const startTransfers = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    unlockAudio();
    const idSet = new Set(ids);
    const now = Date.now();
    const toPersist: TransferItem[] = [];

    const nextList = transfersRef.current.map((item) => {
      if (!idSet.has(item.id)) return item;
      if (item.status === 'downloading' || item.status === 'completed' || item.status === 'queued') {
        return item;
      }
      const updated: TransferItem = {
        ...item,
        status: 'queued',
        error: null,
        updatedAt: now,
      };
      toPersist.push(updated);
      return updated;
    });

    if (toPersist.length === 0) return;
    transfersRef.current = nextList;
    setTransfers(nextList);
    for (const item of toPersist) {
      void putTransfer(item);
    }
    onToastRef.current?.(
      'info',
      `Started ${toPersist.length} queued download${toPersist.length === 1 ? '' : 's'}`
    );
  }, []);

  const verifyTransfer = useCallback(
    async (id: string, customExpectedRaw?: string | null) => {
      const item = transfersRef.current.find((t) => t.id === id);
      if (!item || item.status !== 'completed') return;

      if (customExpectedRaw !== undefined && customExpectedRaw !== null && customExpectedRaw.trim() !== '') {
        const parsed = normalizeSha256(customExpectedRaw);
        if (!parsed) {
          onToastRef.current?.(
            'error',
            'Invalid SHA-256 checksum — enter a 64-character hex digest or 44-character Base64 hash.'
          );
          return;
        }
        // If we already computed SHA-256, compare immediately without re-reading IndexedDB unless forced
        if (item.computedSha256) {
          const matches = item.computedSha256 === parsed;
          const updated: TransferItem = {
            ...item,
            expectedSha256: parsed,
            verificationStatus: matches ? 'verified' : 'mismatch',
            verificationError: matches
              ? null
              : 'SHA-256 mismatch — package does not match expected checksum.',
            verifiedAt: Date.now(),
            updatedAt: Date.now(),
          };
          upsertTransferState(updated);
          if (matches) {
            onToastRef.current?.('success', `${item.fileName}: SHA-256 verified against expected digest.`);
          } else {
            playErrorTone(soundMutedRef.current);
            onToastRef.current?.('error', `${item.fileName}: SHA-256 mismatch detected!`);
          }
          return;
        }
      }

      const result = await verifyTransferChunks(item, customExpectedRaw);
      if (result.verificationStatus === 'verified') {
        onToastRef.current?.('success', `${item.fileName}: SHA-256 integrity verified.`);
      } else if (result.verificationStatus === 'mismatch') {
        playErrorTone(soundMutedRef.current);
        onToastRef.current?.('error', `${item.fileName}: SHA-256 mismatch — package corrupted!`);
      } else if (result.verificationStatus === 'computed') {
        onToastRef.current?.('info', `${item.fileName}: SHA-256 checksum calculated.`);
      } else if (result.verificationStatus === 'error') {
        onToastRef.current?.('error', result.verificationError || 'SHA-256 verification failed.');
      }
    },
    [upsertTransferState, verifyTransferChunks]
  );

  const verifyAllCompleted = useCallback(async () => {
    const pending = transfersRef.current.filter(
      (t) =>
        t.status === 'completed' &&
        (!t.verificationStatus ||
          t.verificationStatus === 'unverified' ||
          t.verificationStatus === 'error')
    );
    for (const item of pending) {
      await verifyTransferChunks(item);
    }
  }, [verifyTransferChunks]);

  const redownloadTransfer = useCallback(
    async (id: string) => {
      unlockAudio();
      const item = transfersRef.current.find((t) => t.id === id);
      if (!item) return;
      const ctrl = controllersRef.current.get(id);
      if (ctrl) ctrl.abort();

      await deleteChunksForTransfer(id);
      const resetItem: TransferItem = {
        ...item,
        bytesDownloaded: 0,
        status: 'queued',
        mode: 'resumable',
        speedBps: 0,
        etaSeconds: null,
        error: null,
        computedSha256: null,
        verificationStatus: 'unverified',
        verifiedAt: null,
        verificationError: null,
        completedAt: null,
        updatedAt: Date.now(),
      };
      upsertTransferState(resetItem);
      onToastRef.current?.('info', `Re-downloading clean copy of ${item.fileName}`);
      void refreshStorageEstimate();
    },
    [refreshStorageEstimate, upsertTransferState]
  );

  const buildQueueExportPayload = useCallback((): QueueExportPayload => {
    const list = transfersRef.current;
    const now = Date.now();
    const exportedItems: ExportedQueueItem[] = list.map((item) => {
      const pct =
        item.sizeBytes > 0
          ? Math.min(100, Math.round((item.bytesDownloaded / item.sizeBytes) * 100))
          : item.status === 'completed'
            ? 100
            : 0;
      return {
        id: item.id,
        productId: item.productId,
        appTitle: item.appTitle,
        iconUrl: item.iconUrl,
        fileName: item.fileName,
        type: item.type,
        arch: item.arch,
        version: item.version,
        status: item.status,
        mode: item.mode,
        progressPercent: pct,
        bytesDownloaded: item.bytesDownloaded,
        sizeBytes: item.sizeBytes,
        sanitizedUrl: item.sanitizedUrl,
        rawUrl: item.rawUrl,
        proxyPath: buildProxyDownloadUrl(item.sanitizedUrl, item.fileName),
        expectedSha256: item.expectedSha256 ?? null,
        computedSha256: item.computedSha256 ?? null,
        verificationStatus: item.verificationStatus ?? 'unverified',
        error: item.error,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        completedAt: item.completedAt,
      };
    });

    return {
      schema: 'sideload-queue-v1',
      exportedAt: new Date(now).toISOString(),
      exportedAtMs: now,
      sourceOrigin: typeof window !== 'undefined' ? window.location.origin : '',
      holdQueue,
      summary: {
        total: list.length,
        downloading: list.filter((t) => t.status === 'downloading').length,
        queued: list.filter((t) => t.status === 'queued').length,
        paused: list.filter((t) => t.status === 'paused').length,
        interrupted: list.filter((t) => t.status === 'interrupted').length,
        completed: list.filter((t) => t.status === 'completed').length,
        error: list.filter((t) => t.status === 'error').length,
      },
      transfers: exportedItems,
    };
  }, [holdQueue]);

  const exportQueueJson = useCallback(() => {
    const payload = buildQueueExportPayload();
    if (payload.transfers.length === 0) {
      onToastRef.current?.('info', 'Your transfer queue is empty — nothing to export.');
      return;
    }

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 16);
    const fileName = `sideload-queue-${stamp}.json`;
    triggerBlobDownload(blob, fileName);
    onToastRef.current?.(
      'success',
      `Exported ${payload.transfers.length} transfer${
        payload.transfers.length === 1 ? '' : 's'
      } to ${fileName}`
    );
  }, [buildQueueExportPayload]);

  const copyQueueJson = useCallback(async (): Promise<boolean> => {
    const payload = buildQueueExportPayload();
    if (payload.transfers.length === 0) {
      onToastRef.current?.('info', 'Your transfer queue is empty — nothing to copy.');
      return false;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      onToastRef.current?.(
        'success',
        `Copied JSON snapshot of ${payload.transfers.length} transfer${
          payload.transfers.length === 1 ? '' : 's'
        } to clipboard`
      );
      return true;
    } catch {
      onToastRef.current?.('error', 'Clipboard access failed — use Export JSON file instead.');
      return false;
    }
  }, [buildQueueExportPayload]);

  const importQueueJson = useCallback(
    async (
      rawText: string
    ): Promise<{ added: number; skipped: number; rejected: number }> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        onToastRef.current?.('error', 'Invalid JSON file — could not parse queue snapshot.');
        return { added: 0, skipped: 0, rejected: 1 };
      }

      const candidateList: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { transfers?: unknown[] }).transfers)
          ? (parsed as { transfers: unknown[] }).transfers
          : parsed &&
              typeof parsed === 'object' &&
              Array.isArray((parsed as { items?: unknown[] }).items)
            ? (parsed as { items: unknown[] }).items
            : [];

      if (candidateList.length === 0) {
        onToastRef.current?.('error', 'No transfer entries found in the selected JSON file.');
        return { added: 0, skipped: 0, rejected: 0 };
      }

      const existingIds = new Set(transfersRef.current.map((t) => t.id));
      const existingUrlKeys = new Set(
        transfersRef.current.map((t) => `${t.sanitizedUrl}::${t.fileName}`)
      );

      let added = 0;
      let skipped = 0;
      let rejected = 0;
      const importedItems: TransferItem[] = [];
      const now = Date.now();

      for (let i = 0; i < candidateList.length; i++) {
        const entry = candidateList[i];
        if (!entry || typeof entry !== 'object') {
          rejected++;
          continue;
        }
        const rec = entry as Record<string, unknown>;
        const rawUrlCandidate =
          (typeof rec.sanitizedUrl === 'string' && rec.sanitizedUrl) ||
          (typeof rec.rawUrl === 'string' && rec.rawUrl) ||
          (typeof rec.url === 'string' && rec.url) ||
          '';

        const sanitized = sanitizePackageUrl(rawUrlCandidate);
        if (!sanitized.ok) {
          rejected++;
          continue;
        }

        const safeName = sanitizeFileName(
          typeof rec.fileName === 'string' ? rec.fileName : '',
          `package_${i + 1}.msix`
        );

        const candidateId =
          typeof rec.id === 'string' && rec.id.trim()
            ? rec.id.trim()
            : `imported-${now}-${i}`;

        const urlKey = `${sanitized.url}::${safeName}`;
        if (existingIds.has(candidateId) || existingUrlKeys.has(urlKey)) {
          skipped++;
          continue;
        }

        const { bytes: localChunkBytes } = await getDownloadedByteCount(candidateId);
        const rawStatus = (
          typeof rec.status === 'string' ? rec.status : 'paused'
        ) as TransferStatus;

        let nextStatus: TransferStatus;
        let nextError: string | null = null;
        if (rawStatus === 'completed') {
          nextStatus = 'completed';
        } else if (rawStatus === 'paused') {
          nextStatus = 'paused';
        } else {
          nextStatus = 'interrupted';
          nextError =
            localChunkBytes > 0
              ? 'Imported queue item — ready to resume from local chunks.'
              : 'Imported from queue JSON — click Resume to download on this device.';
        }

        const sizeBytes =
          typeof rec.sizeBytes === 'number' && Number.isFinite(rec.sizeBytes) && rec.sizeBytes >= 0
            ? rec.sizeBytes
            : 0;

        const expectedSha256 = normalizeSha256(
          typeof rec.expectedSha256 === 'string' ? rec.expectedSha256 : null
        );

        const item: TransferItem = {
          id: candidateId,
          productId:
            typeof rec.productId === 'string' && rec.productId.trim()
              ? rec.productId.trim()
              : 'IMPORTED',
          appTitle:
            typeof rec.appTitle === 'string' && rec.appTitle.trim()
              ? rec.appTitle.trim()
              : safeName,
          iconUrl: typeof rec.iconUrl === 'string' ? rec.iconUrl : null,
          fileName: safeName,
          sanitizedUrl: sanitized.url,
          rawUrl:
            typeof rec.rawUrl === 'string' && rec.rawUrl.trim()
              ? rec.rawUrl
              : sanitized.url,
          type: typeof rec.type === 'string' && rec.type ? rec.type : 'Package',
          arch: typeof rec.arch === 'string' && rec.arch ? rec.arch : 'any',
          version: typeof rec.version === 'string' ? rec.version : null,
          sizeBytes,
          bytesDownloaded: localChunkBytes,
          status: nextStatus,
          mode: 'resumable',
          speedBps: 0,
          etaSeconds: null,
          error: nextError,
          bgFetchId: null,
          expectedSha256,
          computedSha256:
            localChunkBytes > 0 && typeof rec.computedSha256 === 'string'
              ? normalizeSha256(rec.computedSha256)
              : null,
          verificationStatus:
            localChunkBytes > 0 &&
            (rec.verificationStatus === 'verified' ||
              rec.verificationStatus === 'mismatch' ||
              rec.verificationStatus === 'computed')
              ? rec.verificationStatus
              : 'unverified',
          verifiedAt: null,
          verificationError: null,
          createdAt:
            typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt)
              ? rec.createdAt
              : now,
          updatedAt: now,
          completedAt:
            nextStatus === 'completed' &&
            typeof rec.completedAt === 'number' &&
            Number.isFinite(rec.completedAt)
              ? rec.completedAt
              : null,
        };

        existingIds.add(candidateId);
        existingUrlKeys.add(urlKey);
        importedItems.push(item);
        added++;
      }

      if (importedItems.length > 0) {
        const nextList = [...importedItems, ...transfersRef.current];
        transfersRef.current = nextList;
        setTransfers(nextList);
        for (const item of importedItems) {
          await putTransfer(item);
        }
        void refreshStorageEstimate();
      }

      if (added > 0) {
        const extra = [
          skipped > 0 ? `${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : '',
          rejected > 0 ? `${rejected} invalid` : '',
        ]
          .filter(Boolean)
          .join(', ');
        onToastRef.current?.(
          'success',
          `Imported ${added} transfer${added === 1 ? '' : 's'} from queue JSON${
            extra ? ` (${extra})` : ''
          }`
        );
      } else {
        onToastRef.current?.(
          'info',
          `No new transfers imported (${skipped} duplicate${
            skipped === 1 ? '' : 's'
          }, ${rejected} invalid URL${rejected === 1 ? '' : 's'}).`
        );
      }

      return { added, skipped, rejected };
    },
    [refreshStorageEstimate]
  );

  return {
    transfers,
    holdQueue,
    toggleHoldQueue,
    storageInfo,
    isPersistentGranted,
    supportsBackgroundFetch,
    completionFlash,
    verifyingProgress,
    dismissCompletionFlash: () => setCompletionFlash(null),
    enqueuePackage,
    enqueueBatch,
    pauseTransfer,
    resumeTransfer,
    resumeAllInterrupted,
    pauseAll,
    cancelTransfer,
    saveCompletedFile,
    clearCompleted,
    renameTransfers,
    startTransfers,
    verifyTransfer,
    verifyAllCompleted,
    redownloadTransfer,
    exportQueueJson,
    copyQueueJson,
    importQueueJson,
  };
}
