/**
 * Reading replies aloud with the voices already on the device (free, offline
 * where the system voices are installed):
 * - Windows/Mac/Edge: the browser's speech synthesis.
 * - Android: the phone's own text-to-speech engine through a small bridge in
 *   MainActivity.kt (Android's WebView has no speech synthesis).
 */
import { createSignal } from "solid-js";
import { cleanForSpeech, detectLang, speechLocale, splitForSpeech } from "./audio";

interface AndroidTts {
  available(): boolean;
  speak(id: string, text: string, lang: string, rate: number): boolean;
  stop(): void;
}
declare global {
  interface Window {
    TalkdudeTTS?: AndroidTts;
    __tdTts?: (id: string, event: string) => void;
  }
}

const KEY_AUTO = "talkdude_tts_auto";
const KEY_RATE = "talkdude_tts_rate";
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const [autoRead, setAutoReadSignal] = createSignal(get(KEY_AUTO) === "1");
const [speechRate, setSpeechRateSignal] = createSignal(Number(get(KEY_RATE)) || 1);
/** Id of the message being read aloud, or null. */
const [speakingId, setSpeakingId] = createSignal<string | null>(null);
export { autoRead, speechRate, speakingId };

export function setAutoRead(on: boolean): void { set(KEY_AUTO, on ? "1" : "0"); setAutoReadSignal(on); }
export function setSpeechRate(r: number): void { const v = Math.min(2, Math.max(0.5, r)); set(KEY_RATE, String(v)); setSpeechRateSignal(v); }

const android = (): AndroidTts | null => {
  try { return window.TalkdudeTTS && window.TalkdudeTTS.available() ? window.TalkdudeTTS : null; } catch { return null; }
};
const synth = (): SpeechSynthesis | null => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

// Android's speech engine starts a moment after the app; check again for a few seconds.
const [androidReady, setAndroidReady] = createSignal(!!android());
if (typeof window !== "undefined" && window.TalkdudeTTS && !androidReady()) {
  let tries = 0;
  const t = setInterval(() => {
    if (android()) { setAndroidReady(true); clearInterval(t); } else if (++tries > 30) clearInterval(t);
  }, 500);
}

/** Whether answers can be read aloud on this device (reactive). */
export function ttsSupported(): boolean {
  return androidReady() || (!window.TalkdudeTTS && !!synth());
}

/** Picks the nicest installed voice for a language (Edge's "Natural"/"Online" voices sound best). */
function pickVoice(locale: string): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  const lang = locale.slice(0, 2).toLowerCase();
  const matches = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
  if (!matches.length) return null;
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|online|neural/i.test(v.name) ? 4 : 0) + (v.lang.toLowerCase().replace("_", "-") === locale.toLowerCase() ? 2 : 0) + (v.default ? 1 : 0);
  return matches.sort((a, b) => score(b) - score(a))[0];
}

let session = 0;
// Keep the current utterance referenced (Chrome may otherwise drop it without onend).
let current: { utterance: SpeechSynthesisUtterance | null; done: (ok: boolean) => void } | null = null;
const androidWaiters = new Map<string, (ok: boolean) => void>();
if (typeof window !== "undefined") {
  window.__tdTts = (id, event) => {
    if (event === "start") return;
    const w = androidWaiters.get(id);
    androidWaiters.delete(id);
    w?.(event === "done");
  };
}

function speakPiece(text: string, locale: string, rate: number): Promise<boolean> {
  const a = android();
  if (a) {
    return new Promise((resolve) => {
      const id = `td${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      androidWaiters.set(id, resolve);
      if (!a.speak(id, text, locale, rate)) { androidWaiters.delete(id); resolve(false); }
    });
  }
  const s = synth();
  if (!s) return Promise.resolve(false);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    u.rate = rate;
    const v = pickVoice(locale);
    if (v) u.voice = v;
    let settled = false;
    // Some engines never fire onend; give up after a generous estimate of the reading time.
    const timer = setTimeout(() => done(false), 8000 + (text.length * 140) / rate);
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (current?.utterance === u) current = null;
      resolve(ok);
    };
    current = { utterance: u, done };
    u.onend = () => done(true);
    u.onerror = () => done(false);
    s.speak(u);
  });
}

/** Stops anything being read aloud. */
export function stopSpeaking(): void {
  session++;
  setSpeakingId(null);
  try { android()?.stop(); } catch { /* ignore */ }
  for (const w of androidWaiters.values()) w(false);
  androidWaiters.clear();
  const c = current;
  current = null;
  synth()?.cancel();
  c?.done(false);
}

/**
 * Reads text aloud (markdown is cleaned up first). Resolves when it's done or
 * stopped. `id` marks which message is playing (for the speaker button).
 */
export async function speak(markdown: string, id: string | null = null, lang?: "id" | "en"): Promise<void> {
  stopSpeaking();
  const text = cleanForSpeech(markdown);
  if (!text) return;
  const my = ++session;
  setSpeakingId(id);
  const locale = speechLocale(lang ?? detectLang(text));
  // Some engines cut long texts off, so read it sentence by sentence.
  for (const piece of splitForSpeech(text)) {
    if (session !== my) return;
    const ok = await speakPiece(piece, locale, speechRate());
    if (!ok && session !== my) return;
  }
  if (session === my) setSpeakingId(null);
}

/** Voices load late in some browsers; call once early so the first read uses a good voice. */
export function warmUpVoices(): void {
  try { synth()?.getVoices(); } catch { /* ignore */ }
}
