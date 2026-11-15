import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const PWAInstallButton: React.FC<{ onFallbackClick?: () => void }> = ({
  onFallbackClick,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="inline-flex items-center gap-2 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4453E0] whitespace-nowrap shrink-0"
      >
        <Download className="size-3.5" />
        Install App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Smartphone className="size-3.5 text-[#4453E0]" />
          Install on iOS
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  Install on iPhone or iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close instructions"
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="size-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                <li>1. Tap the <strong>Share</strong> button in Safari&apos;s toolbar.</li>
                <li>2. Scroll down and tap <strong>Add to Home Screen</strong>.</li>
                <li>3. Open Sideload from your home screen for offline access.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-slate-900 dark:bg-slate-100 py-2 text-xs font-semibold text-white dark:text-slate-900 transition-colors hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  if (onFallbackClick) {
    return (
      <button
        type="button"
        onClick={onFallbackClick}
        className="inline-flex items-center gap-2 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4453E0] whitespace-nowrap shrink-0"
      >
        <Download className="size-3.5" />
        Install &amp; Protocol
      </button>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-600/30 bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg"
    >
      <WifiOff className="size-3.5 shrink-0" />
      <span>Offline Mode — Cached packages &amp; queue remain available.</span>
    </div>
  );
};
