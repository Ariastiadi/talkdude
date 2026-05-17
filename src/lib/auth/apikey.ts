import { db } from "../db";
import { platformFetch } from "../platform";
import { GEMINI_BASE_URL, GEMINI_API_KEY_SETTING } from "./constants";

/**
 * Retrieves the stored Gemini API key, or null if none is saved.
 */
export async function getApiKey(): Promise<string | null> {
  try {
    const setting = await db.settings.get(GEMINI_API_KEY_SETTING);
    return typeof setting?.value === "string" && setting.value.trim()
      ? setting.value.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Persists a Gemini API key to the database.
 */
export async function setApiKey(key: string): Promise<void> {
  await db.settings.put({ key: GEMINI_API_KEY_SETTING, value: key.trim() });
}

/**
 * Removes the stored Gemini API key.
 */
export async function clearApiKey(): Promise<void> {
  await db.settings.delete(GEMINI_API_KEY_SETTING);
}

/**
 * Validates an API key by making a lightweight models list request.
 * Returns null if the key appears valid, or an error message string if not.
 * Network errors are treated as "possibly valid" to avoid blocking the user
 * on transient connectivity issues.
 */
export async function validateApiKey(key: string): Promise<string | null> {
  const trimmed = key.trim();
  if (!trimmed) {
    return "API key cannot be empty.";
  }

  try {
    const resp = await platformFetch(
      `${GEMINI_BASE_URL}/v1beta/models?key=${encodeURIComponent(trimmed)}&pageSize=1`,
      { method: "GET" },
    );

    if (resp.ok) return null;

    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      let message = "Invalid API key.";
      try {
        const body = (await resp.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // ignore parse errors
      }
      return message;
    }

    // Treat 5xx as transient so the user isn't blocked on server issues.
    return null;
  } catch {
    // Treat network errors as transient.
    return null;
  }
}
