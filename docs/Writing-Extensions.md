# Writing CozyCode Extensions

> A complete guide for the community. Build an extension in minutes, package it as a
> single `.cext` file, and share it. No build tools, no SDK, no VS Code.

CozyCode extensions are **not** VS Code extensions. VS Code's extension model assumes
an Electron main process, a Node extension host, and a huge `vscode` API surface —
none of which fits CozyCode's lightweight Rust + Tauri architecture. So CozyCode has
its own small, native model designed to be **easy to write and hard to break the IDE
with**.

---

## 1. What language do I write in?

**JavaScript (plain HTML/CSS/JS).** That's the recommendation, and here's why:

- **Zero toolchain.** The CozyCode workbench is already a web UI. Your extension is
  just an HTML file with a `<script>`. No compiler, no bundler, no `npm install`, no
  `package.json` gymnastics. Save the file, re-import, done.
- **Everyone knows it.** The web platform is the largest developer community on earth.
- **It cannot touch the IDE core.** Every extension runs inside a **sandboxed
  `<iframe>`**. It has no access to the workbench DOM, to Monaco, or to CozyCode's
  internal state. It talks to CozyCode *only* through the small `cozy` API. This is a
  hard boundary enforced by the browser, not a convention you can accidentally break.

You may use TypeScript, a framework, or a bundler if you like — but then *you* run the
build and ship the compiled output. The extension CozyCode loads is always plain
web files. For most extensions, one `index.html` is all you need.

---

## 2. Anatomy of an extension

An extension is a **folder** with two required things:

```
my-extension/
├── cozy.json      ← the manifest (required)
├── index.html     ← the entry point (required)
├── icon.svg       ← optional, shown in the activity bar / list
└── ...            ← any other JS/CSS/images your entry references
```

Packaged for sharing, that folder becomes a single **`.cext`** file — which is just a
`.zip` renamed. A plain `.zip` imports identically. (See §7.)

The fastest way to start: copy [`examples/hello-cozy/`](../examples/hello-cozy) and edit it.

---

## 3. The manifest — `cozy.json`

```json
{
  "id": "yourname.my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "description": "One line about what it does.",
  "publisher": "yourname",
  "icon": "icon.svg",
  "main": "index.html",
  "contributes": {
    "views": [
      { "id": "myext.panel", "title": "My Panel", "icon": "$(rocket)", "location": "right" }
    ],
    "commands": [
      { "command": "myext.doThing", "title": "Do The Thing", "category": "My Extension" }
    ],
    "themes": [
      { "label": "My Dark Theme", "path": "themes/dark.json", "uiTheme": "vs-dark" }
    ]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | ✅ | Unique. Convention: `publisher.name`. This becomes the install folder name. |
| `name` | ✅ | Display name. |
| `version` | ✅ | Semver string. |
| `description` | | Shown in the Extensions list. |
| `icon` | | Path (relative to the folder) to an SVG/PNG. Rendered **monochrome** to match the theme, like the built-in icons. |
| `main` | | Entry HTML. Defaults to `index.html`. |
| `contributes.views` | | Panels you add to the UI. See §4. |
| `contributes.commands` | | Commands shown in the Command Palette (`F1`). |
| `contributes.themes` | | Color themes (VS Code theme JSON format — reused as-is). |

### Views

```json
{ "id": "myext.panel", "title": "My Panel", "icon": "$(rocket)", "location": "right" }
```

- `id` — unique per view; used in code and internally.
- `title` — shown as the panel header / tab.
- `icon` — a **codicon** name as `$(name)` (see https://microsoft.github.io/vscode-codicons/),
  or a path to your own SVG/PNG.
- `location` — **`left`**, **`right`**, or **`bottom`** (see §4).

### Commands

```json
{ "command": "myext.doThing", "title": "Do The Thing", "category": "My Extension" }
```

Commands appear in the palette as *“My Extension: Do The Thing”*. They run the handler
you register in code (§6). Declaring a command here makes it visible **before** any of
your views are opened.

---

## 4. Where views appear — Left / Right / Bottom

`location` maps directly to CozyCode's layout, same three spots as VS Code:

```
┌────┬──────────────┬───────────────────────────┬──────────────┬────┐
│ A  │              │                           │              │ A' │
│ c  │   LEFT       │         EDITOR            │   RIGHT      │ c  │
│ t  │  side bar    │                           │  side bar    │ t  │
│ i  │  "left"      │                           │  "right"     │ '  │
│ v  │              │                           │              │    │
│ b  ├──────────────┴───────────────────────────┴──────────────┤    │
│ a  │                   BOTTOM panel  "bottom"                 │    │
└────┴─────────────────────────────────────────────────────────┴────┘
```

- **`left`** — primary side bar (where Explorer / Search / Source Control live). Your
  view gets an **activity-bar button** on the far left; clicking it shows your panel.
- **`right`** — secondary side bar. Gets a button on the far-right activity bar. Good
  for chat / assistant / companion panels. Toggle with `Ctrl+Alt+B`.
- **`bottom`** — the panel next to Terminal / Problems. Your view gets a **tab** there.

Each view is rendered as your entry HTML in a sandboxed iframe that fills the panel.
Panels are lazy — the iframe loads the first time the view is revealed, then persists
(its state survives hide/show).

---

## 5. The host vs. view model

Your `main` HTML may run in **two situations**, and `cozy.view.isHost` tells them apart:

- **Host** (`cozy.view.isHost === true`) — a **hidden** instance loaded once at startup.
  This is your *activation*: register commands and event listeners here. It has no
  visible UI (it's `display:none`).
- **View** (`cozy.view.isHost === false`) — one instance **per visible view**, created
  when that view is revealed. `cozy.view.id` is the view's id. Render your UI here.

Structure your entry file like this:

```html
<script>
  if (cozy.view.isHost) {
    // activation: commands + listeners
    cozy.commands.register('myext.doThing', () => cozy.window.showMessage('done!'));
  } else {
    // render the panel for cozy.view.id
    document.body.innerHTML = '<h3>Hello</h3>';
  }
</script>
```

Why split it? So your commands work from the palette **even if the user never opens
your view**, while your view still renders on demand. If your extension is pure logic
with no views, only the host runs — that's fine.

---

## 6. The `cozy` API

`window.cozy` is injected before your scripts run. Everything is async (returns a
Promise) because it round-trips to the Rust backend.

### `cozy.view`
| | |
|---|---|
| `cozy.view.id` | This view's id (`''` for the host instance). |
| `cozy.view.isHost` | `true` for the hidden host instance. |

### `cozy.commands`
| | |
|---|---|
| `cozy.commands.register(id, fn)` | Register a command handler. Call in the host. `fn` may be async and may return a value. |
| `cozy.commands.execute(id, ...args)` | Run a command (yours or another extension's). Returns its result. |

### `cozy.workspace`
| | |
|---|---|
| `cozy.workspace.root()` | Absolute path of the open folder, or `''`. |
| `cozy.workspace.listDir(path)` | `[{ name, path, is_dir }]`. |

### `cozy.fs`
| | |
|---|---|
| `cozy.fs.readFile(path)` | File contents as a string. |
| `cozy.fs.writeFile(path, text)` | Write a file. |

### `cozy.window`
| | |
|---|---|
| `cozy.window.showMessage(text, ...buttons)` | Toast. With buttons, resolves the clicked index. |
| `cozy.window.showInput(prompt, value?)` | Input box. Resolves the string, or `undefined` if cancelled. |
| `cozy.window.showQuickPick(items, placeholder?)` | `items` = strings or `{ label, detail, value }`. Resolves the pick. |
| `cozy.window.openFile(path)` | Open a file in the editor. |

### `cozy.storage`  (per-extension, persistent)
| | |
|---|---|
| `cozy.storage.get(key)` | Returns the stored value (JSON), or `null`. |
| `cozy.storage.set(key, value)` | Persist a JSON-serializable value. |

### `cozy.on(event, callback)`  — events from CozyCode
| event | payload |
|---|---|
| `workspaceChanged` | `{ root }` — a folder was opened. |
| `activeFileChanged` | `{ path, languageId }` — the active editor file changed. |

Example:

```js
cozy.on('activeFileChanged', ({ path, languageId }) => {
  console.log('now editing', path, 'as', languageId);
});
```

> **Requesting more API.** The surface is intentionally small. If your extension needs
> something that isn't here, open an issue or PR — new `cozy` methods are added in
> [`dist/extensions.js`](../dist/extensions.js) (`handleCozy`) and are one small
> function each.

---

## 7. Packaging as `.cext`

A `.cext` is a zip of the extension folder (with `cozy.json` at the top). From inside
the folder:

**PowerShell (Windows)**
```powershell
Compress-Archive -Path * -DestinationPath ..\my-extension.zip -Force
Rename-Item ..\my-extension.zip ..\my-extension.cext
```

**bash / macOS / Linux**
```sh
zip -r ../my-extension.cext .
```

The `.cext` extension is purely cosmetic — users can double-check by renaming to `.zip`.
CozyCode accepts either.

---

## 8. Installing

- **From a file** — Extensions view → **Import Extension (.cext / .zip)**, or the
  Command Palette → *“Extensions: Install from File”*. Pick your `.cext`.
- Installed extensions live in `data/extensions/<id>/` next to the CozyCode executable
  (portable — nothing goes to AppData).
- Enable / disable / uninstall from the Extensions view. Changes apply immediately.

---

## 9. A workspace marketplace (`.cozycode/extensions.json`)

Any repo can advertise CozyCode extensions to anyone who opens it. Add a file at
`<workspace>/.cozycode/extensions.json`:

```json
{
  "extensions": [
    {
      "id": "acme.linter",
      "name": "Acme Linter",
      "description": "Lints Acme files.",
      "repo": "https://github.com/acme/cozy-linter",
      "download": "https://github.com/acme/cozy-linter/releases/latest/download/acme-linter.cext"
    }
  ]
}
```

When that folder is open, its entries appear in the Extensions view under **WORKSPACE
MARKETPLACE**:

- **Open Repo** — opens `repo` in the browser.
- **Install** — downloads `download` and installs it (CozyCode asks first; downloading
  is always confirmed).

`download` is optional — without it, users get an **Open Repo** link only. A bare
array (without the `extensions` wrapper) also works. This is how a community index or a
monorepo of extensions can be discovered with zero server.

---

## 10. Full example

The complete, commented starter lives in [`examples/hello-cozy/`](../examples/hello-cozy).
It contributes one right-side view and one command, and demonstrates `cozy.workspace`,
`cozy.window`, `cozy.commands`, and events. Copy it, rename the `id`, and build from there.

---

## 11. Constraints & good citizenship

- **Sandbox.** Your iframe has `allow-scripts allow-same-origin allow-forms
  allow-popups allow-downloads`. You cannot reach the parent DOM or other extensions.
- **File access** goes through `cozy.fs` and hits the same Rust backend the editor uses.
  Only touch files inside the workspace unless the user clearly asked otherwise.
- **No telemetry.** CozyCode ships zero telemetry and expects the same of extensions.
  Don't phone home. Don't collect analytics. If you must talk to a network service,
  say so in your `description` and make it opt-in.
- **Stay responsive.** The host instance shares no thread with the workbench (it's a
  separate iframe), but long CPU loops still hurt. Keep work async.

---

## 12. Contributing

CozyCode is MIT-licensed (based on Code - OSS). Extensions are yours to license as you
wish. To contribute an extension to the CozyCode org, or to extend the `cozy` API
itself, open a PR against the repo. The whole extension runtime is a single readable
file — [`dist/extensions.js`](../dist/extensions.js) — and the manifest/import logic is
[`src-tauri/src/ext_cmds.rs`](../src-tauri/src/ext_cmds.rs).
