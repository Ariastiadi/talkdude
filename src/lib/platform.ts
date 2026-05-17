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

// === Open URL ===

export async function platformOpenUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
