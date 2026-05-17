![Banner](assets/banner.webp)

# Lumi AI ✨

A friendly, human-like AI chatbot powered by Google's Gemini models via the Gemini API.

## Features 🌟

- **Gemini models** - Gemini 3.1 Flash Lite, Gemma 4 26B, and Gemma 4 31B
- **Thinking** - Configurable thinking levels per model
- **Branching** - Edit messages and navigate between response branches
- **Custom instructions** - Create, toggle, and stack custom instructions to personalize AI behavior
- **File attachments** - Images, PDFs, and other files as context
- **Google Search** - Grounded responses with web search integration
- **Code Execution** - Run Python code and render outputs inline
- **Markdown rendering** - Code highlighting, LaTeX, and rich formatting
- **Background streaming** - Responses continue even when switching conversations
- **Local storage** - Conversations stored locally via IndexedDB

## Supported Platforms 📲

| Platform | Format | Download |
|----------|--------|----------|
| Android | APK | [GitHub Releases](https://github.com/iamlooper/Lumi-AI/releases) |
| Windows | EXE, MSI | [GitHub Releases](https://github.com/iamlooper/Lumi-AI/releases) |
| Linux | AppImage, DEB, RPM | [GitHub Releases](https://github.com/iamlooper/Lumi-AI/releases) |

> **Linux (Arch/Fedora-based distros):** If the AppImage crashes with an EGL display error, install the `.deb` (via `debtap`) or `.rpm` (via `rpmextract`) package instead.

## Screenshots 📱

[<img src="assets/screenshots/1.webp" width=140>](assets/screenshots/1.webp)
[<img src="assets/screenshots/2.webp" width=140>](assets/screenshots/2.webp)
[<img src="assets/screenshots/3.webp" width=140>](assets/screenshots/3.webp)
[<img src="assets/screenshots/4.webp" width=140>](assets/screenshots/4.webp)
[<img src="assets/screenshots/5.webp" width=140>](assets/screenshots/5.webp)

## Requirements 📋

- [Bun](https://bun.sh/) 1.0+
- [Rust](https://www.rust-lang.org/) 1.77+
- [Tauri](https://v2.tauri.app/) v2

## Build 🔨

```bash
# Install dependencies
bun install

# Development
bun run tauri dev

# Production build
bun run tauri build
```

## Credits 👥

- [Waze](https://t.me/XelXen) - Logo Designer
- [NADER](https://t.me/NaderMagdy0) - Tester
- [Emad](https://t.me/emadseed) - Tester
- [SyntaxSpin](https://Syntaxspin) - Tester
- [inulute](https://t.me/inulute) - Tester

## License 📄

MIT License - see [LICENSE](LICENSE)
