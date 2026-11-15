import React from 'react';
import { ArrowRight, HardDriveDownload, Save, Trash2 } from 'lucide-react';
import type { ProductPackageResponse, TransferItem } from '../types/store';
import { formatBytes } from '../utils/urlSanitizer';

interface OfflineCachePanelProps {
  cachedProducts: ProductPackageResponse[];
  completedTransfers: TransferItem[];
  onLoadProduct: (product: ProductPackageResponse) => void;
  onDeleteCachedProduct: (productId: string) => void;
  onSaveCompleted: (item: TransferItem) => void;
  onGoToFinder: () => void;
}

export const OfflineCachePanel: React.FC<OfflineCachePanelProps> = ({
  cachedProducts,
  completedTransfers,
  onLoadProduct,
  onDeleteCachedProduct,
  onSaveCompleted,
  onGoToFinder,
}) => {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          Offline Catalog &amp; Saved Packages
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Every looked-up Microsoft Store manifest and completed transfer is cached locally in IndexedDB so you can inspect package links and re-save downloaded bundles even without internet access.
        </p>
      </div>

      {/* Completed Offline Packages */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-5 py-3">
          <h2 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Completed Offline Packages ({completedTransfers.length})
          </h2>
        </div>

        {completedTransfers.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No completed offline packages stored yet.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {completedTransfers.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {item.fileName}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                    {item.appTitle} · {formatBytes(item.bytesDownloaded)} ·{' '}
                    {new Date(item.completedAt || item.updatedAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onSaveCompleted(item)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap shrink-0"
                >
                  <Save className="size-3.5" />
                  Save to Disk
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Cached Store Manifests */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-5 py-3">
          <h2 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Cached Store Lookups ({cachedProducts.length})
          </h2>
        </div>

        {cachedProducts.length === 0 ? (
          <div className="p-8 text-center">
            <HardDriveDownload className="mx-auto size-8 text-slate-400" />
            <p className="mt-3 text-sm font-medium text-slate-800 dark:text-slate-200">
              No cached manifests yet
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Look up any app in Finder and its package catalog will be stored here for offline reference.
            </p>
            <button
              type="button"
              onClick={onGoToFinder}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white hover:bg-[#3846C9]"
            >
              Search Microsoft Store
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {cachedProducts.map((prod) => (
              <div
                key={prod.productId}
                className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {prod.iconUrl ? (
                    <img
                      src={prod.iconUrl}
                      alt={prod.title}
                      referrerPolicy="no-referrer"
                      className="size-10 shrink-0 rounded-lg border border-slate-200 dark:border-slate-800 object-cover"
                    />
                  ) : (
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#4453E0]/10 font-bold text-[#4453E0]">
                      {prod.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                      {prod.title}
                    </p>
                    <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                      {prod.publisher ?? 'Microsoft Store'} ·{' '}
                      <span className="font-mono">{prod.productId}</span> · {prod.files.length}{' '}
                      packages · {prod.ring}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onLoadProduct(prod)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    Open Links
                    <ArrowRight className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteCachedProduct(prod.productId)}
                    aria-label="Delete cached entry"
                    className="inline-flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-rose-600"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
