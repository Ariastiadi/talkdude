# talkdude

An honest, laid-back AI chat companion for **Android, Windows and Linux**. Your chats stay on your device, and you can use models from many providers with your own API keys.

talkdude started as a fork of [Lumi AI](https://github.com/iamlooper/Lumi-AI) (MIT) by Looper and is now a standalone project licensed **GPL-3.0-or-later**.

## Features

- **Multi-provider**: Gemini/Gemma (Google AI Studio), Claude (Anthropic), OpenAI, Groq, OpenRouter, DeepSeek, Mistral, local Ollama, or any OpenAI-compatible server. All models live in one model picker.
- **Free, no chat limits**: talkdude never limits how much you chat. Use free tiers (Gemini, Groq, OpenRouter's free models) or run models locally with Ollama. When one model hits its provider's rate limit, talkdude automatically continues on the next model you have set up.
- **Optional content filter**: Gemini's safety filters can be switched off in Settings (every category set to `BLOCK_NONE`, for adults). Each provider's own policies still apply.
- **Nothing-style design**: monochrome black and white, red accent, dot-matrix headings (Doto font). Dark, light or follow the system.
- **Export & backup**: export a conversation to Markdown (`.md`), back up every chat to JSON and restore it any time. API keys are never written to backups.
- **Characters (Chai / Character.AI style)**: chat with characters that have their own personality, scenario, greeting and example dialogue. Browse a gallery of original starter characters, create your own (emoji or image avatar), remix the built-in ones, and import/export **Character Card V2** files (JSON or PNG, the format used by SillyTavern and Chub).
- **Persona**: tell the AI who you are once; characters use your name for `{{user}}`.
- **Swipes**: regenerate a reply and swipe between the answers (`< 2/3 >`). **Edit any AI reply** to steer the story.
- **Pinned memories**: pin up to 15 messages or notes per chat; they are always sent to the AI so it never forgets them.
- **Thinking** with adjustable levels (Gemini/Gemma models), **branching** (edit a message and switch between answers), stackable **custom instructions**.
- **File attachments**, **Google Search grounding** and **Python code execution** (Gemini models).
- **Rich Markdown**: code highlighting, LaTeX, tables.
- **Background streaming**: answers keep coming while you switch conversations.
- **100% local**: conversations are stored in IndexedDB on your device. No middleman server.

## Download

| Platform | Format | Link |
|----------|--------|------|
| Android  | APK (arm64-v8a, armeabi-v7a, x86_64, x86) | [Releases](https://github.com/Ariastiadi/talkdude/releases) |
| Windows  | EXE (NSIS), MSI | [Releases](https://github.com/Ariastiadi/talkdude/releases) |
| Linux    | AppImage, DEB, RPM | [Releases](https://github.com/Ariastiadi/talkdude/releases) |

Android: install and update with [Obtainium](https://github.com/ImranR98/Obtainium) using this repository's URL.

> **Linux (Arch/Fedora-based):** if the AppImage crashes with an EGL display error, install the `.deb` (via `debtap`) or `.rpm` instead.

## Getting started

1. Open talkdude. Enter a **Gemini API key** (free from [Google AI Studio](https://aistudio.google.com/app/apikey)) or tap *Skip for now*.
2. Go to **Settings → Other providers → Add provider**, pick a preset (Groq, OpenRouter, Claude, …), paste your API key, then **Test connection** and **Save**. For OpenRouter, tap **Fetch model list** with *free models only* ticked.
3. Pick a model from the model button at the bottom right of the message box.

**Ollama on your phone:** run Ollama on a PC in the same Wi-Fi network with `OLLAMA_HOST=0.0.0.0`, then use `http://<pc-ip>:11434/v1` as the Base URL.

## Build it yourself

Requirements: [Bun](https://bun.sh/) 1.0+, [Rust](https://www.rust-lang.org/) 1.77+, [Tauri v2](https://v2.tauri.app/) (plus the Android SDK/NDK for the APK).

```bash
bun install
bun run tauri icon app-icon.svg   # regenerate app icons
bun run tauri dev                 # development build
bun run tauri build               # desktop release build
bun run tauri android build --apk # Android
```

Releases are automatic: every push to `main` builds all platforms in GitHub Actions. If the `version` in `src-tauri/tauri.conf.json` has no release yet, a new GitHub Release with the APK, EXE/MSI and AppImage/DEB/RPM is published.

## License

talkdude © 2026 Ariastiadi — [GNU GPL v3.0 or later](LICENSE).

Based on Lumi AI © 2026 Looper (MIT). The original MIT license text and third-party asset credits are in [NOTICE.md](NOTICE.md).
