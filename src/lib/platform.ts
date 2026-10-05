/**
 * Platform abstraction layer.
 * Detects whether the app is running inside Tauri or a plain browser,
 * and provides unified APIs for HTTP fetch and opening URLs.
 */

// === Detection ===

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export function isMobile(): boolean {
  return /android|iphone|ipad/i.test(navigator.userAgent);
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

// === HTTP Fetch ===

export async function platformFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url as string, init);
  }
  return fetch(String(url), init);
}

// === Mobile fetch routing ===
// Android/iOS WebViews can't reach most external HTTPS APIs directly, so
// requests to other origins go through Tauri's Rust HTTP client. Requests for
// the app's own files (WebAssembly, workers, data:/blob: URLs) must stay on
// the WebView's fetch, otherwise local assets would fail to load.

let mobileFetchInstalled = false;

export async function installMobileFetch(): Promise<void> {
  if (mobileFetchInstalled || !isTauri() || !isMobile()) return;
  mobileFetchInstalled = true;
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let external = false;
      try {
        const u = new URL(raw, location.href);
        external = (u.protocol === "https:" || u.protocol === "http:") && u.origin !== location.origin;
      } catch { /* relative or odd URL: keep native */ }
      return external
        ? (tauriFetch as unknown as typeof globalThis.fetch)(input, init)
        : nativeFetch(input, init);
    }) as typeof globalThis.fetch;
  } catch {
    mobileFetchInstalled = false;
  }
}

// === Open URL ===

export async function platformOpenUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
