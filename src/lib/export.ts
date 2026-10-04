/**
 * Export & backup: save a conversation as Markdown, and back up / restore the
 * whole local database as JSON.
 */
import { db, type Conversation, type Message, type MessageBranch, type CustomInstruction, type Character } from "./db";
import { isTauri, isAndroid } from "./platform";
import { modelLabel } from "./stores/settings";
import type { AndroidFsUri } from "tauri-plugin-android-fs-api";

// === File Saving (Downloads folder on every platform) ===

export type SaveResult = { ok: true; message: string } | { ok: false; message: string };

export async function saveBytesToDownloads(filename: string, bytes: Uint8Array, mimeType: string): Promise<SaveResult> {
  if (isTauri() && isAndroid()) {
    const { AndroidFs, AndroidPublicGeneralPurposeDir, getAndroidApiLevel } = await import("tauri-plugin-android-fs-api");
    const apiLevel = await getAndroidApiLevel();
    if (apiLevel < 29) {
      const alreadyGranted = await AndroidFs.checkPublicFilesPermission();
      if (!alreadyGranted) {
        const granted = await AndroidFs.requestPublicFilesPermission();
        if (!granted) return { ok: false, message: "Storage permission denied" };
      }
    }
    let uri: AndroidFsUri | undefined;
    try {
      uri = await AndroidFs.createNewPublicFile(AndroidPublicGeneralPurposeDir.Download, filename, mimeType, { isPending: true });
      await AndroidFs.writeFile(uri, bytes);
      await AndroidFs.setPublicFilePending(uri, false);
      await AndroidFs.scanPublicFile(uri);
    } catch {
      if (uri != null) await AndroidFs.removeFile(uri).catch(() => {});
      return { ok: false, message: `Could not save ${filename}` };
    }
    return { ok: true, message: `${filename} saved to Downloads` };
  }

  if (isTauri()) {
    try {
      const { writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      await writeFile(filename, bytes, { baseDir: BaseDirectory.Download });
      return { ok: true, message: `${filename} saved to Downloads` };
    } catch (err) {
      console.error("Tauri fs write failed:", err);
    }
  }

  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return { ok: true, message: `${filename} downloaded` };
}

export function saveTextToDownloads(filename: string, text: string, mimeType = "text/plain"): Promise<SaveResult> {
  return saveBytesToDownloads(filename, new TextEncoder().encode(text), mimeType);
}

// === Markdown Export ===

function safeFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return base || "chat";
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function conversationToMarkdown(conv: Conversation, messages: Message[], botName = "talkdude"): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");
  lines.push(`- Model: ${modelLabel(conv.model)}`);
  lines.push(`- Created: ${new Date(conv.createdAt).toLocaleString()}`);
  lines.push(`- Exported: ${new Date().toLocaleString()} with talkdude`);
  lines.push("");
  for (const msg of messages) {
    lines.push(msg.role === "user" ? "## 🧑 You" : `## 🤖 ${botName}`);
    lines.push("");
    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          lines.push(part.text.trim());
          lines.push("");
          break;
        case "thinking":
          if (part.text.trim()) {
            lines.push("<details><summary>Thinking</summary>");
            lines.push("");
            lines.push(part.text.trim());
            lines.push("");
            lines.push("</details>");
            lines.push("");
          }
          break;
        case "inlineData":
          if (part.mimeType.startsWith("image/")) {
            lines.push(`![${part.label ?? "image"}](data:${part.mimeType};base64,${part.data})`);
            lines.push("");
          }
          break;
        case "fileData":
          lines.push(`📎 Attachment: ${part.fileName} (${part.mimeType})`);
          lines.push("");
          break;
        case "executableCode":
          lines.push("```" + (part.language || "").toLowerCase());
          lines.push(part.code);
          lines.push("```");
          lines.push("");
          break;
        case "codeExecutionResult":
          lines.push("```text");
          lines.push(part.output);
          lines.push("```");
          lines.push("");
          break;
        case "searchGrounding":
          if (part.sources.length) {
            lines.push("Sources:");
            for (const s of part.sources) lines.push(`- [${s.title}](${s.uri})`);
            lines.push("");
          }
          break;
      }
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

export async function exportConversationMarkdown(conversationId: string): Promise<SaveResult> {
  const conv = await db.conversations.get(conversationId);
  if (!conv) return { ok: false, message: "Conversation not found" };
  const messages = await db.messages.where("conversationId").equals(conversationId).sortBy("createdAt");
  const character = conv.characterId ? await db.characters.get(conv.characterId) : undefined;
  const botName = character?.name ?? (conv.characterId?.startsWith("builtin-") ? conv.title : "talkdude");
  const md = conversationToMarkdown(conv, messages, botName);
  return saveTextToDownloads(`talkdude-${safeFilename(conv.title)}-${stamp()}.md`, md, "text/markdown");
}

// === Backup & Restore ===

export interface BackupFile {
  app: "talkdude";
  version: 1;
  exportedAt: number;
  conversations: Conversation[];
  messages: Message[];
  messageBranches: MessageBranch[];
  customInstructions: CustomInstruction[];
  characters?: Character[];
  /** Non-secret settings only (API keys are never written to a backup). */
  settings: { key: string; value: unknown }[];
}

const SECRET_SETTING_KEYS = new Set(["gemini_api_key"]);

export async function createBackup(): Promise<BackupFile> {
  const settings = (await db.settings.toArray())
    .filter((s) => !SECRET_SETTING_KEYS.has(s.key))
    .map((s) => {
      // Strip API keys from provider entries.
      if (s.key === "talkdude_providers" && Array.isArray(s.value)) {
        return { key: s.key, value: (s.value as Record<string, unknown>[]).map((p) => ({ ...p, apiKey: "" })) };
      }
      return { key: s.key, value: s.value };
    });
  return {
    app: "talkdude",
    version: 1,
    exportedAt: Date.now(),
    conversations: await db.conversations.toArray(),
    messages: await db.messages.toArray(),
    messageBranches: await db.messageBranches.toArray(),
    customInstructions: await db.customInstructions.toArray(),
    characters: await db.characters.toArray(),
    settings,
  };
}

export async function exportBackup(): Promise<SaveResult> {
  const backup = await createBackup();
  return saveTextToDownloads(`talkdude-backup-${stamp()}.json`, JSON.stringify(backup), "application/json");
}

/**
 * Restores a backup. Existing records with the same id are overwritten;
 * everything else is kept, so restoring is additive and safe to repeat.
 * Returns the number of conversations restored.
 */
export async function importBackup(file: File): Promise<number> {
  const text = await file.text();
  let data: Partial<BackupFile>;
  try { data = JSON.parse(text); } catch { throw new Error("This file is not a valid talkdude backup."); }
  if (data.app !== "talkdude" || !Array.isArray(data.conversations) || !Array.isArray(data.messages)) {
    throw new Error("This file is not a valid talkdude backup.");
  }
  await db.transaction("rw", [db.conversations, db.messages, db.messageBranches, db.customInstructions, db.characters, db.settings], async () => {
    await db.conversations.bulkPut(data.conversations!);
    await db.messages.bulkPut(data.messages!);
    if (Array.isArray(data.messageBranches)) await db.messageBranches.bulkPut(data.messageBranches);
    if (Array.isArray(data.customInstructions)) await db.customInstructions.bulkPut(data.customInstructions);
    if (Array.isArray(data.characters)) await db.characters.bulkPut(data.characters);
    if (Array.isArray(data.settings)) {
      for (const s of data.settings) {
        if (!s || typeof s.key !== "string" || SECRET_SETTING_KEYS.has(s.key)) continue;
        // Never let a backup overwrite the keys the user has configured here.
        if (s.key === "talkdude_providers") {
          const existing = await db.settings.get(s.key);
          if (existing) continue;
        }
        await db.settings.put({ key: s.key, value: s.value });
      }
    }
  });
  return data.conversations!.length;
}
