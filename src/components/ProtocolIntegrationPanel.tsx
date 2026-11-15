import React, { useMemo, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Laptop,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface ProtocolIntegrationPanelProps {
  onOpenBookmarklet: () => void;
  onTestProtocolLink: (link: string) => void;
  onToast: (kind: 'success' | 'error' | 'info', msg: string) => void;
}

export const ProtocolIntegrationPanel: React.FC<ProtocolIntegrationPanelProps> = ({
  onOpenBookmarklet,
  onTestProtocolLink,
  onToast,
}) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const [webProtoStatus, setWebProtoStatus] = useState<'idle' | 'registered' | 'unsupported'>('idle');
  const [copiedPs, setCopiedPs] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://localhost:3000';

  const takeoverRegContent = useMemo(() => {
    const targetUrl = `${origin}/?link=%1`;
    return [
      'Windows Registry Editor Version 5.00',
      '',
      '; Sideload — Route ms-windows-store:// protocol links to Sideload Web App',
      '[HKEY_CURRENT_USER\\Software\\Classes\\ms-windows-store]',
      '@="URL:Sideload MS Store Protocol"',
      '"URL Protocol"=""',
      '',
      '[HKEY_CURRENT_USER\\Software\\Classes\\ms-windows-store\\DefaultIcon]',
      '@="msedge.exe,0"',
      '',
      '[HKEY_CURRENT_USER\\Software\\Classes\\ms-windows-store\\shell\\open\\command]',
      `@="cmd /c start \\"\\" \\"${targetUrl}\\""`,
      '',
    ].join('\r\n');
  }, [origin]);

  const restoreRegContent = useMemo(() => {
    return [
      'Windows Registry Editor Version 5.00',
      '',
      '; Remove user-level override so Windows restores the default Microsoft Store handler',
      '[-HKEY_CURRENT_USER\\Software\\Classes\\ms-windows-store]',
      '',
    ].join('\r\n');
  }, []);

  const powerShellCommand = useMemo(() => {
    return `$base = "HKCU:\\Software\\Classes\\ms-windows-store"; New-Item -Path "$base\\shell\\open\\command" -Force | Out-Null; Set-ItemProperty -Path $base -Name "(Default)" -Value "URL:Sideload MS Store"; New-ItemProperty -Path $base -Name "URL Protocol" -Value "" -Force | Out-Null; Set-ItemProperty -Path "$base\\shell\\open\\command" -Name "(Default)" -Value "cmd /c start \`"\`" \`"${origin}/?link=%1\`""`;
  }, [origin]);

  const downloadTextFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handleRegisterWebProtocol = () => {
    if (typeof navigator.registerProtocolHandler !== 'function') {
      setWebProtoStatus('unsupported');
      onToast('error', 'Browser does not support navigator.registerProtocolHandler.');
      return;
    }
    try {
      navigator.registerProtocolHandler(
        'web+msstore',
        `${origin}/?link=%s`
      );
      setWebProtoStatus('registered');
      onToast('success', 'Registered web+msstore:// handler in your browser.');
    } catch (err) {
      setWebProtoStatus('unsupported');
      onToast(
        'error',
        err instanceof Error ? err.message : 'Protocol registration blocked by browser context.'
      );
    }
  };

  const handleCopyPs = async () => {
    try {
      await navigator.clipboard.writeText(powerShellCommand);
      setCopiedPs(true);
      onToast('success', 'PowerShell takeover command copied');
      window.setTimeout(() => setCopiedPs(false), 1800);
    } catch {
      onToast('error', 'Failed to copy command');
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          Offline App &amp; Microsoft Store Protocol Integration
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Install Sideload as a standalone offline-capable PWA, register browser protocol handling, and optionally intercept native{' '}
          <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
            ms-windows-store://
          </code>{' '}
          links on Windows so every store link opens directly here.
        </p>
      </div>

      {/* Step 1: PWA Offline Installation */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]">
              <Laptop className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                01. Install Offline Web App (PWA)
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Caches the app shell via Service Worker, unlocks desktop{' '}
                <code className="font-mono text-xs">protocol_handlers</code> in the Web App Manifest, and supports background fetches.
              </p>
            </div>
          </div>

          <div className="shrink-0">
            {isInstalled ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                <Check className="size-4" />
                Installed as Standalone App
              </span>
            ) : isInstallable ? (
              <button
                type="button"
                onClick={() => void install()}
                className="inline-flex items-center gap-2 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] whitespace-nowrap shrink-0"
              >
                <Download className="size-3.5" />
                Install Sideload App
              </button>
            ) : (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Use browser address-bar Install icon (Edge/Chrome)
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Step 2: Browser web+msstore:// registration */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]">
              <Globe className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                02. Browser Protocol Handler (<span className="font-mono text-sm">web+msstore://</span>)
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Modern browsers restrict direct JS registration of OS schemes, so Sideload registers{' '}
                <code className="font-mono text-xs">web+msstore://</code> via Web Standards and declares{' '}
                <code className="font-mono text-xs">ms-windows-store</code> in its PWA manifest.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRegisterWebProtocol}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-900 transition-colors hover:opacity-90 whitespace-nowrap shrink-0"
            >
              {webProtoStatus === 'registered' ? 'Registered' : 'Register Handler'}
            </button>
            <button
              type="button"
              onClick={() => onTestProtocolLink('ms-windows-store://pdp/?ProductId=9WZDNCRFHVN5')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <ExternalLink className="size-3.5" />
              Test Link Parsing
            </button>
          </div>
        </div>
      </section>

      {/* Step 3: Windows OS Native Protocol Takeover */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
        <div className="flex items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#4453E0]/10 text-[#4453E0] dark:text-[#7A87FF]">
            <Terminal className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              03. Windows Native <span className="font-mono text-sm">ms-windows-store://</span> Takeover
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Override the Windows user-level registry class (<code className="font-mono text-xs">HKCU\Software\Classes\ms-windows-store</code>) so clicking any Microsoft Store link anywhere in Windows launches Sideload automatically instead of the Store app. Includes a clean restore script.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => downloadTextFile(takeoverRegContent, 'Sideload-Takeover-MSStore.reg')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4453E0] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#3846C9] whitespace-nowrap shrink-0"
              >
                <Download className="size-3.5" />
                Download Takeover .reg
              </button>
              <button
                type="button"
                onClick={() => downloadTextFile(restoreRegContent, 'Restore-Default-MSStore.reg')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="size-3.5" />
                Download Restore Default .reg
              </button>
              <button
                type="button"
                onClick={onOpenBookmarklet}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Code2 className="size-3.5 text-[#4453E0]" />
                Browser Bookmarklet
              </button>
            </div>

            <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Or run in Windows PowerShell (No admin required)
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyPs()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  {copiedPs ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
                  {copiedPs ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                {powerShellCommand}
              </pre>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
