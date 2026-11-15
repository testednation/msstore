import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  Download,
  Keyboard,
  Loader2,
  Moon,
  PackageCheck,
  Play,
  Search,
  Sparkles,
  Star,
  Sun,
  Terminal,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import { BookmarkletModal } from './components/BookmarkletModal';
import { Header, type ActiveTab } from './components/Header';
import { OfflineCachePanel } from './components/OfflineCachePanel';
import { OfflineIndicator } from './components/PWAInstallButton';
import { PackageRow } from './components/PackageRow';
import { ProtocolIntegrationPanel } from './components/ProtocolIntegrationPanel';
import { TransferQueuePanel } from './components/TransferQueuePanel';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  triggerDirectSanitizedDownload,
  useTransferManager,
} from './hooks/useTransferManager';
import type {
  ArchFilter,
  PackageFile,
  PackageTypeFilter,
  ProductPackageResponse,
  StoreRing,
  StoreSearchResult,
  TransferMode,
} from './types/store';
import {
  playCompletionChime,
  requestNotificationPermission,
  unlockAudio,
} from './utils/notifications';
import {
  deleteCatalogEntry,
  getAllCatalogEntries,
  saveCatalogEntry,
} from './utils/queueDb';
import {
  buildProxyDownloadUrl,
  formatBytes,
  parseStoreInput,
  sanitizePackageUrl,
} from './utils/urlSanitizer';

const PRESET_APPS = [
  { label: 'Spotify', id: '9NCBCSZSJRSB' },
  { label: 'Windows Terminal', id: '9N0DX20HK701' },
  { label: 'Calculator', id: '9WZDNCRFHVN5' },
  { label: 'Paint', id: '9PCFS5B6T72H' },
  {
    label: 'File Viewer Plus',
    id: 'https://marketplace.microsoft.com/en-us/product/saas/Sharpened.FileViewerPlusEnterprise',
  },
];

const PACKAGE_TYPES: PackageTypeFilter[] = [
  'All',
  'MSIX Bundle',
  'APPX Bundle',
  'MSIX',
  'APPX',
];

const ARCHITECTURES: ArchFilter[] = ['All', 'x64', 'arm64', 'x86', 'arm'];

const RINGS: Array<{ value: StoreRing; label: string }> = [
  { value: 'Retail', label: 'Retail (RP)' },
  { value: 'RP', label: 'Release Preview' },
  { value: 'WIS', label: 'Insider Slow' },
  { value: 'WIF', label: 'Insider Fast' },
];

interface ToastMessage {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

const ProductAvatar: React.FC<{
  iconUrl: string | null;
  title: string;
  size?: 'sm' | 'md';
}> = ({ iconUrl, title, size = 'md' }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const dim = size === 'sm' ? 'size-9 rounded-lg' : 'size-12 rounded-xl';

  if (iconUrl && !imgFailed) {
    return (
      <img
        src={iconUrl}
        alt={title}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`${dim} shrink-0 border border-slate-200 dark:border-slate-800 object-cover bg-slate-100 dark:bg-slate-800`}
      />
    );
  }

  return (
    <div
      className={`${dim} flex shrink-0 items-center justify-center border border-[#4453E0]/20 bg-[#4453E0]/10 font-bold text-[#4453E0] dark:text-[#7A87FF]`}
    >
      {(title.trim()[0] || 'A').toUpperCase()}
    </div>
  );
};

export default function App() {
  const isOnline = useOnlineStatus();

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('sideload.theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('sideload.theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('sideload.theme', 'light');
    }
  }, [darkMode]);

  const [activeTab, setActiveTab] = useState<ActiveTab>('finder');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((kind: 'success' | 'error' | 'info', text: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const [soundMuted, setSoundMuted] = useState(
    () => localStorage.getItem('sideload.soundMuted') === '1'
  );
  const [transferMode, setTransferMode] = useState<TransferMode>(
    () => (localStorage.getItem('sideload.transferMode') as TransferMode) || 'resumable'
  );
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );

  const transferMgr = useTransferManager({
    soundMuted,
    onToast: addToast,
  });

  // Lookup state
  const [queryInput, setQueryInput] = useState('');
  const [ring, setRing] = useState<StoreRing>('Retail');
  const [lookupStatus, setLookupStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle'
  );
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupTargetName, setLookupTargetName] = useState<string | null>(null);
  const [productData, setProductData] = useState<ProductPackageResponse | null>(null);

  // Live search state
  const [searchResults, setSearchResults] = useState<StoreSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Filters & toggles
  const [typeFilter, setTypeFilter] = useState<PackageTypeFilter>('All');
  const [archFilter, setArchFilter] = useState<ArchFilter>('All');
  const [selectedPackageIds, setSelectedPackageIds] = useState<Set<string>>(() => new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [offlineMode, setOfflineMode] = useState(
    () => localStorage.getItem('sideload.offlineMode') === '1'
  );
  const [autoDownload, setAutoDownload] = useState(
    () => localStorage.getItem('sideload.autoDownload') === '1'
  );
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Cached offline catalog
  const [cachedProducts, setCachedProducts] = useState<ProductPackageResponse[]>([]);

  const resultsRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastNonTransferTabRef = useRef<ActiveTab>('finder');
  const handledInitialUrlRef = useRef(false);

  const refreshCatalogCache = useCallback(async () => {
    try {
      const entries = await getAllCatalogEntries();
      setCachedProducts(entries);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshCatalogCache();
  }, [refreshCatalogCache]);

  // Clear package selection whenever active product changes
  useEffect(() => {
    setSelectedPackageIds(new Set());
  }, [productData?.productId]);

  const handleToggleSound = () => {
    const next = !soundMuted;
    setSoundMuted(next);
    localStorage.setItem('sideload.soundMuted', next ? '1' : '0');
    if (!next) {
      unlockAudio();
      playCompletionChime(false);
    }
  };

  const handleChangeTransferMode = (mode: TransferMode) => {
    setTransferMode(mode);
    localStorage.setItem('sideload.transferMode', mode);
  };

  const handleRequestNotifications = async () => {
    const perm = await requestNotificationPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      addToast('success', 'Desktop completion notifications enabled.');
    } else if (perm === 'denied') {
      addToast('error', 'Notifications were blocked by browser permissions.');
    }
  };

  const handleFetchPackages = useCallback(
    async (rawTarget: string, displayTitle: string | null = null, overrideRing?: StoreRing) => {
      unlockAudio();
      const targetRing = overrideRing ?? ring;
      setLookupStatus('loading');
      setLookupError(null);
      setSearchResults(null);
      setLookupTargetName(displayTitle);

      try {
        if (!navigator.onLine) {
          // Serve from offline IndexedDB cache if available
          const cached = cachedProducts.find(
            (c) =>
              c.productId.toUpperCase() === rawTarget.trim().toUpperCase() ||
              c.title.toLowerCase().includes(rawTarget.trim().toLowerCase())
          );
          if (cached) {
            setProductData(cached);
            setLookupStatus('success');
            setTypeFilter('All');
            setArchFilter('All');
            addToast('info', `Loaded ${cached.title} from offline IndexedDB cache.`);
            return;
          }
          throw new Error('You are currently offline and this app is not in your local cache.');
        }

        const res = await fetch(
          `/api/packages?input=${encodeURIComponent(rawTarget)}&ring=${encodeURIComponent(targetRing)}`
        );
        const json = (await res.json()) as ProductPackageResponse & { error?: string };
        if (!res.ok) {
          throw new Error(json.error || `Lookup failed (HTTP ${res.status})`);
        }

        setProductData(json);
        setLookupStatus('success');
        setTypeFilter('All');
        setArchFilter('All');

        // Persist in IndexedDB catalog cache for offline access
        await saveCatalogEntry(json);
        void refreshCatalogCache();

        addToast(
          'success',
          `Found ${json.files.length} package${json.files.length === 1 ? '' : 's'} for ${json.title}`
        );

        if (autoDownload && json.files.length > 0) {
          const latest = json.files[0];
          window.setTimeout(() => {
            addToast('info', `Auto-downloading latest bundle: ${latest.fileName}`);
            void transferMgr.enqueuePackage(
              latest,
              {
                productId: json.productId,
                appTitle: json.title,
                iconUrl: json.iconUrl,
              },
              transferMode
            );
          }, 300);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Something went wrong. Try again.';
        setLookupError(msg);
        setLookupStatus('error');
      }
    },
    [
      addToast,
      autoDownload,
      cachedProducts,
      refreshCatalogCache,
      ring,
      transferMgr,
      transferMode,
    ]
  );

  // Live debounced search for plain app names
  useEffect(() => {
    const trimmed = queryInput.trim();
    const looksLikeUrlOrId =
      /^[0-9][A-Z0-9]{11,13}$/i.test(trimmed) ||
      /^https?:\/\//i.test(trimmed) ||
      /microsoft\.com/i.test(trimmed) ||
      /^(?:ms-(?:windows-)?store|web\+msstore):/i.test(trimmed);

    if (trimmed.length < 2 || looksLikeUrlOrId || lookupStatus === 'loading') {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    if (!navigator.onLine) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
        const json = (await res.json()) as { results?: StoreSearchResult[] };
        if (!cancelled) {
          setSearchResults(Array.isArray(json.results) ? json.results : []);
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setIsSearching(false);
    };
  }, [queryInput, lookupStatus]);

  // Handle incoming protocol / query parameters (?link=, ?productId=, ?query=, ?tab=)
  useEffect(() => {
    if (handledInitialUrlRef.current) return;
    handledInitialUrlRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'transfers' || tabParam === 'protocol' || tabParam === 'offline') {
      setActiveTab(tabParam);
    }

    const incoming = params.get('productId') || params.get('link') || params.get('query');
    if (!incoming) return;

    window.history.replaceState(null, '', window.location.pathname);
    setQueryInput(incoming);
    const parsed = parseStoreInput(incoming);
    if (parsed.kind === 'product') {
      void handleFetchPackages(parsed.productId);
    } else {
      setQueryInput(parsed.query);
    }
  }, [handleFetchPackages]);

  const executeLookup = useCallback(async () => {
    unlockAudio();
    const trimmed = queryInput.trim();
    if (!trimmed) {
      addToast('error', 'Type an app name, or paste a Store link / Product ID.');
      setActiveTab('finder');
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }
    setActiveTab('finder');
    const parsed = parseStoreInput(trimmed);
    if (parsed.kind === 'product') {
      await handleFetchPackages(parsed.productId);
    } else {
      setProductData(null);
      setLookupStatus('idle');
      setLookupError(null);
      setIsSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(parsed.query)}`);
        const json = (await res.json()) as { results?: StoreSearchResult[] };
        setSearchResults(Array.isArray(json.results) ? json.results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }
  }, [addToast, handleFetchPackages, queryInput]);

  const handleSubmitLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeLookup();
  };

  useEffect(() => {
    if (activeTab !== 'transfers') {
      lastNonTransferTabRef.current = activeTab;
    }
  }, [activeTab]);

  // Global keyboard shortcuts: Ctrl+F (focus search), Ctrl+Enter (trigger search), Ctrl+T (toggle transfers)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      const isTypingField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (mod && !e.altKey && !e.shiftKey && key === 'f') {
        e.preventDefault();
        setActiveTab('finder');
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }

      if (mod && !e.altKey && e.key === 'Enter') {
        e.preventDefault();
        void executeLookup();
        return;
      }

      if ((mod && !e.altKey && !e.shiftKey && key === 't') || (e.altKey && !mod && key === 't')) {
        e.preventDefault();
        setActiveTab((prev) =>
          prev === 'transfers' ? lastNonTransferTabRef.current : 'transfers'
        );
        return;
      }

      if (e.key === 'Escape') {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (bookmarkletOpen) {
          setBookmarkletOpen(false);
          return;
        }
        if (isTypingField && target) {
          target.blur();
        }
        return;
      }

      if (!isTypingField && !mod && !e.altKey) {
        if (e.key === '/') {
          e.preventDefault();
          setActiveTab('finder');
          window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
          });
        } else if (e.key === '?') {
          e.preventDefault();
          setShortcutsOpen((prev) => !prev);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bookmarkletOpen, executeLookup, shortcutsOpen]);

  const handleCopySanitizedLink = async (file: PackageFile) => {
    const sanitized = sanitizePackageUrl(file.url);
    if (!sanitized.ok) {
      addToast('error', `Cannot copy invalid link: ${sanitized.error}`);
      return;
    }
    const proxyAbsolute = `${window.location.origin}${buildProxyDownloadUrl(
      sanitized.url,
      file.fileName
    )}`;
    try {
      await navigator.clipboard.writeText(proxyAbsolute);
      setCopiedId(file.id);
      window.setTimeout(() => setCopiedId(null), 1600);
      addToast('success', 'Sanitized direct download link copied.');
    } catch {
      addToast('error', 'Clipboard access failed — copy link from inspector.');
    }
  };

  const handleDownloadFile = (file: PackageFile) => {
    if (!productData) return;
    void transferMgr.enqueuePackage(
      file,
      {
        productId: productData.productId,
        appTitle: productData.title,
        iconUrl: productData.iconUrl,
      },
      transferMode
    );
  };

  const toggleSelectPackage = useCallback((fileId: string) => {
    setSelectedPackageIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);

  const toggleSelectGroup = useCallback((groupFiles: PackageFile[]) => {
    setSelectedPackageIds((prev) => {
      const next = new Set(prev);
      const allSelected =
        groupFiles.length > 0 && groupFiles.every((f) => next.has(f.id));
      if (allSelected) {
        for (const f of groupFiles) next.delete(f.id);
      } else {
        for (const f of groupFiles) next.add(f.id);
      }
      return next;
    });
  }, []);

  const handleQueueSelectedFiles = useCallback(
    (filesToQueue: PackageFile[]) => {
      if (!productData || filesToQueue.length === 0) return;
      void transferMgr.enqueueBatch(
        filesToQueue,
        {
          productId: productData.productId,
          appTitle: productData.title,
          iconUrl: productData.iconUrl,
        },
        transferMode
      );
      setSelectedPackageIds((prev) => {
        const next = new Set(prev);
        for (const f of filesToQueue) {
          next.delete(f.id);
        }
        return next;
      });
    },
    [productData, transferMgr, transferMode]
  );

  const handleNativeDownloadFile = (file: PackageFile) => {
    unlockAudio();
    const ok = triggerDirectSanitizedDownload(file.url, file.fileName);
    if (ok) {
      addToast('info', `Started sanitized browser download for ${file.fileName}`);
    } else {
      addToast('error', 'Download link failed URL sanitization.');
    }
  };

  // Filtered & grouped files
  const groupedPackages = useMemo(() => {
    if (!productData) return [];
    const filtered = productData.files.filter(
      (f) =>
        (typeFilter === 'All' || f.type === typeFilter) &&
        (archFilter === 'All' || f.arch === archFilter)
    );
    const map = new Map<string, PackageFile[]>();
    for (const f of filtered) {
      const key = f.version ?? 'Other';
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return Array.from(map.entries()).map(([version, files]) => ({ version, files }));
  }, [productData, typeFilter, archFilter]);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of productData?.files ?? []) {
      map.set(f.type, (map.get(f.type) ?? 0) + 1);
    }
    return map;
  }, [productData]);

  const archCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of productData?.files ?? []) {
      map.set(f.arch, (map.get(f.arch) ?? 0) + 1);
    }
    return map;
  }, [productData]);

  // Transfer lookups mapped by URL and fileName + productId
  const transferLookup = useMemo(() => {
    const map = new Map<string, (typeof transferMgr.transfers)[number]>();
    for (const t of transferMgr.transfers) {
      const nameKey = `${t.productId}::${t.fileName}`;
      if (!map.has(nameKey)) map.set(nameKey, t);
      if (t.sanitizedUrl) {
        const urlKey = `${t.productId}::${t.sanitizedUrl}`;
        if (!map.has(urlKey)) map.set(urlKey, t);
      }
      if (t.rawUrl) {
        const rawKey = `${t.productId}::${t.rawUrl}`;
        if (!map.has(rawKey)) map.set(rawKey, t);
      }
    }
    return map;
  }, [transferMgr.transfers]);

  const activeTransfers = transferMgr.transfers.filter(
    (t) => t.status === 'downloading' || t.status === 'queued'
  );
  const interruptedTransfers = transferMgr.transfers.filter(
    (t) => t.status === 'interrupted'
  );
  const stagedTransfers = transferMgr.transfers.filter(
    (t) => t.status === 'paused'
  );
  const failedTransfers = transferMgr.transfers.filter(
    (t) => t.status === 'error'
  );
  const completedTransfers = transferMgr.transfers.filter(
    (t) => t.status === 'completed'
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 transition-colors">
      {/* Subtle full-screen edge flash overlay on download completion */}
      {transferMgr.completionFlash && (
        <div
          key={transferMgr.completionFlash.at}
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 border-4 border-emerald-500/70 bg-emerald-500/5 animate-completion-flash"
        />
      )}

      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeTransferCount={
          activeTransfers.length +
          interruptedTransfers.length +
          stagedTransfers.length +
          failedTransfers.length
        }
      />

      <main className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6 sm:pt-8">
        {/* Workspace Utility Toolbar (below header, keeping Top Bar strictly 3-zone) */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-slate-600 dark:text-slate-400">
            <span className="font-medium text-slate-800 dark:text-slate-200">
              MS Store Direct Package Downloader
            </span>
            <span aria-hidden="true">·</span>
            <span>{isOnline ? 'Online' : 'Offline Mode'}</span>
            {transferMgr.isPersistentGranted && (
              <>
                <span aria-hidden="true">·</span>
                <span>Persistent Queue Active</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleSound}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              title="Toggle completion sound chime"
            >
              {soundMuted ? (
                <VolumeX className="size-3.5 text-slate-400" />
              ) : (
                <Volume2 className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
              )}
              <span>{soundMuted ? 'Muted' : 'Sound On'}</span>
            </button>

            {notificationPermission !== 'unsupported' &&
              notificationPermission !== 'granted' && (
                <button
                  type="button"
                  onClick={() => void handleRequestNotifications()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Bell className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
                  <span>Enable Alerts</span>
                </button>
              )}

            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Keyboard className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
              <span>Shortcuts</span>
            </button>

            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label="Toggle color theme"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {darkMode ? (
                <>
                  <Sun className="size-3.5 text-amber-400" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="size-3.5 text-slate-600" />
                  <span>Dark</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Completion Flash Notification Banner */}
        {transferMgr.completionFlash && (
          <div
            role="status"
            className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/50 px-4 py-3 text-sm"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="font-medium text-emerald-950 dark:text-emerald-100">
                Download complete: <strong className="font-semibold">{transferMgr.completionFlash.fileName}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('transfers')}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                View Transfers
              </button>
              <button
                type="button"
                onClick={transferMgr.dismissCompletionFlash}
                aria-label="Dismiss notification"
                className="rounded-md p-1 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        )}

        {/* Interrupted Transfers Recovery Banner */}
        {interruptedTransfers.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-amber-950 dark:text-amber-100">
                <strong className="font-semibold">
                  {interruptedTransfers.length} interrupted transfer
                  {interruptedTransfers.length === 1 ? '' : 's'}
                </strong>{' '}
                restored from persistent storage with saved byte progress.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={transferMgr.resumeAllInterrupted}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 whitespace-nowrap shrink-0"
              >
                <Play className="size-3.5" />
                Resume All
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('transfers')}
                className="rounded-lg border border-amber-400/60 dark:border-amber-700 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50 whitespace-nowrap shrink-0"
              >
                Manage Queue
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: FINDER */}
        {activeTab === 'finder' && (
          <div>
            {/* Search & Lookup Card */}
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
              <form onSubmit={(e) => void handleSubmitLookup(e)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="store-input"
                    className="text-sm font-semibold tracking-tight text-slate-900 dark:text-white"
                  >
                    Search the Store, or paste a link / product ID
                  </label>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">Channel:</span>
                    <select
                      aria-label="Release channel"
                      value={ring}
                      onChange={(e) => setRing(e.target.value as StoreRing)}
                      className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200"
                    >
                      {RINGS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-2.5 sm:flex-row">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                    <input
                      ref={searchInputRef}
                      id="store-input"
                      type="text"
                      value={queryInput}
                      onChange={(e) => setQueryInput(e.target.value)}
                      placeholder="Spotify, Windows Terminal, ms-windows-store://pdp/?ProductId=…"
                      disabled={lookupStatus === 'loading'}
                      autoFocus
                      className="h-11 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-10 pr-20 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-[#4453E0] focus:outline-none focus:ring-2 focus:ring-[#4453E0]/20 disabled:opacity-60"
                    />
                    {isSearching ? (
                      <Loader2 className="absolute right-3.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-[#4453E0]" />
                    ) : (
                      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400 sm:inline-block">
                        Ctrl+F
                      </kbd>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={lookupStatus === 'loading'}
                    title="Trigger search or package lookup (Ctrl+Enter)"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#4453E0] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#3846C9] disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    {lookupStatus === 'loading' ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Generating…
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4" />
                        Get links
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setBookmarkletOpen(true)}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 text-sm font-medium text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    <Wand2 className="size-4 text-[#4453E0] dark:text-[#7A87FF]" />
                    Capture
                  </button>
                </div>
              </form>

              {/* Quick Try Presets */}
              <div className="mt-3.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-500 dark:text-slate-400">Try:</span>
                {PRESET_APPS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setQueryInput(preset.id);
                      void handleFetchPackages(preset.id, preset.label);
                    }}
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-300 transition-colors hover:border-[#4453E0]/40 hover:text-[#4453E0] dark:hover:text-[#7A87FF] whitespace-nowrap shrink-0"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {/* Options */}
              <div className="mt-4 space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={offlineMode}
                      onChange={(e) => {
                        setOfflineMode(e.target.checked);
                        localStorage.setItem(
                          'sideload.offlineMode',
                          e.target.checked ? '1' : '0'
                        );
                      }}
                      className="size-4 rounded border-slate-300 accent-[#4453E0]"
                    />
                    Offline download mode (persist packages in IndexedDB for USB / offline installs)
                  </label>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Resumes cleanly across tab switches &amp; interruptions
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={autoDownload}
                      onChange={(e) => {
                        setAutoDownload(e.target.checked);
                        localStorage.setItem(
                          'sideload.autoDownload',
                          e.target.checked ? '1' : '0'
                        );
                      }}
                      className="size-4 rounded border-slate-300 accent-[#4453E0]"
                    />
                    Auto-download the latest bundle after generation
                  </label>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">Transfer:</span>
                    <select
                      aria-label="Transfer mode"
                      value={transferMode}
                      onChange={(e) => handleChangeTransferMode(e.target.value as TransferMode)}
                      className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200"
                    >
                      <option value="resumable">Resumable Background Queue</option>
                      {transferMgr.supportsBackgroundFetch && (
                        <option value="bgfetch">SW Background Fetch (Tab-Close Safe)</option>
                      )}
                      <option value="native">Direct Browser Native Stream</option>
                    </select>
                  </div>
                </div>

                {transferMode === 'resumable' && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={transferMgr.holdQueue}
                        onChange={transferMgr.toggleHoldQueue}
                        className="size-4 rounded border-slate-300 accent-[#4453E0]"
                      />
                      Hold queued downloads before starting (allows batch renaming files first)
                    </label>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Rename in Transfers (Ctrl+T)
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* Live Search Dropdown Results */}
            {searchResults !== null && lookupStatus !== 'loading' && (
              <section className="mt-4 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-2.5 text-xs">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {isSearching
                      ? 'Searching Microsoft Store…'
                      : searchResults.length === 0
                        ? 'No matching apps found'
                        : `Store results for "${queryInput.trim()}"`}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    Click an app to generate sanitized links
                  </span>
                </div>

                {isSearching ? (
                  <div className="space-y-3 p-4">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="size-9 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-3.5 w-1/3 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                          <div className="h-3 w-1/4 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="max-h-80 divide-y divide-slate-200 dark:divide-slate-800 overflow-y-auto">
                    {searchResults.map((item) => (
                      <button
                        key={item.productId}
                        type="button"
                        onClick={() => {
                          setQueryInput(item.productId);
                          resultsRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start',
                          });
                          void handleFetchPackages(item.productId, item.title);
                        }}
                        className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <ProductAvatar iconUrl={item.iconUrl} title={item.title} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                            {item.title}
                          </p>
                          <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                            {item.publisher ?? 'Microsoft Store'}
                            {item.rating !== null && (
                              <span className="ml-2 inline-flex items-center gap-1 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                <Star className="size-3 fill-amber-400 text-amber-400" />
                                {item.rating.toFixed(1)}
                                {item.ratingsCount !== null
                                  ? ` (${item.ratingsCount.toLocaleString()})`
                                  : ''}
                              </span>
                            )}
                          </p>
                        </div>
                        {item.price && (
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            {item.price}
                          </span>
                        )}
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#4453E0]/10 text-[#4453E0] transition-colors group-hover:bg-[#4453E0] group-hover:text-white">
                          <ArrowRight className="size-3.5" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Loading State */}
            {lookupStatus === 'loading' && (
              <section
                ref={resultsRef}
                className="mt-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6"
              >
                <div className="flex items-center gap-2.5 text-sm font-medium text-slate-700 dark:text-slate-300">
                  <Loader2 className="size-4 animate-spin text-[#4453E0]" />
                  <span>
                    {lookupTargetName
                      ? `Querying Microsoft FE3 Delivery Catalog for ${lookupTargetName}…`
                      : 'Querying Microsoft DisplayCatalog & FE3 Delivery servers…'}
                  </span>
                </div>
                <div className="mt-5 space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="size-9 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3.5 w-3/4 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                        <div className="h-3 w-1/2 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                      </div>
                      <div className="h-8 w-24 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Error State */}
            {lookupStatus === 'error' && (
              <section className="mt-5 rounded-xl border border-rose-300 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30 p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-rose-600 dark:text-rose-400" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">
                        Package lookup failed
                      </p>
                      <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                        {lookupError}
                      </p>
                      <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                        DRM-protected games, Win32-hosted installers, or paid subscription-only listings may not distribute MSIX/APPX bundles via FE3.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFetchPackages(queryInput)}
                    className="inline-flex h-8 shrink-0 items-center rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Try again
                  </button>
                </div>
              </section>
            )}

            {/* Empty / Idle State */}
            {lookupStatus === 'idle' && searchResults === null && !isSearching && (
              <section className="mt-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 sm:p-10 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]">
                  <PackageCheck className="size-6" />
                </div>
                <h2 className="mt-4 text-lg font-bold tracking-tight text-slate-900 dark:text-white text-balance">
                  Search the Store by name — sanitized package links follow automatically
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  Type any app name or paste an{' '}
                  <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
                    apps.microsoft.com
                  </code>{' '}
                  or{' '}
                  <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
                    ms-windows-store://
                  </code>{' '}
                  link. Sideload queries Microsoft&apos;s delivery servers directly, sanitizes every signed CDN URL, and streams transfers with resumable IndexedDB persistence.
                </p>

                <div className="mx-auto mt-6 grid max-w-2xl gap-3 text-left text-xs text-slate-600 dark:text-slate-400 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5">
                    <p className="font-semibold text-slate-900 dark:text-white">
                      Zero Link Mangling
                    </p>
                    <p className="mt-1">
                      Decodes XML entities and preserves HMAC query signatures cleanly via range-capable proxy streaming.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5">
                    <p className="font-semibold text-slate-900 dark:text-white">
                      Background &amp; Resumable
                    </p>
                    <p className="mt-1">
                      Leave tabs safely while transfers continue; interrupted downloads resume from saved IndexedDB chunks.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5">
                    <p className="font-semibold text-slate-900 dark:text-white">
                      Offline PWA &amp; Protocol
                    </p>
                    <p className="mt-1">
                      Install offline and bind{' '}
                      <code className="font-mono">ms-windows-store://</code>{' '}
                      directly to Sideload.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* Success: Product Packages */}
            {lookupStatus === 'success' && productData && (
              <div ref={resultsRef} className="mt-5 space-y-5">
                {/* Product Summary & Filter Bar */}
                <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-4">
                      <ProductAvatar
                        iconUrl={productData.iconUrl}
                        title={productData.title}
                      />
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                          {productData.title}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400">
                          <span>{productData.publisher ?? 'Microsoft Store'}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{productData.productId}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                            {productData.files.length} packages
                          </span>
                          {productData.runtimes.length > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-[#4453E0] dark:text-[#7A87FF] tabular-nums">
                                {productData.runtimes.length} runtime
                                {productData.runtimes.length === 1 ? '' : 's'}
                              </span>
                            </>
                          )}
                        </div>
                        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                          Sanitized Microsoft delivery CDN links · signed URLs expire after several hours.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          void transferMgr.enqueueBatch(
                            [...productData.files.slice(0, 1), ...productData.runtimes],
                            {
                              productId: productData.productId,
                              appTitle: productData.title,
                              iconUrl: productData.iconUrl,
                            },
                            transferMode
                          )
                        }
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                      >
                        <Download className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
                        Queue Latest + Runtimes
                      </button>
                    </div>
                  </div>

                  {/* Interactive Filter Segmented Buttons */}
                  <div className="mt-5 flex flex-wrap items-center gap-1.5 border-t border-slate-200 dark:border-slate-800 pt-4">
                    {PACKAGE_TYPES.map((t) => {
                      const count = t === 'All' ? productData.files.length : typeCounts.get(t);
                      const active = typeFilter === t;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTypeFilter(t)}
                          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-[#4453E0] text-white'
                              : 'border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <span>{t}</span>
                          {count !== undefined && (
                            <span
                              className={`font-mono tabular-nums ${
                                active ? 'text-white/80' : 'text-slate-400'
                              }`}
                            >
                              {count}
                            </span>
                          )}
                        </button>
                      );
                    })}

                    <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-800" />

                    {ARCHITECTURES.map((arch) => {
                      const count =
                        arch === 'All' ? productData.files.length : archCounts.get(arch);
                      const active = archFilter === arch;
                      return (
                        <button
                          key={arch}
                          type="button"
                          onClick={() => setArchFilter(arch)}
                          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                              : 'border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <span>{arch}</span>
                          {count !== undefined && (
                            <span
                              className={`font-mono tabular-nums ${
                                active ? 'opacity-75' : 'text-slate-400'
                              }`}
                            >
                              {count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Grouped App Packages */}
                {groupedPackages.length === 0 ? (
                  <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {productData.files.length === 0
                        ? 'No MSIX or APPX packages were returned for this app'
                        : 'No packages match the selected filters'}
                    </p>
                  </section>
                ) : (
                  <section className="divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    {groupedPackages.map(({ version, files }, groupIdx) => {
                      const selectedInGroup = files.filter((f) =>
                        selectedPackageIds.has(f.id)
                      );
                      const allInGroupSelected =
                        files.length > 0 && selectedInGroup.length === files.length;

                      return (
                        <div
                          key={version}
                          className="divide-y divide-slate-100 dark:divide-slate-800/70"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 dark:bg-slate-950 px-4 py-2.5 text-xs sm:px-5">
                            <div className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={allInGroupSelected}
                                onChange={() => toggleSelectGroup(files)}
                                aria-label={`Select all packages in version ${version}`}
                                title={
                                  allInGroupSelected
                                    ? `Deselect all in version ${version}`
                                    : `Select all in version ${version}`
                                }
                                className="size-4 shrink-0 cursor-pointer rounded border-slate-300 dark:border-slate-700 accent-[#4453E0]"
                              />
                              <span className="font-semibold text-slate-800 dark:text-slate-200">
                                Version{' '}
                                <span className="font-mono tabular-nums">{version}</span>
                              </span>
                              {groupIdx === 0 && (
                                <span className="font-semibold text-[#4453E0] dark:text-[#7A87FF]">
                                  · Latest
                                </span>
                              )}
                              {selectedInGroup.length > 0 && (
                                <span className="font-mono text-[11px] font-medium text-[#4453E0] dark:text-[#7A87FF] tabular-nums">
                                  · {selectedInGroup.length} selected
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2.5">
                              <button
                                type="button"
                                disabled={selectedInGroup.length === 0}
                                onClick={() => handleQueueSelectedFiles(selectedInGroup)}
                                className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-[#4453E0] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                              >
                                <Download className="size-3.5" />
                                Queue Selected
                                {selectedInGroup.length > 0
                                  ? ` (${selectedInGroup.length})`
                                  : ''}
                              </button>
                              <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                {files.length} file{files.length === 1 ? '' : 's'}
                              </span>
                            </div>
                          </div>

                          {files.map((file) => (
                            <PackageRow
                              key={file.id}
                              file={file}
                              isLatest={groupIdx === 0}
                              selected={selectedPackageIds.has(file.id)}
                              onToggleSelect={toggleSelectPackage}
                              transfer={
                                transferLookup.get(`${productData.productId}::${file.url}`) ??
                                transferLookup.get(`${productData.productId}::${file.rawUrl}`) ??
                                transferLookup.get(`${productData.productId}::${file.fileName}`)
                              }
                              copied={copiedId === file.id}
                              onCopySanitizedLink={(f) => void handleCopySanitizedLink(f)}
                              onDownload={handleDownloadFile}
                              onNativeDownload={handleNativeDownloadFile}
                              onPause={transferMgr.pauseTransfer}
                              onResume={transferMgr.resumeTransfer}
                              onSaveCompleted={(t) => void transferMgr.saveCompletedFile(t)}
                              onCancel={(id) => void transferMgr.cancelTransfer(id)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </section>
                )}

                {/* Runtimes & Dependencies */}
                {productData.runtimes.length > 0 && (() => {
                  const selectedRuntimes = productData.runtimes.filter((rt) =>
                    selectedPackageIds.has(rt.id)
                  );
                  const allRuntimesSelected =
                    productData.runtimes.length > 0 &&
                    selectedRuntimes.length === productData.runtimes.length;

                  return (
                    <section className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-2.5 text-xs sm:px-5">
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={allRuntimesSelected}
                            onChange={() => toggleSelectGroup(productData.runtimes)}
                            aria-label="Select all runtime dependencies"
                            className="size-4 shrink-0 cursor-pointer rounded border-slate-300 dark:border-slate-700 accent-[#4453E0]"
                          />
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            Runtimes &amp; Framework Dependencies
                          </span>
                          {selectedRuntimes.length > 0 && (
                            <span className="font-mono text-[11px] font-medium text-[#4453E0] dark:text-[#7A87FF] tabular-nums">
                              · {selectedRuntimes.length} selected
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            disabled={selectedRuntimes.length === 0}
                            onClick={() => handleQueueSelectedFiles(selectedRuntimes)}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-[#4453E0] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                          >
                            <Download className="size-3.5" />
                            Queue Selected
                            {selectedRuntimes.length > 0
                              ? ` (${selectedRuntimes.length})`
                              : ''}
                          </button>
                          <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                            {productData.runtimes.length} file
                            {productData.runtimes.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                      <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {productData.runtimes.map((rt) => (
                          <PackageRow
                            key={rt.id}
                            file={rt}
                            isLatest={false}
                            selected={selectedPackageIds.has(rt.id)}
                            onToggleSelect={toggleSelectPackage}
                            transfer={
                              transferLookup.get(`${productData.productId}::${rt.url}`) ??
                              transferLookup.get(`${productData.productId}::${rt.rawUrl}`) ??
                              transferLookup.get(`${productData.productId}::${rt.fileName}`)
                            }
                            copied={copiedId === rt.id}
                            onCopySanitizedLink={(f) => void handleCopySanitizedLink(f)}
                            onDownload={handleDownloadFile}
                            onNativeDownload={handleNativeDownloadFile}
                            onPause={transferMgr.pauseTransfer}
                            onResume={transferMgr.resumeTransfer}
                            onSaveCompleted={(t) => void transferMgr.saveCompletedFile(t)}
                            onCancel={(id) => void transferMgr.cancelTransfer(id)}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })()}

                {/* Sideload Install Tips */}
                <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  <div className="flex items-start gap-2.5">
                    <Terminal className="mt-0.5 size-4 shrink-0 text-[#4453E0] dark:text-[#7A87FF]" />
                    <div className="space-y-1.5">
                      <p>
                        Install a downloaded package by double-clicking it, or run{' '}
                        <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-slate-900 dark:text-slate-100">
                          Add-AppxPackage -Path &quot;file.msixbundle&quot;
                        </code>{' '}
                        in Windows PowerShell.
                      </p>
                      <p>
                        Packages are standard ZIP archives — you can also extract them with{' '}
                        <a
                          href="https://www.7-zip.org/download.html"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-[#4453E0] dark:text-[#7A87FF] underline underline-offset-2"
                        >
                          7-Zip
                        </a>{' '}
                        or{' '}
                        <a
                          href="https://github.com/M2Team/NanaZip/releases"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-[#4453E0] dark:text-[#7A87FF] underline underline-offset-2"
                        >
                          NanaZip
                        </a>{' '}
                        if the App Installer is unavailable. Install any matching VC++ / UI.Xaml runtime above if required.
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: PERSISTENT TRANSFER QUEUE */}
        {activeTab === 'transfers' && (
          <TransferQueuePanel
            transfers={transferMgr.transfers}
            holdQueue={transferMgr.holdQueue}
            onToggleHoldQueue={transferMgr.toggleHoldQueue}
            storageInfo={transferMgr.storageInfo}
            isPersistentGranted={transferMgr.isPersistentGranted}
            supportsBackgroundFetch={transferMgr.supportsBackgroundFetch}
            transferMode={transferMode}
            onChangeTransferMode={handleChangeTransferMode}
            soundMuted={soundMuted}
            onToggleSound={handleToggleSound}
            onTestSound={() => {
              unlockAudio();
              playCompletionChime(false);
            }}
            notificationPermission={notificationPermission}
            onRequestNotifications={() => void handleRequestNotifications()}
            onPause={transferMgr.pauseTransfer}
            onResume={transferMgr.resumeTransfer}
            onCancel={transferMgr.cancelTransfer}
            onSaveCompleted={(t) => void transferMgr.saveCompletedFile(t)}
            onRetryAllFailed={transferMgr.retryAllFailed}
            onResumeAll={transferMgr.resumeAllInterrupted}
            onPauseAll={transferMgr.pauseAll}
            onClearCompleted={() => void transferMgr.clearCompleted()}
            onRenameTransfers={transferMgr.renameTransfers}
            onStartTransfers={transferMgr.startTransfers}
            verifyingProgress={transferMgr.verifyingProgress}
            onVerifyTransfer={(id, customExpected) =>
              void transferMgr.verifyTransfer(id, customExpected)
            }
            onVerifyAllCompleted={() => void transferMgr.verifyAllCompleted()}
            onRedownloadTransfer={(id) => void transferMgr.redownloadTransfer(id)}
            onExportQueue={transferMgr.exportQueueJson}
            onCopyQueueJson={transferMgr.copyQueueJson}
            onImportQueueJson={transferMgr.importQueueJson}
            onGoToFinder={() => setActiveTab('finder')}
          />
        )}

        {/* TAB 3: PROTOCOL TAKEOVER & OFFLINE PWA SETUP */}
        {activeTab === 'protocol' && (
          <ProtocolIntegrationPanel
            onOpenBookmarklet={() => setBookmarkletOpen(true)}
            onTestProtocolLink={(link) => {
              setActiveTab('finder');
              setQueryInput(link);
              const parsed = parseStoreInput(link);
              if (parsed.kind === 'product') {
                void handleFetchPackages(parsed.productId);
              }
            }}
            onToast={addToast}
          />
        )}

        {/* TAB 4: OFFLINE CACHE */}
        {activeTab === 'offline' && (
          <OfflineCachePanel
            cachedProducts={cachedProducts}
            completedTransfers={completedTransfers}
            onLoadProduct={(prod) => {
              setProductData(prod);
              setLookupStatus('success');
              setActiveTab('finder');
            }}
            onDeleteCachedProduct={(id) => {
              void deleteCatalogEntry(id).then(refreshCatalogCache);
            }}
            onSaveCompleted={(t) => void transferMgr.saveCompletedFile(t)}
            onGoToFinder={() => setActiveTab('finder')}
          />
        )}
      </main>

      {/* Floating Active Background Transfer Bar (visible when away from Transfers tab) */}
      {activeTab !== 'transfers' && activeTransfers.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3.5 shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-white">
              Background Transfer ({activeTransfers.length})
            </span>
            <button
              type="button"
              onClick={() => setActiveTab('transfers')}
              className="text-xs font-semibold text-[#4453E0] dark:text-[#7A87FF] hover:underline"
            >
              Open Queue
            </button>
          </div>
          {activeTransfers.slice(0, 1).map((item) => {
            const pct =
              item.sizeBytes > 0
                ? Math.min(100, Math.round((item.bytesDownloaded / item.sizeBytes) * 100))
                : 0;
            return (
              <div key={item.id} className="mt-2">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <span className="truncate">{item.fileName}</span>
                  <span className="font-mono tabular-nums shrink-0">{pct}%</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-[#4453E0] transition-all duration-200"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  {formatBytes(item.bytesDownloaded)}
                  {item.sizeBytes > 0 ? ` / ${formatBytes(item.sizeBytes)}` : ''}
                  {item.speedBps > 0 ? ` · ${formatBytes(item.speedBps)}/s` : ''}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2 w-full max-w-md px-4 pointer-events-none"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-lg ${
                t.kind === 'error'
                  ? 'border-rose-300 dark:border-rose-800 bg-rose-600 text-white'
                  : t.kind === 'success'
                    ? 'border-emerald-300 dark:border-emerald-800 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white'
              }`}
            >
              <span className="truncate">{t.text}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                aria-label="Close toast"
                className="opacity-80 hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <OfflineIndicator />

      <BookmarkletModal
        open={bookmarkletOpen}
        onClose={() => setBookmarkletOpen(false)}
        onCopySuccess={() =>
          addToast('success', 'Bookmarklet copied — create a bookmark and paste it as URL.')
        }
      />

      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4">
              <h2
                id="shortcuts-title"
                className="text-base font-semibold text-slate-900 dark:text-white"
              >
                Keyboard Shortcuts
              </h2>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close shortcuts"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {[
                { label: 'Focus search bar', keys: ['Ctrl+F', '/'] },
                { label: 'Trigger search / get links', keys: ['Ctrl+Enter'] },
                { label: 'Toggle Transfers tab', keys: ['Ctrl+T', 'Alt+T'] },
                { label: 'Close modal or blur input', keys: ['Esc'] },
                { label: 'Open shortcuts reference', keys: ['?'] },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-4 py-2.5"
                >
                  <span className="text-slate-700 dark:text-slate-300">{row.label}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {row.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-0.5 font-mono text-xs font-medium text-slate-800 dark:text-slate-200"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
