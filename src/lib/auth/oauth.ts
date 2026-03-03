import { generatePKCE } from "./pkce";
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_SCOPES,
  ANTIGRAVITY_OAUTH_REDIRECT_PORT,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_API_CLIENT,
  ANTIGRAVITY_CLIENT_METADATA,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
} from "./constants";
import { db, type AuthAccount } from "../db";
import {
  isTauri,
  isMobile,
  platformFetch,
  platformStartOAuthListener,
  getOAuthRedirectUri,
} from "../platform";

// --- Types ---

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
}

interface UserInfo {
  email?: string;
  name?: string;
  picture?: string;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string };
  allowedTiers?: { id?: string; isDefault?: boolean }[];
}

interface OnboardResponse {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: string | { id?: string };
  };
}

// --- Antigravity API Headers (CORS-safe) ---

/**
 * Returns extra Antigravity identification headers.
 * In web mode these are omitted — CORS only allows Authorization + Content-Type.
 * In Tauri mode requests bypass CORS, so all headers are sent.
 */
function getAntigravityApiHeaders(): Record<string, string> {
  if (!isTauri()) return {};
  return {
    "User-Agent": ANTIGRAVITY_USER_AGENT,
    "X-Goog-Api-Client": ANTIGRAVITY_API_CLIENT,
    "Client-Metadata": ANTIGRAVITY_CLIENT_METADATA,
  };
}

// --- Project ID Extraction ---

function extractProjectId(data: { cloudaicompanionProject?: string | { id?: string } }): string {
  const proj = data.cloudaicompanionProject;
  if (!proj) return "";
  if (typeof proj === "string") return proj.trim();
  if (typeof proj === "object" && typeof proj.id === "string") return proj.id.trim();
  return "";
}

// --- User Onboarding ---

/**
 * Onboards a user by calling the onboardUser endpoint.
 * Tries across all endpoint fallbacks.
 * Polls up to 10 times (5 s intervals) until the server reports done.
 */
async function onboardUser(accessToken: string, tierID: string, projectId?: string): Promise<string> {
  const maxAttempts = 10;
  const pollDelayMs = 5_000;

  const metadata: Record<string, string> = {
    ideType: "ANTIGRAVITY",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }

  const body = JSON.stringify({ tierId: tierID, metadata });

  for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp: Response;
      try {
        resp = await platformFetch(`${baseEndpoint}/${ANTIGRAVITY_API_VERSION}:onboardUser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...getAntigravityApiHeaders(),
          },
          body,
        });
      } catch {
        break; // network error on this endpoint, try next
      }

      if (!resp.ok) {
        break; // error on this endpoint, try next
      }

      const data = (await resp.json()) as OnboardResponse;

      if (data.done) {
        const resolvedId = data.response ? extractProjectId(data.response) : "";
        if (resolvedId) return resolvedId;
        if (projectId) return projectId;
        break;
      }

      // Not finished yet — wait before next poll
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollDelayMs));
      }
    }
  }

  return "";
}

// --- Project Discovery ---

/**
 * Discovers the project ID for an authenticated user.
 * 1. Calls loadCodeAssist across multiple endpoints (prod first) to get the project + tier.
 * 2. If no project found, calls onboardUser to auto-provision one.
 */
export async function discoverProjectId(accessToken: string): Promise<string> {
  const loadBody = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });

  let data: LoadCodeAssistResponse | null = null;

  // Try loadCodeAssist across all endpoints
  const loadEndpoints = [...new Set([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS])];
  for (const baseEndpoint of loadEndpoints) {
    try {
      const resp = await platformFetch(`${baseEndpoint}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...getAntigravityApiHeaders(),
        },
        body: loadBody,
      });

      if (!resp.ok) continue;

      const payload = (await resp.json()) as LoadCodeAssistResponse;
      const projectId = extractProjectId(payload);
      if (projectId) {
        data = payload;
        break;
      }
    } catch {
      continue;
    }
  }

  const frontendProjectId = data ? extractProjectId(data) : "";

  // Determine tier from allowedTiers when available
  let tierID = "";
  if (data && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
    const defaultTier = data.allowedTiers.find((t) => t.isDefault);
    if (defaultTier?.id?.trim()) {
      tierID = defaultTier.id.trim();
    } else if (data.allowedTiers[0]?.id?.trim()) {
      tierID = data.allowedTiers[0].id.trim();
    }
  }

  if (frontendProjectId) {
    return frontendProjectId;
  }

  // No project from loadCodeAssist — auto-provision via onboarding.
  // When allowedTiers is absent, try both known default tiers in sequence
  // since different accounts may require either one to succeed.
  if (data && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
    return await onboardUser(accessToken, tierID);
  }

  const fallbackTiers = ["FREE", "legacy-tier"];
  for (const tier of fallbackTiers) {
    const provisionedId = await onboardUser(accessToken, tier);
    if (provisionedId) return provisionedId;
  }

  return "";
}

// --- Post-Auth: fetch user info, discover project, persist account ---

async function finalizeLogin(
  accessToken: string,
  refreshToken: string,
  tokenExpiry: number,
): Promise<AuthAccount> {
  // Fetch user info
  let email = "";
  try {
    const userResp = await platformFetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userResp.ok) {
      const userInfo = (await userResp.json()) as UserInfo;
      email = userInfo.email ?? "";
    }
  } catch {
    // Non-fatal: email is optional
  }

  // Discover project ID
  const projectId = await discoverProjectId(accessToken);

  // Persist account
  const now = Date.now();
  const account: AuthAccount = {
    id: crypto.randomUUID(),
    email,
    refreshToken,
    accessToken,
    tokenExpiry,
    projectId,
    createdAt: now,
    updatedAt: now,
  };

  // Clear any existing accounts (single-account mode)
  await db.auth.clear();
  await db.auth.put(account);

  return account;
}

// --- OAuth Login (PKCE + loopback/popup, unified for all platforms) ---

async function loginWithGoogleImpl(): Promise<AuthAccount> {
  const pkce = await generatePKCE();

  const state = btoa(JSON.stringify({ verifier: pkce.verifier }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const authUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", ANTIGRAVITY_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  const redirectUri = getOAuthRedirectUri(ANTIGRAVITY_OAUTH_REDIRECT_PORT);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const authUrlStr = authUrl.toString();

  // Mobile Tauri: navigate the main webview to Google OAuth directly.
  // The Android WebView User-Agent is overridden in lib.rs to remove the
  // "; wv)" token, preventing Google's 403 disallowed_useragent block.
  // on_navigation in Rust intercepts the redirect and navigates back.
  if (isTauri() && isMobile()) {
    localStorage.setItem(
      "lumi_pending_oauth",
      JSON.stringify({ verifier: pkce.verifier, redirectUri, timestamp: Date.now() }),
    );
    window.location.href = authUrlStr;
    // Page navigates away — this promise never resolves in the current JS context
    return new Promise<AuthAccount>(() => {});
  }

  // Desktop Tauri / Web: TCP listener + system browser, or popup + postMessage
  const callbackUrlStr = await platformStartOAuthListener(ANTIGRAVITY_OAUTH_REDIRECT_PORT, authUrlStr);
  const callbackUrl = new URL(callbackUrlStr);
  const code = callbackUrl.searchParams.get("code");

  if (!code) {
    const error = callbackUrl.searchParams.get("error") || "No authorization code received";
    throw new Error(`OAuth failed: ${error}`);
  }

  // Exchange code for tokens
  const startTime = Date.now();
  const tokenResp = await platformFetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const errorText = await tokenResp.text();
    throw new Error(`Token exchange failed (${tokenResp.status}): ${errorText}`);
  }

  const tokenData = (await tokenResp.json()) as GoogleTokenResponse;
  const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;

  return finalizeLogin(
    tokenData.access_token,
    tokenData.refresh_token,
    startTime + expiresIn * 1000,
  );
}

// --- Public API ---

/**
 * Initiates the full Google OAuth flow.
 * Tauri (desktop): PKCE + loopback TCP listener + system browser.
 * Tauri (mobile): PKCE + in-WebView OAuth (custom UA bypasses disallowed_useragent).
 * Web: PKCE + popup + postMessage callback.
 */
export async function loginWithGoogle(): Promise<AuthAccount> {
  return loginWithGoogleImpl();
}

// --- Mobile OAuth Resumption ---

/**
 * Checks for a pending mobile OAuth flow (stored in localStorage before
 * navigating away) and completes the token exchange if a result was captured
 * by the Rust on_navigation handler. Returns the AuthAccount on success,
 * or null if there is no pending flow / the user cancelled.
 */
export async function resumeMobileOAuth(): Promise<AuthAccount | null> {
  if (!isTauri() || !isMobile()) return null;

  const raw = localStorage.getItem("lumi_pending_oauth");
  if (!raw) return null;

  let pending: { verifier: string; redirectUri: string; timestamp: number };
  try {
    pending = JSON.parse(raw);
  } catch {
    localStorage.removeItem("lumi_pending_oauth");
    return null;
  }

  // Expire after 10 minutes
  if (Date.now() - pending.timestamp > 10 * 60 * 1000) {
    localStorage.removeItem("lumi_pending_oauth");
    return null;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const callbackUrlStr = await invoke<string | null>("get_oauth_result");

    if (!callbackUrlStr) {
      localStorage.removeItem("lumi_pending_oauth");
      return null;
    }

    localStorage.removeItem("lumi_pending_oauth");

    const callbackUrl = new URL(callbackUrlStr);
    const code = callbackUrl.searchParams.get("code");

    if (!code) {
      const error = callbackUrl.searchParams.get("error") || "No authorization code received";
      throw new Error(`OAuth failed: ${error}`);
    }

    // Exchange code for tokens
    const startTime = Date.now();
    const tokenResp = await platformFetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
        client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const errorText = await tokenResp.text();
      throw new Error(`Token exchange failed (${tokenResp.status}): ${errorText}`);
    }

    const tokenData = (await tokenResp.json()) as GoogleTokenResponse;
    const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;

    return finalizeLogin(
      tokenData.access_token,
      tokenData.refresh_token,
      startTime + expiresIn * 1000,
    );
  } catch (err) {
    localStorage.removeItem("lumi_pending_oauth");
    throw err;
  }
}

/**
 * Returns the current account from the database, or null if none exists.
 */
export async function getAccount(): Promise<AuthAccount | null> {
  const accounts = await db.auth.toArray();
  return accounts[0] ?? null;
}

/**
 * Removes all stored accounts (logout).
 */
export async function logout(): Promise<void> {
  await db.auth.clear();
}
