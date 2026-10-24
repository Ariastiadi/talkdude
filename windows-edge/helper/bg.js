// Fetches web pages for the talkdude page. Text only, no cookies, GET only.
const MAX = 1_500_000;
const ALLOWED_HEADERS = ["accept", "accept-language"];

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const from = sender.url || "";
  if (!from.startsWith("file:///") || !/\/talkdude-edge\/index\.html/.test(from)) return false;
  let url;
  try { url = new URL(msg.url); } catch { reply({ ok: false, error: "bad url" }); return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") { reply({ ok: false, error: "only web pages" }); return false; }
  const headers = {};
  for (const [k, v] of Object.entries(msg.headers || {})) if (ALLOWED_HEADERS.includes(k.toLowerCase())) headers[k] = String(v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  fetch(url.href, { method: "GET", headers, credentials: "omit", redirect: "follow", signal: ctl.signal })
    .then(async (r) => reply({ ok: true, status: r.status, type: r.headers.get("content-type") || "", url: r.url, text: (await r.text()).slice(0, MAX) }))
    .catch((e) => reply({ ok: false, error: String(e && e.message || e) }))
    .finally(() => clearTimeout(timer));
  return true;
});
