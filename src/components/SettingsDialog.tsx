import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { apiKey, apiKeyLoading, apiKeyError, submitApiKey, removeApiKey } from "../lib/stores/auth";
import {
  providers, upsertProvider, removeProvider, PROVIDER_PRESETS,
  theme, setTheme, safetyOff, setSafetyOff, setSettingsDialogOpen,
  autoFallback, setAutoFallback,
  providerUsable, type Provider, type ThemeMode,
  settingsTab, setSettingsTab, type SettingsTab, makeModelId, DEVICE_PROVIDER_ID,
} from "../lib/stores/settings";
import {
  LOCAL_MODELS, downloadedLocal, downloadProgress, downloadLocalModel, deleteLocalModel,
  formatSize, localSupported,
} from "../lib/api/local";
import { selectedModel, chooseModel } from "../lib/stores/chat";
import { modelUsable } from "../lib/stores/ai";
import { DownloadBar } from "./AiSetup";
import { notes, learningEnabled, setLearningEnabled, addNote, updateNote, deleteNote, clearNotes, MAX_NOTES } from "../lib/stores/learning";
import { testProvider, fetchModels } from "../lib/api/providers";
import { persona, setPersona } from "../lib/stores/characters";
import { platformOpenUrl } from "../lib/platform";
import "./SettingsDialog.css";

const AISTUDIO_KEY_URL = "https://aistudio.google.com/app/apikey";

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "device", label: "On-device" },
  { key: "gemini", label: "Gemini" },
  { key: "providers", label: "Providers" },
  { key: "persona", label: "Persona" },
  { key: "memory", label: "Memory" },
  { key: "appearance", label: "Look" },
];

export default function SettingsDialog() {
  const tab = settingsTab;
  const setTab = setSettingsTab;
  const close = () => setSettingsDialogOpen(false);

  return (
    <Portal>
      <div class="apikey-dialog-backdrop" onClick={close}>
        <div class="apikey-dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
          <div class="settings-head">
            <h2 class="md-typescale-headline-small apikey-dialog-title">Settings</h2>
            <md-icon-button type="button" aria-label="Close" onClick={close}><md-icon>close</md-icon></md-icon-button>
          </div>
          <div class="settings-tabs" role="tablist">
            <For each={TABS}>
              {(t) => (
                <button type="button" role="tab" class={`settings-tab ${tab() === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>{t.label}</button>
              )}
            </For>
          </div>
          <div class="settings-body">
            <Show when={tab() === "device"}><DeviceTab /></Show>
            <Show when={tab() === "memory"}><MemoryTab /></Show>
            <Show when={tab() === "gemini"}><GeminiTab /></Show>
            <Show when={tab() === "providers"}><ProvidersTab /></Show>
            <Show when={tab() === "persona"}><PersonaTab /></Show>
            <Show when={tab() === "appearance"}><AppearanceTab /></Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// === Memory Tab ===

function MemoryTab() {
  const [draft, setDraft] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const [editText, setEditText] = createSignal("");
  const [confirmClear, setConfirmClear] = createSignal(false);
  return (
    <div class="settings-section">
      <p class="md-typescale-body-medium apikey-dialog-subtitle">
        talkdude learns from your chats: it notes things you tell it about yourself (your name, interests, plans, how you like answers) and gives the relevant ones to the AI in every chat, so it gets more personal and helpful over time. Notes stay on this device.
      </p>
      <label class="settings-toggle">
        <div>
          <div class="md-typescale-body-large">Learn from my chats</div>
          <div class="md-typescale-body-small settings-help">{learningEnabled() ? "On. New facts are added after replies; you'll see “Remembered: …”." : "Off. Nothing new is learned and saved notes aren't used."}</div>
        </div>
        <input type="checkbox" checked={learningEnabled()} onChange={(e) => setLearningEnabled(e.currentTarget.checked)} />
        <span class={`toggle-track ${learningEnabled() ? "on" : ""}`}><span class="toggle-thumb" /></span>
      </label>
      <form class="memory-add" onSubmit={async (e) => { e.preventDefault(); if (await addNote(draft())) setDraft(""); }}>
        <input class="api-key-input" placeholder="Add something to remember, e.g. “I prefer short answers”" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />
        <button type="submit" class="td-btn td-btn-primary td-btn-sm" disabled={draft().trim().length < 4}><span>Add</span></button>
      </form>
      <div class="md-typescale-label-medium settings-help">{notes().length} of {MAX_NOTES} notes</div>
      <Show when={notes().length === 0}>
        <p class="md-typescale-body-small settings-help">Nothing learned yet. Just chat — try telling talkdude your name or what you're working on.</p>
      </Show>
      <For each={notes()}>
        {(n) => (
          <div class="memory-item md-typescale-body-small">
            <Show when={editing() === n.id} fallback={<span>{n.text}</span>}>
              <input class="api-key-input" value={editText()} onInput={(e) => setEditText(e.currentTarget.value)}
                onKeyDown={async (e) => { if (e.key === "Enter") { await updateNote(n.id, editText()); setEditing(null); } }} />
            </Show>
            <Show when={editing() === n.id} fallback={
              <md-icon-button class="action-btn" type="button" aria-label="Edit note" onClick={() => { setEditing(n.id); setEditText(n.text); }}><md-icon>edit</md-icon></md-icon-button>
            }>
              <md-icon-button class="action-btn" type="button" aria-label="Save note" onClick={async () => { await updateNote(n.id, editText()); setEditing(null); }}><md-icon>check</md-icon></md-icon-button>
            </Show>
            <md-icon-button class="action-btn" type="button" aria-label="Forget" onClick={() => deleteNote(n.id)}><md-icon>close</md-icon></md-icon-button>
          </div>
        )}
      </For>
      <Show when={notes().length > 0}>
        <div class="settings-row">
          <button type="button" class="td-btn td-btn-danger td-btn-sm" onClick={async () => { if (confirmClear()) { await clearNotes(); setConfirmClear(false); } else setConfirmClear(true); }}>
            <md-icon>delete_sweep</md-icon><span>{confirmClear() ? "Tap again to forget everything" : "Forget everything"}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

// === On-device Tab ===

function DeviceTab() {
  const [error, setError] = createSignal<string | null>(null);
  const get = async (key: string) => {
    setError(null);
    try {
      await downloadLocalModel(key);
      if (!modelUsable(selectedModel())) chooseModel(makeModelId(DEVICE_PROVIDER_ID, key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div class="settings-section">
      <p class="md-typescale-body-medium apikey-dialog-subtitle">
        Run an AI directly on this device: no API key, no account, no limits, and it works offline after the download. Answers are simpler and slower than cloud models; bigger models are smarter but need more memory.
      </p>
      <Show when={!localSupported()}>
        <div class="login-error md-typescale-body-small">This device's web view can't run on-device models.</div>
      </Show>
      <Show when={error()}><div class="login-error md-typescale-body-small">{error()}</div></Show>
      <For each={LOCAL_MODELS}>
        {(m) => {
          const id = makeModelId(DEVICE_PROVIDER_ID, m.key);
          const have = () => downloadedLocal().includes(m.key);
          const busy = () => downloadProgress()[m.key] !== undefined;
          return (
            <div class="device-model">
              <div class="device-model-head">
                <div class="device-model-info">
                  <div class="md-typescale-title-small">{m.name}</div>
                  <div class="md-typescale-body-small settings-help">{m.note}</div>
                  <div class="md-typescale-label-small settings-help">{formatSize(m.size)}{have() ? " · on this device" : ""}{selectedModel() === id ? " · in use" : ""}</div>
                </div>
              </div>
              <Show when={busy()}><DownloadBar modelKey={m.key} /></Show>
              <Show when={!busy()}>
                <div class="settings-row">
                  <Show when={have()} fallback={
                    <button type="button" class="td-btn td-btn-outline td-btn-sm" disabled={!localSupported()} onClick={() => get(m.key)}>
                      <md-icon>download</md-icon><span>Download</span>
                    </button>
                  }>
                    <button type="button" class="td-btn td-btn-primary td-btn-sm" disabled={selectedModel() === id} onClick={() => chooseModel(id)}>
                      <md-icon>check</md-icon><span>{selectedModel() === id ? "In use" : "Use"}</span>
                    </button>
                    <button type="button" class="td-btn td-btn-danger td-btn-sm" onClick={() => deleteLocalModel(m.key)}>
                      <md-icon>delete</md-icon><span>Delete</span>
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <p class="md-typescale-body-small settings-help">
        Models are downloaded once from Hugging Face and kept in talkdude's private storage. Qwen 2.5 is Apache-2.0; Llama 3.2 is under the Llama 3.2 Community License.
      </p>
    </div>
  );
}

// === Gemini Tab ===

function GeminiTab() {
  const [value, setValue] = createSignal(apiKey() ?? "");
  const [saved, setSaved] = createSignal(false);

  const save = async (e: Event) => {
    e.preventDefault();
    await submitApiKey(value());
    if (!apiKeyError()) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
  };

  return (
    <form class="api-key-form settings-section" onSubmit={save}>
      <p class="md-typescale-body-medium apikey-dialog-subtitle">
        Gemini API key from Google AI Studio (free). Needed for Gemini/Gemma models, file attachments, Google Search and code execution.
      </p>
      <Show when={apiKeyError()}>
        <div class="login-error md-typescale-body-medium apikey-dialog-error">{apiKeyError()}</div>
      </Show>
      <div class="api-key-input-wrapper">
        <input
          type="password"
          class="api-key-input md-typescale-body-large"
          placeholder="AIza..."
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
          disabled={apiKeyLoading()}
        />
      </div>
      <p class="md-typescale-body-small login-disclaimer api-key-hint">
        Get a key at{" "}
        <a href={AISTUDIO_KEY_URL} class="login-link" onClick={(e) => { e.preventDefault(); platformOpenUrl(AISTUDIO_KEY_URL); }}>Google AI Studio</a>
      </p>
      <div class="settings-row">
        <button type="submit" class="td-btn td-btn-primary" disabled={apiKeyLoading() || !value().trim()}>
          <md-icon>key</md-icon>
          <span>{apiKeyLoading() ? "Checking…" : saved() ? "Saved" : "Save key"}</span>
        </button>
        <Show when={apiKey()}>
          <button type="button" class="td-btn td-btn-danger" onClick={async () => { setValue(""); await removeApiKey(); }} disabled={apiKeyLoading()}>
            <span>Remove key</span>
          </button>
        </Show>
      </div>

      <div class="settings-divider" />

      <label class="settings-toggle">
        <div>
          <div class="md-typescale-body-large">Gemini content filter</div>
          <div class="md-typescale-body-small settings-help">
            {safetyOff()
              ? "Off: every Gemini safety category is set to BLOCK_NONE (18+). The provider's own policies still apply."
              : "On (Google default): answers considered sensitive are blocked."}
          </div>
        </div>
        <input type="checkbox" checked={!safetyOff()} onChange={(e) => setSafetyOff(!e.currentTarget.checked)} />
        <span class={`toggle-track ${!safetyOff() ? "on" : ""}`}><span class="toggle-thumb" /></span>
      </label>

      <label class="settings-toggle">
        <div>
          <div class="md-typescale-body-large">Keep going when a model hits its limit</div>
          <div class="md-typescale-body-small settings-help">
            talkdude never limits how much you chat. Limits come from each provider's free quota; when one model is rate-limited, the answer automatically continues on another model you have set up.
          </div>
        </div>
        <input type="checkbox" checked={autoFallback()} onChange={(e) => setAutoFallback(e.currentTarget.checked)} />
        <span class={`toggle-track ${autoFallback() ? "on" : ""}`}><span class="toggle-thumb" /></span>
      </label>
    </form>
  );
}

// === Providers Tab ===

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function ProvidersTab() {
  const [editing, setEditing] = createSignal<Provider | null>(null);
  const [modelsText, setModelsText] = createSignal("");
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<string | null>(null);
  const [presetOpen, setPresetOpen] = createSignal(false);
  const [freeOnly, setFreeOnly] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);

  const loadModels = async () => {
    setFetching(true);
    setTestResult(null);
    try {
      const ids = await fetchModels(current(), freeOnly());
      if (ids.length === 0) setTestResult("No models found.");
      else { setModelsText(ids.join(", ")); setTestResult(`${ids.length} models found ✔`); }
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const startAdd = (presetKey: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey)!;
    setEditing({ id: newId(), type: preset.type, name: preset.name, baseUrl: preset.baseUrl, apiKey: "", models: [...preset.models] });
    setModelsText(preset.models.join(", "));
    setTestResult(null);
    setPresetOpen(false);
    setFreeOnly(!!preset.freeOnly);
  };

  const startEdit = (p: Provider) => {
    setEditing({ ...p, models: [...p.models] });
    setModelsText(p.models.join(", "));
    setTestResult(null);
  };

  const current = (): Provider => {
    const e = editing()!;
    return { ...e, baseUrl: e.baseUrl.trim().replace(/\/+$/, ""), models: modelsText().split(/[\n,]/).map((m) => m.trim()).filter(Boolean) };
  };

  const save = async (e: Event) => {
    e.preventDefault();
    const p = current();
    if (!p.name.trim() || !p.baseUrl || p.models.length === 0) return;
    await upsertProvider(p);
    setEditing(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const err = await testProvider(current());
    setTestResult(err ?? "Connected ✔");
    setTesting(false);
  };

  const keyUrlFor = (p: Provider): string => {
    const preset = PROVIDER_PRESETS.find((x) => x.baseUrl && p.baseUrl.startsWith(x.baseUrl.replace(/\/v1$/, "")));
    return preset?.keyUrl ?? "";
  };

  return (
    <div class="settings-section">
      <Show when={!editing()} fallback={
        <form class="settings-form" onSubmit={save}>
          <label class="settings-field">
            <span class="md-typescale-label-medium">Name</span>
            <input class="api-key-input" value={editing()!.name} onInput={(e) => setEditing({ ...editing()!, name: e.currentTarget.value })} />
          </label>
          <label class="settings-field">
            <span class="md-typescale-label-medium">API type</span>
            <select class="api-key-input" value={editing()!.type} onChange={(e) => setEditing({ ...editing()!, type: e.currentTarget.value as Provider["type"] })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </label>
          <label class="settings-field">
            <span class="md-typescale-label-medium">Base URL</span>
            <input class="api-key-input" value={editing()!.baseUrl} spellcheck={false} onInput={(e) => setEditing({ ...editing()!, baseUrl: e.currentTarget.value })} />
          </label>
          <label class="settings-field">
            <span class="md-typescale-label-medium">API key</span>
            <input class="api-key-input" type="password" autocomplete="off" value={editing()!.apiKey} onInput={(e) => setEditing({ ...editing()!, apiKey: e.currentTarget.value })} />
            <Show when={keyUrlFor(editing()!)}>
              <span class="md-typescale-body-small settings-help">
                Get a key at{" "}
                <a href={keyUrlFor(editing()!)} class="login-link" onClick={(e) => { e.preventDefault(); platformOpenUrl(keyUrlFor(editing()!)); }}>{keyUrlFor(editing()!).replace(/^https?:\/\//, "").split("/")[0]}</a>
              </span>
            </Show>
          </label>
          <label class="settings-field">
            <span class="md-typescale-label-medium">Models (comma separated)</span>
            <textarea class="api-key-input settings-textarea" rows={3} value={modelsText()} onInput={(e) => setModelsText(e.currentTarget.value)} />
          </label>
          <div class="settings-row">
            <button type="button" class="td-btn td-btn-outline td-btn-sm" onClick={loadModels} disabled={fetching() || !editing()!.baseUrl.trim()}>
              {fetching() ? "Fetching…" : "Fetch model list"}
            </button>
            <label class="settings-inline-check md-typescale-body-small">
              <input type="checkbox" checked={freeOnly()} onChange={(e) => setFreeOnly(e.currentTarget.checked)} />
              free models only
            </label>
          </div>
          <Show when={testResult()}>
            <div class={`md-typescale-body-small ${testResult()?.endsWith("✔") ? "settings-ok" : "login-error"}`} style={{ "white-space": "normal" }}>{testResult()}</div>
          </Show>
          <div class="settings-row">
            <button type="submit" class="td-btn td-btn-primary" disabled={!editing()!.name.trim() || !editing()!.baseUrl.trim() || !modelsText().trim()}>
              <md-icon>save</md-icon>
              <span>Save</span>
            </button>
            <button type="button" class="td-btn td-btn-outline" onClick={runTest} disabled={testing() || !editing()!.baseUrl.trim()}>
              {testing() ? "Testing…" : "Test connection"}
            </button>
            <button type="button" class="td-btn td-btn-ghost" onClick={() => setEditing(null)}><span>Cancel</span></button>
          </div>
        </form>
      }>
        <p class="md-typescale-body-medium apikey-dialog-subtitle">
          Use models from OpenAI, Claude, Groq, OpenRouter, DeepSeek, Mistral, Ollama or any OpenAI-compatible server with your own API key. Added models appear in the model picker.
        </p>
        <For each={providers()}>
          {(p) => (
            <div class="provider-item">
              <div class="provider-info">
                <div class="md-typescale-body-large">{p.name}</div>
                <div class="md-typescale-body-small settings-help">{p.models.length} model{p.models.length === 1 ? "" : "s"} · {p.apiKey ? "key saved" : providerUsable(p) ? "local server, no key needed" : "no key yet"}</div>
              </div>
              <md-icon-button type="button" aria-label="Edit" onClick={() => startEdit(p)}><md-icon>edit</md-icon></md-icon-button>
              <md-icon-button type="button" aria-label="Delete" onClick={() => removeProvider(p.id)}><md-icon>delete</md-icon></md-icon-button>
            </div>
          )}
        </For>
        <div class="settings-row">
          <button type="button" class="td-btn td-btn-primary" onClick={() => setPresetOpen(!presetOpen())}>
            <md-icon>{presetOpen() ? "expand_less" : "add"}</md-icon>
            <span>Add provider</span>
          </button>
        </div>
        <Show when={presetOpen()}>
            <div class="preset-menu">
              <For each={PROVIDER_PRESETS}>
                {(preset) => (
                  <button type="button" class="preset-item md-typescale-body-medium" onClick={() => startAdd(preset.key)}>
                    {preset.name}
                    <Show when={preset.free}><span class="free-badge">FREE</span></Show>
                  </button>
                )}
              </For>
            </div>
        </Show>
      </Show>
    </div>
  );
}

// === Appearance Tab ===

function AppearanceTab() {
  const options: { value: ThemeMode; label: string; icon: string }[] = [
    { value: "system", label: "System", icon: "brightness_auto" },
    { value: "dark", label: "Dark", icon: "dark_mode" },
    { value: "light", label: "Light", icon: "light_mode" },
  ];
  return (
    <div class="settings-section">
      <p class="md-typescale-body-medium apikey-dialog-subtitle">Nothing-style monochrome theme: black and white, red accent, dot-matrix headings.</p>
      <div class="theme-options">
        <For each={options}>
          {(o) => (
            <button type="button" class={`theme-option ${theme() === o.value ? "selected" : ""}`} onClick={() => setTheme(o.value)}>
              <md-icon>{o.icon}</md-icon>
              <span class="md-typescale-label-large">{o.label}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

// === Persona Tab ===

function PersonaTab() {
  const [name, setName] = createSignal(persona().name);
  const [desc, setDesc] = createSignal(persona().description);
  const [saved, setSaved] = createSignal(false);
  const save = async (e: Event) => {
    e.preventDefault();
    await setPersona({ name: name().trim(), description: desc().trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
    <form class="settings-section settings-form" onSubmit={save}>
      <p class="md-typescale-body-medium apikey-dialog-subtitle">
        Tell the AI who you are. Characters use your name for {"{{user}}"}, and every chat gets this context.
      </p>
      <label class="settings-field">
        <span class="md-typescale-label-medium">Your name</span>
        <input class="api-key-input" maxLength={40} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="settings-field">
        <span class="md-typescale-label-medium">About you (optional)</span>
        <textarea class="api-key-input settings-textarea" rows={4} maxLength={728} placeholder="e.g. I live in Jakarta, I like sci-fi and spicy food, I prefer short answers." value={desc()} onInput={(e) => setDesc(e.currentTarget.value)} />
      </label>
      <div class="settings-row">
        <button type="submit" class="td-btn td-btn-primary">
          <md-icon>save</md-icon>
          <span>{saved() ? "Saved" : "Save persona"}</span>
        </button>
      </div>
    </form>
  );
}
