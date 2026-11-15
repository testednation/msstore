import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderArchive,
  Pause,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { PackageFile, TransferItem } from '../types/store';
import { formatBytes } from '../utils/urlSanitizer';

interface PackageRowProps {
  file: PackageFile;
  isLatest: boolean;
  transfer?: TransferItem;
  copied: boolean;
  onCopySanitizedLink: (file: PackageFile) => void;
  onDownload: (file: PackageFile) => void;
  onNativeDownload: (file: PackageFile) => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onSaveCompleted: (transfer: TransferItem) => void;
  onCancel: (transferId: string) => void;
}

export const PackageRow: React.FC<PackageRowProps> = ({
  file,
  isLatest,
  transfer,
  copied,
  onCopySanitizedLink,
  onDownload,
  onNativeDownload,
  onPause,
  onResume,
  onSaveCompleted,
  onCancel,
}) => {
  const [showSanitizedInfo, setShowSanitizedInfo] = useState(false);

  const totalBytes = transfer?.sizeBytes || file.sizeBytes || 0;
  const downloadedBytes = transfer?.bytesDownloaded || 0;
  const pct =
    totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : transfer?.status === 'completed'
        ? 100
        : 0;

  const isActive =
    transfer?.status === 'downloading' || transfer?.status === 'queued';
  const isPausedOrInterrupted =
    transfer?.status === 'paused' || transfer?.status === 'interrupted';
  const isCompleted = transfer?.status === 'completed';
  const isError = transfer?.status === 'error';

  return (
    <div className="px-4 py-3.5 transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/30 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 sm:flex">
            <FolderArchive className="size-4" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">
              {file.fileName}
            </p>
            {/* Clean unboxed metadata with typographic separators */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400">
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {file.type}
              </span>
              {file.arch !== 'any' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{file.arch}</span>
                </>
              )}
              {file.version && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{file.version}</span>
                </>
              )}
              {file.sizeLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{file.sizeLabel}</span>
                </>
              )}
              {isLatest && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-[#4453E0] dark:text-[#7A87FF]">
                    Latest release
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action controls */}
        <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-center">
          <button
            type="button"
            onClick={() => setShowSanitizedInfo((s) => !s)}
            title="Inspect sanitized URL"
            aria-label="Inspect sanitized URL"
            className={`inline-flex size-8 items-center justify-center rounded-lg border transition-colors ${
              showSanitizedInfo
                ? 'border-[#4453E0]/40 bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]'
                : 'border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <ShieldCheck className="size-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onCopySanitizedLink(file)}
            title="Copy sanitized proxy download link"
            aria-label="Copy sanitized download link"
            className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => onNativeDownload(file)}
            title="Hand off directly to browser native download manager"
            aria-label="Direct browser stream download"
            className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ExternalLink className="size-3.5" />
          </button>

          {!transfer && (
            <button
              type="button"
              onClick={() => onDownload(file)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#4453E0] px-3.5 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] whitespace-nowrap shrink-0"
            >
              <Download className="size-3.5" />
              Download
            </button>
          )}

          {isActive && transfer && (
            <button
              type="button"
              onClick={() => onPause(transfer.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Pause className="size-3.5" />
              Pause
            </button>
          )}

          {isPausedOrInterrupted && transfer && (
            <button
              type="button"
              onClick={() => onResume(transfer.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#4453E0] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] whitespace-nowrap shrink-0"
            >
              <Play className="size-3.5" />
              Resume ({pct}%)
            </button>
          )}

          {isError && transfer && (
            <button
              type="button"
              onClick={() => onResume(transfer.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-rose-700 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="size-3.5" />
              Retry
            </button>
          )}

          {isCompleted && transfer && (
            <button
              type="button"
              onClick={() => onSaveCompleted(transfer)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 whitespace-nowrap shrink-0"
            >
              <Save className="size-3.5" />
              Save Again
            </button>
          )}

          {transfer && (
            <button
              type="button"
              onClick={() => onCancel(transfer.id)}
              title="Remove from queue"
              aria-label="Remove from queue"
              className="inline-flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Inline transfer progress bar for large files */}
      {transfer && (
        <div className="mt-3 sm:pl-12">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span
              className={`font-medium ${
                isCompleted
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : isError
                    ? 'text-rose-600 dark:text-rose-400'
                    : isPausedOrInterrupted
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-[#4453E0] dark:text-[#7A87FF]'
              }`}
            >
              {transfer.status === 'downloading' && 'Transferring in background…'}
              {transfer.status === 'queued' && 'Queued — waiting for slot…'}
              {transfer.status === 'paused' && 'Paused — progress saved to IndexedDB'}
              {transfer.status === 'interrupted' &&
                (transfer.error || 'Interrupted — ready to resume')}
              {transfer.status === 'completed' &&
                (transfer.verificationStatus === 'verifying'
                  ? 'Verifying SHA-256…'
                  : transfer.verificationStatus === 'mismatch'
                    ? 'Transfer complete · SHA-256 mismatch!'
                    : transfer.verificationStatus === 'verified'
                      ? 'Transfer complete · SHA-256 verified'
                      : 'Transfer complete')}
              {transfer.status === 'error' && (transfer.error || 'Transfer failed')}
            </span>

            <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
              {formatBytes(downloadedBytes)}
              {totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''}
              {transfer.speedBps > 0 ? ` · ${formatBytes(transfer.speedBps)}/s` : ''}
              {transfer.etaSeconds !== null &&
              transfer.etaSeconds > 0 &&
              transfer.status === 'downloading'
                ? ` · ${transfer.etaSeconds}s left`
                : ''}
              {` · ${pct}%`}
            </span>
          </div>

          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                isCompleted
                  ? 'bg-emerald-600'
                  : isError
                    ? 'bg-rose-600'
                    : isPausedOrInterrupted
                      ? 'bg-amber-500'
                      : 'bg-[#4453E0]'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Sanitized URL inspection panel */}
      {showSanitizedInfo && (
        <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs sm:ml-12">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              Sanitized CDN URL Verification
            </span>
            <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
              {file.isSigned ? 'Signed Microsoft Token Preserved' : 'Verified Microsoft CDN'}
            </span>
          </div>
          {file.sanitizationNotes.length > 0 && (
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Fixes applied: {file.sanitizationNotes.join(' · ')}
            </p>
          )}
          <p className="mt-1.5 break-all font-mono text-[11px] text-slate-600 dark:text-slate-400">
            {file.url}
          </p>
        </div>
      )}
    </div>
  );
};
