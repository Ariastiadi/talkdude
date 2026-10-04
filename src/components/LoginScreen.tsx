import { Show, createSignal } from "solid-js";
import {
  apiKey,
  apiKeyLoading,
  apiKeyError,
  submitApiKey,
  closeApiKeyDialog,
} from "../lib/stores/auth";
import { platformOpenUrl } from "../lib/platform";
import "./LoginScreen.css";

const AISTUDIO_KEY_URL = "https://aistudio.google.com/app/apikey";

export default function LoginScreen() {
  const [inputValue, setInputValue] = createSignal(apiKey() ?? "");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(inputValue());
  };

  const handleSkip = () => {
    closeApiKeyDialog();
  };

  const handleGetKey = (e: Event) => {
    e.preventDefault();
    platformOpenUrl(AISTUDIO_KEY_URL);
  };

  return (
    <div class="login-screen">
      <div class="login-card">
        <md-elevation></md-elevation>
        <div class="login-logo">
          <div class="login-icon lumi-logo" />
        </div>
        <h1 class="md-typescale-display-small login-title brand-name">talkdude</h1>
        <p class="md-typescale-body-large login-subtitle">
          Free to use: enter a Gemini API key from Google AI Studio, or skip and add another free provider (Groq, OpenRouter, local Ollama) in Settings.
        </p>

        <Show when={apiKeyError()}>
          <div class="login-error md-typescale-body-medium">
            {apiKeyError()}
          </div>
        </Show>

        <form class="api-key-form" onSubmit={handleSubmit}>
          <div class="api-key-input-wrapper">
            <input
              type="password"
              class="api-key-input md-typescale-body-large"
              placeholder="AIza..."
              value={inputValue()}
              onInput={(e) => setInputValue(e.currentTarget.value)}
              autocomplete="off"
              spellcheck={false}
              disabled={apiKeyLoading()}
            />
          </div>

          <p class="md-typescale-body-small login-disclaimer api-key-hint">
            Get your free API key from{" "}
            <a href={AISTUDIO_KEY_URL} class="login-link" onClick={handleGetKey}>
              Google AI Studio
            </a>
          </p>

          <div class="api-key-actions">
            <md-filled-button
              type="submit"
              disabled={apiKeyLoading() || !inputValue().trim()}
              class="login-button"
            >
              <Show
                when={!apiKeyLoading()}
                fallback={
                  <md-circular-progress
                    indeterminate
                    style={{ "--md-circular-progress-size": "24px" }}
                  ></md-circular-progress>
                }
              >
                <md-icon slot="icon">key</md-icon>
                Save API key
              </Show>
            </md-filled-button>

            <button
              type="button"
              class="login-text-btn"
              onClick={handleSkip}
              disabled={apiKeyLoading()}
            >
              Skip for now
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
