'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { elevationAt, sampleAt, type FlyoverPath, type FlyoverSample } from '@/lib/flyover';

export type PlaybackSpeed = 1 | 2 | 5;
export const PLAYBACK_SPEEDS: PlaybackSpeed[] = [1, 2, 5];

/** Roughly a metre per 8 ms, clamped so short and long routes both feel right. */
const MIN_DURATION_MS = 15000;
const MAX_DURATION_MS = 50000;
/** The HUD only needs a few updates per second; the map runs at full frame rate. */
const HUD_INTERVAL_MS = 60;

export type FlyoverTelemetry = {
  /** Distance already covered by the marker, in metres. */
  distanceMeters: number;
  /** Elevation at the marker, taken from the third coordinate. */
  elevationMeters: number;
  /** Playback progress, 0–1. */
  progress: number;
};

export function flyoverDurationMs(totalMeters: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, totalMeters * 8));
}

type FrameHandler = (sample: FlyoverSample, progress: number) => void;

/**
 * Drives the flyover animation with `requestAnimationFrame`.
 *
 * The marker, camera and route reveal are pushed straight to the map through
 * `onFrame` every frame; React state is refreshed at a lower rate so the HUD
 * numbers and the scrubber stay in sync without re-rendering 60 times a second.
 */
export function useFlyoverPlayback(path: FlyoverPath | null, onFrame: FrameHandler) {
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  const progressRef = useRef(0);
  const frameRef = useRef(onFrame);
  const lastEmitRef = useRef(0);
  const durationMs = path ? flyoverDurationMs(path.totalMeters) : MIN_DURATION_MS;
  const durationRef = useRef(durationMs);
  const speedRef = useRef<PlaybackSpeed>(speed);

  frameRef.current = onFrame;
  durationRef.current = durationMs;
  speedRef.current = speed;

  const emit = useCallback(
    (value: number, force = false) => {
      const current = path;
      if (!current) return;
      frameRef.current(sampleAt(current, value * current.totalMeters), value);

      const now = performance.now();
      if (force || now - lastEmitRef.current >= HUD_INTERVAL_MS) {
        lastEmitRef.current = now;
        setProgress(value);
      }
    },
    [path],
  );

  // A new route resets the marker to its first vertex.
  useEffect(() => {
    progressRef.current = 0;
    setProgress(0);
    setIsPlaying(false);
    if (path) emit(0, true);
  }, [path, emit]);

  useEffect(() => {
    if (!isPlaying || !path) return;

    let handle = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const deltaMs = Math.min(now - last, 250);
      last = now;

      const step = (deltaMs * speedRef.current) / durationRef.current;
      const next = Math.min(1, progressRef.current + step);
      progressRef.current = next;
      emit(next, next >= 1);

      if (next >= 1) {
        setIsPlaying(false);
        return;
      }
      handle = requestAnimationFrame(tick);
    };

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [isPlaying, path, emit]);

  const play = useCallback(() => {
    if (!path) return;
    // Replaying after the end restarts from the first vertex.
    if (progressRef.current >= 1) {
      progressRef.current = 0;
      emit(0, true);
    }
    setIsPlaying(true);
  }, [path, emit]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  const seek = useCallback(
    (value: number) => {
      const clamped = Math.min(1, Math.max(0, value));
      progressRef.current = clamped;
      emit(clamped, true);
    },
    [emit],
  );

  const restart = useCallback(() => {
    seek(0);
    setIsPlaying(true);
  }, [seek]);

  const cycleSpeed = useCallback(() => {
    setSpeed((current) => {
      const index = PLAYBACK_SPEEDS.indexOf(current);
      return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length];
    });
  }, []);

  const telemetry: FlyoverTelemetry = {
    distanceMeters: path ? progress * path.totalMeters : 0,
    elevationMeters: path ? elevationAt(path, progress * path.totalMeters) : 0,
    progress,
  };

  return {
    progress,
    isPlaying,
    speed,
    telemetry,
    play,
    pause,
    toggle,
    seek,
    restart,
    cycleSpeed,
  };
}
