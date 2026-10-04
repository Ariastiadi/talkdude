/**
 * Non-Gemini providers: OpenAI-compatible (OpenAI, Groq, OpenRouter, DeepSeek,
 * Mistral, Ollama, ...) and Anthropic (Claude).
 *
 * Both are driven through the same StreamCallbacks interface used by the
 * Gemini module so the chat store does not care which backend answers.
 */
import type { Provider } from "../stores/settings";
import type { GeminiContent, GeminiContentPart } from "./types";
import type { StreamCallbacks } from "./gemini";
import { isTauri, isMobile } from "../platform";

// === Fetch Selection ===
// Mobile WebViews block external HTTPS, so the Tauri HTTP plugin is required.
// Desktop uses the native fetch so SSE streaming works (the plugin's stream
// pull deadlocks the WebView event loop on desktop).

async function pickFetch(): Promise<typeof globalThis.fetch> {
  if (isTauri() && isMobile()) {
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return tauriFetch as unknown as typeof globalThis.fetch;
    } catch { /* fall through */ }
  }
  return globalThis.fetch.bind(globalThis);
}

// === Message Conversion ===

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentPart[];
}

function partsToText(parts: GeminiContentPart[]): string {
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!)
    .join("");
}

function toOpenAIMessages(contents: GeminiContent[], systemInstruction: string): OpenAIMessage[] {
  const msgs: OpenAIMessage[] = [{ role: "system", content: systemInstruction }];
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    const images = c.parts.filter((p) => p.inlineData && p.inlineData.mimeType.startsWith("image/"));
    const text = partsToText(c.parts);
    if (role === "user" && images.length > 0) {
      const content: OpenAIContentPart[] = [];
      if (text) content.push({ type: "text", text });
      for (const img of images) {
        content.push({ type: "image_url", image_url: { url: `data:${img.inlineData!.mimeType};base64,${img.inlineData!.data}` } });
      }
      msgs.push({ role, content });
    } else if (text) {
      msgs.push({ role, content: text });
    }
  }
  return msgs;
}

type AnthropicContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentPart[];
}

function toAnthropicMessages(contents: GeminiContent[]): AnthropicMessage[] {
  const msgs: AnthropicMessage[] = [];
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    const content: AnthropicContentPart[] = [];
    const text = partsToText(c.parts);
    if (text) content.push({ type: "text", text });
    if (role === "user") {
      for (const p of c.parts) {
        if (p.inlineData && p.inlineData.mimeType.startsWith("image/")) {
          content.push({ type: "image", source: { type: "base64", media_type: p.inlineData.mimeType, data: p.inlineData.data } });
        }
      }
    }
    if (content.length === 0) continue;
    // Anthropic requires strict alternation; merge consecutive same-role turns.
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else msgs.push({ role, content });
  }
  if (msgs.length > 0 && msgs[0].role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "..." }] });
  return msgs;
}

// === Errors ===

function friendlyHttpError(status: number, body: string, providerName: string): string {
  let detail = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const e = j.error;
    detail = typeof e === "string" ? e : e?.message ?? j.message ?? "";
  } catch { detail = body.slice(0, 200); }
  switch (status) {
    case 401: return `${providerName}: invalid API key. Check it in Settings.`;
    case 403: return `${providerName}: access denied. ${detail}`;
    case 404: return `${providerName}: model not found. ${detail}`;
    case 429: return `${providerName}: rate limit reached. Try again in a moment.`;
    default:
      if (status >= 500) return `${providerName} is having problems (${status}). Try again.`;
      return `${providerName}: request failed (${status}). ${detail}`;
  }
}

// === SSE Reader ===

async function readSse(
  resp: Response,
  onEvent: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // No streaming body available; treat the whole payload as one event.
    onEvent(await resp.text());
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } return; }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) onEvent(data);
    }
  }
  if (buffer.trim().startsWith("data:")) onEvent(buffer.trim().slice(5).trim());
}

// === OpenAI-compatible ===

export async function streamOpenAI(
  provider: Provider,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<void> {
  const f = await pickFetch();
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(contents, systemInstruction),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (maxTokens) body.max_tokens = maxTokens;

  let resp: Response;
  try {
    resp = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.baseUrl.includes("openrouter.ai") ? { "HTTP-Referer": "https://github.com/Ariastiadi/talkdude", "X-Title": "talkdude" } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (!signal?.aborted) callbacks.onError?.(`Could not connect to ${provider.name}. Check your internet connection or the Base URL.`);
    callbacks.onDone?.();
    return;
  }

  if (!resp.ok) {
    callbacks.onError?.(friendlyHttpError(resp.status, await resp.text().catch(() => ""), provider.name));
    callbacks.onDone?.();
    return;
  }

  try {
    await readSse(resp, (data) => {
      if (data === "[DONE]") return;
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      const choice = j.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        // DeepSeek / OpenRouter reasoning fields.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) callbacks.onThinking?.(reasoning);
        if (typeof delta.content === "string" && delta.content) callbacks.onText?.(delta.content);
      }
      if (j.usage) {
        callbacks.onUsage?.({
          promptTokens: j.usage.prompt_tokens ?? 0,
          outputTokens: j.usage.completion_tokens ?? 0,
          totalTokens: j.usage.total_tokens ?? 0,
        });
      }
    }, signal);
  } catch (err) {
    if (!signal?.aborted) callbacks.onError?.(err instanceof Error ? err.message : String(err));
  } finally {
    callbacks.onDone?.();
  }
}

export async function sendOpenAI(
  provider: Provider,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  maxTokens?: number,
): Promise<string> {
  const f = await pickFetch();
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const resp = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model, messages: toOpenAIMessages(contents, systemInstruction), ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
  });
  if (!resp.ok) throw new Error(friendlyHttpError(resp.status, await resp.text().catch(() => ""), provider.name));
  const j = await resp.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// === Anthropic ===

const ANTHROPIC_VERSION = "2023-06-01";

function anthropicHeaders(provider: Provider): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": provider.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    // Required for direct calls from a WebView / browser context.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export async function streamAnthropic(
  provider: Provider,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  maxTokens = 8192,
): Promise<void> {
  const f = await pickFetch();
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/messages`;
  let resp: Response;
  try {
    resp = await f(url, {
      method: "POST",
      headers: anthropicHeaders(provider),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemInstruction,
        messages: toAnthropicMessages(contents),
        stream: true,
      }),
      signal,
    });
  } catch {
    if (!signal?.aborted) callbacks.onError?.(`Could not connect to ${provider.name}. Check your internet connection or the Base URL.`);
    callbacks.onDone?.();
    return;
  }

  if (!resp.ok) {
    callbacks.onError?.(friendlyHttpError(resp.status, await resp.text().catch(() => ""), provider.name));
    callbacks.onDone?.();
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    await readSse(resp, (data) => {
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      switch (j.type) {
        case "message_start":
          inputTokens = j.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_delta":
          if (j.delta?.type === "text_delta" && j.delta.text) callbacks.onText?.(j.delta.text);
          else if (j.delta?.type === "thinking_delta" && j.delta.thinking) callbacks.onThinking?.(j.delta.thinking);
          break;
        case "message_delta":
          outputTokens = j.usage?.output_tokens ?? outputTokens;
          break;
        case "error":
          callbacks.onError?.(j.error?.message ?? "Anthropic API error");
          break;
      }
    }, signal);
    if (inputTokens || outputTokens) {
      callbacks.onUsage?.({ promptTokens: inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
    }
  } catch (err) {
    if (!signal?.aborted) callbacks.onError?.(err instanceof Error ? err.message : String(err));
  } finally {
    callbacks.onDone?.();
  }
}

export async function sendAnthropic(
  provider: Provider,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  maxTokens = 256,
): Promise<string> {
  const f = await pickFetch();
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/messages`;
  const resp = await f(url, {
    method: "POST",
    headers: anthropicHeaders(provider),
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemInstruction, messages: toAnthropicMessages(contents) }),
  });
  if (!resp.ok) throw new Error(friendlyHttpError(resp.status, await resp.text().catch(() => ""), provider.name));
  const j = await resp.json();
  return (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

// === Connection Test ===

/** Returns null when the provider answers, otherwise an error string. */
export async function testProvider(provider: Provider): Promise<string | null> {
  try {
    const f = await pickFetch();
    const base = provider.baseUrl.replace(/\/+$/, "");
    const resp = provider.type === "anthropic"
      ? await f(`${base}/models?limit=1`, { headers: anthropicHeaders(provider) })
      : await f(`${base}/models`, { headers: { Authorization: `Bearer ${provider.apiKey}` } });
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) return "The server rejected the API key.";
    if (resp.status === 404) return null; // some servers have no /models; key may still work
    return `Server answered ${resp.status}.`;
  } catch {
    return "Could not connect. Check the Base URL and your internet connection.";
  }
}

// === Model List ===

/**
 * Fetches the model ids a provider offers. With freeOnly (OpenRouter), only
 * models priced at zero / tagged ":free" are returned.
 */
export async function fetchModels(provider: Provider, freeOnly = false): Promise<string[]> {
  const f = await pickFetch();
  const base = provider.baseUrl.replace(/\/+$/, "");
  const resp = provider.type === "anthropic"
    ? await f(`${base}/models?limit=100`, { headers: anthropicHeaders(provider) })
    : await f(`${base}/models`, { headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {} });
  if (!resp.ok) throw new Error(friendlyHttpError(resp.status, await resp.text().catch(() => ""), provider.name));
  const j = await resp.json();
  const rows: any[] = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  let list = rows.filter((m) => typeof m?.id === "string");
  if (freeOnly) {
    list = list.filter((m) =>
      m.id.endsWith(":free") ||
      (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0));
  }
  return list.map((m) => m.id as string).sort();
}
