'use client';

import { Activity, CircleDot, Route } from 'lucide-react';

export type TabKey = 'routes' | 'record' | 'activities';

const TABS: { key: TabKey; label: string; icon: typeof Route }[] = [
  { key: 'routes', label: 'Routes', icon: Route },
  { key: 'record', label: 'Record', icon: CircleDot },
  { key: 'activities', label: 'Activities', icon: Activity },
];

export default function BottomNav({
  active,
  onChange,
  lockedTabs = [],
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  /** Tabs that open the Pro paywall instead of switching. */
  lockedTabs?: TabKey[];
}) {
  return (
    <nav className="absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-md items-stretch">
        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          const locked = lockedTabs.includes(key);
          return (
            <li key={key} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={locked ? `${label} (khusus Pro)` : label}
                className={`flex w-full flex-col items-center gap-1 py-3 text-[11px] font-medium transition ${
                  isActive ? 'text-orange-400' : 'text-slate-400 active:text-slate-200'
                }`}
              >
                <span className="relative">
                  <Icon size={22} strokeWidth={isActive ? 2.4 : 2} />
                  {locked && (
                    <span className="absolute -right-3 -top-1.5 rounded-full bg-orange-500 px-1 text-[7px] font-bold leading-tight text-white">
                      PRO
                    </span>
                  )}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
