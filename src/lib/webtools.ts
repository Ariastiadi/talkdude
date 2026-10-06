/**
 * Web search and "read this link" for every AI (not just Gemini). The app does
 * the lookup itself, with no key and no account, and hands the results to the
 * model as extra context. Search uses DuckDuckGo's plain HTML page, with
 * Wikipedia as a fallback. In the app, requests go through the native HTTP
 * client (no browser CORS limits); in a plain browser only CORS-friendly sites work.
 */
import { platformFetch } from "./platform";

export interface WebSource { uri: string; title: string }
export interface WebContext { text: string; queries: string[]; sources: WebSource[] }

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

async function getText(url: string, signal?: AbortSignal, timeoutMs = 9000): Promise<{ text: string; type: string; url: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await platformFetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "en,id;q=0.8" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const text = (await res.text()).slice(0, 1_500_000);
    return { text, type, url: res.url || url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// === HTML to plain text ===

export function htmlToText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = (doc.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim();
  doc.querySelectorAll("script,style,noscript,svg,iframe,form,nav,footer,header,aside,button,select,template").forEach((e) => e.remove());
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  if (!root) return { title, text: "" };
  root.querySelectorAll("p,div,br,li,tr,h1,h2,h3,h4,h5,h6,section,pre,blockquote").forEach((e) => e.append("\n"));
  const text = (root.textContent ?? "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** Fetches a page and returns its readable text (HTML, text or JSON). */
export async function fetchPageText(url: string, maxChars: number, signal?: AbortSignal): Promise<{ title: string; text: string } | null> {
  try {
    const r = await getText(url, signal);
    if (/pdf|image|audio|video|zip|octet/.test(r.type)) return null;
    if (/html/.test(r.type) || /^\s*<(!doctype|html)/i.test(r.text)) {
      const { title, text } = htmlToText(r.text);
      return text ? { title, text: text.slice(0, maxChars) } : null;
    }
    return { title: url, text: r.text.slice(0, maxChars) };
  } catch {
    return null;
  }
}

// === Search ===

interface Hit { title: string; url: string; snippet: string }

export function parseDuckDuckGo(html: string): Hit[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const hits: Hit[] = [];
  doc.querySelectorAll(".result, .web-result").forEach((el) => {
    if (el.classList.contains("result--ad")) return;
    const a = el.querySelector("a.result__a") as HTMLAnchorElement | null;
    if (!a) return;
    let href = a.getAttribute("href") ?? "";
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      href = real ? decodeURIComponent(real) : u.href;
    } catch { /* keep raw */ }
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) return;
    const snippet = (el.querySelector(".result__snippet")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const title = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (title) hits.push({ title, url: href, snippet });
  });
  return hits;
}

async function searchDuckDuckGo(q: string, signal?: AbortSignal): Promise<Hit[]> {
  const r = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=wt-wt`, signal);
  return parseDuckDuckGo(r.text);
}

async function searchWikipedia(q: string, signal?: AbortSignal): Promise<Hit[]> {
  const out: Hit[] = [];
  for (const lang of ["en", "id"]) {
    try {
      const r = await getText(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&origin=*&srlimit=4`,
        signal,
      );
      const j = JSON.parse(r.text) as { query?: { search?: { title: string; snippet: string }[] } };
      for (const s of j.query?.search ?? []) {
        out.push({
          title: `${s.title} (Wikipedia)`,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
          snippet: s.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'"),
        });
      }
      if (out.length) break;
    } catch { /* try the next language */ }
  }
  return out;
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<Hit[]> {
  try {
    const hits = await searchDuckDuckGo(query, signal);
    if (hits.length) return hits;
  } catch { /* fall through to Wikipedia */ }
  return searchWikipedia(query, signal);
}

// === Putting it together ===

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function urlsIn(text: string, max = 3): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;!?]+$/, "")))].slice(0, max);
}

/** Search phrase from a chat message: drop links and filler, keep it short. */
function queryFrom(text: string): string {
  return text.replace(URL_RE, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export interface WebBudget {
  /** Characters of search results (titles + snippets). */
  results: number;
  /** Characters kept from each opened page. */
  page: number;
  /** How many result pages to open (0 = snippets only). */
  openPages: number;
}

export async function buildWebContext(
  userText: string,
  opts: { search: boolean; links: boolean; budget: WebBudget; signal?: AbortSignal },
): Promise<WebContext> {
  const { budget, signal } = opts;
  const blocks: string[] = [];
  const sources: WebSource[] = [];
  const queries: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const opened = new Set<string>();

  if (opts.links) {
    for (const url of urlsIn(userText)) {
      opened.add(url);
      const page = await fetchPageText(url, budget.page, signal);
      if (page) {
        sources.push({ uri: url, title: page.title || url });
        blocks.push(`[Opened link: ${url}]\n${page.text}`);
      } else {
        blocks.push(`[Could not open the link: ${url}]`);
      }
    }
  }

  const q = queryFrom(userText);
  if (opts.search && q.length >= 3) {
    queries.push(q);
    const hits = (await searchWeb(q, signal)).slice(0, 6);
    if (!hits.length) {
      blocks.push("[Web search: no results could be loaded (maybe no internet). Tell the user you couldn't search and answer from what you know.]");
    } else {
      let used = 0;
      const lines: string[] = [];
      hits.forEach((h, i) => {
        const line = `[${sources.length + 1}] ${h.title} — ${h.url}\n${h.snippet}`;
        if (used + line.length > budget.results && lines.length) return;
        used += line.length;
        lines.push(line);
        sources.push({ uri: h.url, title: h.title });
        void i;
      });
      blocks.push(`[Web search results for “${q}” — today is ${today}. Use them, and mention a source number like [1] when you rely on it.]\n${lines.join("\n\n")}`);
      const open = hits.filter((h) => !opened.has(h.url)).slice(0, budget.openPages);
      const pages = await Promise.all(open.map((h) => fetchPageText(h.url, budget.page, signal)));
      pages.forEach((p, i) => {
        if (p) blocks.push(`[Page text from ${open[i].url}]\n${p.text}`);
      });
    }
  }

  return { text: blocks.join("\n\n"), queries, sources };
}
