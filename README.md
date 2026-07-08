<div align="center">
  <img src="src-tauri/icons/cozycode.png" width="96" alt="CozyCode">
  <h1>CozyCode</h1>
  <p><b>The cozy, lightweight editor built for vibe coding.</b></p>
  <p>A Rust + Tauri rework of VS Code — full workbench, a fraction of the RAM, <b>zero telemetry</b>, and an <b>AI-native workflow with Claude Code built in</b>.</p>
</div>

---

## What makes CozyCode different

CozyCode keeps everything you love about VS Code (the Monaco editor, the workbench, Source Control, real extensions) but runs the backend in **Rust on Tauri (WebView2)** instead of Electron. The result:

| | VS Code | CozyCode |
|---|---|---|
| Idle RAM | ~1–1.5 GB | **~350 MB** |
| Binary size | ~350 MB | **~10 MB** |
| Telemetry | on by default | **none, ever** |
| AI workflow | extension | **built in** |

Then it goes further — purpose-built for **vibe coding**: staying in flow with an AI pair right in the editor, and reading AI-generated Markdown the way you'd read a knowledge base.

---

## Vibe coding, first-class

### Claude Code, in the editor
CozyCode ships a dedicated **AI panel** on the right. Two modes, one click apart:

- **AI Chat** — talk to any model over the Chat API. `@` to mention files, highlight code and drop it into chat, attach files, paste images. Bring your own key: **Anthropic · OpenAI · OpenRouter · z.ai · Groq · Ollama**.
- **Claude Code CLI** — run the real [Claude Code](https://www.anthropic.com/claude-code) agent right inside CozyCode (you install the CLI once, CozyCode drives it). Multi-session, restore, kill-per-session.

> The AI panel is **built in** — no extension to install, no marketplace account, no telemetry. Bring your key and go.

### AI-native Markdown
AI writes a lot of Markdown — plans, notes, docs. CozyCode makes it a pleasure to read:

- **📖 Markdown Preview** — built in (no extension). Right-click any `.md` → **Preview Markdown** (or `Ctrl+Shift+V`). Themed rendering: headings, code blocks, tables, blockquotes, checkboxes, images. **`[[wikilinks]]`** are clickable.
- **🕸️ Graph View (Obsidian-style)** — see how your notes and docs connect. CozyCode scans the workspace for `.md` files, extracts `[[wikilinks]]` and `[](file.md)` links, and draws an interactive force-directed graph. Hover to highlight neighbours, click a node to open it, drag / pan / zoom. Perfect for navigating an AI-built knowledge base.

---

## Everything else (full VS Code parity)

- **Editor** — Monaco (the same core as VS Code), preview/pinned tabs, syntax for every language, minimap, zoom (`Ctrl +/−/0`)
- **Explorer** — file tree with [vscode-icons](https://github.com/vscode-icons/vscode-icons), ripgrep search, Quick Open (`Ctrl+P`), a titlebar command center
- **Source Control** — multi-repo, REPOSITORIES / CHANGES / GRAPH, diff, stage / discard, commit, merge, push / pull, Pull Requests, and **AI-generated commit messages**
- **Extensions** — CozyCode's own lightweight, native model: an extension is plain HTML/JS in a sandboxed iframe, packaged as a single **`.cext`** file, talking to the editor through a small `cozy` API. Views land **left / right / bottom**, commands in the palette, with monochrome icons that match the theme. No VS Code, no Node, no build step. Write one in minutes — see [Writing Extensions](docs/Writing-Extensions.md).
- **Layout** — resizable sidebars & panel that track the cursor exactly, titlebar toggles for Left / Panel / Right (`Ctrl+Alt+B`), custom titlebar + menus
- **Terminal** — auto-detected shells (pwsh, cmd, Git Bash, WSL, zsh/bash), split, drag-reorder, per-terminal kill
- **Remote** — built-in SSH (SFTP edit, port forwarding) and public tunnels (cloudflared / ngrok / tailscale)
- **Media** — image / video / PDF / CSV / XLSX viewers, Save-with-Encoding, hot-exit (unsaved files survive a restart)
- **More** — Problems panel, Ports, Settings & Keybindings UI, GitHub sign-in, self-update from within the app (Help → About → Check for Update)
- **Privacy** — no telemetry, no phone-home. Your keys and settings stay in your local profile, never in the build.

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

- `src-tauri/` — Rust backend + Tauri config (fs, git, pty, ssh, extensions, AI, tunnels, Markdown graph)
- `dist/` — frontend (Monaco workbench UI, no build step)
- `examples/` — starter extension (`hello-cozy`) for the native `.cext` model

## License

MIT. Based on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft. Not affiliated with or endorsed by Microsoft. Claude Code is a product of Anthropic; CozyCode integrates the CLI you install, and is not affiliated with Anthropic.
