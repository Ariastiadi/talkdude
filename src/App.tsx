import { Show, onMount, createSignal } from "solid-js";
import { account, initAuth } from "./lib/stores/auth";
import { loadConversations } from "./lib/stores/chat";
import { loadCustomInstructions } from "./lib/stores/custom-instructions";
import { initDB } from "./lib/db";
import { isTauri, isMobile, platformOpenUrl } from "./lib/platform";

import LoginScreen from "./components/LoginScreen";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import "./lib/material-web";
import "./theme.css";
import "./markdown-theme.css";
import "./App.css";

const [sidebarOpen, setSidebarOpen] = createSignal(false);
export { sidebarOpen, setSidebarOpen };

function App() {
  const [appReady, setAppReady] = createSignal(false);

  onMount(async () => {
    await initDB();
    await initAuth();
    await loadConversations();
    await loadCustomInstructions();
    setAppReady(true);

    // --- Tauri-specific: native app behavior ---
    if (isTauri()) {
      // Restrict zoom via viewport meta — only on Tauri, not web
      // (web must keep accessibility zoom available).
      const vp = document.querySelector('meta[name="viewport"]');
      if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");

      // Disable double-tap zoom and remove tap highlight for native feel.
      // Applied via JS so these don't affect the web version at all.
      document.documentElement.style.touchAction = "manipulation";
      document.documentElement.style.setProperty("-webkit-tap-highlight-color", "transparent");

      // Intercept all external link clicks (markdown links, etc.) and
      // open them in the system browser via the opener plugin.
      document.addEventListener("click", (e) => {
        if (e.defaultPrevented) return;
        const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        if (href.startsWith("http://") || href.startsWith("https://")) {
          e.preventDefault();
          platformOpenUrl(href);
        }
      });

      // Desktop-only: disable zoom shortcuts and context menu.
      // On mobile these are either irrelevant (keyboard zoom) or actively
      // harmful (contextmenu prevention breaks the native text-selection
      // popup with copy/share/read-aloud actions).
      if (!isMobile()) {
        document.addEventListener("wheel", (e) => {
          if (e.ctrlKey || e.metaKey) e.preventDefault();
        }, { passive: false });

        document.addEventListener("keydown", (e) => {
          if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
            e.preventDefault();
          }
        });

        document.addEventListener("contextmenu", (e) => e.preventDefault());
      }
    }

    // Wait until the browser is truly idle — all pending resources (fonts,
    // images, sub-resources) loaded, layout settled, custom elements upgraded.
    // On Tauri the window is still hidden so rAF won't fire; we rely on the
    // load event + idle callback instead.
    if (document.readyState !== "complete") {
      await new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
    }
    await new Promise<void>((r) => {
      if ("requestIdleCallback" in window) {
        (window as any).requestIdleCallback(() => r(), { timeout: 300 });
      } else {
        setTimeout(r, 200);
      }
    });

    // Show the Tauri window now that everything is fully rendered (desktop starts
    // hidden via visible(false) to prevent FOUC / partial-render flash).
    if (isTauri()) {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        await getCurrentWebviewWindow().show();
      } catch (_) {}
    }

    // Enable CSS transitions/animations now that the initial render is settled.
    document.documentElement.classList.remove("preload");
  });

  return (
    <Show when={appReady()} fallback={<div />}>
    <Show when={account()} fallback={<LoginScreen />}>
      <div class="app-shell">
        <Show when={sidebarOpen()}>
          <div class="sidebar-backdrop" onClick={() => setSidebarOpen(false)}></div>
        </Show>
        <div class={`sidebar-container ${sidebarOpen() ? "open" : ""}`}>
          <Sidebar />
        </div>
        <div class="chat-container">
          <ChatView />
        </div>
      </div>
    </Show>
    </Show>
  );
}

export default App;
