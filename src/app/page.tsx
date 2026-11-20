'use client';

import dynamic from 'next/dynamic';

const AppShell = dynamic(() => import('@/components/AppShell'), {
  ssr: false,
  loading: () => <div className="h-dvh w-full bg-slate-950" />,
});

export default function Home() {
  return <AppShell />;
}
