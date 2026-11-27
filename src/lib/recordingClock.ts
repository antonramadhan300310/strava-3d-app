/**
 * Wall-clock duration model for a recording session.
 *
 * `setInterval` is suspended when the WebView goes to the background, so a
 * ticking counter freezes at whatever value it had when the screen locked while
 * the GPS keeps adding distance — which shows up as a several-hundred km/h
 * average. Every duration is therefore derived from timestamps instead:
 *
 *   active = now - recordingStartedAt - totalPausedMs
 *
 * A pause (manual or automatic) opens a pause window; the open window is folded
 * into `totalPausedMs` on resume, so the value is always reproducible from
 * `(startedAt, pausedMs)` alone — which is exactly what the session backup
 * stores.
 */

export type RecordingClockSnapshot = {
  startedAt: number;
  /** Paused milliseconds already folded in (an open pause is not included). */
  pausedMs: number;
  /** Start of the open pause window, or null while running. */
  pauseStartedAt: number | null;
};

export type RecordingClock = {
  /** Starts a new session; ignored when one is already running. */
  start: (at: number) => void;
  /** Opens a pause window; ignored when already paused or not started. */
  pause: (at: number) => void;
  /** Closes the open pause window and adds it to the paused total. */
  resume: (at: number) => void;
  /** Freezes the clock (same as pause) before a save/finish. */
  stop: (at: number) => void;
  /** Active (unpaused) milliseconds. */
  activeMs: (at: number) => number;
  /** Total wall-clock milliseconds since the session started. */
  elapsedMs: (at: number) => number;
  /** Total paused milliseconds, including an open pause window. */
  pausedMs: (at: number) => number;
  /** True when the session exists and no pause window is open. */
  isRunning: () => boolean;
  /** True once `start` has been called. */
  isStarted: () => boolean;
  readonly startedAt: number;
  snapshot: (at: number) => RecordingClockSnapshot;
  /** Rebuilds the clock from a stored session, preserving its active time. */
  restoreFrom: (input: {
    startedAt: number;
    activeMs: number;
    paused: boolean;
    at: number;
  }) => void;
};

/**
 * Timestamps can be slightly out of order (a fix that arrives late, a clock
 * that steps backwards). Clamping to the last observed value keeps the derived
 * durations monotonic instead of producing a negative or exploding average.
 */
export function createRecordingClock(): RecordingClock {
  let startedAt = 0;
  let started = false;
  let pauseStartedAt: number | null = null;
  let pausedMs = 0;
  let lastSeen = Number.NEGATIVE_INFINITY;

  const clamp = (at: number): number => {
    const value = Number.isFinite(at) ? at : Math.max(lastSeen, Date.now());
    const bounded = Math.max(value, lastSeen);
    lastSeen = bounded;
    return bounded;
  };

  const openPause = (at: number): number => {
    if (pauseStartedAt === null) return 0;
    return Math.max(0, at - pauseStartedAt);
  };

  const pausedTotal = (at: number): number => pausedMs + openPause(at);

  const activeMs = (at: number): number => {
    if (!started) return 0;
    const now = clamp(at);
    return Math.max(0, now - startedAt - pausedTotal(now));
  };

  return {
    get startedAt() {
      return startedAt;
    },
    start(at) {
      if (started) return;
      startedAt = Number.isFinite(at) ? at : Date.now();
      started = true;
      pauseStartedAt = null;
      pausedMs = 0;
      lastSeen = startedAt;
    },
    pause(at) {
      if (!started || pauseStartedAt !== null) return;
      pauseStartedAt = clamp(at);
    },
    resume(at) {
      if (!started || pauseStartedAt === null) return;
      const now = clamp(at);
      pausedMs += Math.max(0, now - pauseStartedAt);
      pauseStartedAt = null;
    },
    stop(at) {
      if (!started || pauseStartedAt !== null) return;
      pauseStartedAt = clamp(at);
    },
    activeMs,
    elapsedMs(at) {
      if (!started) return 0;
      return Math.max(0, clamp(at) - startedAt);
    },
    pausedMs(at) {
      if (!started) return 0;
      return Math.max(0, pausedTotal(clamp(at)));
    },
    isRunning() {
      return started && pauseStartedAt === null;
    },
    isStarted() {
      return started;
    },
    snapshot(at) {
      const now = clamp(at);
      return {
        startedAt,
        pausedMs: Math.max(0, pausedMs),
        pauseStartedAt,
      };
    },
    restoreFrom({ startedAt: storedStart, activeMs: storedActive, paused, at }) {
      startedAt = Number.isFinite(storedStart) ? storedStart : at;
      started = true;
      lastSeen = Math.max(at, startedAt);
      const elapsed = Math.max(0, at - startedAt);
      const active = Math.min(Math.max(0, storedActive), elapsed);
      pausedMs = elapsed - active;
      // A paused session keeps counting as paused from now on; a recording
      // session continues running with the recovered active total.
      pauseStartedAt = paused ? at : null;
    },
  };
}
