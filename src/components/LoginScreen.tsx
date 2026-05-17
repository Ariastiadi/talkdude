import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import {
  apiKey,
  apiKeyLoading,
  apiKeyError,
  submitApiKey,
  closeApiKeyDialog,
  removeApiKey,
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
        <h1 class="md-typescale-display-small login-title">Lumi AI</h1>
        <p class="md-typescale-body-large login-subtitle">
          Enter your Gemini API key to get started
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
                Save API Key
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

/**
 * Dialog for reconfiguring the API key after initial setup.
 * Rendered as a Portal overlay on top of the app shell, not a full-screen
 * replacement. Uses independent CSS classes so it works regardless of which
 * stylesheets are loaded.
 */
export function ApiKeyDialog() {
  const [inputValue, setInputValue] = createSignal(apiKey() ?? "");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(inputValue());
  };

  const handleCancel = () => {
    closeApiKeyDialog();
  };

  const handleRemoveKey = async () => {
    setInputValue("");
    await removeApiKey();
  };

  const handleGetKey = (e: Event) => {
    e.preventDefault();
    platformOpenUrl(AISTUDIO_KEY_URL);
  };

  return (
    <Portal>
      <div class="apikey-dialog-backdrop" onClick={handleCancel}>
        <div class="apikey-dialog" onClick={(e) => e.stopPropagation()}>
          <h2 class="md-typescale-headline-small apikey-dialog-title">API Key Settings</h2>
          <p class="md-typescale-body-medium apikey-dialog-subtitle">
            Update your Gemini API key
          </p>

          <Show when={apiKeyError()}>
            <div class="login-error md-typescale-body-medium apikey-dialog-error">
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
                  Save API Key
                </Show>
              </md-filled-button>

              <button
                type="button"
                class="login-text-btn login-text-btn-primary apikey-dialog-cancel"
                onClick={handleCancel}
                disabled={apiKeyLoading()}
              >
                Cancel
              </button>
            </div>
          </form>

          <button
            type="button"
            class="login-text-btn login-text-btn-danger apikey-dialog-remove"
            onClick={handleRemoveKey}
            disabled={apiKeyLoading()}
          >
            Remove API key
          </button>
        </div>
      </div>
    </Portal>
  );
}
