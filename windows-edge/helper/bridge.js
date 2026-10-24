// Runs only in the talkdude page. Passes its web requests to the helper's
// background worker, which may read other websites (the page itself may not).
document.documentElement.dataset.tdBridge = "1";
window.addEventListener("message", (e) => {
  // Only the talkdude page itself, never frames inside it (like the Run sandbox).
  if (e.source !== window) return;
  const req = e.data && e.data.__tdBridge;
  if (!req || typeof req.id !== "number" || typeof req.url !== "string") return;
  chrome.runtime.sendMessage({ url: req.url, headers: req.headers || {} }, (r) => {
    const reply = chrome.runtime.lastError || !r ? { ok: false, error: "helper not available" } : r;
    window.postMessage({ __tdBridgeReply: { id: req.id, ...reply } }, "*");
  });
});
