import { createSignal } from "solid-js";
import { getApiKey, setApiKey, clearApiKey, validateApiKey } from "../auth/apikey";

// === State ===

const [apiKey, setApiKeySignal] = createSignal<string | null>(null);
const [apiKeyLoading, setApiKeyLoading] = createSignal(false);
const [apiKeyError, setApiKeyError] = createSignal<string | null>(null);
const [apiKeyDialogOpen, setApiKeyDialogOpen] = createSignal(false);
// Distinguishes first-run onboarding from Settings re-config.
const [isOnboardingFlow, setIsOnboardingFlow] = createSignal(false);

export { apiKey, apiKeyLoading, apiKeyError, apiKeyDialogOpen, isOnboardingFlow };

/**
 * Loads the stored API key from the database and auto-opens the key dialog
 * if no key is found.
 */
export async function initAuth(): Promise<void> {
  try {
    const key = await getApiKey();
    setApiKeySignal(key);
    if (!key) {
      setIsOnboardingFlow(true);
      setApiKeyDialogOpen(true);
    }
  } catch {
    // DB read failed; treat as no key, dialog will open
    setIsOnboardingFlow(true);
    setApiKeyDialogOpen(true);
  }
}

/**
 * Opens the API key dialog (e.g. from the sidebar).
 */
export function openApiKeyDialog(): void {
  setApiKeyError(null);
  setIsOnboardingFlow(false);
  setApiKeyDialogOpen(true);
}

/**
 * Closes the API key dialog without saving (skip).
 */
export function closeApiKeyDialog(): void {
  setApiKeyDialogOpen(false);
  setApiKeyError(null);
  setIsOnboardingFlow(false);
}

/**
 * Validates and saves a new API key.
 * Updates the in-memory signal and closes the dialog on success.
 */
export async function submitApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  setApiKeyError(null);

  if (!trimmed) {
    setApiKeyError("Please enter an API key.");
    return;
  }

  setApiKeyLoading(true);
  try {
    const validationError = await validateApiKey(trimmed);
    if (validationError) {
      setApiKeyError(validationError);
      return;
    }
    await setApiKey(trimmed);
    setApiKeySignal(trimmed);
    setIsOnboardingFlow(false);
    setApiKeyDialogOpen(false);
  } catch (err) {
    setApiKeyError(err instanceof Error ? err.message : String(err));
  } finally {
    setApiKeyLoading(false);
  }
}

/**
 * Clears the stored API key and re-opens the key dialog.
 */
export async function removeApiKey(): Promise<void> {
  await clearApiKey();
  setApiKeySignal(null);
  setApiKeyError(null);
  // Keep overlay mode; user is already inside the app shell.
  setIsOnboardingFlow(false);
  setApiKeyDialogOpen(true);
}

