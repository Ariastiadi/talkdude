/**
 * talkdude app settings: AI providers, theme, and content-filter preference.
 * Everything is persisted in the `settings` table (IndexedDB via Dexie).
 */
import { createSignal } from "solid-js";
import { db } from "../db";
import { downloadedLocal, localModelInfo } from "../api/local";

// === Provider Types ===

export type ProviderType = "gemini" | "openai" | "anthropic" | "local";

/** Built-in provider for models that run on this device (no key, no limits). */
export const DEVICE_PROVIDER_ID = "device";

function deviceProvider(): Provider {
  return { id: DEVICE_PROVIDER_ID, type: "local", name: "On-device", baseUrl: "", apiKey: "", models: downloadedLocal() };
}

export function isDeviceModelId(modelId: string): boolean {
  return modelId.startsWith(DEVICE_PROVIDER_ID + "::");
}

export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  /** Base URL without trailing slash, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Model IDs the user wants to see in the model picker. */
  models: string[];
}

/** Built-in presets offered when the user adds a provider. */
export const PROVIDER_PRESETS: { key: string; name: string; type: ProviderType; baseUrl: string; models: string[]; keyUrl: string; free?: boolean; freeOnly?: boolean }[] = [
  // Free options first. Model lists on free tiers change often, so "Fetch model list"
  // in Settings fetches the current list (OpenRouter is filtered to ":free" models).
  { key: "openrouter-free", name: "OpenRouter (free models)", type: "openai", baseUrl: "https://openrouter.ai/api/v1", models: [], keyUrl: "https://openrouter.ai/keys", free: true, freeOnly: true },
  { key: "groq", name: "Groq (free, fast)", type: "openai", baseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"], keyUrl: "https://console.groq.com/keys", free: true },
  { key: "ollama", name: "Ollama local (free, unlimited, offline)", type: "openai", baseUrl: "http://localhost:11434/v1", models: ["llama3.2"], keyUrl: "https://ollama.com/download", free: true },
  { key: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4.1", "gpt-4.1-mini", "o4-mini"], keyUrl: "https://platform.openai.com/api-keys" },
  { key: "anthropic", name: "Claude (Anthropic)", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-5", "claude-haiku-4-5"], keyUrl: "https://console.anthropic.com/settings/keys" },
  { key: "openrouter", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat-v3.1"], keyUrl: "https://openrouter.ai/keys" },
  { key: "deepseek", name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], keyUrl: "https://platform.deepseek.com/api_keys" },
  { key: "mistral", name: "Mistral", type: "openai", baseUrl: "https://api.mistral.ai/v1", models: ["mistral-large-latest", "mistral-small-latest"], keyUrl: "https://console.mistral.ai/api-keys" },
  { key: "custom", name: "Other OpenAI-compatible", type: "openai", baseUrl: "https://", models: [], keyUrl: "" },
];

// === Settings Keys ===

const PROVIDERS_KEY = "talkdude_providers";
const THEME_KEY = "talkdude_theme";
const SAFETY_KEY = "talkdude_safety_off";
const SELECTED_MODEL_KEY = "talkdude_selected_model";
const FALLBACK_KEY = "talkdude_auto_fallback";

export type ThemeMode = "system" | "dark" | "light";

// === State ===

const [providers, setProvidersSignal] = createSignal<Provider[]>([]);
const [theme, setThemeSignal] = createSignal<ThemeMode>("system");
/** When true, Gemini safety filters are set to BLOCK_NONE for all categories. */
const [safetyOff, setSafetyOffSignal] = createSignal(false);
const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
/** When a model hits a rate limit / quota, continue with the next usable model. */
const [autoFallback, setAutoFallbackSignal] = createSignal(true);

export type SettingsTab = "device" | "gemini" | "providers" | "persona" | "appearance";
const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("device");

export { providers, theme, safetyOff, settingsDialogOpen, setSettingsDialogOpen, autoFallback, settingsTab, setSettingsTab };

export function openSettings(tab?: SettingsTab): void {
  if (tab) setSettingsTab(tab);
  setSettingsDialogOpen(true);
}

// === Composite Model IDs ===
// Gemini models keep their plain id ("gemini-3.1-flash-lite").
// Other providers use "<providerId>::<modelId>" so one string identifies both.

export const MODEL_SEP = "::";

export function isGeminiModelId(modelId: string): boolean {
  return !modelId.includes(MODEL_SEP);
}

export function resolveModel(modelId: string): { provider: Provider | null; model: string } {
  if (isGeminiModelId(modelId)) return { provider: null, model: modelId };
  const idx = modelId.indexOf(MODEL_SEP);
  const providerId = modelId.slice(0, idx);
  const model = modelId.slice(idx + MODEL_SEP.length);
  if (providerId === DEVICE_PROVIDER_ID) {
    return { provider: localModelInfo(model) ? deviceProvider() : null, model };
  }
  const provider = providers().find((p) => p.id === providerId) ?? null;
  return { provider, model };
}

export function makeModelId(providerId: string, model: string): string {
  return `${providerId}${MODEL_SEP}${model}`;
}

/** Human-readable label for any model id. */
export function modelLabel(modelId: string): string {
  const { provider, model } = resolveModel(modelId);
  if (provider?.type === "local") return `${localModelInfo(model)?.name ?? model} · On-device`;
  return provider ? `${model} · ${provider.name}` : model;
}

// === Persistence ===

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await db.settings.get(key);
    return row && row.value !== undefined ? (row.value as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function initSettings(): Promise<void> {
  const list = await readSetting<Provider[]>(PROVIDERS_KEY, []);
  setProvidersSignal(Array.isArray(list) ? list : []);
  const t = await readSetting<ThemeMode>(THEME_KEY, "system");
  setThemeSignal(t === "dark" || t === "light" ? t : "system");
  applyTheme(theme());
  setSafetyOffSignal(await readSetting<boolean>(SAFETY_KEY, false) === true);
  setAutoFallbackSignal(await readSetting<boolean>(FALLBACK_KEY, true) !== false);
}

export async function setAutoFallback(on: boolean): Promise<void> {
  setAutoFallbackSignal(on);
  await db.settings.put({ key: FALLBACK_KEY, value: on });
}

/** A provider can be used when it has a key, or points at a local server (Ollama). */
export function providerUsable(p: Provider): boolean {
  return !!p.apiKey.trim() || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.)/.test(p.baseUrl);
}

/**
 * Every model the user can currently chat with, in fallback order:
 * the provider models first (their free tiers are independent), then Gemini.
 */
export function usableModelIds(geminiModelIds: string[], hasGeminiKey: boolean): string[] {
  const ids: string[] = [];
  for (const p of providers()) {
    if (!providerUsable(p)) continue;
    for (const m of p.models) ids.push(makeModelId(p.id, m));
  }
  if (hasGeminiKey) ids.push(...geminiModelIds);
  // On-device models last: they always work, but are slower than the cloud.
  for (const k of downloadedLocal()) ids.push(makeModelId(DEVICE_PROVIDER_ID, k));
  return ids;
}

export async function saveProviders(list: Provider[]): Promise<void> {
  setProvidersSignal(list);
  await db.settings.put({ key: PROVIDERS_KEY, value: list });
}

export async function upsertProvider(p: Provider): Promise<void> {
  const list = providers().slice();
  const idx = list.findIndex((x) => x.id === p.id);
  if (idx === -1) list.push(p); else list[idx] = p;
  await saveProviders(list);
}

export async function removeProvider(id: string): Promise<void> {
  await saveProviders(providers().filter((p) => p.id !== id));
}

export async function setTheme(mode: ThemeMode): Promise<void> {
  setThemeSignal(mode);
  applyTheme(mode);
  await db.settings.put({ key: THEME_KEY, value: mode });
}

export async function setSafetyOff(off: boolean): Promise<void> {
  setSafetyOffSignal(off);
  await db.settings.put({ key: SAFETY_KEY, value: off });
}

export async function persistSelectedModel(modelId: string): Promise<void> {
  try { await db.settings.put({ key: SELECTED_MODEL_KEY, value: modelId }); } catch { /* ignore */ }
}

export async function loadSelectedModel(): Promise<string | null> {
  const v = await readSetting<string | null>(SELECTED_MODEL_KEY, null);
  return typeof v === "string" && v ? v : null;
}

// === Theme Application ===

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.remove("theme-dark", "theme-light");
  if (mode === "dark") root.classList.add("theme-dark");
  if (mode === "light") root.classList.add("theme-light");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    meta.setAttribute("content", dark ? "#000000" : "#FFFFFF");
  }
}
