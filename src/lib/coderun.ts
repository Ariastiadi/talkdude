/**
 * "Run" for code blocks in AI replies, for every model (Gemini's code execution
 * runs on Google's servers; this runs on your device instead).
 *
 * - JavaScript runs in a separate Web Worker with a time limit.
 * - Python runs with Pyodide (Python compiled to WebAssembly). It is downloaded
 *   once from the jsDelivr CDN the first time you run Python (about 10 MB).
 * Code only runs when you tap Run.
 */

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

function workerFrom(src: string): Worker {
  return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
}

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

let pyWorker: Worker | null = null;

export function runnableLanguage(lang: string): "js" | "py" | null {
  const l = lang.toLowerCase();
  if (["js", "javascript", "node", "mjs"].includes(l)) return "js";
  if (["py", "python", "python3"].includes(l)) return "py";
  return null;
}

export function runCode(lang: "js" | "py", code: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const fresh = lang === "js";
    // Python keeps its worker so later runs are fast (Pyodide loads once).
    const w = fresh ? workerFrom(JS_WORKER) : (pyWorker ??= workerFrom(PY_WORKER));
    const limit = lang === "js" ? 8000 : 120_000;
    const timer = setTimeout(() => {
      w.terminate();
      if (!fresh) pyWorker = null;
      resolve({ ok: false, out: `Stopped: the code ran longer than ${limit / 1000} seconds.` });
    }, limit);
    w.onmessage = (e) => {
      clearTimeout(timer);
      if (fresh) w.terminate();
      resolve(e.data as { ok: boolean; out: string });
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      if (!fresh) pyWorker = null;
      resolve({ ok: false, out: lang === "py" ? `Python could not start (needs internet the first time). ${e.message ?? ""}` : String(e.message ?? e) });
    };
    w.postMessage(code);
  });
}
