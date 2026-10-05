/**
 * "Learns from your chats": talkdude keeps short notes about the user
 * (name, likes, plans, how they like answers) taken from conversations, and
 * gives the most relevant ones to the AI in every chat — so the built-in AI
 * gets more personal and useful the more you talk to it.
 *
 * The model weights don't change (training on a phone isn't practical); this
 * is the same long-term memory approach big chat apps use. Notes stay on the
 * device (stored in settings, so backups include them) and can be edited or
 * deleted in Settings → Memory.
 */
import { createSignal } from "solid-js";
import { db } from "../db";

export interface LearnedNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** How often the note was given to the AI (used to keep the useful ones). */
  uses: number;
}

const NOTES_KEY = "talkdude_learned_notes";
const ENABLED_KEY = "talkdude_learning";
export const MAX_NOTES = 200;

const [notes, setNotesSignal] = createSignal<LearnedNote[]>([]);
const [learningEnabled, setLearningEnabledSignal] = createSignal(true);
/** Last note learned, for a small "Remembered: …" toast. */
const [lastLearned, setLastLearned] = createSignal<string | null>(null);
export { notes, learningEnabled, lastLearned, setLastLearned };

async function persist(list: LearnedNote[]): Promise<void> {
  setNotesSignal(list);
  try { await db.settings.put({ key: NOTES_KEY, value: list }); } catch { /* ignore */ }
}

export async function loadLearning(): Promise<void> {
  try {
    const v = (await db.settings.get(NOTES_KEY))?.value;
    setNotesSignal(Array.isArray(v) ? (v as LearnedNote[]).filter((n) => n && typeof n.text === "string") : []);
    const e = (await db.settings.get(ENABLED_KEY))?.value;
    setLearningEnabledSignal(e !== false);
  } catch { /* ignore */ }
}

export async function setLearningEnabled(on: boolean): Promise<void> {
  setLearningEnabledSignal(on);
  try { await db.settings.put({ key: ENABLED_KEY, value: on }); } catch { /* ignore */ }
}

// === Text helpers ===

const STOP = new Set(("the a an and or but if then so to of in on at for with from by is are was were be been am i you he she it we they me my " +
  "your our their this that these those do does did have has had not no yes just really very can could would should will " +
  "yang dan atau di ke dari ini itu aku saya kamu dia kita kami mereka ada tidak bukan juga sudah belum akan bisa mau " +
  "untuk dengan pada dalam karena jadi kalau apa siapa kenapa gimana ya sih dong kok aja deh nih").split(" "));

function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
}

function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

// === Editing ===

export async function addNote(text: string): Promise<LearnedNote | null> {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (t.length < 4) return null;
  const list = notes().slice();
  const now = Date.now();
  // Same fact again (or an update of it): replace instead of piling up.
  const dup = list.findIndex((n) => similarity(n.text, t) >= 0.7);
  let note: LearnedNote;
  if (dup !== -1) {
    note = { ...list[dup], text: t, updatedAt: now };
    list[dup] = note;
  } else {
    note = { id: crypto.randomUUID(), text: t, createdAt: now, updatedAt: now, uses: 0 };
    list.unshift(note);
  }
  if (list.length > MAX_NOTES) {
    // Drop the least useful, oldest notes.
    list.sort((a, b) => (b.uses - a.uses) || (b.updatedAt - a.updatedAt));
    list.length = MAX_NOTES;
  }
  await persist(list);
  return note;
}

export async function updateNote(id: string, text: string): Promise<void> {
  const t = text.trim().slice(0, 200);
  if (!t) return deleteNote(id);
  await persist(notes().map((n) => (n.id === id ? { ...n, text: t, updatedAt: Date.now() } : n)));
}

export async function deleteNote(id: string): Promise<void> {
  await persist(notes().filter((n) => n.id !== id));
}

export async function clearNotes(): Promise<void> {
  await persist([]);
}

// === Using notes in a chat ===

/** The notes most relevant to what the user just said, plus the newest ones. */
export function relevantNotes(query: string, limit: number): LearnedNote[] {
  const list = notes();
  if (!list.length) return [];
  const q = new Set(words(query));
  const now = Date.now();
  const scored = list.map((n) => {
    let overlap = 0;
    for (const w of words(n.text)) if (q.has(w)) overlap++;
    const ageDays = (now - n.updatedAt) / 86_400_000;
    return { n, score: overlap * 3 + Math.max(0, 2 - ageDays / 15) + Math.min(n.uses, 20) * 0.05 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.n);
}

/** System-prompt block with what talkdude has learned about the user. */
export function buildLearnedPrompt(query: string, limit = 12): string | undefined {
  if (!learningEnabled()) return undefined;
  const picked = relevantNotes(query, limit);
  if (!picked.length) return undefined;
  // Count uses without awaiting (cheap, best-effort).
  const ids = new Set(picked.map((p) => p.id));
  void persist(notes().map((n) => (ids.has(n.id) ? { ...n, uses: n.uses + 1 } : n)));
  return "[What you know about the user from earlier chats — use it naturally, don't list it back]\n" +
    picked.map((p) => `- ${p.text}`).join("\n");
}

// === Learning ===

const pendingByConv = new Map<string, string[]>();
let learning = false;

/** Messages that obviously contain nothing durable aren't worth a model call. */
function worthLearning(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  return /\b(i|i'm|im|my|me|mine|aku|saya|gue|gw|ku|namaku|nama saya)\b/i.test(t) || t.length > 120;
}

export const EXTRACT_PROMPT = `You are a memory assistant. From the user's messages below, write down durable facts about the USER that would help in future chats: their name, age range, job or studies, where they live, family, pets, likes and dislikes, goals and plans, and how they want answers (language, length, tone).

Rules:
- One short fact per line, starting with "- ", written in third person ("The user ...").
- Only facts the user clearly said about themselves. Ignore questions, jokes, role-play and anything said by the assistant.
- Skip passwords, ID numbers, bank details, health, religion, politics and other sensitive details.
- At most 3 lines. If there is nothing worth remembering, reply exactly: NONE`;

/**
 * Called after each finished reply. Every few user messages (or when one looks
 * personal) the current AI is asked to pull out facts worth remembering.
 * `ask` sends one prompt to the active model and returns its text.
 */
export async function learnFromMessage(convId: string, userText: string, ask: (prompt: string) => Promise<string>): Promise<void> {
  if (!learningEnabled()) return;
  const queue = pendingByConv.get(convId) ?? [];
  if (worthLearning(userText)) queue.push(userText.slice(0, 600));
  pendingByConv.set(convId, queue);
  if (!queue.length || learning) return;
  const personal = /\b(my name|nama(ku| saya)|i am|i'm|aku|saya)\b/i.test(userText);
  if (queue.length < 3 && !personal) return;

  learning = true;
  pendingByConv.set(convId, []);
  try {
    const known = notes().slice(0, 30).map((n) => `- ${n.text}`).join("\n") || "(nothing yet)";
    const reply = await ask(`${EXTRACT_PROMPT}\n\nAlready known (don't repeat unless it changed):\n${known}\n\nUser messages:\n${queue.map((q) => `"""${q}"""`).join("\n")}`);
    if (/^\s*NONE\b/i.test(reply)) return;
    const lines = reply.split("\n").map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, "").trim()).filter((l) => l.length >= 6 && l.length <= 200 && !/^none$/i.test(l));
    for (const l of lines.slice(0, 3)) {
      if (/password|kata sandi|pin\b|nik\b|ktp|rekening|credit card|kartu kredit/i.test(l)) continue;
      const n = await addNote(l);
      if (n) setLastLearned(n.text);
    }
  } catch {
    // Learning is best-effort; never disturb the chat.
  } finally {
    learning = false;
  }
}
