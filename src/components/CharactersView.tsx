import { For, Show, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import type { Character } from "../lib/db";
import {
  allCharacters, setCharactersViewOpen, saveCharacter, deleteCharacter, duplicateCharacter,
  emptyCharacter, importCharacterFile, exportCharacter, imageToAvatar, fillNames,
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
        <span class="md-typescale-title-medium chat-topbar-title brand-name">characters</span>
        <div class="topbar-spacer" />
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
          <div class="characters-actions">
            <md-filled-button type="button" onClick={() => setEditing(emptyCharacter())}>
              <md-icon slot="icon">add</md-icon>
              Create
            </md-filled-button>
            <button type="button" class="login-text-btn login-text-btn-primary" onClick={() => importRef?.click()}>
              Import card
            </button>
            <input ref={importRef} type="file" accept=".json,.png,application/json,image/png" style="display:none" onChange={handleImport} />
          </div>
        </div>

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
                <Show when={!c.builtIn}><span class="mine-badge">MINE</span></Show>
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
            <div class="apikey-dialog-backdrop" onClick={() => setDetail(null)}>
              <div class="apikey-dialog character-detail" onClick={(e) => e.stopPropagation()}>
                <div class="character-detail-head">
                  <CharacterAvatar avatar={d().avatar} size={72} />
                  <div>
                    <h2 class="md-typescale-headline-small">{d().name}</h2>
                    <p class="md-typescale-body-medium settings-help">{d().tagline}</p>
                  </div>
                </div>
                <Show when={d().greeting}>
                  <div class="character-greeting md-typescale-body-medium">{fillNames(d().greeting, d().name)}</div>
                </Show>
                <div class="character-tags">
                  <For each={d().tags}>{(t) => <span class="category-chip small">{t}</span>}</For>
                </div>
                <div class="settings-row character-detail-actions">
                  <md-filled-button type="button" onClick={() => chat(d())}>
                    <md-icon slot="icon">chat</md-icon>
                    Chat
                  </md-filled-button>
                  <button type="button" class="login-text-btn login-text-btn-primary" onClick={() => { setEditing(d().builtIn ? duplicateCharacter(d()) : { ...d(), tags: [...d().tags] }); setDetail(null); }}>
                    {d().builtIn ? "Remix" : "Edit"}
                  </button>
                  <button type="button" class="login-text-btn" onClick={async () => showToast((await exportCharacter(d())).message)}>Export card</button>
                  <Show when={!d().builtIn}>
                    <button type="button" class="login-text-btn login-text-btn-danger" onClick={async () => { await deleteCharacter(d().id); setDetail(null); showToast("Character deleted"); }}>Delete</button>
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

function CharacterEditor(props: { initial: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const [c, setC] = createSignal<Character>({ ...props.initial, tags: [...props.initial.tags] });
  const [tagsText, setTagsText] = createSignal(props.initial.tags.join(", "));
  const [error, setError] = createSignal<string | null>(null);
  let avatarRef: HTMLInputElement | undefined;

  const set = <K extends keyof Character>(k: K, v: Character[K]) => setC({ ...c(), [k]: v });

  const pickAvatar = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try { set("avatar", await imageToAvatar(file)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const save = async (ev: Event) => {
    ev.preventDefault();
    const cur = c();
    if (!cur.name.trim()) { setError("Give your character a name."); return; }
    if (!cur.personality.trim()) { setError("Describe the character's personality."); return; }
    const saved = await saveCharacter({
      ...cur,
      name: cur.name.trim(),
      tagline: cur.tagline.trim().slice(0, 80),
      tags: tagsText().split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
    });
    props.onSaved(saved);
  };

  const isImage = () => c().avatar.startsWith("data:");

  return (
    <Portal>
      <div class="apikey-dialog-backdrop" onClick={props.onClose}>
        <form class="apikey-dialog settings-dialog character-editor" onClick={(e) => e.stopPropagation()} onSubmit={save}>
          <div class="settings-head">
            <h2 class="md-typescale-headline-small apikey-dialog-title">{props.initial.createdAt ? "Edit character" : "New character"}</h2>
            <md-icon-button type="button" aria-label="Close" onClick={props.onClose}><md-icon>close</md-icon></md-icon-button>
          </div>
          <div class="settings-body settings-form">
            <div class="editor-avatar-row">
              <CharacterAvatar avatar={c().avatar} size={64} />
              <label class="settings-field editor-emoji">
                <span class="md-typescale-label-medium">Avatar emoji</span>
                <input class="api-key-input" maxLength={4} value={isImage() ? "" : c().avatar} placeholder={isImage() ? "(image)" : "🙂"} onInput={(e) => e.currentTarget.value && set("avatar", e.currentTarget.value)} />
              </label>
              <button type="button" class="login-text-btn login-text-btn-primary" onClick={() => avatarRef?.click()}>Upload image</button>
              <input ref={avatarRef} type="file" accept="image/*" style="display:none" onChange={pickAvatar} />
            </div>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Name</span>
              <input class="api-key-input" value={c().name} onInput={(e) => set("name", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Tagline (shown under the name)</span>
              <input class="api-key-input" maxLength={80} value={c().tagline} onInput={(e) => set("tagline", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Personality &amp; backstory</span>
              <textarea class="api-key-input settings-textarea" rows={5} placeholder="Who is {{char}}? How do they talk, what do they like, how do they treat {{user}}?" value={c().personality} onInput={(e) => set("personality", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Scenario (optional)</span>
              <textarea class="api-key-input settings-textarea" rows={2} placeholder="Where and when does the chat take place?" value={c().scenario} onInput={(e) => set("scenario", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Greeting (first message)</span>
              <textarea class="api-key-input settings-textarea" rows={3} value={c().greeting} onInput={(e) => set("greeting", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Example dialogue (optional)</span>
              <textarea class="api-key-input settings-textarea" rows={3} placeholder={"{{user}}: Hi!\n{{char}}: *waves* Hey there!"} value={c().exampleDialogue} onInput={(e) => set("exampleDialogue", e.currentTarget.value)} />
            </label>
            <label class="settings-field">
              <span class="md-typescale-label-medium">Tags (comma separated)</span>
              <input class="api-key-input" placeholder="Comfort, Adventure, Learning, Fun, Mystery, Roleplay" value={tagsText()} onInput={(e) => setTagsText(e.currentTarget.value)} />
            </label>
            <p class="md-typescale-body-small settings-help">Tip: write {"{{char}}"} for the character's name and {"{{user}}"} for yours (set your name under Settings → Persona).</p>
            <Show when={error()}><div class="login-error md-typescale-body-small">{error()}</div></Show>
            <div class="settings-row">
              <md-filled-button type="submit">
                <md-icon slot="icon">save</md-icon>
                Save
              </md-filled-button>
              <button type="button" class="login-text-btn" onClick={props.onClose}>Cancel</button>
            </div>
          </div>
        </form>
      </div>
    </Portal>
  );
}
