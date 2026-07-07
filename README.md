<div align="center">
  <img src="dist/logo.svg" width="72" alt="CozyCode">
  <h1>CozyCode</h1>
  <p><b>A cozy, lightweight code editor.</b> Rust + Tauri rework of VS Code (Code - OSS).</p>
  <p>Feature parity with VS Code, a fraction of the RAM, and <b>zero telemetry</b>.</p>
</div>

## Why

VS Code is great but heavy — Electron plus a handful of Node processes idle around **1–1.5 GB**. CozyCode keeps the parts developers love (the Monaco editor, the workbench UX, Source Control, extensions) but runs the backend in Rust on Tauri (WebView2), idling around **~350 MB** with a **~10 MB** binary.

## Features

- **Editor** — Monaco (same core as VS Code), tabs with preview/pin, multi-language syntax, minimap, zoom (Ctrl +/−/0)
- **Explorer** — file tree with [vscode-icons](https://github.com/vscode-icons/vscode-icons), ripgrep search, quick open (Ctrl+P)
- **Source Control** — multi-repo, REPOSITORIES / CHANGES / GRAPH layout, diff, stage/discard, commit, merge, push/pull, Pull Requests, **AI-generated commit messages**
- **Terminal** — auto-detected shells (pwsh, cmd, Git Bash, WSL, zsh/bash), split, drag-reorder, per-terminal kill
- **Extensions** — install from [Open VSX](https://open-vsx.org), color themes, a lightweight extension host (completions, diagnostics)
- **Remote** — built-in SSH (SFTP edit, port forwarding), public tunnels (cloudflared/ngrok/tailscale)
- **AI** — Claude panel (Chat API + Claude Code CLI); commit-message generation across Anthropic / OpenAI / OpenRouter / z.ai / Groq / Ollama
- **More** — Problems panel, Ports, Settings & Keybindings UI, GitHub OAuth device-flow sign-in, media viewers (image / video / PDF / CSV / XLSX), Save-with-Encoding, hot-exit (unsaved files survive restart)
- **No telemetry** — nothing leaves your machine

## Build from source

Requires the Rust toolchain and, on Windows, MSVC Build Tools + WebView2.

```sh
cd src-tauri
cargo build --release
# binary: src-tauri/target/release/cozycode.exe
```

Dev run: `cargo run` (from `src-tauri/`).

## Layout

- `src-tauri/` — Rust backend + Tauri config (fs, git, pty, ssh, extension host, AI, tunnels)
- `dist/` — frontend (Monaco workbench UI, no build step)

## License

MIT. Based on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft. Not affiliated with or endorsed by Microsoft.
