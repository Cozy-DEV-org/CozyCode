<div align="center">
  <img src="src-tauri/icons/cozycode.png" width="96" alt="CozyCode">
  <h1>CozyCode</h1>
  <p><b>The cozy, lightweight editor built for vibe coding.</b></p>
  <p>A Rust + Tauri rework of VS Code — full workbench, a fraction of the RAM, <b>zero telemetry</b>, an <b>AI-native workflow</b>, and real language servers, formatting, and themes built in.</p>
  <p>
    <a href="https://github.com/Cozy-DEV-org/CozyCode/releases/latest"><b>⬇ Download</b></a> ·
    <a href="docs/Writing-Extensions.md">Write an extension</a> ·
    <a href="https://github.com/Cozy-DEV-org/CozyCode-Extensions">Get extensions</a>
  </p>
</div>

---

## What makes CozyCode different

CozyCode keeps everything you love about VS Code (the Monaco editor, the workbench, Source Control) but runs the backend in **Rust on Tauri (WebView2)** instead of Electron:

| | VS Code | CozyCode |
|---|---|---|
| Idle RAM | ~1–1.5 GB | **~350 MB** |
| Installer | ~90+ MB | **~6 MB** |
| Telemetry | on by default | **none, ever** |
| AI workflow | extension | **built in** |
| Formatter · themes · LSP | install extensions | **built in / one-click** |

Then it goes further — purpose-built for **vibe coding**: an AI pair right in the editor, reading AI-generated Markdown like a knowledge base, and everything you need (formatting, themes, language servers) already on board.

---

## Install

- **Download** the latest `.exe` (NSIS) or `.msi` from **[Releases](https://github.com/Cozy-DEV-org/CozyCode/releases/latest)**.
- **Self-update** built in — **Help → About → Check for Update** pulls and installs the next version.
- Portable: your extensions and settings live next to the executable, never in the build.

---

## Highlights

- 🤖 **AI panel built in** — AI Chat (any model, your key) + the real Claude Code CLI, right in the editor.
- 🧩 **Native extensions** — a `.cext` is plain HTML/JS in a sandbox; no VS Code, no Electron. **[Grab ready-made ones →](https://github.com/Cozy-DEV-org/CozyCode-Extensions)**
- 🧠 **Real language servers** — Lua, Roblox (Luau), and JavaScript/TypeScript LSP extensions: context-aware autocomplete, hover, signatures, and docs.
- ✨ **Built-in Prettier** — Format Document for JS/TS/JSX/TSX/JSON/CSS/HTML/Vue/Markdown/YAML/GraphQL, entirely offline (no Node/npx).
- 🎨 **326 themes built in** — the full [rainglow](https://github.com/rainglow/vscode) collection, with **live preview** as you arrow through the picker.
- 📖 **AI-native Markdown** — themed Preview + an Obsidian-style Graph View.
- 🔒 **Zero telemetry** — nothing leaves your machine.

---

## Vibe coding, first-class

### Claude Code, in the editor
A dedicated **AI panel** on the right, two modes one click apart:

- **AI Chat** — talk to any model over the Chat API. `@` to mention files, drop in selected code, attach files, paste images. Bring your own key: **Anthropic · OpenAI · OpenRouter · z.ai · Groq · Ollama**.
- **Claude Code CLI** — run the real [Claude Code](https://www.anthropic.com/claude-code) agent inside CozyCode (install the CLI once, CozyCode drives it). Multi-session, restore, kill-per-session.

> Built in — no extension, no marketplace account, no telemetry. Bring your key and go.

### AI-native Markdown
- **Markdown Preview** — right-click any `.md` → **Preview Markdown** (`Ctrl+Shift+V`). Themed headings, code, tables, blockquotes, checkboxes, images; **`[[wikilinks]]`** are clickable.
- **Graph View (Obsidian-style)** — scans the workspace for `.md`, extracts `[[wikilinks]]` + `[](file.md)`, draws an interactive force-directed graph. Hover to highlight, click to open, drag / pan / zoom.

---

## Features

### Editor & navigation
- **Monaco** (the same core as VS Code) — preview/pinned tabs, syntax for every language, minimap, zoom (`Ctrl +/−/0`).
- **Explorer** with [vscode-icons](https://github.com/vscode-icons/vscode-icons), ripgrep **Search**, **Quick Open** (`Ctrl+P`), a titlebar command center.
- **Command Palette** and a full **Keybindings** UI.

### Formatting — built-in Prettier
- **Format Document** (`Shift+Alt+F` / right-click / palette / format-on-save) runs **[Prettier](https://prettier.io)** bundled in the app — **no Node, no npx, offline**.
- Covers **JS · TS · JSX · TSX · JSON · CSS · SCSS · LESS · HTML · Vue · Markdown · YAML · GraphQL**, and respects `.prettierrc` / `package.json#prettier`.

### Themes — 326 built in
- **Color Theme** picker (Manage gear or palette) lists Dark+ / Light+, all **326 [rainglow](https://github.com/rainglow/vscode) themes**, and any theme an extension contributes.
- **Live preview**: arrow through to preview instantly, **Enter** to keep, **Esc** to revert. Themes restyle both the editor and the whole workbench.

### Language servers (LSP)
Language support comes as native extensions running real language servers over the `cozy.process` bridge — context-aware **autocomplete, hover, signatures, documentation**:
- **Lua** ([LuaLS](https://github.com/LuaLS/lua-language-server)) · **Roblox / Luau** ([RobloxLsp](https://github.com/NightrainsRbx/RobloxLsp)) · **JavaScript / TypeScript** ([typescript-language-server](https://github.com/typescript-language-server/typescript-language-server)).
- Download them from the **[CozyCode Extensions repo](https://github.com/Cozy-DEV-org/CozyCode-Extensions)**; each fetches its server on first use.

### Source Control
- Multi-repo, **REPOSITORIES / CHANGES / GRAPH**, diff, stage / discard, commit, merge, push / pull, **Pull Requests**, and **AI-generated commit messages**. GitHub sign-in.

### Terminal, Remote & Media
- **Terminal** — auto-detected shells (pwsh, cmd, Git Bash, WSL, zsh/bash), split, drag-reorder, per-terminal kill.
- **Remote** — built-in SSH (SFTP edit, port forwarding) and public tunnels (cloudflared / ngrok / tailscale).
- **Media** — image / video / PDF / CSV / XLSX viewers, Save-with-Encoding, hot-exit (unsaved files survive a restart).

### Layout & more
- Resizable sidebars & panel that track the cursor exactly, titlebar toggles for **Left / Panel / Right** (`Ctrl+Alt+B`), custom titlebar + menus, **Problems**, **Ports**.
- **Privacy** — no telemetry, no phone-home; keys and settings stay in your local profile.

---

## Extensions

CozyCode has its **own** native extension model — nothing to do with VS Code. An extension is plain **HTML/JS in a sandboxed iframe**, packaged as a single **`.cext`** (a renamed `.zip`), talking to the editor through a small `cozy` API. Views land **left / right / bottom**, commands hit the palette, icons match the theme. No Electron, no Node runtime, no build step.

- **Get extensions** → download `.cext` files from **[github.com/Cozy-DEV-org/CozyCode-Extensions](https://github.com/Cozy-DEV-org/CozyCode-Extensions)** (Lua LSP, Roblox LSP, JS/TS LSP, and more), then **Extensions view → Import Extension (.cext / .zip)**.
- **Write your own** in minutes — see **[docs/Writing-Extensions.md](docs/Writing-Extensions.md)** and the starter in [`examples/hello-cozy`](examples/hello-cozy). Language servers get a full LSP bridge (`cozy.process` + `cozy.languages`).
- A repo can even ship a `.cozycode/extensions.json` to advertise extensions to anyone who opens it.

---

## What's new

- **v0.24** — 326 built-in themes (rainglow) with live preview.
- **v0.23** — built-in Prettier (Format Document), offline, no Node.
- **v0.22** — LSP completions now show type signatures + documentation (`completionItem/resolve`).
- **v0.21** — LSP support in the extension runtime; Lua, Roblox, and JS/TS language-server extensions.
- **v0.20** — native `.cext` extension model (replacing VS Code compatibility); fixed the "Open with CozyCode" console window.
- **v0.19** — vibe-coding release: Markdown Preview + Graph View, interactive UI bridge, monochrome extension icons.

Full per-version notes on the [Releases](https://github.com/Cozy-DEV-org/CozyCode/releases) page.

---

## Build from source

Requires the [Rust toolchain](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
cd src-tauri
cargo build --release          # -> target/release/cozycode.exe
```

### Installers / cross-platform

CozyCode builds for **Windows, macOS, and Linux**. Install the Tauri CLI (`cargo install tauri-cli --version "^2"`), then:

```sh
cargo tauri build
```

- **Windows** → `.exe` (NSIS) + `.msi`
- **macOS** → `.dmg` + `.app` (universal via `--target universal-apple-darwin`)
- **Linux** → `.deb` + `.AppImage` + `.rpm`

On macOS/Linux set `bundle.targets` in `tauri.conf.json` to `"all"`; the committed config lists Windows bundlers. Self-update signing uses the key in `TAURI_SIGNING_PRIVATE_KEY`. Dev run: `cargo run` from `src-tauri/`.

## Layout

- `src-tauri/` — Rust backend + Tauri config (fs, git, pty, ssh, extension host + `cozy.process` LSP bridge, AI, tunnels, Markdown graph).
- `dist/` — frontend (Monaco workbench UI, no build step; bundled Prettier in `dist/prettier`, themes in `dist/themes`).
- `docs/` — the extension authoring guide.
- `examples/` — starter extension (`hello-cozy`) for the native `.cext` model.

## License

MIT. Based on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft. Bundles [Prettier](https://prettier.io) (MIT) and the [rainglow](https://github.com/rainglow/vscode) themes (MIT). Not affiliated with or endorsed by Microsoft. Claude Code is a product of Anthropic; CozyCode integrates the CLI you install, and is not affiliated with Anthropic.
