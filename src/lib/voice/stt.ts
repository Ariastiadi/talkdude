/**
 * Speech to text for every AI: Whisper runs on this device (see stt.worker.ts).
 * One-time download: the model from Hugging Face plus a checked 14 MB engine file.
 */
import { createSignal } from "solid-js";
import { cleanTranscript } from "./audio";

export interface SttModel { key: string; id: string; name: string; bytes: number; note: string }

// Quantized (8-bit) Whisper from onnx-community; sizes are the files actually downloaded.
export const STT_MODELS: SttModel[] = [
  { key: "base", id: "onnx-community/whisper-base", name: "Whisper Base", bytes: 79_800_000, note: "Better for Indonesian and accents" },
  { key: "tiny", id: "onnx-community/whisper-tiny", name: "Whisper Tiny", bytes: 43_700_000, note: "Faster, less accurate" },
];
const DTYPE = { encoder_model: "q8", decoder_model_merged: "q8" };

/** ONNX Runtime Web (MIT): same version as the glue code bundled with the app; hash and size come from the build. */
export const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist/ort-wasm-simd-threaded.wasm`;
export const ORT_WASM_SHA256 = __ORT_WASM_SHA256__;
export const ORT_WASM_BYTES = __ORT_WASM_SIZE__;

const KEY_MODEL = "talkdude_stt_model";
const KEY_LANG = "talkdude_stt_lang";
const KEY_READY = "talkdude_stt_ready";
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

const [sttModelKey, setSttModelKeySignal] = createSignal(get(KEY_MODEL) ?? "base");
/** Model keys that finished downloading on this device. */
const [sttReady, setSttReady] = createSignal<string[]>(JSON.parse(get(KEY_READY) ?? "[]"));
/** Download progress 0..1 while loading, null otherwise. */
const [sttProgress, setSttProgress] = createSignal<number | null>(null);
const [sttError, setSttError] = createSignal<string | null>(null);
/** "auto" (Indonesian or English), "any" (every language Whisper knows), or a language code. */
const [sttLanguage, setSttLanguageSignal] = createSignal(get(KEY_LANG) ?? "auto");
export { sttModelKey, sttReady, sttProgress, sttError, sttLanguage };

export const STT_LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Indonesian or English (detect)" },
  { value: "id", label: "Indonesian only" },
  { value: "en", label: "English only" },
  { value: "any", label: "Any language (detect)" },
];
export function setSttLanguage(v: string): void { set(KEY_LANG, v); setSttLanguageSignal(v); }

export const sttModel = () => STT_MODELS.find((m) => m.key === sttModelKey()) ?? STT_MODELS[0];
export const sttDownloaded = () => sttReady().includes(sttModelKey());
export const sttSupported = () => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export function setSttModelKey(key: string): void {
  if (!STT_MODELS.some((m) => m.key === key)) return;
  set(KEY_MODEL, key);
  setSttModelKeySignal(key);
  loadedKey = null;
}

let worker: Worker | null = null;
let loadedKey: string | null = null;
let loading: Promise<void> | null = null;
let loadingKey: string | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (t: string) => void; fail: (e: Error) => void }>();
let loadWaiter: { ok: () => void; fail: (e: Error) => void } | null = null;

/** Stops the worker and fails everything that was waiting for it. */
function teardown(err: Error): void {
  loadWaiter?.fail(err);
  loadWaiter = null;
  for (const w of waiting.values()) w.fail(err);
  waiting.clear();
  worker?.terminate();
  worker = null;
  loadedKey = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./stt.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id?: number; text?: string; message?: string; loaded?: number; total?: number };
    if (m.type === "progress") {
      const total = (m.total ?? 0) + ORT_WASM_BYTES;
      setSttProgress(Math.min(0.99, ((m.loaded ?? 0) + ORT_WASM_BYTES) / Math.max(total, sttModel().bytes + ORT_WASM_BYTES)));
    } else if (m.type === "ready") {
      loadWaiter?.ok();
      loadWaiter = null;
    } else if (m.type === "result" && m.id !== undefined) {
      waiting.get(m.id)?.ok(m.text ?? "");
      waiting.delete(m.id);
    } else if (m.type === "error") {
      const err = new Error(m.message || "Speech recognition failed");
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!.fail(err); waiting.delete(m.id); }
      else if (loadWaiter) { loadWaiter.fail(err); loadWaiter = null; }
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    teardown(new Error(e.message || "Speech recognition stopped"));
  };
  return worker;
}

/** Downloads (first time) and loads the speech model. Safe to call many times. */
export function ensureStt(): Promise<void> {
  const model = sttModel();
  if (loadedKey === model.key && worker) return Promise.resolve();
  // Another model is loading (the choice changed meanwhile): wait, then load this one.
  if (loading) return loadingKey === model.key ? loading : loading.catch(() => {}).then(() => ensureStt());
  loadingKey = model.key;
  setSttError(null);
  if (!sttDownloaded()) setSttProgress(0);
  loading = new Promise<void>((ok, fail) => {
    loadWaiter = { ok, fail };
    getWorker().postMessage({ type: "load", model: model.id, wasmUrl: ORT_WASM_URL, wasmSha256: ORT_WASM_SHA256, dtype: DTYPE });
  }).then(() => {
    loadedKey = model.key;
    if (!sttReady().includes(model.key)) {
      const next = [...sttReady(), model.key];
      setSttReady(next);
      set(KEY_READY, JSON.stringify(next));
    }
  }).catch((e: Error) => {
    if (e.message === "Voice input was removed.") throw e;
    const offline = /fetch|network|HTTP/i.test(e.message);
    const msg = offline ? "Couldn't download voice input. Check your internet connection and try again." : e.message;
    setSttError(msg);
    throw new Error(msg);
  }).finally(() => {
    loading = null;
    loadingKey = null;
    setSttProgress(null);
  });
  return loading;
}

/** Turns 16 kHz mono audio into text, in the language set in Settings → Voice. */
export async function transcribe(audio: Float32Array, language: string = sttLanguage()): Promise<string> {
  await ensureStt();
  const id = nextId++;
  const text = await new Promise<string>((ok, fail) => {
    waiting.set(id, { ok, fail });
    getWorker().postMessage({ type: "transcribe", id, audio, language }, [audio.buffer]);
  });
  return cleanTranscript(text);
}

/** Removes the downloaded speech models and engine from this device. */
export async function deleteStt(): Promise<void> {
  teardown(new Error("Voice input was removed."));
  loading = null;
  loadingKey = null;
  setSttProgress(null);
  try {
    await caches.delete("talkdude-voice");
    const c = await caches.open("transformers-cache");
    for (const req of await c.keys()) if (/whisper/i.test(req.url)) await c.delete(req);
  } catch { /* nothing cached */ }
  setSttReady([]);
  set(KEY_READY, null);
}
