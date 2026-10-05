/**
 * On-device AI: runs a small open model (GGUF) directly inside the app with
 * llama.cpp compiled to WebAssembly (wllama). No API key, no account, no
 * network after the one-time model download, and no usage limits.
 *
 * The model files are stored in the app's private storage (OPFS) and loaded
 * into a Web Worker, so the UI keeps running while the model thinks.
 */
import { createSignal } from "solid-js";
import type { Wllama, ModelManager } from "@wllama/wllama";
import type { GeminiContent } from "./types";
import type { StreamCallbacks } from "./gemini";
import { isMobile, installMobileFetch } from "../platform";

export interface LocalModel {
  key: string;
  name: string;
  /** Short description shown in Settings. */
  note: string;
  url: string;
  /** Download size in bytes. */
  size: number;
  ctx: number;
}

// Ungated GGUF builds on Hugging Face (Apache-2.0 / Llama 3.2 Community License).
export const LOCAL_MODELS: LocalModel[] = [
  {
    key: "qwen2.5-0.5b",
    name: "Qwen 2.5 0.5B",
    note: "Smallest and fastest. Good for casual chat on any phone.",
    url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    size: 397_808_192,
    ctx: 4096,
  },
  {
    key: "llama3.2-1b",
    name: "Llama 3.2 1B",
    note: "Better stories and role-play. Needs a phone with 4 GB+ RAM.",
    url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    size: 807_694_464,
    ctx: 4096,
  },
  {
    key: "qwen2.5-1.5b",
    name: "Qwen 2.5 1.5B",
    note: "Smartest of the three. Best on PCs and recent phones (6 GB+ RAM).",
    url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
    size: 986_048_768,
    ctx: 4096,
  },
];

export const DEFAULT_LOCAL_MODEL = LOCAL_MODELS[0].key;

export function localModelInfo(key: string): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.key === key);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

// === State ===

/** Keys of models fully downloaded to this device. */
const [downloadedLocal, setDownloadedLocal] = createSignal<string[]>([]);
/** key -> progress 0..1 while a download runs. */
const [downloadProgress, setDownloadProgress] = createSignal<Record<string, number>>({});
/** Model currently being loaded into memory (first message after start). */
const [loadingLocal, setLoadingLocal] = createSignal<string | null>(null);
export { downloadedLocal, downloadProgress, loadingLocal };

const downloadAborts = new Map<string, AbortController>();

let wllamaMod: typeof import("@wllama/wllama") | null = null;
let manager: ModelManager | null = null;
let engine: Wllama | null = null;
let loadedKey: string | null = null;
let loadingPromise: Promise<void> | null = null;
/** Only one generation at a time; the engine has a single context. */
let queue: Promise<unknown> = Promise.resolve();

/** Last native error lines, shown with crash messages to make them actionable. */
const recentErrors: string[] = [];
const quietLogger = {
  debug: () => {},
  log: () => {},
  warn: (...a: unknown[]) => console.warn("[on-device]", ...a),
  error: (...a: unknown[]) => {
    console.error("[on-device]", ...a);
    const line = a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ").split("\n")[0].trim();
    if (line && !/^Stack trace/i.test(line)) { recentErrors.push(line.slice(0, 160)); if (recentErrors.length > 5) recentErrors.shift(); }
  },
};

function engineInfo(): string {
  return `engine ${needsCompatEngine() ? "compat" : "standard"}; JSPI ${supportsJspi() ? "yes" : "no"}, Memory64 ${supportsMemory64() ? "yes" : "no"}`;
}

async function mod() {
  if (!wllamaMod) wllamaMod = await import("@wllama/wllama");
  return wllamaMod;
}

async function getManager(): Promise<ModelManager> {
  if (!manager) {
    const m = await mod();
    manager = new m.ModelManager({ logger: quietLogger, allowOffline: true, parallelDownloads: 2 });
  }
  return manager;
}

// === Engine (llama.cpp WebAssembly) ===
// Not bundled, to keep the app small: fetched once with the first model download,
// verified against the hash of the version talkdude was built with, then cached.

type EngineFile = { url: string; size: number; sha256: string; type: string };

const CDN = "https://cdn.jsdelivr.net/npm";
const ENGINE_DEFAULT: EngineFile[] = [
  { url: `${CDN}/@wllama/wllama@${__WLLAMA_VERSION__}/esm/wasm/wllama.wasm`, size: __WLLAMA_WASM_SIZE__, sha256: __WLLAMA_WASM_SHA256__, type: "application/wasm" },
];
// For WebViews without JSPI or Memory64 (older Android System WebView): slower, but works.
const ENGINE_COMPAT: EngineFile[] = [
  { url: `${CDN}/@wllama/wllama-compat@${__WLLAMA_VERSION__}/wasm/wllama.wasm`, size: __WLLAMA_COMPAT_WASM_SIZE__, sha256: __WLLAMA_COMPAT_WASM_SHA256__, type: "application/wasm" },
  { url: `${CDN}/@wllama/wllama-compat@${__WLLAMA_VERSION__}/wasm/wllama.js`, size: __WLLAMA_COMPAT_JS_SIZE__, sha256: __WLLAMA_COMPAT_JS_SHA256__, type: "text/javascript" },
];

function supportsJspi(): boolean {
  return !!(WebAssembly as any).Suspending;
}

function supportsMemory64(): boolean {
  try {
    new WebAssembly.Memory({ address: "i64", initial: 1n } as any);
    return true;
  } catch {
    return false;
  }
}

/** True when this WebView can't run the fast engine build. */
export function needsCompatEngine(): boolean {
  return !supportsJspi() || !supportsMemory64();
}

function engineFiles(): EngineFile[] {
  return needsCompatEngine() ? ENGINE_COMPAT : ENGINE_DEFAULT;
}

export function engineSize(): number {
  return engineFiles().reduce((n, f) => n + f.size, 0);
}

/** Kept for deleting everything when the last model is removed. */
export const ENGINE_URLS = [...ENGINE_DEFAULT, ...ENGINE_COMPAT].map((f) => f.url);

const engineBlobUrls = new Map<string, string>();

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function engineCached(): Promise<boolean> {
  try {
    const cm = (await getManager()).cacheManager;
    for (const f of engineFiles()) {
      const blob = await cm.open(f.url);
      if (!blob || blob.size !== f.size) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Downloads (if needed) and verifies the engine files; returns blob: URLs the
 * worker can load. Not bundled with the app, to keep it small.
 */
async function ensureEngine(onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<Map<string, string>> {
  const cm = (await getManager()).cacheManager;
  const out = new Map<string, string>();
  let done = 0;
  for (const f of engineFiles()) {
    const known = engineBlobUrls.get(f.url);
    if (known) { out.set(f.url, known); done += f.size; continue; }
    let blob = await cm.open(f.url);
    if (!blob || blob.size !== f.size) {
      await installMobileFetch();
      if (blob) await cm.delete(f.url);
      const base = done;
      await cm.download(f.url, { signal, progressCallback: ({ loaded }) => onProgress?.(base + loaded) });
      blob = await cm.open(f.url);
    }
    if (!blob || (await sha256Hex(blob)) !== f.sha256) {
      await cm.delete(f.url).catch(() => {});
      throw new Error("The on-device engine download was damaged. Please try again.");
    }
    const url = URL.createObjectURL(new Blob([blob], { type: f.type }));
    engineBlobUrls.set(f.url, url);
    out.set(f.url, url);
    done += f.size;
    onProgress?.(done);
  }
  return out;
}

export function localSupported(): boolean {
  return typeof WebAssembly === "object" && typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

/** Re-reads which models are on this device. Call once at startup. */
export async function refreshLocalModels(): Promise<void> {
  if (!localSupported()) return;
  try {
    const mm = await getManager();
    const models = await mm.getModels();
    const keys = LOCAL_MODELS.filter((lm) => models.some((m) => m.url === lm.url && m.size > 0)).map((m) => m.key);
    setDownloadedLocal(keys);
  } catch (e) {
    console.warn("[on-device] could not list models", e);
  }
}

export async function downloadLocalModel(key: string): Promise<void> {
  const info = localModelInfo(key);
  if (!info) throw new Error("Unknown model");
  if (downloadAborts.has(key)) return;
  const ac = new AbortController();
  downloadAborts.set(key, ac);
  setDownloadProgress((p) => ({ ...p, [key]: 0 }));
  try {
    // Ask the system to keep the files even when storage gets low.
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
    await installMobileFetch();
    const mm = await getManager();
    const engineTotal = (await engineCached()) ? 0 : engineSize();
    const total = info.size + engineTotal;
    let engineDone = 0;
    const report = (modelLoaded: number) =>
      setDownloadProgress((p) => ({ ...p, [key]: Math.min(1, (engineDone + modelLoaded) / total) }));
    if (engineTotal) await ensureEngine((l) => { engineDone = Math.min(l, engineTotal); report(0); }, ac.signal);
    await mm.downloadModel(info.url, {
      signal: ac.signal,
      progressCallback: ({ loaded }) => report(loaded),
    });
    await refreshLocalModels();
  } catch (e) {
    if (ac.signal.aborted) throw new Error("Download cancelled.");
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/quota|space|storage/i.test(msg)
      ? "Not enough free storage on this device for this model."
      : `Download failed. Check your internet connection and try again. (${msg})`);
  } finally {
    downloadAborts.delete(key);
    setDownloadProgress((p) => { const n = { ...p }; delete n[key]; return n; });
  }
}

export function cancelLocalDownload(key: string): void {
  downloadAborts.get(key)?.abort();
}

export async function deleteLocalModel(key: string): Promise<void> {
  const info = localModelInfo(key);
  if (!info) return;
  if (loadedKey === key && engine) {
    try { await engine.exit(); } catch { /* ignore */ }
    engine = null;
    loadedKey = null;
  }
  const mm = await getManager();
  const models = await mm.getModels({ includeInvalid: true });
  for (const m of models) if (m.url === info.url) await m.remove();
  await refreshLocalModels();
  // Free the engine too once no model is left.
  if (downloadedLocal().length === 0) {
    for (const u of ENGINE_URLS) { try { await mm.cacheManager.delete(u); } catch { /* ignore */ } }
    for (const u of engineBlobUrls.values()) URL.revokeObjectURL(u);
    engineBlobUrls.clear();
  }
}

async function ensureLoaded(key: string): Promise<Wllama> {
  if (engine && loadedKey === key) return engine;
  if (loadingPromise) await loadingPromise.catch(() => {});
  if (engine && loadedKey === key) return engine;
  const info = localModelInfo(key);
  if (!info) throw new Error("This on-device model is not available.");
  if (!downloadedLocal().includes(key)) throw new Error(`${info.name} is not downloaded yet. Download it in Settings → On-device.`);

  setLoadingLocal(key);
  loadingPromise = (async () => {
    if (engine) {
      try { await engine.exit(); } catch { /* ignore */ }
      engine = null;
      loadedKey = null;
    }
    const m = await mod();
    const mm = await getManager();
    const model = (await mm.getModels()).find((x) => x.url === info.url);
    if (!model) throw new Error(`${info.name} is not downloaded yet.`);
    const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    const urls = await ensureEngine();
    const compat = needsCompatEngine();
    let compatWorker = "";
    if (compat) {
      const js = await mm.cacheManager.open(ENGINE_COMPAT[1].url);
      compatWorker = js ? await js.text() : "";
    }
    const make = () => {
      const w = new m.Wllama(
        { default: urls.get((compat ? ENGINE_COMPAT : ENGINE_DEFAULT)[0].url)! },
        { logger: quietLogger, allowOffline: true, modelManager: mm },
      );
      if (compat) w.setCompat({ worker: { code: compatWorker }, wasm: urls.get(ENGINE_COMPAT[0].url)! });
      return w;
    };
    // Phones: smaller context and batches keep memory use low.
    const params = isMobile()
      ? { n_ctx: Math.min(info.ctx, 2048), n_batch: 256, n_ubatch: 256, n_threads: threads }
      : { n_ctx: info.ctx, n_threads: threads };
    let w = make();
    // WebGPU on phones is still unreliable, so phones always use the CPU.
    const tryGpu = !isMobile() && !compat && w.isSupportWebGPU();
    try {
      await w.loadModel(model, { ...params, n_gpu_layers: tryGpu ? 999 : 0 });
    } catch (e) {
      try { await w.exit(); } catch { /* ignore */ }
      if (!tryGpu) throw e;
      w = make();
      await w.loadModel(model, { ...params, n_gpu_layers: 0 });
    }
    engine = w;
    loadedKey = key;
  })();
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
    setLoadingLocal(null);
  }
  return engine!;
}

// === Prompt building ===

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

function toLocalMessages(contents: GeminiContent[], systemInstruction: string, ctx: number, maxOut: number): ChatMsg[] {
  const msgs: ChatMsg[] = [];
  for (const c of contents) {
    const text = c.parts.filter((p) => p.text && !p.thought).map((p) => p.text!).join("").trim();
    if (!text) continue;
    const role = c.role === "model" ? "assistant" : "user";
    const last = msgs[msgs.length - 1];
    // Chat templates expect alternating turns.
    if (last && last.role === role) last.content += "\n\n" + text;
    else msgs.push({ role, content: text });
  }
  // Keep the newest turns that fit the context window (≈3.5 characters per token).
  const budget = Math.floor((ctx - maxOut - 64) * 3.5);
  let used = systemInstruction.length;
  const kept: ChatMsg[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    used += msgs[i].content.length + 16;
    if (used > budget && kept.length > 0) break;
    kept.unshift(i === msgs.length - 1 && used > budget
      ? { ...msgs[i], content: msgs[i].content.slice(-Math.max(200, budget - systemInstruction.length)) }
      : msgs[i]);
  }
  while (kept.length && kept[0].role !== "user") kept.shift();
  return [{ role: "system", content: systemInstruction }, ...kept];
}

// === Generation ===

export async function streamLocal(
  key: string,
  contents: GeminiContent[],
  systemInstruction: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<void> {
  const run = async () => {
    try {
      const w = await ensureLoaded(key);
      if (signal?.aborted) return;
      const info = localModelInfo(key)!;
      const maxOut = maxTokens ?? 768;
      const messages = toLocalMessages(contents, systemInstruction, info.ctx, maxOut);
      const stream = await w.createChatCompletion({
        messages,
        max_tokens: maxOut,
        temperature: 0.8,
        top_p: 0.95,
        top_k: 40,
        stream: true,
        abortSignal: signal,
      } as any);
      for await (const chunk of stream as unknown as AsyncIterable<any>) {
        if (signal?.aborted) break;
        const t = chunk?.choices?.[0]?.delta?.content;
        if (typeof t === "string" && t) callbacks.onText?.(t);
      }
    } catch (e) {
      if (signal?.aborted || (e as any)?.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : String(e);
      // A crashed engine can't be reused; the next message starts a fresh one.
      if (/ABORT|crash|RuntimeError|unreachable/i.test(msg) && engine) {
        const dead = engine;
        engine = null;
        loadedKey = null;
        void dead.exit().catch(() => {});
      }
      const detail = recentErrors.length ? ` Details: ${recentErrors[recentErrors.length - 1]}.` : "";
      callbacks.onError?.(/memory|OOM|allocate/i.test(msg + detail)
        ? "Not enough memory to run this on-device model. Close other apps, or try Qwen 2.5 0.5B in Settings → On-device."
        : `The on-device model stopped (${msg.trim() || "unknown error"}).${detail} Send your message again to retry. [${engineInfo()}]`);
      recentErrors.length = 0;
    } finally {
      callbacks.onDone?.();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  await p;
}

export async function sendLocal(key: string, contents: GeminiContent[], systemInstruction: string, maxTokens?: number): Promise<string> {
  let out = "";
  let err: string | null = null;
  await streamLocal(key, contents, systemInstruction, { onText: (t) => { out += t; }, onError: (e) => { err = e; } }, undefined, maxTokens);
  if (err) throw new Error(err);
  return out;
}
