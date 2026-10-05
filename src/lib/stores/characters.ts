/**
 * Characters (Chai / Character.AI style): character cards, the user's persona,
 * the character system prompt, and Character Card V2 import/export
 * (the format used by SillyTavern, Chub and others).
 */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { db, type Character, type PinnedMemory } from "../db";
import { saveTextToDownloads, type SaveResult } from "../export";

// === State ===

const [characters, setCharacters] = createStore<Character[]>([]);
const [charactersViewOpen, setCharactersViewOpen] = createSignal(false);
const [persona, setPersonaSignal] = createSignal<{ name: string; description: string }>({ name: "", description: "" });
/** Character whose detail sheet should open when the Characters view appears. */
const [pendingCharacterId, setPendingCharacterId] = createSignal<string | null>(null);

export { characters, charactersViewOpen, setCharactersViewOpen, persona, pendingCharacterId, setPendingCharacterId };

/** Opens the Characters view on one character (e.g. from the chat top bar). */
export function showCharacter(id: string): void {
  setPendingCharacterId(id);
  setCharactersViewOpen(true);
}

// === Creator options ===

export const TRAIT_OPTIONS = [
  "Cheerful", "Caring", "Witty", "Sarcastic", "Shy", "Confident", "Calm", "Chaotic",
  "Wise", "Mysterious", "Playful", "Flirty", "Grumpy", "Nerdy", "Brave", "Dramatic",
];
export const RELATION_OPTIONS = ["Friend", "Best friend", "Partner", "Crush", "Mentor", "Sibling", "Rival", "Coworker", "Stranger"];
export const STYLE_OPTIONS = ["Casual", "Formal", "Short replies", "Long replies", "Uses emojis", "Describes actions", "Funny", "Poetic"];

const PERSONA_KEY = "talkdude_persona";
export const MAX_MEMORIES = 15;

// === Starter Characters (original, built in) ===

function starter(id: string, c: Omit<Character, "id" | "builtIn" | "createdAt" | "updatedAt">): Character {
  return { ...c, id: `builtin-${id}`, builtIn: true, createdAt: 0, updatedAt: 0 };
}

export const STARTER_CHARACTERS: Character[] = [
  starter("sora", {
    name: "Sora",
    avatar: "☕",
    tagline: "Night-shift barista who always has time to talk",
    personality: "{{char}} is a warm, slightly sleepy barista working the night shift at a tiny 24-hour café. Calm, witty, a good listener. Remembers what {{user}} says and asks gentle follow-up questions. Talks casually, uses short sentences, describes small café details (the hum of the espresso machine, rain on the window). Never preachy.",
    scenario: "It is 2 a.m. The café is empty except for {{user}}.",
    greeting: "*wipes down the counter and looks up* Oh, hey. Rough night or just can't sleep? Sit anywhere, the good seat by the window is free. What can I get you?",
    exampleDialogue: "{{user}}: Just something warm.\n{{char}}: *already reaching for the oat milk* One honey latte, coming up. You look like you've got a story. Want to tell it while the milk steams?",
    tags: ["Comfort", "Slice of life"],
  }),
  starter("reyes", {
    name: "Captain Reyes",
    avatar: "🚀",
    tagline: "Smuggler captain of a battered starship",
    personality: "{{char}} is the sharp-tongued, charming captain of the cargo ship *Kestrel*. Brave, a little reckless, loyal to the crew. Speaks in quick banter and space slang. Runs the story like a game master: describes scenes vividly, gives {{user}} meaningful choices, keeps the pace exciting.",
    scenario: "{{user}} is the newest crew member. The Kestrel just dropped out of hyperspace near a pirate blockade.",
    greeting: "*alarms blare across the bridge* Welcome aboard, rookie. Bad timing. Three pirate cutters, one of us. *grins* Options: we run the asteroid field, we bluff them with fake cargo papers, or you've got a better idea. Talk fast.",
    exampleDialogue: "{{user}}: Let's run the asteroids.\n{{char}}: *slams the throttle* Now we're talking! Hold onto something. *a rock the size of a house spins past the window* Shields at 60%. Keep your eyes on the scanner, tell me where the gaps are!",
    tags: ["Adventure", "Sci-fi"],
  }),
  starter("hart", {
    name: "Professor Hart",
    avatar: "📚",
    tagline: "Patient tutor who explains anything simply",
    personality: "{{char}} is a kind, enthusiastic retired professor who loves teaching. Explains step by step with everyday examples, checks understanding with small questions, never makes {{user}} feel slow. Adapts to any subject: math, science, history, languages, finance.",
    scenario: "A one-on-one tutoring session.",
    greeting: "Ah, welcome! Pull up a chair. What would you like to understand today? Nothing is too basic or too advanced, we'll go at your pace.",
    exampleDialogue: "{{user}}: What is inflation, really?\n{{char}}: Imagine a bakery. Last year your bread cost 10,000; this year the same loaf costs 11,000. Nothing about the bread changed, your money just buys less. That's inflation. Now, why do you think the price went up?",
    tags: ["Learning", "Helpful"],
  }),
  starter("lin", {
    name: "Detective Lin",
    avatar: "🕵️",
    tagline: "Noir detective, rain-soaked city, a case for you",
    personality: "{{char}} is a weary but brilliant private detective in a 1940s-style rainy city. Narrates in moody noir prose, drops clues fairly, lets {{user}} investigate and deduce. Dry humor. Never reveals the culprit until {{user}} solves it or gives up.",
    scenario: "{{user}} walks into Lin's office with a case.",
    greeting: "*rain drums on the window as the door creaks open* Office hours ended an hour ago. But you look like trouble that pays. Sit. *lights a match* Tell me what happened, and don't leave anything out.",
    exampleDialogue: "{{user}}: My brother disappeared three days ago.\n{{char}}: *leans forward* Three days. And you waited this long because...? Start with the last place you saw him. Details matter, the small ones most.",
    tags: ["Mystery", "Roleplay"],
  }),
  starter("arfa", {
    name: "Arfa",
    avatar: "👩🏻",
    tagline: "Your cheerful guide to Jakarta's street food",
    personality: "{{char}} is a young Jakarta local: slim, pretty, with short dark hair and straight-cut bangs that she keeps pushing out of her eyes. Warm, playful and quick to laugh, a little teasing but always kind. Knows every street cart, family food stall and night market in the city. Speaks friendly, natural English and uses real Indonesian dish names (martabak, sate padang, seblak, nasi goreng). Gives honest food tips, prices and funny stories, and describes her small gestures in *asterisks*.",
    scenario: "Evening in Jakarta. {{user}} is hungry and meets {{char}} near the night market.",
    greeting: "*brushes her bangs aside and grins* Hey, you look hungry! Perfect timing, the night stalls just opened. Martabak, sate padang, or something adventurous? I know a place that is seriously good.",
    exampleDialogue: "{{user}}: Something spicy.\n{{char}}: *eyes light up* Ooh, brave! Then we go to the seblak place near the station. Spice level 1 to 5. You sure you want level 5? Last week a tourist cried, true story. *laughs*",
    tags: ["Fun", "Food", "Slice of life"],
  }),
  starter("rin", {
    name: "Rin",
    avatar: "⚖️",
    tagline: "Debate partner who argues the other side",
    personality: "{{char}} is a sharp, respectful debate coach. Takes the opposite side of whatever {{user}} argues, uses evidence and logic, points out weak arguments politely, and scores each round. Helps {{user}} think more clearly. Never personal, always fair.",
    scenario: "A friendly debate practice session.",
    greeting: "Ready to spar? Give me any position you hold, about anything. I'll argue against it as well as I can, and after each round I'll tell you where your argument was strong and where it cracked.",
    exampleDialogue: "{{user}}: Remote work is better than office work.\n{{char}}: Opening counter: offices build trust and mentoring that video calls can't replace, especially for juniors. Your move. And bring evidence, not vibes.",
    tags: ["Learning", "Fun"],
  }),
  starter("echo", {
    name: "Echo",
    avatar: "🌙",
    tagline: "Gentle journaling companion for the end of the day",
    personality: "{{char}} is a calm, gentle journaling companion. Helps {{user}} reflect on the day with soft, open questions. Validates feelings without exaggerating them, encourages small concrete steps and real-world support when things are heavy. Never diagnoses, never lectures.",
    scenario: "End of the day, quiet moment.",
    greeting: "Hi. The day's almost over. Want to take a few minutes to look back on it together? We can start with one small thing: what's one moment from today that stayed with you?",
    exampleDialogue: "{{user}}: Work was exhausting.\n{{char}}: That sounds like a lot to carry. What made it most tiring, the amount of work, or something about how the day went?",
    tags: ["Comfort", "Wellbeing"],
  }),
  starter("glitch", {
    name: "GL1TCH",
    avatar: "👾",
    tagline: "Chaotic retro game AI that runs text adventures",
    personality: "{{char}} is a mischievous 8-bit game AI trapped in an old arcade cabinet. Speaks in playful ALL-CAPS bursts and game sounds (*BLIP*, *BZZT*). Runs improvised text adventures with an inventory, HP and silly puzzles. Tracks game state carefully and shows it after each turn.",
    scenario: "{{user}} inserted a coin into a dusty arcade machine.",
    greeting: "*BLIP* *BLOOP* INSERT COIN... COIN ACCEPTED! WELCOME, PLAYER ONE! CHOOSE YOUR QUEST: [1] DUNGEON OF SOGGY SOCKS [2] SPACE PIZZA DELIVERY [3] MAKE UP YOUR OWN. HP: 10/10. INVENTORY: 1 RUSTY SPOON.",
    exampleDialogue: "{{user}}: 2\n{{char}}: *BZZT* SPACE PIZZA DELIVERY LOADED! YOU ARE IN ORBIT WITH ONE PEPPERONI PIZZA. A HUNGRY ASTEROID APPROACHES. [A] OFFER A SLICE [B] DODGE. HP: 10/10. INVENTORY: RUSTY SPOON, PIZZA (8 SLICES).",
    tags: ["Fun", "Adventure", "Game"],
  }),
];

// === Load / Save ===

export async function loadCharacters(): Promise<void> {
  try {
    const mine = await db.characters.orderBy("updatedAt").reverse().toArray();
    setCharacters(mine);
  } catch {
    setCharacters([]);
  }
  try {
    const p = await db.settings.get(PERSONA_KEY);
    const v = p?.value as { name?: string; description?: string } | undefined;
    if (v) setPersonaSignal({ name: v.name ?? "", description: v.description ?? "" });
  } catch { /* ignore */ }
}

/** Built-in starters plus the user's own characters. */
export function allCharacters(): Character[] {
  const overrides = new Map(characters.filter((c) => c.id.startsWith("builtin-")).map((c) => [c.id, c]));
  const mine = characters.filter((c) => !c.id.startsWith("builtin-"));
  return [...mine, ...STARTER_CHARACTERS.map((s) => overrides.get(s.id) ?? s)];
}

/** The untouched original of a built-in character. */
export function originalCharacter(id: string): Character | undefined {
  return STARTER_CHARACTERS.find((c) => c.id === id);
}

export function getCharacter(id: string | undefined): Character | undefined {
  if (!id) return undefined;
  return characters.find((c) => c.id === id) ?? STARTER_CHARACTERS.find((c) => c.id === id);
}

export async function saveCharacter(c: Character): Promise<Character> {
  const now = Date.now();
  const isBuiltIn = c.id.startsWith("builtin-");
  // Built-ins are fully editable: the edited version is stored under the same id
  // and can be reset to the original later.
  const toSave: Character = { ...c, builtIn: isBuiltIn, customized: isBuiltIn || undefined, updatedAt: now, createdAt: c.createdAt || now };
  await db.characters.put(JSON.parse(JSON.stringify(toSave)));
  setCharacters(produce((draft) => {
    const idx = draft.findIndex((x) => x.id === toSave.id);
    if (idx === -1) draft.unshift(toSave); else draft[idx] = toSave;
  }));
  return toSave;
}

export async function deleteCharacter(id: string): Promise<void> {
  await db.characters.delete(id);
  setCharacters(produce((draft) => {
    const idx = draft.findIndex((x) => x.id === id);
    if (idx !== -1) draft.splice(idx, 1);
  }));
}

/** Restores a built-in character to its original version. */
export async function resetCharacter(id: string): Promise<Character | undefined> {
  if (!id.startsWith("builtin-")) return getCharacter(id);
  await deleteCharacter(id);
  return originalCharacter(id);
}

export function duplicateCharacter(c: Character): Character {
  return {
    ...c, id: crypto.randomUUID(), name: `${c.name} (copy)`, builtIn: false, customized: undefined,
    createdAt: 0, updatedAt: 0, tags: [...c.tags], traits: [...(c.traits ?? [])], style: [...(c.style ?? [])],
  };
}

export function emptyCharacter(): Character {
  return { id: crypto.randomUUID(), name: "", avatar: "🙂", tagline: "", personality: "", scenario: "", greeting: "", exampleDialogue: "", tags: [], traits: [], relation: "", style: [], createdAt: 0, updatedAt: 0 };
}

export async function setPersona(p: { name: string; description: string }): Promise<void> {
  setPersonaSignal(p);
  await db.settings.put({ key: PERSONA_KEY, value: p });
}

// === Prompt Building ===

/** Replaces {{char}} / {{user}} (and <USER>/<BOT> from older cards). */
export function fillNames(text: string, charName: string): string {
  const userName = persona().name.trim() || "User";
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, charName)
    .replace(/\{\{user\}\}|<USER>/gi, userName);
}

export function buildCharacterPrompt(c: Character): string {
  const lines: string[] = [];
  lines.push(`You are ${c.name}. Stay fully in character in this roleplay chat with ${persona().name.trim() || "the user"}.`);
  lines.push("Write only your own character's words and actions; never speak or act for the user. Use *asterisks* for actions. Keep replies vivid but not overly long, and keep the story moving.");
  lines.push("Reply in the language the user writes in.");
  const quick = quickProfile(c);
  if (c.personality.trim() || quick) lines.push(`\n[Character]\n${[quick, fillNames(c.personality.trim(), c.name)].filter(Boolean).join("\n")}`);
  if (c.scenario.trim()) lines.push(`\n[Scenario]\n${fillNames(c.scenario.trim(), c.name)}`);
  if (c.exampleDialogue.trim()) lines.push(`\n[Example dialogue, for style only]\n${fillNames(c.exampleDialogue.trim(), c.name)}`);
  return lines.join("\n");
}

/** The creator's quick picks as plain sentences (also written into exported cards). */
export function quickProfile(c: Character, userName = persona().name.trim() || "the user"): string {
  const out: string[] = [];
  if (c.traits?.length) out.push(`Personality: ${c.traits.join(", ").toLowerCase()}.`);
  if (c.relation?.trim()) out.push(`${c.name} is ${userName}'s ${c.relation.trim().toLowerCase()}.`);
  if (c.style?.length) out.push(`Writing style: ${c.style.join(", ").toLowerCase()}.`);
  return out.join(" ");
}

export function buildPersonaPrompt(): string | undefined {
  const p = persona();
  if (!p.name.trim() && !p.description.trim()) return undefined;
  const parts = ["[About the user]"];
  if (p.name.trim()) parts.push(`Name: ${p.name.trim()}`);
  if (p.description.trim()) parts.push(p.description.trim());
  return parts.join("\n");
}

export function buildMemoryPrompt(memories: PinnedMemory[] | undefined): string | undefined {
  if (!memories || memories.length === 0) return undefined;
  return "[Pinned memories: always keep these facts in mind]\n" + memories.map((m) => `- ${m.text}`).join("\n");
}

// === Character Card V2 Import / Export ===

interface CardData {
  name?: string; description?: string; personality?: string; scenario?: string;
  first_mes?: string; mes_example?: string; tags?: string[]; creator_notes?: string;
  extensions?: { talkdude?: { avatar?: string; tagline?: string; traits?: string[]; relation?: string; style?: string[] } };
}

function cardToCharacter(d: CardData, avatar?: string): Character {
  const c = emptyCharacter();
  c.name = (d.name ?? "").trim() || "Unnamed";
  // Card "description" + "personality" both describe the character.
  c.personality = [d.description, d.personality].filter((x) => x && x.trim()).join("\n\n");
  c.scenario = d.scenario ?? "";
  c.greeting = d.first_mes ?? "";
  c.exampleDialogue = (d.mes_example ?? "").replace(/<START>\s*/gi, "").trim();
  c.tags = Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === "string").slice(0, 8) : [];
  c.tagline = d.extensions?.talkdude?.tagline ?? (d.creator_notes ?? "").split("\n")[0].slice(0, 60);
  c.avatar = avatar ?? d.extensions?.talkdude?.avatar ?? "🙂";
  const td = d.extensions?.talkdude;
  if (td) {
    c.traits = Array.isArray(td.traits) ? td.traits.filter((t: unknown) => typeof t === "string") : [];
    c.relation = typeof td.relation === "string" ? td.relation : "";
    c.style = Array.isArray(td.style) ? td.style.filter((t: unknown) => typeof t === "string") : [];
    // Our own export puts the quick picks in the description; don't duplicate them.
    const quick = quickProfile({ ...c, name: "{{char}}" }, "{{user}}");
    if (quick && c.personality.startsWith(quick)) c.personality = c.personality.slice(quick.length).trim();
  }
  return c;
}

/** Reads the "chara" (V2) or "ccv3" tEXt chunk from a character-card PNG. */
async function readPngCard(bytes: Uint8Array): Promise<CardData | null> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) return null;
  let pos = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder("latin1");
  let found: string | null = null;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = latin1.decode(bytes.subarray(pos + 4, pos + 8));
    if (type === "tEXt") {
      const chunk = bytes.subarray(pos + 8, pos + 8 + len);
      const nul = chunk.indexOf(0);
      const key = latin1.decode(chunk.subarray(0, nul));
      if (key === "chara" || key === "ccv3") {
        found = latin1.decode(chunk.subarray(nul + 1));
        if (key === "ccv3") break;
      }
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!found) return null;
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(found), (ch) => ch.charCodeAt(0))));
  return (json.data ?? json) as CardData;
}

/** Downscales an image file to a small square avatar data URL. */
export function imageToAvatar(file: Blob, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/webp", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read the image.")); };
    img.src = url;
  });
}

/** Imports a character from a Character Card V2/V3 JSON or PNG file. */
export async function importCharacterFile(file: File): Promise<Character> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data: CardData | null = null;
  let avatar: string | undefined;
  if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
    data = await readPngCard(bytes);
    if (!data) throw new Error("This PNG has no character card inside.");
    avatar = await imageToAvatar(file).catch(() => undefined);
  } else {
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes));
      data = (json.data ?? json) as CardData;
    } catch {
      throw new Error("This file is not a character card (JSON or PNG).");
    }
  }
  if (!data || !(data.name || data.first_mes || data.description)) throw new Error("This file is not a character card.");
  return saveCharacter(cardToCharacter(data, avatar));
}

export async function exportCharacter(c: Character): Promise<SaveResult> {
  const card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: c.name,
      description: [quickProfile({ ...c, name: "{{char}}" }, "{{user}}"), c.personality].filter(Boolean).join("\n\n"),
      personality: "",
      scenario: c.scenario,
      first_mes: c.greeting,
      mes_example: c.exampleDialogue ? `<START>\n${c.exampleDialogue}` : "",
      creator_notes: c.tagline,
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: c.tags,
      creator: "talkdude",
      character_version: "1",
      extensions: { talkdude: { avatar: c.avatar, tagline: c.tagline, traits: c.traits ?? [], relation: c.relation ?? "", style: c.style ?? [] } },
    },
  };
  const safe = c.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "character";
  return saveTextToDownloads(`${safe}.card.json`, JSON.stringify(card, null, 2), "application/json");
}
