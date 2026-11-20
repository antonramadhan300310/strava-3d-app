'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import BottomNav, { type TabKey } from '@/components/BottomNav';

const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-slate-900" />,
});

const PLACEHOLDERS: Record<Exclude<TabKey, 'record'>, { title: string; hint: string }> = {
  routes: {
    title: 'Routes',
    hint: 'Segera hadir di Milestone berikutnya',
  },
  activities: {
    title: 'Activities',
    hint: 'Segera hadir di Milestone berikutnya',
  },
};

export default function Home() {
  const [tab, setTab] = useState<TabKey>('record');

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-950">
      <div className="absolute inset-0">
        <MapView active={tab === 'record'} />
      </div>

      {tab !== 'record' && (
        <section className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950 px-8 pb-20 text-center">
          <h1 className="text-xl font-semibold text-slate-100">{PLACEHOLDERS[tab].title}</h1>
          <p className="max-w-xs text-sm text-slate-400">{PLACEHOLDERS[tab].hint}</p>
        </section>
      )}

      <BottomNav active={tab} onChange={setTab} />
    </main>
  );
}
