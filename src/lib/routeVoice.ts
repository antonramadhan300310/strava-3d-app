/**
 * Follow Route voice guidance: Web Speech API with a Web Audio beep fallback
 * for WebViews where `speechSynthesis` is missing or silently fails.
 */

export type RouteVoiceEvent = 'off-route' | 'back-on-route' | 'arrived';

const MUTE_KEY = 'allmova_route_voice_muted';
export const OFF_ROUTE_COOLDOWN_MS = 35000;

const PHRASES: Record<RouteVoiceEvent, string> = {
  'off-route': 'Anda keluar jalur',
  'back-on-route': 'Kembali ke jalur',
  arrived: 'Tiba di garis finis',
};

type Tone = { frequency: number; startOffset: number; duration: number };

const TONES: Record<RouteVoiceEvent, Tone[]> = {
  'off-route': [
    { frequency: 520, startOffset: 0, duration: 0.16 },
    { frequency: 400, startOffset: 0.22, duration: 0.22 },
  ],
  'back-on-route': [{ frequency: 720, startOffset: 0, duration: 0.18 }],
  arrived: [
    { frequency: 660, startOffset: 0, duration: 0.14 },
    { frequency: 880, startOffset: 0.18, duration: 0.14 },
    { frequency: 1040, startOffset: 0.36, duration: 0.26 },
  ],
};

let lastOffRouteAt = 0;
let lastEvent: RouteVoiceEvent | null = null;
let audioContext: AudioContext | null = null;

export function isRouteVoiceMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRouteVoiceMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Private mode without storage: the in-memory toggle still works.
  }
}

function speechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

function playBeep(event: RouteVoiceEvent): void {
  if (typeof window === 'undefined') return;
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    if (!audioContext) audioContext = new AudioContextCtor();
    const context = audioContext;
    if (context.state === 'suspended') void context.resume();

    const now = context.currentTime;
    for (const tone of TONES[event]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + tone.startOffset;
      const end = start + tone.duration;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, end);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // Audio is best-effort; a silent failure must never break navigation.
  }
}

function speak(text: string, event: RouteVoiceEvent): void {
  if (!speechAvailable()) {
    playBeep(event);
    return;
  }

  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1;
    utterance.pitch = 1;

    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      playBeep(event);
    };
    utterance.onend = () => {
      settled = true;
    };
    utterance.onerror = fallback;

    synth.speak(utterance);

    // Some WebViews expose speechSynthesis but never start the utterance and
    // never fire `onerror`; fall back to a beep when nothing is playing.
    window.setTimeout(() => {
      if (settled) return;
      if (!synth.speaking && !synth.pending) fallback();
      else settled = true;
    }, 1200);
  } catch {
    playBeep(event);
  }
}

/**
 * Announces one navigation event. Off-route alerts are throttled so a shaky
 * GPS signal cannot repeat the same phrase every fix.
 */
export function announceRouteEvent(event: RouteVoiceEvent): void {
  if (isRouteVoiceMuted()) return;

  if (event === 'off-route') {
    const now = Date.now();
    if (now - lastOffRouteAt < OFF_ROUTE_COOLDOWN_MS) return;
    lastOffRouteAt = now;
  }

  // Repeating the same phrase back-to-back only happens with GPS jitter.
  if (event === lastEvent && event !== 'off-route') return;
  lastEvent = event;

  speak(PHRASES[event], event);
}

/** Lets a fresh guide session re-arm the alerts. */
export function resetRouteVoiceSession(): void {
  lastOffRouteAt = 0;
  lastEvent = null;
}
