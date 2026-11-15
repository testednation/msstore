import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileEdit,
  HardDrive,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { TransferItem, TransferMode } from '../types/store';
import {
  RENAME_PATTERN_PRESETS,
  RENAME_PATTERN_TOKENS,
  buildBatchRenamePreview,
  formatBytes,
  sanitizeFileName,
} from '../utils/urlSanitizer';

interface TransferQueuePanelProps {
  transfers: TransferItem[];
  holdQueue: boolean;
  onToggleHoldQueue: () => void;
  storageInfo: { usage: number; quota: number } | null;
  isPersistentGranted: boolean;
  supportsBackgroundFetch: boolean;
  transferMode: TransferMode;
  onChangeTransferMode: (mode: TransferMode) => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  onTestSound: () => void;
  notificationPermission: NotificationPermission | 'unsupported';
  onRequestNotifications: () => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onSaveCompleted: (item: TransferItem) => void;
  onResumeAll: () => void;
  onPauseAll: () => void;
  onClearCompleted: () => void;
  onRenameTransfers: (
    updates: Array<{ id: string; fileName: string }>,
    startAfter?: boolean
  ) => void;
  onStartTransfers: (ids: string[]) => void;
  verifyingProgress: Record<string, number>;
  onVerifyTransfer: (id: string, customExpected?: string | null) => void;
  onVerifyAllCompleted: () => void;
  onRedownloadTransfer: (id: string) => void;
  onExportQueue: () => void;
  onCopyQueueJson: () => Promise<boolean>;
  onImportQueueJson: (rawText: string) => Promise<unknown>;
  onGoToFinder: () => void;
}

function isEligibleForRename(item: TransferItem): boolean {
  return item.status !== 'downloading' && item.status !== 'completed';
}

function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export const TransferQueuePanel: React.FC<TransferQueuePanelProps> = ({
  transfers,
  holdQueue,
  onToggleHoldQueue,
  storageInfo,
  isPersistentGranted,
  supportsBackgroundFetch,
  transferMode,
  onChangeTransferMode,
  soundMuted,
  onToggleSound,
  onTestSound,
  notificationPermission,
  onRequestNotifications,
  onPause,
  onResume,
  onCancel,
  onSaveCompleted,
  onResumeAll,
  onPauseAll,
  onClearCompleted,
  onRenameTransfers,
  onStartTransfers,
  verifyingProgress,
  onVerifyTransfer,
  onVerifyAllCompleted,
  onRedownloadTransfer,
  onExportQueue,
  onCopyQueueJson,
  onImportQueueJson,
  onGoToFinder,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pattern, setPattern] = useState<string>('{appName}_{version}_{arch}.msix');
  const [renameExpanded, setRenameExpanded] = useState<boolean>(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [expandedHashIds, setExpandedHashIds] = useState<Set<string>>(() => new Set());
  const [customHashInputs, setCustomHashInputs] = useState<Record<string, string>>({});
  const [copiedHashId, setCopiedHashId] = useState<string | null>(null);
  const [copiedQueueJson, setCopiedQueueJson] = useState<boolean>(false);
  const patternInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const activeCount = transfers.filter(
    (t) => t.status === 'downloading' || t.status === 'queued'
  ).length;
  const interruptedCount = transfers.filter(
    (t) => t.status === 'interrupted' || t.status === 'paused' || t.status === 'error'
  ).length;
  const completedCount = transfers.filter((t) => t.status === 'completed').length;
  const verifiedCount = transfers.filter(
    (t) => t.status === 'completed' && t.verificationStatus === 'verified'
  ).length;
  const mismatchCount = transfers.filter(
    (t) => t.status === 'completed' && t.verificationStatus === 'mismatch'
  ).length;
  const unverifiedCompletedCount = transfers.filter(
    (t) =>
      t.status === 'completed' &&
      (!t.verificationStatus ||
        t.verificationStatus === 'unverified' ||
        t.verificationStatus === 'error')
  ).length;

  const eligibleItems = useMemo(
    () => transfers.filter((t) => isEligibleForRename(t)),
    [transfers]
  );

  // Prune stale IDs if transfers finish, start downloading, or get removed
  useEffect(() => {
    const validIds = new Set(eligibleItems.map((t) => t.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [eligibleItems]);

  const selectedItems = useMemo(
    () => eligibleItems.filter((item) => selectedIds.has(item.id)),
    [eligibleItems, selectedIds]
  );

  const otherUsedNames = useMemo(() => {
    const selectedSet = new Set(selectedItems.map((i) => i.id));
    return transfers.filter((t) => !selectedSet.has(t.id)).map((t) => t.fileName);
  }, [selectedItems, transfers]);

  const previewItems = useMemo(
    () => buildBatchRenamePreview(selectedItems, pattern, otherUsedNames),
    [otherUsedNames, pattern, selectedItems]
  );

  const changedCount = useMemo(
    () => previewItems.filter((p) => p.changed).length,
    [previewItems]
  );

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllEligible = () => {
    setSelectedIds(new Set(eligibleItems.map((t) => t.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleInsertToken = (token: string) => {
    const input = patternInputRef.current;
    if (!input) {
      setPattern((prev) => `${prev}${token}`);
      return;
    }
    const start = input.selectionStart ?? pattern.length;
    const end = input.selectionEnd ?? pattern.length;
    const next = `${pattern.slice(0, start)}${token}${pattern.slice(end)}`;
    setPattern(next);
    window.requestAnimationFrame(() => {
      input.focus();
      const cursor = start + token.length;
      input.setSelectionRange(cursor, cursor);
    });
  };

  const handleApplyBatchRename = (startAfter: boolean) => {
    if (previewItems.length === 0) return;
    onRenameTransfers(
      previewItems.map((p) => ({ id: p.id, fileName: p.newName })),
      startAfter
    );
    if (startAfter) {
      setSelectedIds(new Set());
    }
  };

  const startInlineEdit = (item: TransferItem) => {
    setEditingId(item.id);
    setEditingName(item.fileName);
  };

  const commitInlineEdit = (item: TransferItem) => {
    const clean = sanitizeFileName(editingName, item.fileName);
    if (clean && clean !== item.fileName) {
      onRenameTransfers([{ id: item.id, fileName: clean }], false);
    }
    setEditingId(null);
    setEditingName('');
  };

  const allEligibleSelected =
    eligibleItems.length > 0 && selectedItems.length === eligibleItems.length;

  const toggleHashInspector = (id: string) => {
    setExpandedHashIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopySha256 = async (id: string, hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHashId(id);
      window.setTimeout(() => setCopiedHashId(null), 1600);
    } catch {
      // ignore
    }
  };

  const handleCopyQueue = async () => {
    const ok = await onCopyQueueJson();
    if (ok) {
      setCopiedQueueJson(true);
      window.setTimeout(() => setCopiedQueueJson(false), 1600);
    }
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    await onImportQueueJson(text);
  };

  return (
    <div className="space-y-6">
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        onChange={(e) => void handleImportFileChange(e)}
        className="hidden"
        aria-hidden="true"
      />
      {/* Header & Summary strip */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              Persistent Transfer Queue
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Stage and batch-rename queued packages, continue transfers across tab switches, and resume from IndexedDB chunks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {interruptedCount > 0 && (
              <button
                type="button"
                onClick={onResumeAll}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4453E0] px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] whitespace-nowrap shrink-0"
              >
                <Play className="size-3.5" />
                Start / Resume All ({interruptedCount})
              </button>
            )}
            {activeCount > 0 && (
              <button
                type="button"
                onClick={onPauseAll}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Pause className="size-3.5" />
                Pause Active
              </button>
            )}
            {unverifiedCompletedCount > 0 && (
              <button
                type="button"
                onClick={onVerifyAllCompleted}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-3.5 py-2 text-xs font-semibold text-emerald-800 dark:text-emerald-200 transition-colors hover:bg-emerald-100 dark:hover:bg-emerald-900/50 whitespace-nowrap shrink-0"
              >
                <ShieldCheck className="size-3.5" />
                Verify SHA-256 ({unverifiedCompletedCount})
              </button>
            )}
            {completedCount > 0 && (
              <button
                type="button"
                onClick={onClearCompleted}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Trash2 className="size-3.5" />
                Clear Completed
              </button>
            )}
            <button
              type="button"
              disabled={transfers.length === 0}
              onClick={onExportQueue}
              title="Export queue status, URLs, and metadata as JSON"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
              Export JSON
            </button>
            {transfers.length > 0 && (
              <button
                type="button"
                onClick={() => void handleCopyQueue()}
                title="Copy queue JSON snapshot to clipboard"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {copiedQueueJson ? (
                  <>
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                    Copied JSON
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5 text-slate-500 dark:text-slate-400" />
                    Copy JSON
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              title="Import queue JSON file from another session or machine"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Upload className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
              Import JSON
            </button>
          </div>
        </div>

        {/* 4-column metric grid */}
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-200 dark:border-slate-800 pt-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Active Transfers</p>
            <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
              {activeCount}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Staged / Paused</p>
            <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400">
              {interruptedCount}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Completed</p>
            <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {completedCount}
              {verifiedCount > 0 && (
                <span className="ml-1.5 font-sans text-xs font-normal text-slate-500 dark:text-slate-400">
                  · {verifiedCount} verified
                </span>
              )}
              {mismatchCount > 0 && (
                <span className="ml-1.5 font-sans text-xs font-semibold text-rose-600 dark:text-rose-400">
                  · {mismatchCount} mismatch
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <HardDrive className="size-3.5" />
              Persistent Storage
            </p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-white">
              {storageInfo ? formatBytes(storageInfo.usage) : 'Ready'}
              <span className="ml-1.5 font-sans text-xs font-normal text-slate-500 dark:text-slate-400">
                {isPersistentGranted ? '· Locked' : '· IndexedDB'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Background Execution, Queue Staging & Notification Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-slate-900 dark:text-white">
              Background Transfer Engine &amp; Staging
            </p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Choose how downloads run or hold new additions in queue so you can rename files first.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5 rounded-lg bg-slate-100 dark:bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => onChangeTransferMode('resumable')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  transferMode === 'resumable'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Resumable Queue
              </button>
              {supportsBackgroundFetch && (
                <button
                  type="button"
                  onClick={() => onChangeTransferMode('bgfetch')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    transferMode === 'bgfetch'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  SW Background Fetch
                </button>
              )}
              <button
                type="button"
                onClick={() => onChangeTransferMode('native')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  transferMode === 'native'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Browser Native Stream
              </button>
            </div>

            <div className="mt-3">
              <button
                type="button"
                onClick={onToggleHoldQueue}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  holdQueue
                    ? 'border-[#4453E0] bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]'
                    : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Lock className="size-3.5 shrink-0" />
                <span>
                  {holdQueue
                    ? 'Staging On: New packages wait in queue before starting'
                    : 'Hold new downloads in queue (rename before starting)'}
                </span>
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-900 dark:text-white">
              Completion Sound &amp; Flash Alerts
            </p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Flashes browser title, triggers desktop alerts, and plays an audio chime on completion.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onToggleSound}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {soundMuted ? (
                  <VolumeX className="size-3.5 text-rose-500" />
                ) : (
                  <Volume2 className="size-3.5 text-[#4453E0]" />
                )}
                {soundMuted ? 'Sound Muted' : 'Chime Enabled'}
              </button>
              <button
                type="button"
                onClick={onTestSound}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Test Chime
              </button>
              {notificationPermission !== 'unsupported' && (
                <button
                  type="button"
                  onClick={onRequestNotifications}
                  disabled={notificationPermission === 'granted'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <Bell className="size-3.5 text-[#4453E0]" />
                  {notificationPermission === 'granted'
                    ? 'Desktop Alerts On'
                    : notificationPermission === 'denied'
                      ? 'Alerts Blocked'
                      : 'Enable Desktop Alerts'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Batch Rename Studio (visible whenever queued/paused/interrupted/error items exist) */}
      {eligibleItems.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <FileEdit className="size-4 shrink-0 text-[#4453E0] dark:text-[#7A87FF]" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Batch Rename Queued Files
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {eligibleItems.length} eligible file{eligibleItems.length === 1 ? '' : 's'}
                  {' · '}
                  <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {selectedItems.length} selected
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={
                  allEligibleSelected ? handleClearSelection : handleSelectAllEligible
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {allEligibleSelected ? (
                  <CheckSquare className="size-3.5 text-[#4453E0]" />
                ) : (
                  <Square className="size-3.5 text-slate-400" />
                )}
                {allEligibleSelected
                  ? 'Deselect All'
                  : `Select All (${eligibleItems.length})`}
              </button>
              {selectedItems.length > 0 && !allEligibleSelected && (
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setRenameExpanded((v) => !v)}
                aria-expanded={renameExpanded}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {renameExpanded ? (
                  <>
                    <ChevronUp className="size-3.5" />
                    Hide
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3.5" />
                    Configure Pattern
                  </>
                )}
              </button>
            </div>
          </div>

          {renameExpanded && (
            <div className="space-y-4 border-t border-slate-200 dark:border-slate-800 px-5 py-4">
              {/* Pattern Input & Presets */}
              <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                <div>
                  <label
                    htmlFor="batch-rename-pattern"
                    className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
                  >
                    Filename Pattern
                  </label>
                  <input
                    ref={patternInputRef}
                    id="batch-rename-pattern"
                    type="text"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    placeholder="{appName}_{version}_{arch}.msix"
                    className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 font-mono text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-[#4453E0] focus:outline-none focus:ring-2 focus:ring-[#4453E0]/20"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500 dark:text-slate-400 mr-1">
                    Presets:
                  </span>
                  {RENAME_PATTERN_PRESETS.map((preset) => (
                    <button
                      key={preset.pattern}
                      type="button"
                      onClick={() => setPattern(preset.pattern)}
                      className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                        pattern === preset.pattern
                          ? 'border-[#4453E0] bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Token Insertion Helpers */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-slate-500 dark:text-slate-400 mr-1">
                  Insert token:
                </span>
                {RENAME_PATTERN_TOKENS.map((t) => (
                  <button
                    key={t.token}
                    type="button"
                    title={`Insert ${t.token} (${t.desc})`}
                    onClick={() => handleInsertToken(t.token)}
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-700 dark:text-slate-300 transition-colors hover:border-[#4453E0]/50 hover:text-[#4453E0] dark:hover:text-[#7A87FF] whitespace-nowrap shrink-0"
                  >
                    {t.token}
                  </button>
                ))}
              </div>

              {/* Live Before -> After Preview */}
              {selectedItems.length === 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 px-4 py-3 text-xs">
                  <span className="text-slate-600 dark:text-slate-400">
                    Check one or more queued files below to preview renamed filenames before downloading.
                  </span>
                  <button
                    type="button"
                    onClick={handleSelectAllEligible}
                    className="rounded-md bg-[#4453E0] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3846C9] whitespace-nowrap shrink-0"
                  >
                    Select All {eligibleItems.length} Eligible
                  </button>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                  <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <span>Filename Preview ({previewItems.length})</span>
                    <span className="font-mono normal-case tabular-nums">
                      {changedCount} will change
                    </span>
                  </div>
                  <div className="max-h-48 divide-y divide-slate-200/70 dark:divide-slate-800/70 overflow-y-auto">
                    {previewItems.map((row) => (
                      <div
                        key={row.id}
                        className="grid grid-cols-1 gap-1 px-3.5 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-2"
                      >
                        <span
                          title={row.oldName}
                          className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400"
                        >
                          {row.oldName}
                        </span>
                        <ArrowRight className="hidden size-3.5 shrink-0 text-slate-400 sm:block" />
                        <span
                          title={row.newName}
                          className={`truncate font-mono text-[11px] font-semibold ${
                            row.changed
                              ? 'text-[#4453E0] dark:text-[#7A87FF]'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {row.newName}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Batch Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Invalid filename characters are automatically sanitized and duplicate names are numbered.
                </span>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={selectedItems.length === 0 || !pattern.trim()}
                    onClick={() => handleApplyBatchRename(false)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Check className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
                    Apply Rename ({selectedItems.length})
                  </button>
                  <button
                    type="button"
                    disabled={selectedItems.length === 0 || !pattern.trim()}
                    onClick={() => handleApplyBatchRename(true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#4453E0] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Play className="size-3.5" />
                    Rename &amp; Start Downloads ({selectedItems.length})
                  </button>
                  {selectedItems.some((i) => i.status !== 'queued') && (
                    <button
                      type="button"
                      onClick={() => {
                        onStartTransfers(
                          selectedItems
                            .filter((i) => i.status !== 'queued')
                            .map((i) => i.id)
                        );
                        setSelectedIds(new Set());
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      Start Selected
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Transfer List */}
      {transfers.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center">
          <p className="text-base font-semibold text-slate-900 dark:text-white">
            Your persistent queue is empty
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-600 dark:text-slate-400">
            Search for a Microsoft Store app in Finder, or import an exported queue JSON file to resume transfers from another machine.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={onGoToFinder}
              className="inline-flex items-center gap-2 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9]"
            >
              Go to Package Finder
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Upload className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
              Import Queue JSON
            </button>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          {transfers.map((item) => {
            const pct =
              item.sizeBytes > 0
                ? Math.min(100, Math.round((item.bytesDownloaded / item.sizeBytes) * 100))
                : item.status === 'completed'
                  ? 100
                  : 0;
            const canRename = isEligibleForRename(item);
            const isSelected = selectedIds.has(item.id);
            const isEditing = editingId === item.id;
            const verStatus = item.verificationStatus ?? 'unverified';
            const verPct = verifyingProgress[item.id];
            const isHashExpanded =
              expandedHashIds.has(item.id) || verStatus === 'mismatch';

            return (
              <div
                key={item.id}
                className={`p-4 sm:p-5 transition-colors ${
                  verStatus === 'mismatch'
                    ? 'bg-rose-50/40 dark:bg-rose-950/20'
                    : isSelected
                      ? 'bg-[#4453E0]/[0.03] dark:bg-[#4453E0]/[0.08]'
                      : ''
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {canRename ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectItem(item.id)}
                        aria-label={`Select ${item.fileName} for batch rename`}
                        className="mt-1 size-4 shrink-0 cursor-pointer rounded border-slate-300 accent-[#4453E0]"
                      />
                    ) : (
                      <div className="mt-0.5 shrink-0">
                        {item.status === 'completed' ? (
                          verStatus === 'mismatch' ? (
                            <ShieldAlert className="size-4 text-rose-600 dark:text-rose-400" />
                          ) : verStatus === 'verifying' ? (
                            <Loader2 className="size-4 animate-spin text-[#4453E0]" />
                          ) : verStatus === 'verified' ? (
                            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                          )
                        ) : (
                          <span className="inline-block size-4" />
                        )}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            commitInlineEdit(item);
                          }}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setEditingId(null);
                                setEditingName('');
                              }
                            }}
                            autoFocus
                            className="h-8 min-w-0 flex-1 rounded-md border border-[#4453E0] bg-white dark:bg-slate-950 px-2.5 font-mono text-xs text-slate-900 dark:text-white focus:outline-none"
                          />
                          <button
                            type="submit"
                            className="inline-flex h-8 items-center gap-1 rounded-md bg-[#4453E0] px-2.5 text-xs font-semibold text-white hover:bg-[#3846C9] shrink-0"
                          >
                            <Check className="size-3.5" />
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null);
                              setEditingName('');
                            }}
                            aria-label="Cancel rename"
                            className="inline-flex h-8 items-center rounded-md border border-slate-300 dark:border-slate-700 px-2 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                          >
                            <X className="size-3.5" />
                          </button>
                        </form>
                      ) : (
                        <div className="flex items-center gap-2">
                          {(item.status === 'interrupted' || item.status === 'error') && (
                            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                          )}
                          <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                            {item.fileName}
                          </p>
                          {canRename && (
                            <button
                              type="button"
                              onClick={() => startInlineEdit(item)}
                              title="Rename this queued file"
                              aria-label={`Rename ${item.fileName}`}
                              className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 shrink-0"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          )}
                        </div>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400">
                        <span>{item.appTitle}</span>
                        {item.version && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">v{item.version}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>{item.type}</span>
                        {item.arch !== 'any' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{item.arch}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="capitalize">
                          {item.mode === 'bgfetch' ? 'Background Fetch' : 'Resumable IndexedDB'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 pl-7 sm:pl-0">
                    {(item.status === 'downloading' || item.status === 'queued') && (
                      <button
                        type="button"
                        onClick={() => onPause(item.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                      >
                        <Pause className="size-3.5" />
                        Pause
                      </button>
                    )}
                    {(item.status === 'paused' || item.status === 'interrupted') && (
                      <button
                        type="button"
                        onClick={() => onResume(item.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#4453E0] px-3 text-xs font-semibold text-white hover:bg-[#3846C9] whitespace-nowrap shrink-0"
                      >
                        <Play className="size-3.5" />
                        {item.bytesDownloaded === 0 && item.status === 'paused' ? 'Start' : 'Resume'}
                      </button>
                    )}
                    {item.status === 'error' && (
                      <button
                        type="button"
                        onClick={() => onResume(item.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="size-3.5" />
                        Retry
                      </button>
                    )}
                    {item.status === 'completed' && verStatus === 'mismatch' && (
                      <>
                        <button
                          type="button"
                          onClick={() => void onRedownloadTransfer(item.id)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="size-3.5" />
                          Re-download Clean Copy
                        </button>
                        <button
                          type="button"
                          onClick={() => onSaveCompleted(item)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          <Save className="size-3.5" />
                          Save Anyway
                        </button>
                      </>
                    )}
                    {item.status === 'completed' && verStatus !== 'mismatch' && (
                      <>
                        {(verStatus === 'unverified' || verStatus === 'error') && (
                          <button
                            type="button"
                            onClick={() => void onVerifyTransfer(item.id)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                          >
                            <ShieldCheck className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
                            Verify SHA-256
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={verStatus === 'verifying'}
                          onClick={() => onSaveCompleted(item)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 whitespace-nowrap shrink-0"
                        >
                          <Save className="size-3.5" />
                          Save File
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void onCancel(item.id)}
                      aria-label="Remove transfer"
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mt-3 pl-7">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400">
                      {item.error
                        ? item.error
                        : item.status === 'downloading'
                          ? 'Downloading…'
                          : item.status === 'queued'
                            ? 'Waiting in queue…'
                            : item.status === 'paused'
                              ? item.bytesDownloaded === 0
                                ? 'Staged — ready to rename or start'
                                : 'Paused — chunks stored safely'
                              : verStatus === 'verifying'
                                ? `Calculating SHA-256 checksum…${
                                    typeof verPct === 'number' ? ` ${verPct}%` : ''
                                  }`
                                : verStatus === 'mismatch'
                                  ? 'Completed · SHA-256 mismatch detected'
                                  : verStatus === 'verified'
                                    ? 'Completed · SHA-256 integrity verified'
                                    : 'Completed'}
                    </span>
                    <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {formatBytes(item.bytesDownloaded)}
                      {item.sizeBytes > 0 ? ` / ${formatBytes(item.sizeBytes)}` : ''}
                      {item.speedBps > 0 ? ` · ${formatBytes(item.speedBps)}/s` : ''}
                      {item.etaSeconds !== null &&
                      item.etaSeconds > 0 &&
                      item.status === 'downloading'
                        ? ` · ${item.etaSeconds}s`
                        : ''}
                      {` · ${pct}%`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ${
                        item.status === 'completed'
                          ? verStatus === 'mismatch'
                            ? 'bg-rose-600'
                            : verStatus === 'verifying'
                              ? 'bg-[#4453E0]'
                              : 'bg-emerald-600'
                          : item.status === 'error'
                            ? 'bg-rose-600'
                            : item.status === 'paused' || item.status === 'interrupted'
                              ? 'bg-amber-500'
                              : 'bg-[#4453E0]'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* SHA-256 Integrity Summary Strip & Expandable Inspector for Completed Transfers */}
                  {item.status === 'completed' && (
                    <div className="mt-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {verStatus === 'verifying' && (
                            <span className="inline-flex items-center gap-1.5 font-medium text-[#4453E0] dark:text-[#7A87FF]">
                              <Loader2 className="size-3.5 animate-spin" />
                              Verifying package SHA-256 checksum
                              {typeof verPct === 'number' ? ` (${verPct}%)` : '…'}
                            </span>
                          )}
                          {verStatus === 'verified' && (
                            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                              <ShieldCheck className="size-3.5 shrink-0" />
                              SHA-256 Verified · Matches Microsoft Store digest
                            </span>
                          )}
                          {verStatus === 'mismatch' && (
                            <span className="inline-flex items-center gap-1.5 font-semibold text-rose-600 dark:text-rose-400">
                              <ShieldAlert className="size-3.5 shrink-0" />
                              {item.verificationError ||
                                'SHA-256 Mismatch — Package may be corrupted!'}
                            </span>
                          )}
                          {verStatus === 'computed' && (
                            <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
                              <Shield className="size-3.5 shrink-0 text-[#4453E0] dark:text-[#7A87FF]" />
                              SHA-256 Calculated (no Store digest published)
                            </span>
                          )}
                          {verStatus === 'error' && (
                            <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="size-3.5 shrink-0" />
                              {item.verificationError || 'SHA-256 check failed'}
                            </span>
                          )}
                          {verStatus === 'unverified' && (
                            <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                              <Shield className="size-3.5 shrink-0" />
                              SHA-256 not yet verified
                            </span>
                          )}

                          {item.computedSha256 && (
                            <>
                              <span aria-hidden="true" className="text-slate-400">
                                ·
                              </span>
                              <code className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                {shortHash(item.computedSha256)}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  void handleCopySha256(item.id, item.computedSha256!)
                                }
                                title="Copy computed SHA-256"
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                              >
                                {copiedHashId === item.id ? (
                                  <>
                                    <Check className="size-3 text-emerald-600" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="size-3" />
                                    Copy
                                  </>
                                )}
                              </button>
                            </>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => toggleHashInspector(item.id)}
                          className="text-[11px] font-medium text-[#4453E0] dark:text-[#7A87FF] hover:underline whitespace-nowrap shrink-0"
                        >
                          {isHashExpanded ? 'Hide SHA-256 Details' : 'Inspect SHA-256'}
                        </button>
                      </div>

                      {isHashExpanded && (
                        <div className="mt-2.5 space-y-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs">
                          <div className="grid gap-2 sm:grid-cols-[130px_1fr] sm:items-center">
                            <span className="font-medium text-slate-600 dark:text-slate-400">
                              Computed SHA-256
                            </span>
                            <div className="flex items-center justify-between gap-2">
                              <code className="break-all font-mono text-[11px] text-slate-900 dark:text-slate-100">
                                {item.computedSha256 || 'Not calculated yet'}
                              </code>
                              {item.computedSha256 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopySha256(
                                      `${item.id}-full`,
                                      item.computedSha256!
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                                >
                                  {copiedHashId === `${item.id}-full` ? (
                                    <>
                                      <Check className="size-3 text-emerald-600" />
                                      Copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="size-3" />
                                      Copy
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid gap-2 sm:grid-cols-[130px_1fr] sm:items-center">
                            <span className="font-medium text-slate-600 dark:text-slate-400">
                              Expected SHA-256
                            </span>
                            {item.expectedSha256 ? (
                              <code
                                className={`break-all font-mono text-[11px] ${
                                  verStatus === 'mismatch'
                                    ? 'font-semibold text-rose-600 dark:text-rose-400'
                                    : verStatus === 'verified'
                                      ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                                      : 'text-slate-800 dark:text-slate-200'
                                }`}
                              >
                                {item.expectedSha256}
                              </code>
                            ) : (
                              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                Not provided in Store manifest — paste a known checksum below to compare
                              </span>
                            )}
                          </div>

                          <div className="flex flex-col gap-2 border-t border-slate-200 dark:border-slate-800 pt-2.5 sm:flex-row sm:items-center">
                            <input
                              type="text"
                              value={customHashInputs[item.id] ?? ''}
                              onChange={(e) =>
                                setCustomHashInputs((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              placeholder="Paste expected SHA-256 (64 hex chars or Base64) to verify…"
                              className="h-8 min-w-0 flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 font-mono text-[11px] text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-[#4453E0] focus:outline-none"
                            />
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                disabled={
                                  verStatus === 'verifying' ||
                                  !(customHashInputs[item.id] || '').trim()
                                }
                                onClick={() =>
                                  void onVerifyTransfer(
                                    item.id,
                                    customHashInputs[item.id]
                                  )
                                }
                                className="inline-flex h-8 items-center gap-1 rounded-md bg-[#4453E0] px-3 text-[11px] font-semibold text-white hover:bg-[#3846C9] disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                Compare Hash
                              </button>
                              <button
                                type="button"
                                disabled={verStatus === 'verifying'}
                                onClick={() => void onVerifyTransfer(item.id)}
                                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                <RotateCcw className="size-3" />
                                Re-verify
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
