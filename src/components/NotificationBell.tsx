'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, Loader2, Megaphone, RefreshCw, X } from 'lucide-react';
import { useAnnouncements } from '@/context/AnnouncementsContext';
import { formatAnnouncementTime, type Announcement, type AnnouncementKind } from '@/lib/announcements';

const KIND_STYLES: Record<AnnouncementKind, string> = {
  info: 'bg-sky-400/15 text-sky-300',
  warning: 'bg-amber-400/15 text-amber-300',
  success: 'bg-emerald-400/15 text-emerald-300',
  promo: 'bg-[#B9F51E]/15 text-[#B9F51E]',
};

type Props = {
  /** `floating` matches the map controls, `header` matches the profile button. */
  variant?: 'floating' | 'header';
};

export default function NotificationBell({ variant = 'floating' }: Props) {
  const { announcements, loading, error, unreadCount, refresh, markAllSeen } = useAnnouncements();
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const openSheet = useCallback(() => {
    setOpen(true);
    // Fetch again on open so a broadcast published after launch is included,
    // then mark everything the user is looking at as seen.
    void refresh().then((list) => markAllSeen(list.length > 0 ? list : announcements));
  }, [announcements, markAllSeen, refresh]);

  const closeSheet = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      bellRef.current?.focus();
    };
  }, [open]);

  const hasUnread = unreadCount > 0;
  const buttonClass =
    variant === 'header'
      ? 'relative flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 shadow-lg backdrop-blur transition active:scale-95'
      : 'relative flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-[#151B1D]/85 text-slate-100 shadow-xl backdrop-blur transition active:scale-95 active:bg-[#1E2E16]';

  return (
    <>
      <button
        ref={bellRef}
        type="button"
        onClick={openSheet}
        aria-label={hasUnread ? `Notifikasi (${unreadCount} baru)` : 'Notifikasi'}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={buttonClass}
      >
        <Bell size={variant === 'header' ? 19 : 20} />
        {hasUnread && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white shadow"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-sheet-title"
          >
            <button
              type="button"
              aria-label="Tutup notifikasi"
              onClick={closeSheet}
              className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-sm"
            />

            <div className="animate-sheet-down absolute inset-x-3 top-[calc(env(safe-area-inset-top)+12px)] mx-auto flex max-h-[70vh] w-auto max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#151B1D] shadow-2xl">
              <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#B9F51E]/15 text-[#B9F51E]">
                    <Bell size={18} />
                  </span>
                  <div>
                    <h2 id="notification-sheet-title" className="text-sm font-semibold text-slate-100">
                      Notifikasi
                    </h2>
                    <p className="text-[11px] text-slate-400">Pesan dari admin ALLMOVA</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading}
                    aria-label="Muat ulang notifikasi"
                    aria-busy={loading}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition active:bg-[#1E2E16] disabled:opacity-50"
                  >
                    <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
                  </button>
                  <button
                    ref={closeRef}
                    type="button"
                    onClick={closeSheet}
                    aria-label="Tutup"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition active:bg-[#1E2E16]"
                  >
                    <X size={18} />
                  </button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
                {loading && announcements.length === 0 && (
                  <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
                    <Loader2 size={16} className="animate-spin" />
                    Memuat notifikasi…
                  </p>
                )}

                {error && (
                  <p className="mb-2 rounded-xl bg-rose-500/10 px-3 py-2 text-center text-[11px] font-medium text-rose-300">
                    {error}
                  </p>
                )}

                {!loading && announcements.length === 0 && !error && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1E2E16] text-slate-500">
                      <BellOff size={22} />
                    </span>
                    <p className="text-sm font-semibold text-slate-200">Belum ada notifikasi</p>
                    <p className="max-w-[15rem] text-[11px] leading-relaxed text-slate-400">
                      Pengumuman dan pesan baru dari admin ALLMOVA akan muncul di sini.
                    </p>
                  </div>
                )}

                {announcements.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {announcements.map((entry) => (
                      <AnnouncementCard key={entry.id} announcement={entry} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function AnnouncementCard({ announcement }: { announcement: Announcement }) {
  const time = formatAnnouncementTime(announcement.createdAtMs);
  const style = KIND_STYLES[announcement.kind] ?? KIND_STYLES.info;

  return (
    <li className="rounded-xl border border-white/10 bg-[#1E2E16]/60 p-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${style}`}>
          <Megaphone size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[12px] font-semibold leading-snug text-slate-100">
              {announcement.title}
            </p>
            {time && (
              <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-slate-500">
                {time}
              </span>
            )}
          </div>
          {announcement.body && (
            <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-slate-300">
              {announcement.body}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
