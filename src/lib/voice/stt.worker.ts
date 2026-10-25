/// <reference lib="webworker" />
/**
 * Speech-to-text worker: OpenAI Whisper running on this device with
 * Transformers.js + ONNX Runtime (WebAssembly). Nothing you say leaves the device.
 *
 * - The model is downloaded once from Hugging Face and kept in the browser cache.
 * - The ONNX Runtime WebAssembly file (14 MB) is downloaded once from jsDelivr and
 *   checked against a fixed SHA-256 before it is used, so a changed file is refused.
 */
import { env, pipeline, Tensor } from "@huggingface/transformers";

type Msg =
  | { type: "load"; model: string; wasmUrl: string; wasmSha256: string; dtype: Record<string, string> }
  | { type: "transcribe"; id: number; audio: Float32Array; language?: string | null };

/** Languages "auto" chooses between (talkdude's users speak these most). */
const AUTO_LANGS = ["id", "en"];

const WASM_CACHE = "talkdude-voice";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;
let loaded = "";

const post = (m: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getWasm(url: string, want: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open(WASM_CACHE); } catch { /* no Cache API: download every time */ }
  const cached = await cache?.match(url);
  if (cached) {
    const buf = await cached.arrayBuffer();
    if ((await sha256(buf)) === want) return buf;
    await cache?.delete(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the speech engine (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if ((await sha256(buf)) !== want) throw new Error("The downloaded speech engine didn't match its checksum, so it wasn't used.");
  try { await cache?.put(url, new Response(buf.slice(0), { headers: { "content-type": "application/wasm" } })); } catch { /* storage full */ }
  return buf;
}

async function load(m: Extract<Msg, { type: "load" }>) {
  if (asr && loaded === m.model) { post({ type: "ready" }); return; }
  const onnx = env.backends.onnx as { wasm?: Record<string, unknown> };
  if (onnx.wasm) {
    onnx.wasm.wasmBinary = await getWasm(m.wasmUrl, m.wasmSha256);
    // Use the glue code bundled with the app (never fetch code from a CDN).
    onnx.wasm.wasmPaths = undefined;
    onnx.wasm.numThreads = 1;
    onnx.wasm.proxy = false;
  }
  env.useWasmCache = false;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const files = new Map<string, { loaded: number; total: number }>();
  if (asr) { try { await asr.dispose(); } catch { /* ignore */ } asr = null; }
  asr = await pipeline("automatic-speech-recognition", m.model, {
    device: "wasm",
    dtype: m.dtype as never,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let done = 0;
        let total = 0;
        for (const f of files.values()) { done += f.loaded; total += f.total; }
        post({ type: "progress", loaded: done, total });
      }
    },
  });
  reuseEncoderOutput();
  loaded = m.model;
  post({ type: "ready" });
}

/**
 * Language detection and transcription both run the (slow) audio encoder on
 * the same 30-second window. Remember its last result so it runs only once.
 */
function reuseEncoderOutput(): void {
  const session = asr?.model?.sessions?.model as { run: (feeds: Record<string, { data?: ArrayLike<number> }>, ...rest: unknown[]) => Promise<unknown> } | undefined;
  if (!session || (session as { __tdCached?: boolean }).__tdCached) return;
  const run = session.run.bind(session);
  let lastKey = "";
  let lastOut: unknown = null;
  session.run = async (feeds, ...rest) => {
    const d = feeds?.input_features?.data;
    let key = "";
    if (d && d.length) {
      let sum = 0;
      for (let i = 0; i < d.length; i += 61) sum = (sum * 31 + Math.round(Number(d[i]) * 1e4)) % 2147483647;
      key = `${d.length}:${sum}:${d[d.length - 1]}`;
    }
    if (key && key === lastKey && lastOut) return lastOut;
    const out = await run(feeds, ...rest);
    lastKey = key;
    lastOut = out;
    return out;
  };
  (session as { __tdCached?: boolean }).__tdCached = true;
}

/**
 * Whisper can tell which language is spoken: run the first decoding step and
 * compare the scores of the language tokens. ("any" = all languages Whisper knows.)
 */
async function detectLanguage(audio: Float32Array, mode: string): Promise<string> {
  const cfg = asr.model.generation_config as { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  const { input_features } = await asr.processor(audio.subarray(0, 30 * 16000));
  const sot = new Tensor("int64", BigInt64Array.from([BigInt(cfg.decoder_start_token_id)]), [1, 1]);
  const { logits } = await asr.model({ input_features, decoder_input_ids: sot });
  const scores = logits.data as Float32Array;
  const vocab = logits.dims[logits.dims.length - 1];
  const base = scores.length - vocab;
  const tokens = Object.entries(cfg.lang_to_id).map(([t, id]) => [t.replace(/[<|>]/g, ""), id] as const);
  const allowed = mode === "any" ? tokens : tokens.filter(([l]) => AUTO_LANGS.includes(l));
  let best = allowed[0]?.[0] ?? "en";
  let bestScore = -Infinity;
  for (const [l, id] of allowed) {
    const v = scores[base + id];
    if (v > bestScore) { bestScore = v; best = l; }
  }
  return best;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === "load") await load(m);
    else if (m.type === "transcribe") {
      if (!asr) throw new Error("Speech recognition isn't loaded yet.");
      const mode = m.language || "auto";
      const language = mode === "auto" || mode === "any" ? await detectLanguage(m.audio, mode) : mode;
      const out = await asr(m.audio, {
        language,
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      });
      const text = Array.isArray(out) ? out.map((o: { text: string }) => o.text).join(" ") : (out as { text: string }).text;
      post({ type: "result", id: m.id, text: text ?? "", language });
    }
  } catch (err) {
    post({ type: "error", id: (m as { id?: number }).id, message: err instanceof Error ? err.message : String(err) });
  }
};
