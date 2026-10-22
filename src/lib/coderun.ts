/**
 * "Run" for code blocks in AI replies, for every model (Gemini's code execution
 * runs on Google's servers; this runs on your device instead).
 *
 * - Everything runs in a sandboxed frame with an empty origin, so code can't
 *   read talkdude's own data (chats, API keys).
 * - JavaScript runs in a separate Web Worker with a time limit.
 * - Python runs with Pyodide (Python compiled to WebAssembly). It is downloaded
 *   once from the jsDelivr CDN the first time you run Python (about 10 MB).
 * Code only runs when you tap Run.
 */

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

const JS_WORKER = `
const out = [];
const fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); } };
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => out.push(a.map(fmt).join(" "));
onmessage = async (e) => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const r = await new AsyncFunction(e.data)();
    if (r !== undefined) out.push(fmt(r));
    postMessage({ ok: true, out: out.join("\\n") });
  } catch (err) {
    postMessage({ ok: false, out: out.join("\\n") + (out.length ? "\\n" : "") + String(err && err.stack || err) });
  }
};`;

const PY_WORKER = `
importScripts("${PYODIDE}pyodide.js");
let py = null;
onmessage = async (e) => {
  try {
    if (!py) py = await loadPyodide({ indexURL: "${PYODIDE}" });
    let out = "";
    py.setStdout({ batched: (s) => { out += s + "\\n"; } });
    py.setStderr({ batched: (s) => { out += s + "\\n"; } });
    await py.loadPackagesFromImports(e.data).catch(() => {});
    const r = await py.runPythonAsync(e.data);
    if (r !== undefined && r !== null) out += String(r) + "\\n";
    postMessage({ ok: true, out: out.trimEnd() });
  } catch (err) {
    postMessage({ ok: false, out: String(err && err.message || err) });
  }
};`;

// Code runs inside a sandboxed frame with its own empty origin, so it can't read
// talkdude's storage (chats, API keys). Workers inside it give time limits.
const FRAME = `<!doctype html><meta charset="utf-8"><script>
const mk = (src) => { const u = URL.createObjectURL(new Blob([src], { type: "text/javascript" })); const w = new Worker(u); URL.revokeObjectURL(u); return w; };
const JS = ${JSON.stringify(JS_WORKER)};
const PY = ${JSON.stringify(PY_WORKER)};
let py = null;
let pyQueue = Promise.resolve();
// Each run gets its own time limit, counted from when it really starts.
const runIn = (w, code, ms, onStuck) => new Promise((res) => {
  const t = setTimeout(() => { w.terminate(); onStuck(); res({ ok: false, out: "Stopped: the code ran longer than " + ms / 1000 + " seconds." }); }, ms);
  w.onmessage = (e) => { clearTimeout(t); res(e.data); };
  w.onerror = (e) => { e.preventDefault(); clearTimeout(t); w.terminate(); onStuck(); res({ ok: false, out: String(e.message || e) }); };
  w.postMessage(code);
});
onmessage = (e) => {
  const { id, lang, code } = e.data || {};
  if (lang === "js") {
    const w = mk(JS);
    runIn(w, code, 8000, () => {}).then((r) => { w.terminate(); parent.postMessage({ id, ...r }, "*"); });
  } else {
    // One Python run at a time (Pyodide is shared). A broken or stuck Python is started fresh next time.
    pyQueue = pyQueue.then(async () => {
      if (!py) py = mk(PY);
      const r = await runIn(py, code, 180000, () => { py = null; });
      if (!r.ok && /importScripts|NetworkError|Failed to fetch|load/i.test(r.out)) {
        if (py) py.terminate();
        py = null;
        r.out = "Python could not start (it needs internet the first time). " + r.out;
      }
      parent.postMessage({ id, ...r }, "*");
    });
  }
};
parent.postMessage({ ready: true }, "*");
<\/script>`;

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, (r: { ok: boolean; out: string }) => void>();

function ensureFrame(): Promise<void> {
  if (frame && frameReady) return frameReady;
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("aria-hidden", "true");
  f.style.display = "none";
  frame = f;
  frameReady = new Promise((resolve) => {
    const onReady = (e: MessageEvent) => {
      if (e.source === f.contentWindow && e.data?.ready) {
        window.removeEventListener("message", onReady);
        resolve();
      }
    };
    window.addEventListener("message", onReady);
  });
  f.srcdoc = FRAME;
  document.body.appendChild(f);
  return frameReady;
}

if (typeof window !== "undefined") window.addEventListener("message", (e: MessageEvent) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data as { id?: number; ok?: boolean; out?: string };
  if (typeof d?.id !== "number") return;
  const done = pending.get(d.id);
  pending.delete(d.id);
  done?.({ ok: !!d.ok, out: d.out ?? "" });
});

/** Throws away the sandbox (stops anything still running in it). */
function resetFrame(): void {
  frame?.remove();
  frame = null;
  frameReady = null;
  for (const [, done] of pending) done({ ok: false, out: "Stopped." });
  pending.clear();
}

export function runnableLanguage(lang: string): "js" | "py" | null {
  const l = lang.toLowerCase();
  if (["js", "javascript", "node", "mjs"].includes(l)) return "js";
  if (["py", "python", "python3"].includes(l)) return "py";
  return null;
}

export async function runCode(lang: "js" | "py", code: string): Promise<{ ok: boolean; out: string }> {
  await ensureFrame();
  const id = nextId++;
  // The frame enforces the real time limits; this only guards against a frame that stopped answering.
  const safety = lang === "js" ? 15_000 : 20 * 60_000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      if (lang === "js") resetFrame();
      resolve({ ok: false, out: "Stopped: no answer from the code runner." });
    }, safety);
    pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    frame!.contentWindow!.postMessage({ id, lang, code }, "*");
  });
}
