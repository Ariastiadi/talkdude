import { createSignal, createMemo, batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { db, type Conversation, type Message, type MessagePart } from "../db";
import { streamChat, sendChat, uploadFile, getCurrentApiKeyHint, type StreamCallbacks } from "../api/gemini";
import type {
  GeminiContent,
  GeminiContentPart,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiGroundingMetadata,
  GeminiInlineData,
} from "../api/types";
import { DEFAULT_MODEL_ID, TITLE_MODEL, modelSupportsCodeExecution, modelSupportsUrlContext } from "../api/types";
import { getActiveSystemInstruction } from "./custom-instructions";
import { thinkingEnabled, setThinkingEnabled, thinkingLevel, setThinkingLevel, usesLevelBasedThinking, modelSupportsThinking, modelAlwaysThinking, clampThinkingLevelForModel } from "./thinking";

// === Helpers ===

/** Deep-clone a store value into a plain object safe for IndexedDB's structured clone. */
function toPlain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// === Attachment Types ===

export interface FileAttachment {
  id: string;
  file: File;
  mimeType: string;
  preview?: string;        // data URL for image thumbnails
  uploading: boolean;      // true while the Files API upload is in progress
  fileUri?: string;        // Files API URI, set after a successful upload
  expiresAt?: number;      // Unix timestamp (ms) when the uploaded file expires
  apiKeyHint?: string;     // key identifier used at upload time for change detection
  uploadError?: string;    // error message if the upload failed or the file is invalid
}

// === State ===

const [conversations, setConversations] = createStore<Conversation[]>([]);
const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
const [messages, setMessages] = createStore<Message[]>([]);
const [selectedModel, setSelectedModel] = createSignal(DEFAULT_MODEL_ID);

// Per-conversation streaming: which conversations are currently streaming
const [streamingConvIds, setStreamingConvIds] = createStore<Record<string, boolean>>({});

// UI streaming signals: only reflect the currently viewed conversation's stream
const [streamingText, setStreamingText] = createSignal("");
const [streamingThinking, setStreamingThinking] = createSignal("");
const [streamingImages, setStreamingImages] = createStore<GeminiInlineData[]>([]);
const [streamingCodeBlocks, setStreamingCodeBlocks] = createStore<{ language: string; code: string }[]>([]);
const [streamingCodeResults, setStreamingCodeResults] = createStore<{ outcome: string; output: string }[]>([]);
const [chatError, setChatError] = createSignal<string | null>(null);

// Tool toggles
const [searchEnabled, setSearchEnabled] = createSignal(false);
const [urlContextEnabled, setUrlContextEnabled] = createSignal(false);
const [codeExecutionEnabled, setCodeExecutionEnabled] = createSignal(false);

// File attachments pending send
const [pendingAttachments, setPendingAttachments] = createStore<FileAttachment[]>([]);

// Error surfaced at the input area when a file upload fails (separate from chatError).
const [fileUploadError, setFileUploadError] = createSignal<string | null>(null);

// Error recovery: restore user input on stream failure
const [recoveryText, setRecoveryText] = createSignal<string | null>(null);
const [recoveryAttachments, setRecoveryAttachments] = createStore<FileAttachment[]>([]);

// Branch navigation state: branchGroupId → { total, activeIndex }
const [branchState, setBranchState] = createStore<Record<string, { total: number; activeIndex: number }>>({});

// Reactive branch context for active streams: convId → branchCtx
const [streamingBranchCtx, setStreamingBranchCtx] = createStore<Record<string, { branchGroupId: string; branchIndex: number } | undefined>>({});

// Background stream buffers keyed by conversationId
const backgroundStreams = new Map<string, {
  abortController: AbortController;
  fullText: string;
  fullThinking: string;
  branchCtx?: { branchGroupId: string; branchIndex: number };
}>();

// Messages completed while selectConversation's DB read was in-flight.
// Reconciled after setMessages so they aren't dropped by the stale snapshot.
const pendingCompletedMessages = new Map<string, Message>();

// Messages completed for an off-screen branch, keyed by groupId:index.
// navigateBranch reconciles against this after loading the target snapshot.
const pendingCompletedBranchMessages = new Map<string, Message>();

export {
  conversations,
  activeConversationId,
  messages,
  selectedModel,
  setSelectedModel,
  streamingConvIds,
  streamingText,
  streamingThinking,
  streamingImages,
  streamingCodeBlocks,
  streamingCodeResults,
  chatError,
  searchEnabled,
  setSearchEnabled,
  urlContextEnabled,
  setUrlContextEnabled,
  codeExecutionEnabled,
  setCodeExecutionEnabled,
  fileUploadError,
  setFileUploadError,
  pendingAttachments,
  branchState,
  recoveryText,
  recoveryAttachments,
  setRecoveryText,
  setRecoveryAttachments,
};

// === Derived ===

export const activeConversation = createMemo(() => {
  const id = activeConversationId();
  return conversations.find((c) => c.id === id) ?? null;
});

/** True when any pending attachment is still uploading to the Files API. */
export const hasPendingUploads = createMemo(() =>
  pendingAttachments.some((a) => a.uploading),
);

/** Whether the currently viewed conversation is streaming */
export const isStreaming = createMemo(() => {
  const id = activeConversationId();
  return id ? !!streamingConvIds[id] : false;
});

/** Whether we are actively viewing a stream (conversation + branch match) */
export const isViewingActiveStream = createMemo(() => {
  const convId = activeConversationId();
  if (!convId || !streamingConvIds[convId]) return false;
  const ctx = streamingBranchCtx[convId];
  if (!ctx) return true; // no branch context = visible for this conv
  const current = branchState[ctx.branchGroupId];
  return current?.activeIndex === ctx.branchIndex;
});

// === File Attachment Helpers ===

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Maps a file upload failure to a user-readable message.
 * Upload errors need different phrasing than streaming errors because
 * the user needs to know they can retry by re-selecting the file.
 */
function friendlyUploadError(err: unknown): string {
  if (!(err instanceof Error)) return "Upload failed. Please try the file again.";
  const msg = err.message;
  if (msg.includes("No API key")) return msg;
  const statusMatch = msg.match(/got status: (\d+)/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    switch (code) {
      case 400: return "File type or size is not supported. Please try a different file.";
      case 401: return "Invalid API key. Please check your key in Settings.";
      case 403: return "Access denied. Your API key may not have permission to upload files.";
      case 429: return "Upload rate limit reached. Please wait a moment and try again.";
      case 500:
      case 503: return "The Gemini API is temporarily unavailable. Please try again.";
      default: return `Upload failed (${code}). Please try the file again.`;
    }
  }
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.toLowerCase().includes("network")) {
    return "Network error during upload. Check your connection and try again.";
  }
  return "Upload failed. Please try the file again.";
}

/**
 * Restores a saved set of attachments directly into the pending attachment
 * list without triggering re-uploads. Used during error recovery so files
 * that were already successfully uploaded retain their Files API URI.
 */
export function restoreAttachments(atts: FileAttachment[]): void {
  setPendingAttachments([...atts]);
}

/**
 * Adds a file to the pending attachments list and immediately begins
 * uploading it to the Files API. The attachment appears in the UI straight
 * away with `uploading: true`; on failure the attachment is removed and
 * `fileUploadError` is set with a friendly message.
 */
export async function addAttachment(file: File): Promise<void> {
  setFileUploadError(null);
  const mimeType = file.type || "application/octet-stream";
  const isImage = mimeType.startsWith("image/");

  // Generate thumbnail before upload so the UI shows a spinner immediately.
  let preview: string | undefined;
  if (isImage) {
    preview = await readFileAsDataUrl(file);
  }

  const id = crypto.randomUUID();
  const attachment: FileAttachment = {
    id,
    file,
    mimeType,
    preview,
    uploading: true,
  };
  setPendingAttachments(produce((draft) => draft.push(attachment)));

  // Upload in the background; remove the entry on failure.
  try {
    const result = await uploadFile(file, mimeType, file.name);
    setPendingAttachments(produce((draft) => {
      const idx = draft.findIndex((a) => a.id === id);
      if (idx !== -1) {
        draft[idx].uploading = false;
        draft[idx].fileUri = result.fileUri;
        draft[idx].expiresAt = result.expiresAt;
        draft[idx].apiKeyHint = result.apiKeyHint;
      }
    }));
  } catch (err) {
    // Remove failed attachments so they don't block sending.
    setPendingAttachments(produce((draft) => {
      const idx = draft.findIndex((a) => a.id === id);
      if (idx !== -1) draft.splice(idx, 1);
    }));
    setFileUploadError(friendlyUploadError(err));
  }
}

export function removeAttachment(id: string): void {
  setPendingAttachments(produce((draft) => {
    const idx = draft.findIndex((a) => a.id === id);
    if (idx !== -1) draft.splice(idx, 1);
  }));
}

export function clearAttachments(): void {
  setPendingAttachments([]);
}

/**
 * Populates pending attachments from existing message parts (for edit mode).
 *
 * For `fileData` parts: creates a FileAttachment stub using the stored URI.
 * If the file is already expired it is marked with `uploadError` so the UI
 * can show the error state. The user can remove the attachment and re-attach
 * the file to get a fresh upload.
 *
 * `inlineData` parts are not restored as editable attachments. User messages
 * no longer carry `inlineData` after the v5 DB migration. Model messages carry
 * `inlineData` for generated images but are never passed to this function.
 */
export function loadAttachmentsFromParts(parts: MessagePart[]): void {
  const now = Date.now();
  const atts: FileAttachment[] = [];
  for (const part of parts) {
    if (part.type === "fileData") {
      const isImage = part.mimeType.startsWith("image/");
      const expired = part.expiresAt <= now;
      atts.push({
        id: crypto.randomUUID(),
        // Stub File with no bytes; actual content lives in the Files API.
        file: new File([], part.fileName, { type: part.mimeType }),
        mimeType: part.mimeType,
        preview: isImage ? part.preview : undefined,
        uploading: false,
        fileUri: part.fileUri,
        expiresAt: part.expiresAt,
        apiKeyHint: part.apiKeyHint,
        uploadError: expired ? "File has expired. Please re-attach to include it." : undefined,
      });
    }
  }
  setPendingAttachments(atts);
}

// === Actions ===

export async function loadConversations(): Promise<void> {
  const all = await db.conversations.orderBy("updatedAt").reverse().toArray();
  setConversations(all);
}

export async function selectConversation(id: string | null): Promise<void> {
  // Save current settings to the outgoing conversation
  const oldId = activeConversationId();
  if (oldId) {
    await db.conversations.update(oldId, {
      model: selectedModel(),
      searchEnabled: searchEnabled(),
      urlContextEnabled: urlContextEnabled(),
      thinkingEnabled: thinkingEnabled(),
      thinkingLevel: thinkingLevel(),
      codeExecutionEnabled: codeExecutionEnabled(),
    });
  }

  setActiveConversationId(id);
  setChatError(null);
  setFileUploadError(null);

  if (id) {
    // Restore settings from the incoming conversation
    const conv = await db.conversations.get(id);
    if (conv) {
      setSelectedModel(conv.model);
      clampThinkingLevelForModel(conv.model);
      setSearchEnabled(conv.searchEnabled ?? false);
      setUrlContextEnabled(conv.urlContextEnabled ?? false);
      setCodeExecutionEnabled(conv.codeExecutionEnabled ?? false);
      // Disable URL context if the restored model does not support it.
      clampUrlContextForModel(conv.model);
      if (conv.thinkingEnabled !== undefined) setThinkingEnabled(conv.thinkingEnabled);
      if (conv.thinkingLevel !== undefined) setThinkingLevel(conv.thinkingLevel as "low" | "medium" | "high");
    }

    const msgs = await db.messages.where("conversationId").equals(id).sortBy("createdAt");

    // User may have navigated away while the DB read was in-flight.
    if (activeConversationId() !== id) return;

    setMessages(msgs);

    // A message completed during the DB read won't be in msgs. Append it so it
    // isn't dropped from the UI.
    const pending = pendingCompletedMessages.get(id);
    pendingCompletedMessages.delete(id);
    if (pending && !msgs.some((m) => m.id === pending.id)) {
      setMessages(produce((draft) => draft.push(pending)));
    }

    // Load branch state first so we can check stream branch context
    await loadBranchState(id);

    // Restore streaming UI only if the stream's branch matches the current view
    const bg = backgroundStreams.get(id);
    if (bg) {
      const ctx = bg.branchCtx;
      const branchMatches = !ctx || branchState[ctx.branchGroupId]?.activeIndex === ctx.branchIndex;
      if (branchMatches) {
        setStreamingText(bg.fullText);
        setStreamingThinking(bg.fullThinking);
      } else {
        setStreamingText("");
        setStreamingThinking("");
      }
    } else {
      setStreamingText("");
      setStreamingThinking("");
    }
  } else {
    setMessages([]);
    setStreamingText("");
    setStreamingThinking("");
  }
  setStreamingImages([]);
  setStreamingCodeBlocks([]);
  setStreamingCodeResults([]);
}

export async function createConversation(title?: string): Promise<string> {
  const now = Date.now();
  const conv: Conversation = {
    id: crypto.randomUUID(),
    title: title || "New Chat",
    model: selectedModel(),
    searchEnabled: searchEnabled(),
    urlContextEnabled: urlContextEnabled(),
    thinkingEnabled: thinkingEnabled(),
    thinkingLevel: thinkingLevel(),
    codeExecutionEnabled: codeExecutionEnabled(),
    createdAt: now,
    updatedAt: now,
  };
  await db.conversations.put(conv);
  setConversations(produce((draft) => draft.unshift(conv)));
  await selectConversation(conv.id);
  return conv.id;
}

export async function deleteConversation(id: string): Promise<void> {
  // Stop any active stream for this conversation
  const bg = backgroundStreams.get(id);
  if (bg) {
    bg.abortController.abort();
    backgroundStreams.delete(id);
    setStreamingConvIds(produce((d) => { delete d[id]; }));
    setStreamingBranchCtx(produce((d) => { delete d[id]; }));
  }
  pendingCompletedMessages.delete(id);
  for (const [key, msg] of pendingCompletedBranchMessages) {
    if (msg.conversationId === id) pendingCompletedBranchMessages.delete(key);
  }

  await db.conversations.delete(id);
  await db.messages.where("conversationId").equals(id).delete();
  await db.thoughtSignatures.where("conversationId").equals(id).delete();
  await db.messageBranches.where("conversationId").equals(id).delete();
  setConversations(produce((draft) => {
    const idx = draft.findIndex((c) => c.id === id);
    if (idx !== -1) draft.splice(idx, 1);
  }));
  if (activeConversationId() === id) {
    await selectConversation(null);
  }
}

// === Conversation Management: Rename, Pin, Archive ===

export async function renameConversation(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  await db.conversations.update(id, { title: trimmed, updatedAt: Date.now() });
  setConversations(produce((draft) => {
    const conv = draft.find((c) => c.id === id);
    if (conv) { conv.title = trimmed; conv.updatedAt = Date.now(); }
  }));
}

export async function togglePinConversation(id: string): Promise<void> {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  const pinned = conv.pinned ? 0 : Date.now();
  await db.conversations.update(id, { pinned });
  setConversations(produce((draft) => {
    const c = draft.find((c) => c.id === id);
    if (c) c.pinned = pinned;
  }));
}

export async function toggleArchiveConversation(id: string): Promise<void> {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  const archived = !conv.archived;
  // When archiving, also unpin to avoid pinned+archived conflict
  const updates: Partial<Conversation> = { archived };
  if (archived && conv.pinned) updates.pinned = 0;
  await db.conversations.update(id, updates);
  setConversations(produce((draft) => {
    const c = draft.find((c) => c.id === id);
    if (c) {
      c.archived = archived;
      if (archived && c.pinned) c.pinned = 0;
    }
  }));
  if (archived && activeConversationId() === id) {
    await selectConversation(null);
  }
}

// === Batch Conversation Operations ===

export async function deleteConversations(ids: string[]): Promise<void> {
  for (const id of ids) {
    const bg = backgroundStreams.get(id);
    if (bg) {
      bg.abortController.abort();
      backgroundStreams.delete(id);
      setStreamingConvIds(produce((d) => { delete d[id]; }));
      setStreamingBranchCtx(produce((d) => { delete d[id]; }));
    }
    pendingCompletedMessages.delete(id);
    for (const [key, msg] of pendingCompletedBranchMessages) {
      if (msg.conversationId === id) pendingCompletedBranchMessages.delete(key);
    }
    await db.messages.where("conversationId").equals(id).delete();
    await db.thoughtSignatures.where("conversationId").equals(id).delete();
    await db.messageBranches.where("conversationId").equals(id).delete();
  }
  await db.conversations.bulkDelete(ids);
  const idSet = new Set(ids);
  setConversations(produce((draft) => {
    for (let i = draft.length - 1; i >= 0; i--) {
      if (idSet.has(draft[i].id)) draft.splice(i, 1);
    }
  }));
  if (activeConversationId() && idSet.has(activeConversationId()!)) {
    await selectConversation(null);
  }
}

export async function pinConversations(ids: string[]): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    await db.conversations.update(id, { pinned: now });
  }
  const idSet = new Set(ids);
  setConversations(produce((draft) => {
    for (const c of draft) {
      if (idSet.has(c.id)) c.pinned = now;
    }
  }));
}

export async function unpinConversations(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.conversations.update(id, { pinned: 0 });
  }
  const idSet = new Set(ids);
  setConversations(produce((draft) => {
    for (const c of draft) {
      if (idSet.has(c.id)) c.pinned = 0;
    }
  }));
}

export async function archiveConversations(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.conversations.update(id, { archived: true, pinned: 0 });
  }
  const idSet = new Set(ids);
  setConversations(produce((draft) => {
    for (const c of draft) {
      if (idSet.has(c.id)) { c.archived = true; c.pinned = 0; }
    }
  }));
  if (activeConversationId() && idSet.has(activeConversationId()!)) {
    await selectConversation(null);
  }
}

export async function unarchiveConversations(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.conversations.update(id, { archived: false });
  }
  const idSet = new Set(ids);
  setConversations(produce((draft) => {
    for (const c of draft) {
      if (idSet.has(c.id)) c.archived = false;
    }
  }));
}

export async function deleteAllConversations(): Promise<void> {
  // Abort all active streams
  for (const bg of backgroundStreams.values()) {
    bg.abortController.abort();
  }
  backgroundStreams.clear();
  pendingCompletedMessages.clear();
  pendingCompletedBranchMessages.clear();
  setStreamingConvIds({});
  setStreamingBranchCtx({});

  await db.conversations.clear();
  await db.messages.clear();
  await db.thoughtSignatures.clear();
  await db.messageBranches.clear();
  setConversations([]);
  await selectConversation(null);
}

// === Streaming Control ===

export function stopStreaming(): void {
  const convId = activeConversationId();
  if (!convId) return;
  // Only stop if we are viewing the active stream
  if (!isViewingActiveStream()) return;
  const bg = backgroundStreams.get(convId);
  if (bg) {
    bg.abortController.abort();
    backgroundStreams.delete(convId);
  }
  setStreamingConvIds(produce((d) => { delete d[convId]; }));
  setStreamingBranchCtx(produce((d) => { delete d[convId]; }));
  setStreamingText("");
  setStreamingThinking("");
  setStreamingImages([]);
  setStreamingCodeBlocks([]);
  setStreamingCodeResults([]);
}

// === Branch Operations ===

async function loadBranchState(conversationId: string): Promise<void> {
  const branches = await db.messageBranches.where("conversationId").equals(conversationId).toArray();
  const state: Record<string, { total: number; activeIndex: number }> = {};

  // Group branches by branchGroupId and find the max index
  for (const b of branches) {
    if (!state[b.branchGroupId]) {
      state[b.branchGroupId] = { total: 0, activeIndex: 0 };
    }
    state[b.branchGroupId].total = Math.max(state[b.branchGroupId].total, b.branchIndex + 1);
  }

  // The active branch is the live messages not stored as a snapshot. Find it by
  // checking which branchIndex has no matching snapshot.
  const msgs = await db.messages.where("conversationId").equals(conversationId).sortBy("createdAt");
  for (const groupId of Object.keys(state)) {
    const branchMsg = msgs.find((m) => m.branchGroupId === groupId);
    if (branchMsg) {
      // Match live messages against stored snapshots to find the active index.
      const liveSnapshot = msgs.slice(msgs.indexOf(branchMsg));
      const groupBranches = branches.filter((b) => b.branchGroupId === groupId);
      let foundActive = false;
      for (const gb of groupBranches) {
        if (gb.snapshot.length === liveSnapshot.length &&
            gb.snapshot.every((s, i) => s.id === liveSnapshot[i].id)) {
          state[groupId].activeIndex = gb.branchIndex;
          foundActive = true;
          break;
        }
      }
      if (!foundActive) {
        // Live messages don't match any stored snapshot; they are the newest branch
        state[groupId].total += 1;
        state[groupId].activeIndex = state[groupId].total - 1;
      }
    }
  }

  setBranchState(state);
}

export async function navigateBranch(branchGroupId: string, targetIndex: number): Promise<void> {
  const convId = activeConversationId();
  if (!convId) return;
  const state = branchState[branchGroupId];
  if (!state || targetIndex === state.activeIndex || targetIndex < 0 || targetIndex >= state.total) return;

  // Clear streaming UI when switching branches (stream continues in background)
  const bg = backgroundStreams.get(convId);
  if (bg) {
    setStreamingText("");
    setStreamingThinking("");
    setStreamingImages([]);
    setStreamingCodeBlocks([]);
    setStreamingCodeResults([]);
  }

  // Find the branch point user message
  const branchPointMsg = messages.find((m) => m.branchGroupId === branchGroupId);
  if (!branchPointMsg) return;
  const branchPointIdx = messages.findIndex((m) => m.id === branchPointMsg.id);
  if (branchPointIdx === -1) return;

  // Save current active messages from branch point onwards as a branch record
  const currentSnapshot: Message[] = toPlain(messages.slice(branchPointIdx));
  const currentBranchIndex = state.activeIndex;

  // Check if a branch record already exists for the current active index
  const existingActive = await db.messageBranches
    .where("branchGroupId").equals(branchGroupId)
    .filter((b) => b.branchIndex === currentBranchIndex)
    .first();

  if (!existingActive) {
    // Save current as a branch record
    await db.messageBranches.put({
      id: crypto.randomUUID(),
      conversationId: convId,
      branchGroupId,
      branchIndex: currentBranchIndex,
      snapshot: currentSnapshot,
      createdAt: Date.now(),
    });
  } else {
    // Update existing branch snapshot
    await db.messageBranches.update(existingActive.id, { snapshot: currentSnapshot });
  }

  // Load target branch snapshot
  const targetBranch = await db.messageBranches
    .where("branchGroupId").equals(branchGroupId)
    .filter((b) => b.branchIndex === targetIndex)
    .first();

  if (!targetBranch) return;

  // Remove current messages from branch point onwards from DB
  const toRemove = messages.slice(branchPointIdx);
  for (const msg of toRemove) {
    await db.messages.delete(msg.id);
  }

  // Insert target branch's messages into DB
  for (const msg of targetBranch.snapshot) {
    await db.messages.put(msg);
  }

  // Reload messages
  const allMsgs = await db.messages.where("conversationId").equals(convId).sortBy("createdAt");
  setMessages(allMsgs);

  // If a stream completed while navigateBranch was reading, the message may not
  // be in allMsgs yet. Append it to avoid an empty assistant turn.
  const branchKey = `${branchGroupId}:${targetIndex}`;
  const pendingBranchMsg = pendingCompletedBranchMessages.get(branchKey);
  if (
    pendingBranchMsg !== undefined &&
    pendingBranchMsg.conversationId === convId &&
    !allMsgs.some((m) => m.id === pendingBranchMsg.id)
  ) {
    pendingCompletedBranchMessages.delete(branchKey);
    await db.messages.put(pendingBranchMsg);
    setMessages(produce((d) => { d.push(pendingBranchMsg); }));
  }

  // Update active index
  setBranchState(produce((d) => {
    if (d[branchGroupId]) d[branchGroupId].activeIndex = targetIndex;
  }));

  // If we navigated back to the branch that's streaming, restore streaming UI
  const bgAfter = backgroundStreams.get(convId);
  if (bgAfter?.branchCtx?.branchGroupId === branchGroupId && bgAfter.branchCtx.branchIndex === targetIndex) {
    setStreamingText(bgAfter.fullText);
    setStreamingThinking(bgAfter.fullThinking);
  }
}

export async function branchToNewChat(messageId: string): Promise<void> {
  const convId = activeConversationId();
  if (!convId) return;

  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;

  const messagesToCopy = messages.slice(0, idx + 1);

  const now = Date.now();
  const originalConv = activeConversation();
  const newConvId = crypto.randomUUID();
  const newConv: Conversation = {
    id: newConvId,
    title: `Branch: ${originalConv?.title || "Chat"}`,
    model: selectedModel(),
    createdAt: now,
    updatedAt: now,
  };
  await db.conversations.put(newConv);

  // Copy messages with new IDs, stripping branchGroupId so they're clean
  const newMsgs: Message[] = [];
  for (const msg of messagesToCopy) {
    const newMsg: Message = {
      id: crypto.randomUUID(),
      conversationId: newConvId,
      role: msg.role,
      parts: toPlain(msg.parts) as MessagePart[],
      createdAt: msg.createdAt,
    };
    await db.messages.put(newMsg);
    newMsgs.push(newMsg);
  }

  // Update UI state
  setConversations(produce((draft) => draft.unshift(newConv)));
  setActiveConversationId(newConvId);
  setMessages(newMsgs);
  setBranchState({});
  setChatError(null);
  setStreamingText("");
  setStreamingThinking("");
  setStreamingImages([]);
  setStreamingCodeBlocks([]);
  setStreamingCodeResults([]);
}

// === Retry / Edit ===

export async function retryMessage(): Promise<void> {
  const convId = activeConversationId();
  if (!convId || streamingConvIds[convId]) return;

  const allMsgs = [...messages];
  if (allMsgs.length < 2) return;

  const lastMsg = allMsgs[allMsgs.length - 1];
  if (lastMsg.role !== "model") return;

  // Delete the last model message from DB and state
  await db.messages.delete(lastMsg.id);
  setMessages(produce((draft) => draft.pop()));

  // Determine branch context for retry
  const prevUserMsg = allMsgs[allMsgs.length - 2];
  let retryBranchCtx: { branchGroupId: string; branchIndex: number } | undefined;
  if (prevUserMsg?.branchGroupId) {
    const currentBranch = branchState[prevUserMsg.branchGroupId];
    if (currentBranch) {
      retryBranchCtx = { branchGroupId: prevUserMsg.branchGroupId, branchIndex: currentBranch.activeIndex };
    }
  }

  // Rebuild and stream
  const remainingMsgs = await db.messages.where("conversationId").equals(convId).sortBy("createdAt");
  const keyHint = await getCurrentApiKeyHint();
  const contents = buildContentsFromMessages(remainingMsgs, keyHint);
  const userText = prevUserMsg?.parts.find((p) => p.type === "text")?.text ?? "";
  await startStream(convId, contents, userText, remainingMsgs.length, retryBranchCtx);
}

/**
 * Edits a user message: saves old branch, creates new message, streams response.
 */
export async function editMessage(messageId: string, newText: string, newAttachments?: FileAttachment[]): Promise<void> {
  const convId = activeConversationId();
  if (!convId || streamingConvIds[convId]) return;

  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;

  const originalMsg = messages[idx];

  // Assign branchGroupId if not already set
  let branchGroupId = originalMsg.branchGroupId;
  if (!branchGroupId) {
    branchGroupId = crypto.randomUUID();
    // Update the original message in DB to have the branchGroupId
    await db.messages.update(messageId, { branchGroupId });
    setMessages(produce((draft) => { draft[idx].branchGroupId = branchGroupId; }));
  }

  // Save current messages from branch point onwards as a branch snapshot
  const currentSnapshot: Message[] = toPlain(messages.slice(idx));
  const currentBranchCount = branchState[branchGroupId]?.total ?? 1;
  const currentActiveIndex = branchState[branchGroupId]?.activeIndex ?? 0;

  // Save as branch record if this is the first edit (save original as branch 0)
  if (currentBranchCount <= 1) {
    await db.messageBranches.put({
      id: crypto.randomUUID(),
      conversationId: convId,
      branchGroupId,
      branchIndex: 0,
      snapshot: currentSnapshot,
      createdAt: Date.now(),
    });
  } else {
    // Save current active as its branch index
    const existingActive = await db.messageBranches
      .where("branchGroupId").equals(branchGroupId)
      .filter((b) => b.branchIndex === currentActiveIndex)
      .first();
    if (existingActive) {
      await db.messageBranches.update(existingActive.id, { snapshot: currentSnapshot });
    } else {
      await db.messageBranches.put({
        id: crypto.randomUUID(),
        conversationId: convId,
        branchGroupId,
        branchIndex: currentActiveIndex,
        snapshot: currentSnapshot,
        createdAt: Date.now(),
      });
    }
  }

  // Delete messages from branch point onwards from DB
  const toDelete = messages.slice(idx);
  for (const msg of toDelete) {
    await db.messages.delete(msg.id);
  }
  setMessages(produce((draft) => draft.splice(idx)));

  // Build new user message parts
  const userParts: MessagePart[] = [];

  // undefined keeps original non-text parts; FileAttachment[] replaces them.
  if (newAttachments !== undefined) {
    const now = Date.now();
    const currentKeyHint = await getCurrentApiKeyHint();
    for (const att of newAttachments) {
      if (att.uploading || att.uploadError) continue;
      if (att.fileUri && att.expiresAt && att.expiresAt > now && att.apiKeyHint === currentKeyHint) {
        userParts.push({
          type: "fileData",
          mimeType: att.mimeType,
          fileUri: att.fileUri,
          expiresAt: att.expiresAt,
          apiKeyHint: att.apiKeyHint!,
          fileName: att.file.name,
          ...(att.preview ? { preview: att.preview } : {}),
        });
      }
      // Expired, key-mismatched, or failed uploads are silently skipped from the
      // API request but remain visible in the UI.
    }
  } else {
    for (const part of toPlain(originalMsg.parts)) {
      if (part.type !== "text") userParts.push(part);
    }
  }

  if (newText.trim()) {
    userParts.push({ type: "text", text: newText });
  }

  // Create new user message with same branchGroupId
  const newBranchIndex = currentBranchCount <= 1 ? 1 : currentBranchCount;
  const userMsg: Message = {
    id: crypto.randomUUID(),
    conversationId: convId,
    role: "user",
    parts: userParts,
    createdAt: Date.now(),
    branchGroupId,
  };
  await db.messages.put(userMsg);

  // Update branch state before pushing so the navigator renders immediately.
  setBranchState(produce((d) => {
    d[branchGroupId!] = { total: newBranchIndex + 1, activeIndex: newBranchIndex };
  }));

  setMessages(produce((draft) => draft.push(userMsg)));

  // Stream response
  const allMsgs = await db.messages.where("conversationId").equals(convId).sortBy("createdAt");
  const keyHint = await getCurrentApiKeyHint();
  const contents = buildContentsFromMessages(allMsgs, keyHint);
  const editAttachments = newAttachments ? [...newAttachments] : [];

  await startStream(convId, contents, newText, allMsgs.length, {
    branchGroupId: branchGroupId!,
    branchIndex: newBranchIndex,
  }, async () => {
    // Remove the new user message
    await db.messages.delete(userMsg.id);

    // Restore the previous branch's messages from snapshot
    const prevBranch = await db.messageBranches
      .where("branchGroupId").equals(branchGroupId!)
      .filter((b) => b.branchIndex === currentActiveIndex)
      .first();

    if (prevBranch) {
      // Remove any current messages from branch point onwards
      const currentMsgs = await db.messages.where("conversationId").equals(convId!).sortBy("createdAt");
      const branchPointIdx = currentMsgs.findIndex((m) => m.branchGroupId === branchGroupId);
      if (branchPointIdx !== -1) {
        for (const m of currentMsgs.slice(branchPointIdx)) {
          await db.messages.delete(m.id);
        }
      }

      // Re-insert the previous snapshot
      for (const m of prevBranch.snapshot) {
        await db.messages.put(m);
      }
    }

    // Reload and revert atomically so the UI never renders stale branch counts.
    const restored = await db.messages.where("conversationId").equals(convId!).sortBy("createdAt");

    if (currentBranchCount <= 1) {
      // First edit failed; remove all branch artifacts
      const allBranches = await db.messageBranches
        .where("branchGroupId").equals(branchGroupId!)
        .toArray();
      for (const b of allBranches) {
        await db.messageBranches.delete(b.id);
      }
      batch(() => {
        setMessages(restored);
        setBranchState(produce((d) => { delete d[branchGroupId!]; }));
      });
    } else {
    // Subsequent edit failed; remove stale branch record and revert count.
      const stale = await db.messageBranches
        .where("branchGroupId").equals(branchGroupId!)
        .filter((b) => b.branchIndex === newBranchIndex)
        .first();
      if (stale) await db.messageBranches.delete(stale.id);

      batch(() => {
        setMessages(restored);
        setBranchState(produce((d) => {
          d[branchGroupId!] = { total: currentBranchCount, activeIndex: currentActiveIndex };
        }));
      });
    }

    // Set recovery data so UI can repopulate input
    setRecoveryText(newText);
    setRecoveryAttachments(editAttachments);
  });
}

// === Conversation History -> GeminiContent[] ===

/**
 * Converts stored messages to the GeminiContent[] format expected by the API.
 *
 * fileData parts are included only when they are still valid for the current
 * request: not expired AND uploaded with the same API key (identified by
 * `currentApiKeyHint`). Invalid fileData parts are silently dropped from the
 * API payload while remaining visible in the UI.
 *
 * inlineData parts (model-generated images) are always included.
 */
function buildContentsFromMessages(msgs: Message[], currentApiKeyHint: string | null): GeminiContent[] {
  const now = Date.now();
  const raw = msgs.map((msg) => ({
    role: msg.role,
    parts: msg.parts
      .map((p): GeminiContentPart | null => {
        switch (p.type) {
          case "text":
            return { text: p.text };
          case "thinking":
            return {
              thought: true,
              text: p.text,
              ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
            };
          case "inlineData":
            return { inlineData: { mimeType: p.mimeType, data: p.data } };
          case "fileData": {
            // Drop expired files; their content is gone from the Files API.
            if (p.expiresAt <= now) return null;
      // Drop files uploaded with a different key; the Files API restricts access
      // to the key that performed the upload.
            if (currentApiKeyHint !== null && p.apiKeyHint !== currentApiKeyHint) return null;
            return { fileData: { mimeType: p.mimeType, fileUri: p.fileUri } };
          }
          case "functionCall":
            return { functionCall: { name: p.name, args: p.args, ...(p.id ? { id: p.id } : {}) } };
          case "functionResponse":
            return { functionResponse: { name: p.name, response: p.response, ...(p.id ? { id: p.id } : {}) } };
          case "executableCode":
            return { executableCode: { language: p.language, code: p.code } };
          case "codeExecutionResult":
            return { codeExecutionResult: { outcome: p.outcome, output: p.output } };
          case "searchGrounding":
            return null; // not sent back to the API
          default:
            return null;
        }
      })
      .filter((p): p is GeminiContentPart => p !== null && (
        p.text !== "" ||
        !!p.inlineData ||
        !!p.fileData ||
        !!p.functionCall ||
        !!p.functionResponse ||
        !!p.executableCode ||
        !!p.codeExecutionResult
      )),
  })).filter((c) => c.parts.length > 0);

  // Enforce strict user/model alternation. Insert placeholders where consecutive
  // same-role entries occur.
  const result: GeminiContent[] = [];
  for (const entry of raw) {
    if (result.length > 0 && result[result.length - 1].role === entry.role) {
      const filler = entry.role === "user" ? "model" : "user";
      result.push({ role: filler, parts: [{ text: "..." }] });
    }
    result.push(entry);
  }

  // The API requires a leading user message. A v3.2 message containing only
  // inlineData may have been stripped to empty parts by the v5 migration and
  // filtered out above, leaving the model's response first.
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", parts: [{ text: "..." }] });
  }

  return result;
}

// === Build Active Tools ===

/**
 * Disables URL Context for the given model if it does not support it.
 * Call after model selection changes or when restoring per-conversation settings.
 */
export function clampUrlContextForModel(modelId: string): void {
  if (!modelSupportsUrlContext(modelId) && urlContextEnabled()) {
    setUrlContextEnabled(false);
  }
}

function buildActiveTools(): GeminiTool[] {
  const tools: GeminiTool[] = [];
  if (searchEnabled()) {
    tools.push({ googleSearch: {} as Record<string, never> });
  }
  if (urlContextEnabled()) {
    tools.push({ urlContext: {} as Record<string, never> });
  }
  if (codeExecutionEnabled() && modelSupportsCodeExecution(selectedModel())) {
    tools.push({ codeExecution: {} as Record<string, never> });
  }
  return tools;
}

// === Build Generation Config ===

function buildGenerationConfig(model: string): GeminiGenerationConfig | undefined {
  if (!modelSupportsThinking(model)) return undefined;

  const enabled = thinkingEnabled();

  if (usesLevelBasedThinking(model)) {
    // Gemini 3.x and Gemma 4 use the thinkingLevel parameter. alwaysThinking
    // models cannot disable thinking.
    if (modelAlwaysThinking(model)) {
      return {
        maxOutputTokens: 65536,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: thinkingLevel(),
        },
      };
    }
    // Thinking disabled: send minimal for lowest latency.
    if (!enabled) {
      return {
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: "minimal" },
      };
    }
    // Thinking enabled: use the user-selected level.
    // For Gemma 4 this is always "high" (only user-selectable level).
    return {
      maxOutputTokens: 65536,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: thinkingLevel(),
      },
    };
  }

    // Unreachable with current models but preserved as a type guard.
  return undefined;
}

// === Thought Signature Cache ===

async function cacheThoughtSignature(
  conversationId: string,
  model: string,
  signature: string,
  turnIndex: number,
): Promise<void> {
  const id = `${conversationId}:${turnIndex}`;
  await db.thoughtSignatures.put({
    id,
    conversationId,
    model,
    signature,
    createdAt: Date.now(),
  });
}

// === Title Generation ===

async function generateTitle(userText: string, modelText: string, convId: string): Promise<void> {
  try {
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [
          {
            text: `Generate a very short title (max 6 words) for this conversation. Reply with ONLY the title, nothing else.\n\nUser: ${userText.slice(0, 500)}\nAssistant: ${modelText.slice(0, 500)}`,
          },
        ],
      },
    ];

    const result = await sendChat(TITLE_MODEL, contents, { maxOutputTokens: 30 });
    const title = result.parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (title && title.length > 0 && title.length <= 80) {
      await db.conversations.update(convId, { title, updatedAt: Date.now() });
      setConversations(produce((draft) => {
        const conv = draft.find((c) => c.id === convId);
        if (conv) {
          conv.title = title;
          conv.updatedAt = Date.now();
        }
      }));
    }
  } catch (err) {
    // Title generation failed; fallback title is already set
  }
}

// === Core Streaming Engine ===

/**
 * Starts a streaming response for a conversation. Supports background streaming:
 * if the user navigates away, the stream continues and saves on completion.
 */
async function startStream(
  convId: string,
  contents: GeminiContent[],
  userText: string,
  turnCount: number,
  branchCtx?: { branchGroupId: string; branchIndex: number },
  onErrorRecovery?: () => Promise<void>,
): Promise<void> {
  setChatError(null);
  const model = selectedModel();
  const generationConfig = buildGenerationConfig(model);
  const tools = buildActiveTools();
  let hadError = false;

  const controller = new AbortController();
  const isViewing = () => {
    if (activeConversationId() !== convId) return false;
    if (!branchCtx) return true;
    const current = branchState[branchCtx.branchGroupId];
    return current?.activeIndex === branchCtx.branchIndex;
  };

  let fullText = "";
  let fullThinking = "";
  let lastThoughtSignature: string | undefined;
  const collectedParts: MessagePart[] = [];
  const collectedImages: GeminiInlineData[] = [];
  const collectedCodeBlocks: { language: string; code: string }[] = [];
  const collectedCodeResults: { outcome: string; output: string }[] = [];
  let groundingResult: { queries: string[]; sources: { uri: string; title: string }[] } | null = null;

  // Register background stream
  backgroundStreams.set(convId, { abortController: controller, fullText: "", fullThinking: "", branchCtx });
  setStreamingConvIds(produce((d) => { d[convId] = true; }));
  setStreamingBranchCtx(produce((d) => { d[convId] = branchCtx; }));

  if (isViewing()) {
    setStreamingText("");
    setStreamingThinking("");
    setStreamingImages([]);
    setStreamingCodeBlocks([]);
    setStreamingCodeResults([]);
  }

  const callbacks: StreamCallbacks = {
    onText: (chunk) => {
      fullText += chunk;
      const bg = backgroundStreams.get(convId);
      if (bg) bg.fullText = fullText;
      if (isViewing()) setStreamingText(fullText);
    },
    onThinking: (chunk, signature) => {
      fullThinking += chunk;
      if (signature) lastThoughtSignature = signature;
      const bg = backgroundStreams.get(convId);
      if (bg) bg.fullThinking = fullThinking;
      if (isViewing()) setStreamingThinking(fullThinking);
    },
    onInlineData: (data) => {
      collectedImages.push(data);
      if (isViewing()) setStreamingImages(produce((draft) => draft.push(data)));
    },
    onExecutableCode: (block) => {
      collectedCodeBlocks.push(block);
      if (isViewing()) setStreamingCodeBlocks(produce((draft) => draft.push(block)));
    },
    onCodeExecutionResult: (result) => {
      collectedCodeResults.push(result);
      if (isViewing()) setStreamingCodeResults(produce((draft) => draft.push(result)));
    },
    onGroundingMetadata: (metadata: GeminiGroundingMetadata) => {
      const queries = metadata.webSearchQueries ?? [];
      const sources = (metadata.groundingChunks ?? [])
        .filter((c) => c.web)
        .map((c) => ({ uri: c.web!.uri, title: c.web!.title }));
      if (queries.length > 0 || sources.length > 0) {
        groundingResult = { queries, sources };
      }
    },
    onFunctionCall: (call) => {
      collectedParts.push({
        type: "functionCall",
        name: call.name,
        args: call.args,
        ...(call.id ? { id: call.id } : {}),
      });
    },
    onError: (error) => {
      hadError = true;
      if (isViewing()) setChatError(error);
    },
    onDone: async () => {
      backgroundStreams.delete(convId);
      setStreamingConvIds(produce((d) => { delete d[convId]; }));
      setStreamingBranchCtx(produce((d) => { delete d[convId]; }));

      const parts: MessagePart[] = [];

      if (fullThinking) {
        parts.push({
          type: "thinking",
          text: fullThinking,
          ...(lastThoughtSignature ? { thoughtSignature: lastThoughtSignature } : {}),
        });
        if (lastThoughtSignature) {
          await cacheThoughtSignature(convId, model, lastThoughtSignature, turnCount);
        }
      }

      parts.push(...collectedParts);

      // Code execution parts and images always precede the text response.
      for (const block of collectedCodeBlocks) {
        parts.push({ type: "executableCode", language: block.language, code: block.code });
      }
      for (const result of collectedCodeResults) {
        parts.push({ type: "codeExecutionResult", outcome: result.outcome, output: result.output });
      }

      // Inline images from code execution or model generation.
      for (const img of collectedImages) {
        parts.push({ type: "inlineData", mimeType: img.mimeType, data: img.data });
      }

      if (fullText) {
        parts.push({ type: "text", text: fullText });
      }

      if (groundingResult && groundingResult.sources.length > 0) {
        parts.push({
          type: "searchGrounding",
          queries: groundingResult.queries,
          sources: groundingResult.sources,
        });
      }

      // On edit error, recover regardless of partial content and revert the branch.
      const shouldRecoverBranch = hadError && branchCtx && onErrorRecovery && isViewing();

      if (parts.length > 0 && !shouldRecoverBranch) {
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          conversationId: convId,
          role: "model",
          parts,
          createdAt: Date.now(),
        };

        if (isViewing()) {
          // Normal: save to DB and push to UI
          await db.messages.put(assistantMsg);
          // Record before push so selectConversation can reconcile if it races.
          pendingCompletedMessages.set(convId, assistantMsg);
          setMessages(produce((draft) => draft.push(assistantMsg)));
        } else if (branchCtx) {
          // Record before the DB write so navigateBranch can reconcile if it races.
          const branchKey = `${branchCtx.branchGroupId}:${branchCtx.branchIndex}`;
          pendingCompletedBranchMessages.set(branchKey, assistantMsg);
          // Append model response to the branch snapshot in messageBranches.
          const branchRecord = await db.messageBranches
            .where("branchGroupId").equals(branchCtx.branchGroupId)
            .filter((b) => b.branchIndex === branchCtx.branchIndex)
            .first();
          if (branchRecord) {
            await db.messageBranches.update(branchRecord.id, {
              snapshot: [...branchRecord.snapshot, assistantMsg],
            });
          } else {
            // No snapshot exists: the user switched conversations without navigating
            // away from this branch first. Build the snapshot from db.messages.
            const liveMsgs = await db.messages
              .where("conversationId").equals(convId)
              .sortBy("createdAt");
            const branchPointIdx = liveMsgs.findIndex(
              (m) => m.branchGroupId === branchCtx!.branchGroupId,
            );
            const snapshot =
              branchPointIdx !== -1
                ? [...liveMsgs.slice(branchPointIdx), assistantMsg]
                : [assistantMsg];
            await db.messageBranches.put({
              id: crypto.randomUUID(),
              conversationId: convId,
              branchGroupId: branchCtx.branchGroupId,
              branchIndex: branchCtx.branchIndex,
              snapshot,
              createdAt: Date.now(),
            });
            // Only write to db.messages when on a different conversation. Same conv,
            // different branch: db.messages holds the other branch's data.
            if (activeConversationId() !== convId) {
              // Set pending before the put so selectConversation can reconcile on a race.
              pendingCompletedMessages.set(convId, assistantMsg);
              await db.messages.put(assistantMsg);
            }
          }
          // navigateBranch will now find the message via DB, so clean up the pending
          // entry if it hasn't been consumed yet.
          if (pendingCompletedBranchMessages.get(branchKey) === assistantMsg) {
            pendingCompletedBranchMessages.delete(branchKey);
          }
        } else {
          // Background conversation: still save to DB and record for reconciliation.
          await db.messages.put(assistantMsg);
          pendingCompletedMessages.set(convId, assistantMsg);
        }

        await db.conversations.update(convId, { updatedAt: Date.now() });
        setConversations(produce((draft) => {
          const conv = draft.find((c) => c.id === convId);
          if (conv) conv.updatedAt = Date.now();
        }));

        // Title generation on first exchange
        if (turnCount <= 1 && fullText) {
          generateTitle(userText, fullText, convId);
        }
      }

      // Capture viewing state before recovery because recovery mutates activeIndex.
      const wasViewing = isViewing();

      if (shouldRecoverBranch) {
        await onErrorRecovery!();
      } else if (parts.length === 0 && hadError && onErrorRecovery && wasViewing) {
        await onErrorRecovery();
      }

      if (wasViewing) {
        setStreamingText("");
        setStreamingThinking("");
        setStreamingImages([]);
        setStreamingCodeBlocks([]);
        setStreamingCodeResults([]);
      }
    },
  };

  try {
    await streamChat(model, contents, generationConfig, getActiveSystemInstruction(), callbacks, controller.signal, tools);
  } catch (err) {
    // Network error: streamChat threw before callbacks fired.
    backgroundStreams.delete(convId);
    setStreamingConvIds(produce((d) => { delete d[convId]; }));
    setStreamingBranchCtx(produce((d) => { delete d[convId]; }));
    if (isViewing()) {
      setChatError(err instanceof Error ? err.message : "Network error");
      setStreamingText("");
      setStreamingThinking("");
      setStreamingImages([]);
      setStreamingCodeBlocks([]);
      setStreamingCodeResults([]);
      if (onErrorRecovery) await onErrorRecovery();
    }
  }
}

// === Main Send Message ===

export async function sendMessage(text: string): Promise<void> {
  setChatError(null);

  let convId = activeConversationId();

  // Block only if this conversation is already streaming (background streaming
  // on other conversations is allowed).
  if (convId && streamingConvIds[convId]) return;

  if (!convId) {
    convId = await createConversation(text.slice(0, 60));
  }

  // Build user message parts
  const userParts: MessagePart[] = [];
  const now = Date.now();
  const currentKeyHint = await getCurrentApiKeyHint();

  const attachments = [...pendingAttachments];
  for (const att of attachments) {
    if (att.uploading || att.uploadError) continue;
    if (att.fileUri && att.expiresAt && att.expiresAt > now && att.apiKeyHint === currentKeyHint) {
      userParts.push({
        type: "fileData",
        mimeType: att.mimeType,
        fileUri: att.fileUri,
        expiresAt: att.expiresAt,
        apiKeyHint: att.apiKeyHint!,
        fileName: att.file.name,
        ...(att.preview ? { preview: att.preview } : {}),
      });
    }
    // Expired, key-mismatched, or failed uploads are skipped silently.
  }

  if (text.trim()) {
    userParts.push({ type: "text", text });
  }

  clearAttachments();

  const userMsg: Message = {
    id: crypto.randomUUID(),
    conversationId: convId,
    role: "user",
    parts: userParts,
    createdAt: Date.now(),
  };
  await db.messages.put(userMsg);
  setMessages(produce((draft) => draft.push(userMsg)));

  const allMsgs = await db.messages.where("conversationId").equals(convId).sortBy("createdAt");
  const contents = buildContentsFromMessages(allMsgs, currentKeyHint);

  await startStream(convId, contents, text, allMsgs.length, undefined, async () => {
    // Remove orphaned user message from DB and store
    await db.messages.delete(userMsg.id);
    setMessages(produce((draft) => {
      const idx = draft.findIndex((m) => m.id === userMsg.id);
      if (idx !== -1) draft.splice(idx, 1);
    }));

    // Set recovery data so UI can repopulate input
    setRecoveryText(text);
    setRecoveryAttachments(attachments);
  });
}

// === Session Recovery ===

export async function recoverSession(conversationId: string): Promise<void> {
  const conv = await db.conversations.get(conversationId);
  if (!conv) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  await selectConversation(conversationId);
  setChatError(null);
}
