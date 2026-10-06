/**
 * Spoken memory commands, like "save to memory" in ChatGPT, Gemini and Claude.
 * English and Indonesian. Pure functions (no app state) so they are easy to test.
 *
 *   "Save to memory: I'm allergic to peanuts"      -> save
 *   "I prefer short answers, save this to memory"   -> save
 *   "Simpan ke memori bahwa namaku Ari"             -> save
 *   "Remember that my cat is called Miso"           -> save (normal chats only)
 *   "Ingat ya, aku kerja di bank"                   -> save (normal chats only)
 *   "Forget that I like jazz" / "Lupakan soal jazz" -> forget (normal chats only)
 *   "Delete my cat's name from memory"              -> forget
 */

export type MemoryCommand =
  | { action: "save"; content: string }
  | { action: "forget"; content: string };

const SAVE_VERB = "(?:save|add|store|put|write|keep|simpan(?:kan)?|tambah(?:kan)?|masukkan|catat(?:kan)?)";
const THIS = "(?:this|that|it|these|ini|itu)";
const TO = "(?:to|in|into|ke|di|dalam)";
const MEMORY = "(?:memory|memories|memori|ingatan)";
const POLITE = "(?:please |pls |tolong |coba |hey |hi |ok |oke )*";

// "save this to memory: …" (content after) or just "save to memory"
const SAVE_LEADING = new RegExp(
  `^${POLITE}${SAVE_VERB}\\s+(?:${THIS}\\s+)?${TO}\\s+(?:my\\s+|your\\s+|the\\s+|kamu\\s+)?${MEMORY}\\b(?:\\s+(?:that|bahwa|kalau|kalo))?[\\s:,.\\-–]*(.*)$`,
  "is",
);
// "… , save this to memory"
const SAVE_TRAILING = new RegExp(
  `^(.*?)[\\s,.;\\-–]+(?:and |dan |terus )?${POLITE}${SAVE_VERB}\\s+(?:${THIS}\\s+)?${TO}\\s+(?:my\\s+)?${MEMORY}[\\s.!]*$`,
  "is",
);
// "remember that …", "ingat ya, …" (not for questions like "remember when…?")
const REMEMBER = new RegExp(
  `^${POLITE}(?:remember|ingat(?:lah|kan)?|jangan lupa|don'?t forget|catat bahwa)\\s*(?:ya|bahwa|kalau|kalo|that|this|ini)?[\\s:,.\\-–]*(.{4,})$`,
  "is",
);
const QUESTION_START = /^(when|how|what|why|who|where|if|the time|kapan|bagaimana|gimana|apa|kenapa|siapa|gak|ga|nggak|ngga|tidak|kah)\b/i;

const FORGET = new RegExp(
  `^${POLITE}(?:forget|lupakan|lupain)\\s*(?:that|about|tentang|soal|bahwa)?[\\s:,.\\-–]*(.{3,})$`,
  "is",
);
const FORGET_FROM_MEMORY = new RegExp(
  `^${POLITE}(?:remove|delete|hapus(?:kan)?|buang)\\s+(.{3,}?)\\s+(?:from|dari)\\s+(?:my\\s+)?${MEMORY}[\\s.!]*$`,
  "is",
);

function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/^[\s:,.\-–]+|[\s,;:\-–]+$/g, "")
    .trim();
}

/**
 * Looks for a memory command at the start or end of a chat message.
 * `loose` is false in character/roleplay chats, where "remember that…" is usually
 * part of the story; only the explicit "save to memory" forms count there.
 */
export function parseMemoryCommand(text: string, loose = true): MemoryCommand | null {
  const t = text.trim();
  if (!t || t.length > 600) return null;

  let m = FORGET_FROM_MEMORY.exec(t);
  if (m && clean(m[1]).length >= 3) return { action: "forget", content: clean(m[1]) };

  m = SAVE_LEADING.exec(t);
  if (m) {
    const c = clean(m[1] ?? "");
    return { action: "save", content: /^(please|pls|tolong|ya|dong|deh|now|sekarang)$/i.test(c) ? "" : c };
  }

  m = SAVE_TRAILING.exec(t);
  if (m && clean(m[1]).length >= 4) return { action: "save", content: clean(m[1]) };

  if (!loose) return null;

  m = REMEMBER.exec(t);
  if (m) {
    const c = clean(m[1]);
    if (c.length >= 4 && !QUESTION_START.test(c) && !/\?\s*$/.test(t)) return { action: "save", content: c };
  }

  m = FORGET.exec(t);
  if (m) {
    const c = clean(m[1]);
    if (c.length >= 3 && !/\?\s*$/.test(t)) return { action: "forget", content: c };
  }
  return null;
}
