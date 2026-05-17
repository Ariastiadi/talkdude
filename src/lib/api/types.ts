// === Gemini API Request Types ===

export interface GeminiInlineData {
  mimeType: string;
  data: string; // base64-encoded
}

export interface GeminiFileData {
  mimeType: string;
  fileUri: string;
}

export interface GeminiContentPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: GeminiInlineData;
  fileData?: GeminiFileData;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    id?: string;
    response: unknown;
  };
  executableCode?: { language: string; code: string };
  codeExecutionResult?: { outcome: string; output: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiContentPart[];
}

export interface GeminiThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingConfig?: GeminiThinkingConfig;
  responseModalities?: string[]; // e.g. ["TEXT", "IMAGE"]
}

// === Tool Types ===

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export type GeminiTool =
  | { functionDeclarations: GeminiFunctionDeclaration[] }
  | { googleSearch: Record<string, never> }
  | { urlContext: Record<string, never> }
  | { codeExecution: Record<string, never> };

export interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
  systemInstruction?: {
    role?: string;
    parts: { text: string }[];
  };
  tools?: GeminiTool[];
}

// === Gemini API Response Types ===

export interface GeminiGroundingChunk {
  web?: { uri: string; title: string };
}

export interface GeminiGroundingSupport {
  segment?: { startIndex?: number; endIndex?: number; text?: string };
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
}

export interface GeminiGroundingMetadata {
  webSearchQueries?: string[];
  searchEntryPoint?: { renderedContent?: string };
  groundingChunks?: GeminiGroundingChunk[];
  groundingSupports?: GeminiGroundingSupport[];
}

export interface GeminiResponseCandidate {
  content: {
    role: string;
    parts: GeminiContentPart[];
  };
  finishReason?: string;
  groundingMetadata?: GeminiGroundingMetadata;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiApiResponse {
  candidates?: GeminiResponseCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

// === Model Definitions ===

export interface ModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsThinking: boolean;
  alwaysThinking?: boolean;
  defaultThinkingLevel?: string;
  thinkingLevels?: string[];
  supportsCodeExecution?: boolean;
  // When false, URL Context is not available; defaults to true when absent.
  supportsUrlContext?: boolean;
}

export const AVAILABLE_MODELS: ModelDefinition[] = [
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    contextWindow: 1048576,
    maxOutput: 65536,
    supportsThinking: true,
    // Default is "minimal" (no thinking) per API docs; user-selectable levels exclude minimal.
    defaultThinkingLevel: "high",
    thinkingLevels: ["low", "medium", "high"],
    supportsCodeExecution: true,
    supportsUrlContext: true,
  },
  {
    id: "gemma-4-26b-a4b-it",
    name: "Gemma 4 26B",
    contextWindow: 131072,
    maxOutput: 8192,
    supportsThinking: true,
    // Gemma 4 only supports minimal (no thinking) and high; user-selectable level is "high".
    defaultThinkingLevel: "high",
    thinkingLevels: ["high"],
    supportsCodeExecution: true,
    // Gemma 4 does not support URL Context.
    supportsUrlContext: false,
  },
  {
    id: "gemma-4-31b-it",
    name: "Gemma 4 31B",
    contextWindow: 131072,
    maxOutput: 8192,
    supportsThinking: true,
    defaultThinkingLevel: "high",
    thinkingLevels: ["high"],
    supportsCodeExecution: true,
    supportsUrlContext: false,
  },
];

export const DEFAULT_MODEL_ID = "gemini-3.1-flash-lite";

/**
 * Model used for generating conversation titles.
 * Uses the same model as the default chat model (Gemini 3.1 Flash Lite).
 */
export const TITLE_MODEL = "gemini-3.1-flash-lite";

/** Returns true when the model supports the Code Execution tool. */
export function modelSupportsCodeExecution(modelId: string): boolean {
  return AVAILABLE_MODELS.find((m) => m.id === modelId)?.supportsCodeExecution ?? false;
}

/** Returns true when the model supports the URL Context tool. */
export function modelSupportsUrlContext(modelId: string): boolean {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  // Default to true when the field is absent so unknown models are permissive.
  return model?.supportsUrlContext ?? true;
}
