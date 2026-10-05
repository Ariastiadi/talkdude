import { Show, createSignal } from "solid-js";
import {
  apiKey,
  apiKeyLoading,
  apiKeyError,
  submitApiKey,
  closeApiKeyDialog,
} from "../lib/stores/auth";
import { openSettings } from "../lib/stores/settings";
import { startOnDeviceSetup } from "../lib/stores/ai";
import { DEFAULT_LOCAL_MODEL, localModelInfo, formatSize, localSupported } from "../lib/api/local";
import { platformOpenUrl } from "../lib/platform";
import "./LoginScreen.css";

const AISTUDIO_KEY_URL = "https://aistudio.google.com/app/apikey";

/** First run: pick how talkdude thinks. Every option is free. */
export default function LoginScreen() {
  const [inputValue, setInputValue] = createSignal(apiKey() ?? "");
  const local = localModelInfo(DEFAULT_LOCAL_MODEL)!;

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(inputValue());
  };

  const handleOnDevice = () => {
    // The download continues in the background; the chat screen shows progress.
    void startOnDeviceSetup(DEFAULT_LOCAL_MODEL).catch(() => {});
    closeApiKeyDialog();
  };

  const handleOtherProviders = () => {
    closeApiKeyDialog();
    openSettings("providers");
  };

  return (
    <div class="login-screen">
      <div class="onboard">
        <div class="onboard-head">
          <div class="login-logo">
            <div class="login-icon td-logo" />
          </div>
          <h1 class="login-title brand-name">talkdude</h1>
          <p class="md-typescale-body-large login-subtitle">
            Pick how talkdude thinks. Both options are free, and you can change it any time in Settings.
          </p>
        </div>

        <Show when={localSupported()}>
          <section class="onboard-card">
            <span class="td-badge">No key · no limits · offline</span>
            <h2 class="md-typescale-title-large onboard-card-title">On-device AI</h2>
            <p class="md-typescale-body-medium onboard-card-text">
              A small AI ({local.name}) runs right on this device. Private and unlimited. One-time download of {formatSize(local.size)}; answers are simpler and slower than cloud AI.
            </p>
            <button type="button" class="td-btn td-btn-primary td-btn-block" onClick={handleOnDevice}>
              <md-icon>download</md-icon>
              <span>Download and start</span>
            </button>
          </section>
        </Show>

        <section class="onboard-card">
          <span class="td-badge">Free key · smartest answers</span>
          <h2 class="md-typescale-title-large onboard-card-title">Google Gemini</h2>
          <p class="md-typescale-body-medium onboard-card-text">
            Fast cloud AI with files, web search and code. Getting a free key takes about a minute.
          </p>
          <Show when={apiKeyError()}>
            <div class="login-error md-typescale-body-medium">{apiKeyError()}</div>
          </Show>
          <form class="onboard-key" onSubmit={handleSubmit}>
            <input
              type="password"
              class="api-key-input md-typescale-body-large"
              placeholder="Paste key (AIza…)"
              value={inputValue()}
              onInput={(e) => setInputValue(e.currentTarget.value)}
              autocomplete="off"
              spellcheck={false}
              disabled={apiKeyLoading()}
            />
            <button type="submit" class="td-btn td-btn-outline" disabled={apiKeyLoading() || !inputValue().trim()}>
              <span>{apiKeyLoading() ? "Checking…" : "Save"}</span>
            </button>
          </form>
          <button type="button" class="td-btn td-btn-ghost td-btn-sm onboard-link" onClick={() => platformOpenUrl(AISTUDIO_KEY_URL)}>
            <md-icon>open_in_new</md-icon>
            <span>Get a free key at Google AI Studio</span>
          </button>
        </section>

        <div class="onboard-footer">
          <button type="button" class="td-btn td-btn-ghost td-btn-sm" onClick={handleOtherProviders} disabled={apiKeyLoading()}>
            <span>Other providers (Groq, OpenRouter, Claude…)</span>
          </button>
          <button type="button" class="td-btn td-btn-ghost td-btn-sm" onClick={() => closeApiKeyDialog()} disabled={apiKeyLoading()}>
            <span>Skip for now</span>
          </button>
        </div>
      </div>
    </div>
  );
}
