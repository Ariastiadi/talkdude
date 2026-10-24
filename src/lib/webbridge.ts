/**
 * Web access for the Windows Edge version of talkdude.
 *
 * There the app runs as a local page in Microsoft Edge, and Edge does not let a
 * page read other websites (search results, links). The installer also adds a
 * tiny Edge extension ("talkdude helper") that is allowed to fetch web pages for
 * the talkdude page only. It marks the page with data-td-bridge and answers
 * window messages. Without the helper, everything falls back to normal fetch.
 */

interface BridgeReply { id: number; ok: boolean; status?: number; type?: string; url?: string; text?: string; error?: string }

let nextId = 1;
const waiting = new Map<number, (r: BridgeReply) => void>();
let listening = false;

export function hasWebBridge(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset.tdBridge === "1";
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data as { __tdBridgeReply?: BridgeReply };
    const r = d?.__tdBridgeReply;
    if (!r || typeof r.id !== "number") return;
    const done = waiting.get(r.id);
    waiting.delete(r.id);
    done?.(r);
  });
}

/** Fetches a web page through the helper extension. Returns text only. */
export function bridgeGet(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ status: number; type: string; url: string; text: string }> {
  listen();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const stop = () => {
      waiting.delete(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    waiting.set(id, (r) => {
      signal.removeEventListener("abort", stop);
      if (!r.ok) reject(new Error(r.error || "Request failed"));
      else resolve({ status: r.status ?? 0, type: r.type ?? "", url: r.url || url, text: r.text ?? "" });
    });
    window.postMessage({ __tdBridge: { id, url, headers } }, "*");
  });
}
