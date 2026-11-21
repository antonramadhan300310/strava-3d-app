'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MapPin, Search, X } from 'lucide-react';
import { searchPlaces, type PlaceSuggestion } from '@/lib/geocoding';
import type { LngLat } from '@/lib/polyline';

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 400;

type Props = {
  onSelect: (coords: LngLat) => void;
  getBiasCenter: () => LngLat | null;
};

export default function RouteSearchBar({ onSelect, getBiasCenter }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    abortRef.current?.abort();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setError(null);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    const timer = window.setTimeout(() => {
      const center = getBiasCenter();
      searchPlaces(
        trimmed,
        center ? { lat: center[1], lng: center[0] } : undefined,
        controller.signal,
      )
        .then((found) => {
          if (controller.signal.aborted) return;
          setResults(found);
          setOpen(true);
          if (found.length === 0) setError('Alamat tidak ditemukan.');
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setOpen(true);
          setError(cause instanceof Error ? cause.message : 'Pencarian alamat butuh koneksi internet');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, getBiasCenter]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setQuery('');
    setResults([]);
    setError(null);
    setOpen(false);
    setLoading(false);
  }, []);

  const select = useCallback(
    (place: PlaceSuggestion) => {
      onSelect(place.coords);
      setQuery('');
      setResults([]);
      setError(null);
      setOpen(false);
    },
    [onSelect],
  );

  const showDropdown = open && (loading || results.length > 0 || error !== null);

  return (
    <div
      className="relative z-30"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/95 px-3 py-2 shadow-2xl backdrop-blur">
        <Search size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            if (results.length > 0 || error) setOpen(true);
          }}
          placeholder="Cari alamat atau titik rute..."
          aria-label="Cari alamat atau titik rute"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
        />
        {loading && <Loader2 size={15} className="shrink-0 animate-spin text-orange-400" />}
        {query.length > 0 && !loading && (
          <button
            type="button"
            onClick={clear}
            aria-label="Hapus pencarian"
            className="shrink-0 rounded-full p-0.5 text-slate-400 active:bg-slate-800"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute inset-x-0 top-full mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur">
          {loading && results.length === 0 && (
            <p className="px-3 py-2.5 text-xs text-slate-400">Mencari lokasi…</p>
          )}
          {error && !loading && (
            <p className="px-3 py-2.5 text-xs text-rose-300" role="status">
              {error}
            </p>
          )}
          {results.map((place) => (
            <button
              key={place.id}
              type="button"
              onClick={() => select(place)}
              className="flex w-full items-start gap-2 border-b border-white/5 px-3 py-2 text-left last:border-b-0 active:bg-slate-800"
            >
              <MapPin size={15} className="mt-0.5 shrink-0 text-orange-400" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-100">
                  {place.name}
                </span>
                {place.subtitle && (
                  <span className="block truncate text-[11px] text-slate-400">
                    {place.subtitle}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
