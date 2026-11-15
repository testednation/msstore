import React, { useMemo, useState } from 'react';
import { Check, Code2, Copy, X } from 'lucide-react';

interface BookmarkletModalProps {
  open: boolean;
  onClose: () => void;
  onCopySuccess?: () => void;
}

export const BookmarkletModal: React.FC<BookmarkletModalProps> = ({
  open,
  onClose,
  onCopySuccess,
}) => {
  const [copied, setCopied] = useState(false);

  const bookmarkletCode = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `javascript:(function(){var o='${origin}';var l=Array.from(document.querySelectorAll('a[href*="ms-windows-store:"],a[href*="ms-store:"],a[href*="web+msstore:"],a[href*="apps.microsoft.com"]')).map(function(a){return a.href});if(/apps\\.microsoft\\.com/.test(location.href))l.unshift(location.href);l=Array.from(new Set(l));if(!l.length){alert('No Microsoft Store links found on this page.');return}var t=l[0];if(l.length>1){var p=prompt('Found '+l.length+' store links. Enter 1-'+l.length+' to pick one, or OK for the first:','1');var n=parseInt(p,10);if(!isNaN(n)&&n>=1&&n<=l.length)t=l[n-1]}window.open(o+'/?link='+encodeURIComponent(t),'_blank')})();`;
  }, []);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bookmarkletCode);
      setCopied(true);
      onCopySuccess?.();
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bookmarklet-title"
    >
      <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="bookmarklet-title"
              className="text-base font-semibold text-slate-900 dark:text-white"
            >
              Capture Store links from any webpage
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Use this one-click bookmarklet on any webpage to extract{' '}
              <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
                ms-windows-store://
              </code>{' '}
              or{' '}
              <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
                apps.microsoft.com
              </code>{' '}
              links and send them straight into Sideload.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        <ol className="mt-4 space-y-2.5 text-sm text-slate-700 dark:text-slate-300">
          <li className="flex gap-2.5">
            <span className="font-mono text-xs font-semibold text-[#4453E0] pt-0.5">01.</span>
            <span>Copy the bookmarklet script below (pre-configured for this Sideload origin).</span>
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-xs font-semibold text-[#4453E0] pt-0.5">02.</span>
            <span>Create a new browser bookmark named &ldquo;Sideload&rdquo; and paste it as the URL.</span>
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-xs font-semibold text-[#4453E0] pt-0.5">03.</span>
            <span>Click the bookmark on any page with Microsoft Store links to open Sideload automatically.</span>
          </li>
        </ol>

        <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
              <Code2 className="size-3.5 text-[#4453E0]" />
              Bookmarklet code
            </span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-900 transition-colors hover:opacity-90 whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy Code'}
            </button>
          </div>
          <code className="mt-2.5 block max-h-32 overflow-y-auto break-all rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 font-mono text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
            {bookmarkletCode}
          </code>
        </div>
      </div>
    </div>
  );
};
