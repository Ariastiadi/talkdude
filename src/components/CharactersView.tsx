import { renderMarkdown } from "../lib/markdown";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { Character } from "../lib/db";
import {
  allCharacters, setCharactersViewOpen, saveCharacter, deleteCharacter, duplicateCharacter,
  emptyCharacter, importCharacterFile, exportCharacter, imageToAvatar, fillNames,
  resetCharacter, pendingCharacterId, setPendingCharacterId, getCharacter,
  TRAIT_OPTIONS, RELATION_OPTIONS, STYLE_OPTIONS,
} from "../lib/stores/characters";
import { startCharacterChat } from "../lib/stores/chat";
import { setSidebarOpen, sidebarOpen } from "../App";
import "./CharactersView.css";

// === Avatar ===

export function CharacterAvatar(props: { avatar?: string; size?: number; class?: string }) {
  const size = () => props.size ?? 40;
  const isImage = () => !!props.avatar && (props.avatar.startsWith("data:") || props.avatar.startsWith("http"));
  return (
    <div
      class={`char-avatar ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${Math.round(size() * 0.55)}px` }}
    >
      <Show when={isImage()} fallback={<span>{props.avatar || "🙂"}</span>}>
        <img src={props.avatar} alt="" />
      </Show>
    </div>
  );
}

// === Gallery ===

const CATEGORIES = ["All", "Mine", "Comfort", "Adventure", "Learning", "Fun", "Mystery", "Roleplay"];

export default function CharactersView() {
  const [query, setQuery] = createSignal("");
  const [category, setCategory] = createSignal("All");
  const [detail, setDetail] = createSignal<Character | null>(null);
  const [editing, setEditing] = createSignal<Character | null>(null);
  const [toast, setToast] = createSignal<string | null>(null);
  let importRef: HTMLInputElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const showToast = (m: string) => {
    setToast(m);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 3500);
  };

  const list = createMemo(() => {
    const q = query().toLowerCase().trim();
    const cat = category();
    return allCharacters().filter((c) => {
      if (cat === "Mine" && c.builtIn) return false;
      if (cat !== "All" && cat !== "Mine" && !c.tags.some((t) => t.toLowerCase() === cat.toLowerCase())) return false;
      if (!q) return true;
      return [c.name, c.tagline, ...c.tags].some((s) => s.toLowerCase().includes(q));
    });
  });

  onMount(() => {
    const id = pendingCharacterId();
    if (id) { setPendingCharacterId(null); const c = getCharacter(id); if (c) setDetail(c); }
  });

  const chat = async (c: Character) => {
    setDetail(null);
    setCharactersViewOpen(false);
    await startCharacterChat(c.id);
  };

  const handleImport = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const c = await importCharacterFile(file);
      showToast(`${c.name} imported`);
      setDetail(c);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Import failed");
    }
  };

  return (
    <div class="characters-view">
      <div class="chat-topbar">
        <md-icon-button class="sidebar-toggle" type="button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((prev) => !prev)}>
          <md-icon>{sidebarOpen() ? "menu_open" : "menu"}</md-icon>
        </md-icon-button>
        <div class="topbar-titles">
          <span class="md-typescale-title-medium chat-topbar-title">Characters</span>
          <span class="topbar-sub md-typescale-body-small">Pick someone to talk to</span>
        </div>
        <md-icon-button type="button" aria-label="Import character card" onClick={() => importRef?.click()}>
          <md-icon>upload_file</md-icon>
        </md-icon-button>
        <md-icon-button type="button" aria-label="Close" onClick={() => setCharactersViewOpen(false)}>
          <md-icon>close</md-icon>
        </md-icon-button>
      </div>

      <div class="characters-scroll">
        <div class="characters-head">
          <div class="characters-search">
            <md-icon>search</md-icon>
            <input placeholder="Search characters…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          </div>
          <button type="button" class="td-btn td-btn-primary characters-create" onClick={() => setEditing(emptyCharacter())}>
            <md-icon>add</md-icon>
            <span>Create</span>
          </button>
          <input ref={importRef} type="file" accept=".json,.png,application/json,image/png" style="display:none" onChange={handleImport} />
        </div>

        <Show when={!query() && category() === "All"}>
          <button type="button" class="create-hero" onClick={() => setEditing(emptyCharacter())}>
            <div class="create-hero-art" aria-hidden="true"><span /><span /><span /></div>
            <div class="create-hero-text">
              <div class="create-hero-title">Create a Chat AI</div>
              <div class="md-typescale-body-medium create-hero-sub">Give it a name, a face and a personality. A new friend, a story character, anyone you like.</div>
            </div>
            <md-icon class="create-hero-go">arrow_forward</md-icon>
          </button>
        </Show>

        <div class="category-chips">
          <For each={CATEGORIES}>
            {(cat) => (
              <button type="button" class={`category-chip ${category() === cat ? "active" : ""}`} onClick={() => setCategory(cat)}>{cat}</button>
            )}
          </For>
        </div>

        <div class="characters-grid">
          <For each={list()}>
            {(c) => (
              <button type="button" class="character-card" onClick={() => setDetail(c)}>
                <CharacterAvatar avatar={c.avatar} size={56} />
                <div class="character-card-text">
                  <div class="md-typescale-title-small character-name">{c.name}</div>
                  <div class="md-typescale-body-small character-tagline">{c.tagline}</div>
                </div>
                <Show when={!c.builtIn || c.customized}><span class="mine-badge">{c.builtIn ? "EDITED" : "MINE"}</span></Show>
              </button>
            )}
          </For>
        </div>
        <Show when={list().length === 0}>
          <p class="md-typescale-body-medium characters-empty">No characters here yet. Create one or import a character card.</p>
        </Show>
      </div>

      {/* Detail sheet */}
      <Show when={detail()}>
        {(d) => (
          <Portal>
            <div class="td-sheet-backdrop" onClick={() => setDetail(null)}>
              <div class="td-sheet character-detail" onClick={(e) => e.stopPropagation()}>
                <div class="character-detail-head">
                  <CharacterAvatar avatar={d().avatar} size={72} />
                  <div class="character-detail-titles">
                    <h2 class="md-typescale-headline-small">{d().name}</h2>
                    <p class="md-typescale-body-medium settings-help">{d().tagline}</p>
                  </div>
                </div>
                <Show when={d().greeting}>
                  <div class="character-greeting md-typescale-body-medium message-text" innerHTML={renderMarkdown(fillNames(d().greeting, d().name))} />
                </Show>
                <div class="character-tags">
                  <Show when={d().relation}><span class="category-chip small active">{d().relation}</span></Show>
                  <For each={d().traits ?? []}>{(t) => <span class="category-chip small">{t}</span>}</For>
                  <For each={d().tags}>{(t) => <span class="category-chip small">{t}</span>}</For>
                </div>
                <button type="button" class="td-btn td-btn-primary td-btn-block" onClick={() => chat(d())}>
                  <md-icon>chat</md-icon>
                  <span>Chat with {d().name}</span>
                </button>
                <div class="character-detail-actions">
                  <button type="button" class="td-btn td-btn-outline td-btn-sm" onClick={() => { setEditing({ ...d(), tags: [...d().tags] }); setDetail(null); }}>
                    <md-icon>edit</md-icon>
                    <span>Edit</span>
                  </button>
                  <button type="button" class="td-btn td-btn-outline td-btn-sm" onClick={() => { setEditing(duplicateCharacter(d())); setDetail(null); }}>
                    <md-icon>content_copy</md-icon>
                    <span>Copy</span>
                  </button>
                  <button type="button" class="td-btn td-btn-outline td-btn-sm" onClick={async () => showToast((await exportCharacter(d())).message)}>
                    <md-icon>ios_share</md-icon>
                    <span>Export</span>
                  </button>
                  <Show when={d().builtIn && d().customized}>
                    <button type="button" class="td-btn td-btn-outline td-btn-sm" onClick={async () => { const o = await resetCharacter(d().id); setDetail(o ?? null); showToast("Restored the original"); }}>
                      <md-icon>restart_alt</md-icon>
                      <span>Reset</span>
                    </button>
                  </Show>
                  <Show when={!d().builtIn}>
                    <button type="button" class="td-btn td-btn-danger td-btn-sm" onClick={async () => { await deleteCharacter(d().id); setDetail(null); showToast("Character deleted"); }}>
                      <md-icon>delete</md-icon>
                      <span>Delete</span>
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>

      <Show when={editing()}>
        {(e) => <CharacterEditor initial={e()} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); setDetail(c); showToast(`${c.name} saved`); }} />}
      </Show>

      <Show when={toast()}>
        <Portal><div class="sidebar-toast md-typescale-body-medium">{toast()}</div></Portal>
      </Show>
    </div>
  );
}

// === Editor ===
// New characters get a short guided flow (who → personality → first message);
// editing shows every field on one page. Built-ins are editable too.

const QUICK_EMOJIS = ["🙂", "😎", "🥰", "🤖", "🧙", "🦊", "🐱", "👩🏻", "👨🏻", "🧛", "🧚", "🦸", "👻", "🐉", "🌸", "⭐"];

function ChipPicker(props: { options: string[]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div class="chip-picker">
      <For each={props.options}>
        {(o) => (
          <button type="button" class={`category-chip ${props.selected.includes(o) ? "active" : ""}`} onClick={() => props.onToggle(o)}>{o}</button>
        )}
      </For>
    </div>
  );
}

function CharacterEditor(props: { initial: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const isNew = !props.initial.createdAt && !props.initial.id.startsWith("builtin-");
  const [c, setC] = createSignal<Character>({
    ...props.initial,
    tags: [...props.initial.tags],
    traits: [...(props.initial.traits ?? [])],
    style: [...(props.initial.style ?? [])],
    relation: props.initial.relation ?? "",
  });
  const [tagsText, setTagsText] = createSignal(props.initial.tags.join(", "));
  const [error, setError] = createSignal<string | null>(null);
  const [step, setStep] = createSignal(0);
  const [showAdvanced, setShowAdvanced] = createSignal(!isNew);
  let avatarRef: HTMLInputElement | undefined;

  const STEPS = ["Who", "Personality", "First message"];
  const set = <K extends keyof Character>(k: K, v: Character[K]) => setC({ ...c(), [k]: v });
  const toggle = (k: "traits" | "style", v: string) => {
    const cur = c()[k] ?? [];
    set(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v].slice(0, 6));
  };

  const pickAvatar = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try { set("avatar", await imageToAvatar(file)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const validate = (upTo: number): string | null => {
    const cur = c();
    if (upTo >= 0 && !cur.name.trim()) return "Give your character a name.";
    if (upTo >= 1 && !cur.personality.trim() && !(cur.traits?.length)) return "Pick a few traits or describe the personality.";
    return null;
  };

  const next = () => {
    const err = validate(step());
    setError(err);
    if (!err) setStep(step() + 1);
  };

  const save = async (ev?: Event) => {
    ev?.preventDefault();
    const err = validate(2);
    setError(err);
    if (err) return;
    const cur = c();
    const saved = await saveCharacter({
      ...cur,
      name: cur.name.trim(),
      tagline: cur.tagline.trim().slice(0, 80),
      relation: (cur.relation ?? "").trim(),
      tags: tagsText().split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
    });
    props.onSaved(saved);
  };

  const isImage = () => c().avatar.startsWith("data:");
  const showSection = (n: number) => !isNew || step() === n;

  return (
    <Portal>
      <div class="apikey-dialog-backdrop" onClick={props.onClose}>
        <form class="apikey-dialog settings-dialog character-editor" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (isNew && step() < STEPS.length - 1) next(); else void save(); }}>
          <div class="settings-head">
            <h2 class="md-typescale-headline-small apikey-dialog-title">{isNew ? "Create a Chat AI" : `Edit ${props.initial.name || "character"}`}</h2>
            <md-icon-button type="button" aria-label="Close" onClick={props.onClose}><md-icon>close</md-icon></md-icon-button>
          </div>
          <Show when={isNew}>
            <div class="creator-steps">
              <For each={STEPS}>
                {(label, i) => (
                  <button type="button" class={`creator-step ${i() === step() ? "active" : ""} ${i() < step() ? "done" : ""}`}
                    onClick={() => { if (i() <= step() || !validate(i() - 1)) { setError(null); setStep(i()); } }}>
                    <span class="creator-step-dot">{i() < step() ? "✓" : i() + 1}</span>
                    <span>{label}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="settings-body settings-form">
            {/* Who */}
            <Show when={showSection(0)}>
              <div class="creator-avatar-block">
                <button type="button" class="creator-avatar" onClick={() => avatarRef?.click()} aria-label="Choose a photo">
                  <CharacterAvatar avatar={c().avatar} size={104} />
                  <span class="creator-avatar-badge"><md-icon>photo_camera</md-icon></span>
                </button>
                <input ref={avatarRef} type="file" accept="image/*" style="display:none" onChange={pickAvatar} />
                <div class="creator-emoji-row">
                  <For each={QUICK_EMOJIS}>
                    {(e) => <button type="button" class={`creator-emoji ${c().avatar === e ? "active" : ""}`} onClick={() => set("avatar", e)}>{e}</button>}
                  </For>
                  <input class="creator-emoji-input" maxLength={4} placeholder="✏️" aria-label="Any emoji" value={isImage() || QUICK_EMOJIS.includes(c().avatar) ? "" : c().avatar} onInput={(e) => e.currentTarget.value && set("avatar", e.currentTarget.value)} />
                </div>
                <span class="md-typescale-body-small settings-help">Tap the circle to use a photo, or pick an emoji.</span>
              </div>
              <label class="settings-field">
                <span class="md-typescale-label-medium">Name</span>
                <input class="api-key-input" maxLength={40} placeholder="e.g. Nara" value={c().name} onInput={(e) => set("name", e.currentTarget.value)} />
              </label>
              <label class="settings-field">
                <span class="md-typescale-label-medium">Short description</span>
                <input class="api-key-input" maxLength={80} placeholder="e.g. Your sarcastic best friend from college" value={c().tagline} onInput={(e) => set("tagline", e.currentTarget.value)} />
              </label>
            </Show>

            {/* Personality */}
            <Show when={showSection(1)}>
              <div class="settings-field">
                <span class="md-typescale-label-medium">Personality (pick up to 6)</span>
                <ChipPicker options={TRAIT_OPTIONS} selected={c().traits ?? []} onToggle={(v) => toggle("traits", v)} />
              </div>
              <div class="settings-field">
                <span class="md-typescale-label-medium">{c().name.trim() || "They"} {c().name.trim() ? "is" : "are"} your…</span>
                <ChipPicker options={RELATION_OPTIONS} selected={c().relation ? [c().relation!] : []} onToggle={(v) => set("relation", c().relation === v ? "" : v)} />
              </div>
              <div class="settings-field">
                <span class="md-typescale-label-medium">How they talk</span>
                <ChipPicker options={STYLE_OPTIONS} selected={c().style ?? []} onToggle={(v) => toggle("style", v)} />
              </div>
              <label class="settings-field">
                <span class="md-typescale-label-medium">Describe them in your own words</span>
                <textarea class="api-key-input settings-textarea" rows={5} placeholder="Background, looks, likes and dislikes, how they treat {{user}}, things they always say…" value={c().personality} onInput={(e) => set("personality", e.currentTarget.value)} />
              </label>
            </Show>

            {/* First message */}
            <Show when={showSection(2)}>
              <label class="settings-field">
                <span class="md-typescale-label-medium">First message</span>
                <textarea class="api-key-input settings-textarea" rows={4} placeholder={"*looks up and smiles* Hey {{user}}! Where have you been?"} value={c().greeting} onInput={(e) => set("greeting", e.currentTarget.value)} />
              </label>
              <label class="settings-field">
                <span class="md-typescale-label-medium">Scenario (optional)</span>
                <textarea class="api-key-input settings-textarea" rows={2} placeholder="Where and when does the chat take place?" value={c().scenario} onInput={(e) => set("scenario", e.currentTarget.value)} />
              </label>
              <button type="button" class="td-btn td-btn-ghost td-btn-sm creator-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced())}>
                <md-icon>{showAdvanced() ? "expand_less" : "expand_more"}</md-icon><span>Advanced</span>
              </button>
              <Show when={showAdvanced()}>
                <label class="settings-field">
                  <span class="md-typescale-label-medium">Example dialogue</span>
                  <textarea class="api-key-input settings-textarea" rows={3} placeholder={"{{user}}: Hi!\n{{char}}: *waves* Hey there!"} value={c().exampleDialogue} onInput={(e) => set("exampleDialogue", e.currentTarget.value)} />
                </label>
                <label class="settings-field">
                  <span class="md-typescale-label-medium">Tags (comma separated)</span>
                  <input class="api-key-input" placeholder="Comfort, Adventure, Learning, Fun, Mystery, Roleplay" value={tagsText()} onInput={(e) => setTagsText(e.currentTarget.value)} />
                </label>
                <p class="md-typescale-body-small settings-help">Tip: {"{{char}}"} becomes the character's name and {"{{user}}"} yours (set it in Settings → Persona).</p>
              </Show>
            </Show>

            <Show when={error()}><div class="login-error md-typescale-body-small">{error()}</div></Show>
          </div>

          <div class="creator-actions">
            <Show when={isNew && step() > 0} fallback={<button type="button" class="td-btn td-btn-ghost" onClick={props.onClose}><span>Cancel</span></button>}>
              <button type="button" class="td-btn td-btn-ghost" onClick={() => { setError(null); setStep(step() - 1); }}><md-icon>arrow_back</md-icon><span>Back</span></button>
            </Show>
            <Show when={isNew && step() < STEPS.length - 1} fallback={
              <button type="submit" class="td-btn td-btn-primary"><md-icon>{isNew ? "auto_awesome" : "save"}</md-icon><span>{isNew ? "Create" : "Save"}</span></button>
            }>
              <button type="submit" class="td-btn td-btn-primary"><span>Next</span><md-icon>arrow_forward</md-icon></button>
            </Show>
          </div>
        </form>
      </div>
    </Portal>
  );
}
