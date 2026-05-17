import { Show, onMount } from "solid-js";
import { apiKeyDialogOpen, isOnboardingFlow, initAuth } from "./lib/stores/auth";
import { loadConversations } from "./lib/stores/chat";
import { loadCustomInstructions } from "./lib/stores/custom-instructions";
import { initDB } from "./lib/db";
import { isTauri, isMobile, platformOpenUrl } from "./lib/platform";
import { createSignal } from "solid-js";

import LoginScreen, { ApiKeyDialog } from "./components/LoginScreen";
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

    // === Tauri-Specific: Native App Behavior ===
    if (isTauri()) {
      // Disable zoom on Tauri; web keeps accessibility zoom.
      const vp = document.querySelector('meta[name="viewport"]');
      if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");

      // Disable double-tap zoom and tap highlight for native app feel.
      document.documentElement.style.touchAction = "manipulation";
      document.documentElement.style.setProperty("-webkit-tap-highlight-color", "transparent");

      // Open external links in the system browser.
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
      // On mobile this breaks the native text-selection popup.
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

    // Wait for the browser to finish loading resources and upgrading custom
    // elements before showing the window. Tauri starts hidden, so rAF won't
    // fire; use load + requestIdleCallback.
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

    // Show the Tauri window now that initial render is complete.
    // Desktop starts hidden to prevent FOUC.
    if (isTauri()) {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        await getCurrentWebviewWindow().show();
      } catch (_) {}
    }

    // Enable CSS transitions now that initial render is settled.
    document.documentElement.classList.remove("preload");
  });

  return (
    <Show when={appReady()} fallback={<div />}>
      {/*
        Two distinct cases for apiKeyDialogOpen():
        1. Onboarding (no key yet): render LoginScreen full-screen, hide app shell.
        2. Settings reconfigure: overlay ApiKeyDialog on the app shell.
      */}
      <Show when={apiKeyDialogOpen() && isOnboardingFlow()}>
        <LoginScreen />
      </Show>

      {/* App shell: rendered whenever not in the full-screen onboarding flow. */}
      <Show when={!apiKeyDialogOpen() || !isOnboardingFlow()}>
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
          {/* Dialog overlay for reconfiguring the API key after initial setup. */}
          <Show when={apiKeyDialogOpen() && !isOnboardingFlow()}>
            <ApiKeyDialog />
          </Show>
        </div>
      </Show>
    </Show>
  );
}

export default App;
