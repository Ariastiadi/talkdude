import { GoogleGenAI, ThinkingLevel, HarmCategory, HarmBlockThreshold } from "@google/genai";
import type { GenerateContentConfig, Content, Part, Tool } from "@google/genai";
import { getApiKey } from "../auth/apikey";
import { SYSTEM_INSTRUCTION } from "../auth/constants";
import { streamLocal, sendLocal } from "./local";
import { installMobileFetch } from "../platform";
import { resolveModel, safetyOff, autoFallback, usableModelIds, modelLabel } from "../stores/settings";
import { AVAILABLE_MODELS } from "./types";
import { streamOpenAI, streamAnthropic, sendOpenAI, sendAnthropic } from "./providers";
import type {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiContentPart,
  GeminiTool,
  GeminiGroundingMetadata,
  GeminiInlineData,
} from "./types";

// === Tauri Fetch Monkey-Patch ===
// The @google/genai SDK does a live lookup of `globalThis.fetch` at call time
// inside ApiClient.apiCall, so replacing it once redirects all SDK HTTP
// traffic through Tauri's Rust client (plugin-http).
//
// Skipped on desktop: the plugin's ReadableStream pull() drives SSE via
// IPC round-trips. Desktop WebViews (WebKitGTK, WebView2) do not re-enter
// their event pump from a pending pull, so responses deadlock. Native fetch
// works at the network layer without IPC. Mobile requires the plugin because
// the WebView sandbox blocks external HTTPS.

async function ensureFetchPatched(): Promise<void> {
  // Routes external requests through plugin-http on mobile only (see platform.ts).
  await installMobileFetch();
}

// === SDK Client Management: One Instance Per API Key ===
// Creating a new instance on key change ensures subsequent calls use updated
// credentials. The old instance is discarded; GC handles cleanup.

let _client: GoogleGenAI | null = null;
let _clientKey = "";

async function getClient(): Promise<GoogleGenAI> {
  // Patch fetch before the SDK looks up globalThis.fetch.
  await ensureFetchPatched();

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("No API key configured. Please add your Gemini API key in Settings.");
  }

  if (!_client || _clientKey !== apiKey) {
    _client = new GoogleGenAI({ apiKey });
    _clientKey = apiKey;
  }
  return _client;
}

// === API Key Hint ===
// Short non-secret identifier derived from the API key so file uploads can be
// associated with the key that performed them. First 8 + last 4 chars tell keys
// apart without exposing the full key in stored message parts.

function apiKeyHint(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}${key.slice(-4)}`;
}

/**
 * Returns a short identifier for the current API key, or null if no key is set.
 * Used by callers to detect key changes and invalidate Files API references.
 */
export async function getCurrentApiKeyHint(): Promise<string | null> {
  const key = await getApiKey();
  return key ? apiKeyHint(key) : null;
}

// === ThinkingLevel Mapping ===
// Internal store uses lowercase strings; SDK enum uses uppercase. Map
// explicitly so the correct protobuf value is sent over the wire.

const THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

function toSdkThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  return THINKING_LEVEL_MAP[level] ?? ThinkingLevel.HIGH;
}

// === Type Conversion Helpers ===

/**
 * Converts our internal GeminiContent[] to the SDK's Content[].
 *
 * fileData parts are passed through as-is. The caller (buildContentsFromMessages
 * in chat.ts) is responsible for pre-filtering expired or key-mismatched
 * fileData parts before calling this function.
 *
 * Parts that carry no content after mapping are removed so the API never
 * rejects the request with an "empty part" error.
 */
function toSdkContents(contents: GeminiContent[]): Content[] {
  return contents
    .map((c) => ({
      role: c.role,
      parts: c.parts
        .map((p): Part | null => {
          if (p.executableCode) {
            return { executableCode: { language: p.executableCode.language as never, code: p.executableCode.code } };
          }
          if (p.codeExecutionResult) {
            // Outcome is stored as the enum string value.
            return { codeExecutionResult: { outcome: p.codeExecutionResult.outcome as never, output: p.codeExecutionResult.output } };
          }
          if (p.fileData) {
            return { fileData: { mimeType: p.fileData.mimeType, fileUri: p.fileData.fileUri } };
          }
          if (p.inlineData) {
            return { inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } };
          }
          if (p.functionCall) {
            return {
              functionCall: {
                name: p.functionCall.name,
                args: p.functionCall.args as Record<string, unknown>,
                id: p.functionCall.id,
              },
            };
          }
          if (p.functionResponse) {
            return {
              functionResponse: {
                name: p.functionResponse.name,
                id: p.functionResponse.id,
                response: p.functionResponse.response as Record<string, unknown>,
              },
            };
          }
          // Text and thought parts (thought signature sent back for multi-turn continuity).
          return {
            text: p.text ?? "",
            ...(p.thought !== undefined ? { thought: p.thought } : {}),
            ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
          };
        })
        .filter((p): p is Part => {
          if (p === null) return false;
          // Drop empty text parts that are not thought placeholders.
          if ("text" in p && !("thought" in p && p.thought)) {
            return (p.text ?? "").length > 0;
          }
          return true;
        }),
    }))
    .filter((c) => c.parts.length > 0);
}

/**
 * Maps our GeminiGenerationConfig + systemInstruction + tools to
 * the SDK's GenerateContentConfig.
 */
/** Options for a chat request. */
export interface ChatOptions {
  /** Use the given system instruction instead of talkdude's own persona (character chats). */
  replaceBase?: boolean;
}

function systemText(systemInstruction: string | undefined, opts?: ChatOptions): string {
  if (opts?.replaceBase && systemInstruction) return systemInstruction;
  return systemInstruction ? SYSTEM_INSTRUCTION + "\n\n" + systemInstruction : SYSTEM_INSTRUCTION;
}

function toSdkConfig(
  generationConfig: GeminiGenerationConfig | undefined,
  systemInstruction: string | undefined,
  signal?: AbortSignal,
  tools?: GeminiTool[],
  opts?: ChatOptions,
): GenerateContentConfig {
  const sysText = systemText(systemInstruction, opts);

  const cfg: GenerateContentConfig = {
    systemInstruction: sysText,
    ...(signal ? { abortSignal: signal } : {}),
  };

  if (generationConfig) {
    if (generationConfig.maxOutputTokens !== undefined) cfg.maxOutputTokens = generationConfig.maxOutputTokens;
    if (generationConfig.temperature !== undefined) cfg.temperature = generationConfig.temperature;
    if (generationConfig.topP !== undefined) cfg.topP = generationConfig.topP;
    if (generationConfig.topK !== undefined) cfg.topK = generationConfig.topK;
    if (generationConfig.responseModalities) cfg.responseModalities = generationConfig.responseModalities as string[];

    if (generationConfig.thinkingConfig) {
      const tc = generationConfig.thinkingConfig;
      cfg.thinkingConfig = {
        ...(tc.includeThoughts !== undefined ? { includeThoughts: tc.includeThoughts } : {}),
        ...(tc.thinkingBudget !== undefined ? { thinkingBudget: tc.thinkingBudget } : {}),
        ...(tc.thinkingLevel !== undefined
          ? { thinkingLevel: toSdkThinkingLevel(tc.thinkingLevel) }
          : {}),
      };
    }
  }

  if (tools && tools.length > 0) {
    // GeminiTool is structurally identical to the SDK's Tool interface.
    cfg.tools = tools as unknown as Tool[];
  }

  // Content filter preference ("Gemini content filter" in Settings). When the user
  // turns the filter off, every harm category is set to BLOCK_NONE. This is a
  // documented Gemini API parameter; the model's own policies still apply.
  if (safetyOff()) {
    cfg.safetySettings = [
      HarmCategory.HARM_CATEGORY_HARASSMENT,
      HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    ].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
  }

  return cfg;
}

// === Files API ===

/**
 * Uploads a file to the Gemini Files API and returns the URI, expiry
 * timestamp, and a key hint for later validity checks.
 *
 * The Files API stores files for 48 hours. The returned `expiresAt` is
 * derived from the API response's `expirationTime` field (ISO 8601) when
 * present, falling back to 48 hours from the current time.
 *
 * Throws if no API key is configured or if the upload fails.
 */
export async function uploadFile(
  file: File,
  mimeType: string,
  fileName: string,
): Promise<{ fileUri: string; expiresAt: number; apiKeyHint: string }> {
  const client = await getClient(); // also sets _clientKey
  const hint = apiKeyHint(_clientKey);

  const uploaded = await client.files.upload({
    file,
    config: { mimeType, displayName: fileName },
  });

  const fileUri = uploaded.uri;
  if (!fileUri) {
    throw new Error("File upload succeeded but no URI was returned by the API.");
  }

  // Use the API-provided expiry time; default to 48 hours if absent.
  const expiresAt = uploaded.expirationTime
    ? new Date(uploaded.expirationTime).getTime()
    : Date.now() + 48 * 60 * 60 * 1000;

  return { fileUri, expiresAt, apiKeyHint: hint };
}

// === Public Callback Types ===

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string, signature?: string) => void;
  onFunctionCall?: (call: { name: string; args: Record<string, unknown>; id?: string }) => void;
  onInlineData?: (data: GeminiInlineData) => void;
  onExecutableCode?: (block: { language: string; code: string }) => void;
  onCodeExecutionResult?: (result: { outcome: string; output: string }) => void;
  onGroundingMetadata?: (metadata: GeminiGroundingMetadata) => void;
  onUsage?: (usage: { promptTokens: number; outputTokens: number; totalTokens: number; thoughtsTokens?: number }) => void;
  onError?: (error: string) => void;
  onDone?: () => void;
}

// === Streaming Chat ===

/**
 * Returns the user-readable message for a given HTTP status code.
 * Extracted to avoid repeating the switch across multiple error parsing paths.
 */
function httpCodeToFriendlyMessage(code: number): string {
  switch (code) {
    case 400: return "The request was invalid. Check your message and try again.";
    case 401: return "Invalid API key. Please check your key in Settings.";
    case 403: return "Access denied. Your API key may not have permission to use this model.";
    case 404: return "The requested model was not found. Please select a different model.";
    case 429: return "Rate limit reached. Please wait a moment and try again.";
    case 500: return "The Gemini API encountered an internal error. Please try again.";
    case 503: return "The Gemini API is temporarily unavailable. Please try again in a moment.";
    default:
      if (code >= 500) return "The Gemini API is experiencing issues. Please try again.";
      return `Request failed (${code}). Please try again.`;
  }
}

/**
 * Maps a raw SDK or network error to a user-readable message.
 *
 * The SDK produces errors in three distinct formats:
 * - ApiError from streaming: message = "got status: STATUSNAME. {...}" (name, not number)
 *   and .status = numeric HTTP code. The regex path does not match; .status is required.
 * - ApiError from non-streaming: message = JSON.stringify({error:{code,message,status}})
 *   and .status = numeric HTTP code. Both .status and JSON parsing handle it.
 * - Network or programmer errors: plain string messages, handled by the final branches.
 */
function friendlyApiError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;

    // ApiError carries the numeric code on .status regardless of message format.
    const apiStatus = (err as { status?: unknown }).status;
    if (typeof apiStatus === "number" && apiStatus >= 400) {
      return httpCodeToFriendlyMessage(apiStatus);
    }

    // Some SDK paths embed the numeric code directly in the message.
    const statusMatch = msg.match(/got status: (\d+)/);
    if (statusMatch) {
      return httpCodeToFriendlyMessage(parseInt(statusMatch[1], 10));
    }

    // Non-streaming path serializes the error body as JSON.
    try {
      const parsed = JSON.parse(msg) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === "number") {
        return httpCodeToFriendlyMessage(parsed.error.code);
      }
    } catch { /* message is not JSON */ }

    if (msg.includes("No API key")) return msg;
    if (
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError") ||
      msg.toLowerCase().includes("network")
    ) {
      return "Network error. Please check your internet connection and try again.";
    }
    return msg;
  }
  return String(err);
}

// === Automatic Fallback ===
// talkdude itself has no message limit. Limits come from each provider's API
// (free-tier rate limits / daily quota). When the chosen model answers with a
// rate-limit or overload error before producing any text, the request is
// retried on the next usable model so the conversation keeps going.

function isRateLimitError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("rate limit") || m.includes("quota") || m.includes("temporarily unavailable") ||
    m.includes("is having problems") || m.includes("(429)") || m.includes("(503)");
}

export async function streamChat(
  model: string,
  contents: GeminiContent[],
  generationConfig: GeminiGenerationConfig | undefined,
  systemInstruction: string | undefined,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: GeminiTool[],
  opts?: ChatOptions,
): Promise<void> {
  const hasGeminiKey = !!(await getApiKey());
  const order = usableModelIds(AVAILABLE_MODELS.map((m) => m.id), hasGeminiKey);
  // Start with the chosen model, then continue in configured order.
  let candidates = [model, ...order.filter((m) => m !== model)];
  // A Gemini model without a Gemini key can never answer; skip straight to a usable provider.
  if (!hasGeminiKey && !model.includes("::") && order.length > 0) candidates = order;
  const maxAttempts = autoFallback() ? Math.min(candidates.length, 6) : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = candidates[attempt];
    let produced = false;
    let pendingError: string | null = null;
    const isLast = attempt === maxAttempts - 1;

    await streamChatOnce(
      current,
      contents,
      // Thinking config / tools are Gemini-model specific; only keep them for the original model.
      attempt === 0 ? generationConfig : undefined,
      systemInstruction,
      {
        ...callbacks,
        onText: (t) => { produced = true; callbacks.onText?.(t); },
        onThinking: (t, sig) => { produced = true; callbacks.onThinking?.(t, sig); },
        onError: (e) => { pendingError = e; },
        onDone: () => { /* handled below */ },
      },
      signal,
      attempt === 0 ? tools : undefined,
      opts,
    );

    if (signal?.aborted) break;
    const err: string | null = pendingError;
    if (err === null) { callbacks.onDone?.(); return; }
    const canRetry = !produced && !isLast && isRateLimitError(err);
    if (!canRetry) {
      callbacks.onError?.(err);
      callbacks.onDone?.();
      return;
    }
    callbacks.onText?.(`_${modelLabel(current)} hit its limit, continuing with ${modelLabel(candidates[attempt + 1])}._\n\n`);
  }
  callbacks.onDone?.();
}

async function streamChatOnce(
  model: string,
  contents: GeminiContent[],
  generationConfig: GeminiGenerationConfig | undefined,
  systemInstruction: string | undefined,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: GeminiTool[],
  opts?: ChatOptions,
): Promise<void> {
  // Non-Gemini providers (OpenAI-compatible, Anthropic) are routed here.
  const resolved = resolveModel(model);
  if (resolved.provider) {
    const sys = systemText(systemInstruction, opts);
    if (resolved.provider.type === "local") {
      await streamLocal(resolved.model, contents, sys, callbacks, signal, generationConfig?.maxOutputTokens);
    } else if (resolved.provider.type === "anthropic") {
      await streamAnthropic(resolved.provider, resolved.model, contents, sys, callbacks, signal);
    } else {
      await streamOpenAI(resolved.provider, resolved.model, contents, sys, callbacks, signal, generationConfig?.maxOutputTokens);
    }
    return;
  }
  if (model.includes("::") && !resolved.provider) {
    callbacks.onError?.("The provider for this model was removed. Pick another model in Settings.");
    callbacks.onDone?.();
    return;
  }

  let client: GoogleGenAI;
  try {
    client = await getClient();
  } catch (err) {
    callbacks.onError?.(friendlyApiError(err));
    callbacks.onDone?.();
    return;
  }

  const sdkContents = toSdkContents(contents);
  // abortSignal is passed through to fetch RequestInit.signal.
  const sdkConfig = toSdkConfig(generationConfig, systemInstruction, signal, tools, opts);

  try {
    const stream = client.models.generateContentStream({
      model,
      contents: sdkContents,
      config: sdkConfig,
    });

    for await (const chunk of await stream) {
      const parts: Part[] = chunk.candidates?.[0]?.content?.parts ?? [];

      for (const part of parts) {
        if (part.thought && part.text) {
          callbacks.onThinking?.(part.text, part.thoughtSignature);
        } else if (part.executableCode) {
          callbacks.onExecutableCode?.({
            language: part.executableCode.language ?? "",
            code: part.executableCode.code ?? "",
          });
        } else if (part.codeExecutionResult) {
          callbacks.onCodeExecutionResult?.({
            outcome: part.codeExecutionResult.outcome ?? "OUTCOME_UNSPECIFIED",
            output: part.codeExecutionResult.output ?? "",
          });
        } else if (part.text) {
          callbacks.onText?.(part.text);
        } else if (part.inlineData?.data) {
          callbacks.onInlineData?.({
            mimeType: part.inlineData.mimeType ?? "",
            data: part.inlineData.data,
          });
        } else if (part.functionCall) {
          callbacks.onFunctionCall?.({
            name: part.functionCall.name ?? "",
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            id: (part.functionCall as { id?: string }).id,
          });
        }
      }

      const gm = chunk.candidates?.[0]?.groundingMetadata as GeminiGroundingMetadata | undefined;
      if (gm) callbacks.onGroundingMetadata?.(gm);

      const usage = chunk.usageMetadata;
      if (usage) {
        callbacks.onUsage?.({
          promptTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
          thoughtsTokens: (usage as { thoughtsTokenCount?: number }).thoughtsTokenCount,
        });
      }
    }
  } catch (err) {
    // Treat SDK AbortError as a clean stop, not an error.
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError") ||
      signal?.aborted;
    const isIncompleteSegment =
      err instanceof Error && err.message.includes("Incomplete JSON segment");
    if (!isAbort && !isIncompleteSegment) {
      callbacks.onError?.(friendlyApiError(err));
    }
  } finally {
    callbacks.onDone?.();
  }
}

// === Non-Streaming Chat ===

export async function sendChat(
  model: string,
  contents: GeminiContent[],
  generationConfig?: GeminiGenerationConfig,
  systemInstruction?: string,
  opts?: ChatOptions,
): Promise<{
  parts: GeminiContentPart[];
  usage?: { promptTokens: number; outputTokens: number; totalTokens: number };
}> {
  const resolved = resolveModel(model);
  if (resolved.provider) {
    const sys = systemText(systemInstruction, opts);
    const text = resolved.provider.type === "local"
      ? await sendLocal(resolved.model, contents, sys, generationConfig?.maxOutputTokens)
      : resolved.provider.type === "anthropic"
      ? await sendAnthropic(resolved.provider, resolved.model, contents, sys, generationConfig?.maxOutputTokens)
      : await sendOpenAI(resolved.provider, resolved.model, contents, sys, generationConfig?.maxOutputTokens);
    return { parts: [{ text }] };
  }

  const client = await getClient();

  const sdkContents = toSdkContents(contents);
  const sdkConfig = toSdkConfig(generationConfig, systemInstruction, undefined, undefined, opts);

  const response = await client.models.generateContent({
    model,
    contents: sdkContents,
    config: sdkConfig,
  });

  const parts: GeminiContentPart[] = (response.candidates?.[0]?.content?.parts ?? []).map(
    (p): GeminiContentPart => ({
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.thought !== undefined ? { thought: p.thought } : {}),
      ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      ...(p.inlineData?.data
        ? { inlineData: { mimeType: p.inlineData.mimeType ?? "", data: p.inlineData.data } }
        : {}),
    }),
  );

  const usage = response.usageMetadata;
  return {
    parts,
    usage: usage
      ? {
          promptTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        }
      : undefined,
  };
}
