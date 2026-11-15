import React from 'react';
import { Mail } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

export type ActiveTab = 'finder' | 'transfers' | 'protocol' | 'offline';

export const FEEDBACK_EMAIL = 'ishapcha770@gmail.com';

interface HeaderProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  activeTransferCount: number;
  onOpenFeedback: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  activeTransferCount,
  onOpenFeedback,
}) => {
  const navItems: Array<{ id: ActiveTab; label: string }> = [
    { id: 'finder', label: 'Finder' },
    {
      id: 'transfers',
      label: activeTransferCount > 0 ? `Transfers (${activeTransferCount})` : 'Transfers',
    },
    { id: 'protocol', label: 'Protocol Setup' },
    { id: 'offline', label: 'Offline Cache' },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800/90 bg-white/90 dark:bg-[#0B0F17]/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 sm:gap-6 px-4 sm:px-6">
        {/* Zone 1: Single-line Brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('finder')}
          className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4453E0] rounded-lg"
        >
          <img
            src="/icon.svg"
            alt="Sideload"
            width={28}
            height={28}
            className="size-7 rounded-[7px] shrink-0"
          />
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
            Sideload
          </span>
        </button>

        {/* Zone 2: Concise single-line navigation links */}
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-5 sm:gap-6 overflow-x-auto no-scrollbar"
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4453E0] ${
                  isActive
                    ? 'text-slate-950 dark:text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-[17px] h-0.5 bg-[#4453E0]"
                  />
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={onOpenFeedback}
            title={`Send feedback to ${FEEDBACK_EMAIL}`}
            className="inline-flex items-center gap-1.5 py-1 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-[#4453E0] dark:hover:text-[#7A87FF] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4453E0]"
          >
            <Mail className="size-3.5 text-[#4453E0] dark:text-[#7A87FF]" />
            <span>Contact</span>
          </button>
        </nav>

        {/* Zone 3: Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton onFallbackClick={() => onSelectTab('protocol')} />
        </div>
      </div>
    </header>
  );
};

