/**
 * "Is there an AI to talk to?" — ties the Gemini key, the other providers and
 * the on-device models together, and keeps the selected model usable.
 */
import { apiKey } from "./auth";
import { providers, providerUsable, isGeminiModelId, isDeviceModelId, makeModelId, DEVICE_PROVIDER_ID, resolveModel } from "./settings";
import { selectedModel, chooseModel } from "./chat";
import { downloadedLocal, downloadLocalModel, DEFAULT_LOCAL_MODEL } from "../api/local";

export function hasUsableAI(): boolean {
  return !!apiKey() || providers().some(providerUsable) || downloadedLocal().length > 0;
}

export function modelUsable(id: string): boolean {
  if (isGeminiModelId(id)) return !!apiKey();
  if (isDeviceModelId(id)) return downloadedLocal().includes(id.slice(DEVICE_PROVIDER_ID.length + 2));
  const { provider } = resolveModel(id);
  return !!provider && providerUsable(provider) && provider.models.length > 0;
}

/** If the selected model can't answer, switch to one that can. */
export function fixSelectedModel(): void {
  if (modelUsable(selectedModel())) return;
  for (const p of providers()) {
    if (providerUsable(p) && p.models.length) { chooseModel(makeModelId(p.id, p.models[0])); return; }
  }
  const local = downloadedLocal()[0];
  if (local) chooseModel(makeModelId(DEVICE_PROVIDER_ID, local));
}

/** One-tap setup: download the default on-device model, then use it. */
export async function startOnDeviceSetup(key = DEFAULT_LOCAL_MODEL): Promise<void> {
  await downloadLocalModel(key);
  if (!modelUsable(selectedModel())) chooseModel(makeModelId(DEVICE_PROVIDER_ID, key));
}
