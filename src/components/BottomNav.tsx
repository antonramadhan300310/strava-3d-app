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
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <nav className="absolute inset-x-0 bottom-0 z-20 border-t border-white/10 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-md items-stretch">
        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex w-full flex-col items-center gap-1 py-3 text-[11px] font-medium transition ${
                  isActive ? 'text-orange-400' : 'text-slate-400 active:text-slate-200'
                }`}
              >
                <Icon size={22} strokeWidth={isActive ? 2.4 : 2} />
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
