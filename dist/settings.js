// CozyCode settings/keybindings UI, command palette, menus, GitHub account,
// AI commit-message + PR, formatter, keybinding dispatch, startup.
'use strict';

/* ================= settings store ================= */
const SETTINGS_DEFS = [
	['Editor', [
		['editor.fontSize', 'Font Size', 'number', 13],
		['editor.fontFamily', 'Font Family', 'text', 'Consolas, "Courier New", monospace'],
		['editor.tabSize', 'Tab Size', 'number', 4],
		['editor.wordWrap', 'Word Wrap', 'select', 'off', ['off', 'on', 'wordWrapColumn', 'bounded']],
		['editor.minimap', 'Minimap (off = faster)', 'bool', false],
		['editor.bracketPairColorization', 'Bracket Pair Colors (off = faster)', 'bool', false],
		['editor.indentGuides', 'Indent Guides', 'bool', true],
		['editor.formatOnSave', 'Format On Save', 'bool', false],
	]],
	['Terminal', [
		['terminal.shell', 'Default Shell (path/exe)', 'text', ''],
		['terminal.fontSize', 'Terminal Font Size', 'number', 13],
	]],
	['Formatter', [
		['formatter.command', 'Format Command ({file} = path)', 'text', 'npx prettier --write {file}'],
	]],
	['AI (Commit Message)', [
		['ai.provider', 'Provider', 'select', 'anthropic', ['anthropic', 'openai', 'openrouter', 'zai', 'groq', 'ollama', 'custom']],
		['ai.model', 'Model', 'text', 'claude-sonnet-4-5'],
		['ai.apiKey', 'API Key', 'password', ''],
		['ai.baseUrl', 'Custom Base URL (for custom provider)', 'text', ''],
	]],
	['Remote', [
		['remote.localCache', 'Local Cache Folder (save mode both/local)', 'text', ''],
	]],
	['GitHub', [
		['github.clientId', 'OAuth App Client ID (Device Flow)', 'text', ''],
	]],
	['Ports / Tunnel', [
		['tunnel.provider', 'Public Tunnel Provider', 'select', 'cloudflared', ['cloudflared', 'ngrok', 'tailscale']],
		['tunnel.token', 'Tunnel Token (ngrok authtoken / tailscale authkey)', 'password', ''],
	]],
];

const AI_PROVIDERS = {
	anthropic: { base: 'https://api.anthropic.com', anthropic: true, model: 'claude-sonnet-4-5' },
	openai: { base: 'https://api.openai.com/v1', anthropic: false, model: 'gpt-4o-mini' },
	openrouter: { base: 'https://openrouter.ai/api/v1', anthropic: false, model: 'anthropic/claude-3.5-sonnet' },
	zai: { base: 'https://api.z.ai/api/paas/v4', anthropic: false, model: 'glm-4.6' },
	groq: { base: 'https://api.groq.com/openai/v1', anthropic: false, model: 'llama-3.3-70b-versatile' },
	ollama: { base: 'http://localhost:11434/v1', anthropic: false, model: 'qwen2.5-coder' },
	custom: { base: '', anthropic: false, model: '' },
};

async function loadSettings() {
	try { state.settings = JSON.parse(await invoke('settings_read')); } catch { state.settings = {}; }
	// fill defaults
	for (const [, group] of SETTINGS_DEFS)
		for (const [key, , , def] of group)
			if (state.settings[key] === undefined) state.settings[key] = def;
}
async function persistSettings() {
	try { await invoke('settings_write', { content: JSON.stringify(state.settings, null, 2) }); } catch (e) { toast('Save settings: ' + e); }
}

function openSettings() {
	openUiTab('settings', 'Settings', el => {
		el.innerHTML = '<h2>Settings</h2>';
		for (const [group, defs] of SETTINGS_DEFS) {
			const h = document.createElement('h3'); h.textContent = group; el.appendChild(h);
			for (const [key, label, type, def, opts] of defs) {
				const row = document.createElement('div');
				row.className = 'set-row';
				const val = state.settings[key] ?? def;
				let ctrl;
				if (type === 'bool') { ctrl = document.createElement('input'); ctrl.type = 'checkbox'; ctrl.checked = !!val; }
				else if (type === 'select') { ctrl = document.createElement('select'); ctrl.innerHTML = opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join(''); }
				else { ctrl = document.createElement('input'); ctrl.type = type === 'password' ? 'password' : type === 'number' ? 'number' : 'text'; ctrl.value = val; }
				ctrl.onchange = () => {
					state.settings[key] = type === 'bool' ? ctrl.checked : type === 'number' ? +ctrl.value : ctrl.value;
					persistSettings();
					applyEditorSettings();
					if (key === 'ai.provider') { const p = AI_PROVIDERS[ctrl.value]; if (p) { state.settings['ai.model'] = p.model; state.settings['ai.baseUrl'] = p.base; persistSettings(); openSettings(); } }
				};
				const lab = document.createElement('label'); lab.textContent = label;
				row.appendChild(lab); row.appendChild(ctrl);
				el.appendChild(row);
			}
		}
		const raw = document.createElement('div');
		raw.style.marginTop = '20px';
		const rb = document.createElement('button');
		rb.className = 'set-btn';
		rb.textContent = 'Edit settings.json';
		rb.onclick = async () => { const p = await settingsFilePath(); openTextTab('settings.json', 'settings.json', JSON.stringify(state.settings, null, 2), 'json'); };
		raw.appendChild(rb);
		el.appendChild(raw);
	});
}
async function settingsFilePath() { return (await invoke('settings_read'), 'settings.json'); }

/* ================= keybindings ================= */
const DEFAULT_KEYS = {
	'workbench.quickOpen': 'Ctrl+P',
	'workbench.commandPalette': 'F1',
	'workbench.commandPalette2': 'Ctrl+Shift+P',
	'workbench.view.explorer': 'Ctrl+Shift+E',
	'workbench.view.search': 'Ctrl+Shift+F',
	'workbench.view.scm': 'Ctrl+Shift+G',
	'workbench.view.extensions': 'Ctrl+Shift+X',
	'workbench.action.terminal.toggle': 'Ctrl+`',
	'workbench.action.toggleSidebar': 'Ctrl+B',
	'workbench.action.files.openFolder': 'Ctrl+O',
	'workbench.action.files.save': 'Ctrl+S',
	'workbench.action.closeActiveEditor': 'Ctrl+W',
	'workbench.action.showProblems': 'Ctrl+Shift+M',
	'editor.action.formatDocument': 'Shift+Alt+F',
	'workbench.action.openSettings': 'Ctrl+,',
	'workbench.action.toggleClaude': 'Ctrl+Shift+A',
	'workbench.action.zoomIn': 'Ctrl+=',
	'workbench.action.zoomOut': 'Ctrl+-',
	'workbench.action.zoomReset': 'Ctrl+0',
	'workbench.action.run': 'F5',
};
function loadKeys() { try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('cozyKeys') || '{}') }; } catch { return { ...DEFAULT_KEYS }; } }
let KEYS = loadKeys();
function saveKeys() { localStorage.setItem('cozyKeys', JSON.stringify(KEYS)); }

const COMMAND_FNS = {
	'workbench.quickOpen': () => quickOpen(),
	'workbench.commandPalette': () => commandPalette(),
	'workbench.commandPalette2': () => commandPalette(),
	'workbench.view.explorer': () => switchView('explorer'),
	'workbench.view.search': () => switchView('search'),
	'workbench.view.scm': () => switchView('scm'),
	'workbench.view.extensions': () => switchView('extensions'),
	'workbench.action.terminal.toggle': () => toggleTerminal(),
	'workbench.action.toggleSidebar': () => toggleSidebar(),
	'workbench.action.files.openFolder': () => openFolder(),
	'workbench.action.files.save': () => saveActive(),
	'workbench.action.closeActiveEditor': () => state.active && closeTab(state.active),
	'workbench.action.showProblems': () => { Panel.showPanel('problems'); },
	'editor.action.formatDocument': () => formatActive(),
	'workbench.action.openSettings': () => openSettings(),
	'workbench.action.toggleClaude': () => Claude.toggleAux(),
	'workbench.action.zoomIn': () => zoomIn(),
	'workbench.action.zoomOut': () => zoomOut(),
	'workbench.action.zoomReset': () => zoomReset(),
	'workbench.action.run': () => runActiveFile(),
};

function eventToCombo(e) {
	const parts = [];
	if (e.ctrlKey) parts.push('Ctrl');
	if (e.shiftKey) parts.push('Shift');
	if (e.altKey) parts.push('Alt');
	let k = e.key;
	if (k === ' ') k = 'Space';
	else if (k.length === 1) k = k.toUpperCase();
	if (!['Control', 'Shift', 'Alt', 'Meta'].includes(k)) parts.push(k);
	return parts.join('+');
}

function openKeybindings() {
	openUiTab('keybindings', 'Keyboard Shortcuts', el => {
		el.innerHTML = '<h2>Keyboard Shortcuts</h2><div class="desc" style="margin-bottom:12px">Click a shortcut field and press the new key combination. Backspace clears.</div>';
		for (const cmd of Object.keys(DEFAULT_KEYS)) {
			const row = document.createElement('div');
			row.className = 'kb-row';
			const lab = document.createElement('span');
			lab.className = 'kb-label';
			lab.textContent = cmd;
			const inp = document.createElement('input');
			inp.value = KEYS[cmd] || '';
			inp.readOnly = true;
			inp.onkeydown = e => {
				e.preventDefault();
				if (e.key === 'Backspace') { KEYS[cmd] = ''; inp.value = ''; saveKeys(); return; }
				if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
				const combo = eventToCombo(e);
				KEYS[cmd] = combo; inp.value = combo; saveKeys();
				toast('Bound ' + cmd + ' -> ' + combo, 1500);
			};
			const reset = document.createElement('button');
			reset.className = 'inline-act';
			reset.innerHTML = '<span class="codicon codicon-discard"></span>';
			reset.title = 'Reset to default';
			reset.onclick = () => { KEYS[cmd] = DEFAULT_KEYS[cmd]; inp.value = DEFAULT_KEYS[cmd]; saveKeys(); };
			row.appendChild(lab); row.appendChild(inp); row.appendChild(reset);
			el.appendChild(row);
		}
	});
}

/* ================= palette ================= */
let paletteItems = [], paletteSel = 0;
function showPalette(items, placeholder, initial = '') {
	paletteItems = items; paletteSel = 0;
	const p = $('#palette'), input = $('#palette-input');
	p.classList.remove('hidden');
	input.placeholder = placeholder || '';
	input.value = initial;
	input.focus();
	renderPalette();
}
function hidePalette() { $('#palette').classList.add('hidden'); }
function renderPalette() {
	const q = $('#palette-input').value.toLowerCase().replace(/^>/, '').trim();
	const list = $('#palette-list');
	list.innerHTML = '';
	const filtered = paletteItems.filter(i => !q || i.label.toLowerCase().includes(q) || (i.detail || '').toLowerCase().includes(q)).slice(0, 60);
	list._filtered = filtered;
	if (paletteSel >= filtered.length) paletteSel = 0;
	filtered.forEach((item, idx) => {
		const d = document.createElement('div');
		d.className = 'palette-item' + (idx === paletteSel ? ' selected' : '');
		if (item.icon) d.innerHTML = `<span class="codicon codicon-${item.icon}"></span>`;
		else if (item.fileIcon) d.appendChild(fileIconImg(item.fileIcon));
		const l = document.createElement('span'); l.textContent = item.label; d.appendChild(l);
		if (item.detail) { const dt = document.createElement('span'); dt.className = 'dim'; dt.textContent = item.detail; d.appendChild(dt); }
		d.onclick = () => { hidePalette(); item.run(); };
		list.appendChild(d);
	});
}
$('#palette-input').addEventListener('input', e => {
	if (e.target.value.startsWith('>') && $('#palette')._mode === 'files') { $('#palette')._mode = 'commands'; paletteItems = buildCommands(); }
	paletteSel = 0; renderPalette();
});
$('#palette-input').addEventListener('keydown', e => {
	const filtered = $('#palette-list')._filtered || [];
	if (e.key === 'Escape') hidePalette();
	else if (e.key === 'ArrowDown') { paletteSel = Math.min(paletteSel + 1, filtered.length - 1); renderPalette(); e.preventDefault(); }
	else if (e.key === 'ArrowUp') { paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); e.preventDefault(); }
	else if (e.key === 'Enter' && filtered[paletteSel]) { hidePalette(); filtered[paletteSel].run(); }
});
document.addEventListener('mousedown', e => { if (!$('#palette').classList.contains('hidden') && !$('#palette').contains(e.target)) hidePalette(); });

function buildCommands() {
	const repo = $('#st-branch')._repo || state.repos[0];
	const cmds = [
		{ label: 'Preferences: Open Settings', icon: 'settings-gear', detail: KEYS['workbench.action.openSettings'], run: openSettings },
		{ label: 'Preferences: Keyboard Shortcuts', icon: 'record-keys', run: openKeybindings },
		{ label: 'Preferences: Color Theme', icon: 'symbol-color', run: pickTheme },
		{ label: 'File: Open Folder...', icon: 'folder-opened', detail: KEYS['workbench.action.files.openFolder'], run: () => openFolder() },
		{ label: 'File: Save', icon: 'save', run: saveActive },
		{ label: 'File: New File', icon: 'new-file', run: newFile },
		{ label: 'View: Explorer', icon: 'files', run: () => switchView('explorer') },
		{ label: 'View: Search', icon: 'search', run: () => switchView('search') },
		{ label: 'View: Source Control', icon: 'source-control', run: () => switchView('scm') },
		{ label: 'View: Extensions', icon: 'extensions', run: () => switchView('extensions') },
		{ label: 'View: Problems', icon: 'error', run: () => Panel.showPanel('problems') },
		{ label: 'View: Remote SSH', icon: 'remote', run: () => switchView('remote') },
		{ label: 'Terminal: New Terminal', icon: 'terminal', run: () => Panel.newTerminal(false) },
		{ label: 'Terminal: Split Terminal', icon: 'split-horizontal', run: () => Panel.newTerminal(true) },
		{ label: 'Format Document', icon: 'symbol-namespace', detail: KEYS['editor.action.formatDocument'], run: formatActive },
		{ label: 'Ports: Focus on Ports View', icon: 'plug', run: () => Panel.showPanel('ports') },
		{ label: 'Remote-SSH: Add New SSH Host', icon: 'add', run: () => Remote.editConn(null) },
		{ label: 'Accounts: Sign in with GitHub', icon: 'github', run: githubLogin },
		{ label: "Shell Command: Install 'cozy' command in PATH", icon: 'terminal', run: async () => { try { toast(await invoke('install_cli'), 6000); } catch (e) { toast('Install CLI failed: ' + e); } } },
		{ label: 'Explorer: Register "Open with CozyCode" menu', icon: 'menu', run: () => invoke('register_context_menu').then(() => toast('Context menu registered')).catch(e => toast(e)) },
		{ label: 'Extensions: Import from VS Code', icon: 'extensions', run: async () => { if (!(await confirmDialog('Import VS Code extensions?', 'Copy VS Code extensions into CozyCode?'))) return; try { const n = await invoke('import_vscode_extensions'); toast(n > 0 ? `Imported ${n}` : 'Nothing to import'); if (n > 0) Ext.startExtHost(true); } catch (e) { toast(e); } } },
	];
	if (repo) cmds.push(
		{ label: 'Git: Checkout branch...', icon: 'git-branch', detail: repo.name, run: () => Git.pickBranch(repo) },
		{ label: 'Git: Pull', icon: 'arrow-down', run: () => Git.gitNet(repo, 'git_pull') },
		{ label: 'Git: Push', icon: 'arrow-up', run: () => Git.gitNet(repo, 'git_push') },
		{ label: 'Git: Stage All Changes', icon: 'add', run: async () => { await invoke('git_stage_all', { repo: repo.path }); Git.refreshScm(); } },
		{ label: 'Git: Generate Commit Message (AI)', icon: 'sparkle', run: () => { switchView('scm'); repo._msgEl && generateCommitMessage(repo, repo._msgEl); } },
		{ label: 'Git: Create Pull Request', icon: 'git-pull-request', run: () => createPR(repo) },
	);
	return cmds;
}
function commandPalette() {
	$('#palette')._mode = 'commands';
	// include commands contributed by installed extensions
	const extCmds = (Ext.contributedCommands || []).map(c => ({
		label: (c.category ? c.category + ': ' : '') + (typeof c.title === 'string' ? c.title : c.command),
		detail: c.command, icon: 'extensions',
		run: () => Ext.runExtCommand(c.command).catch(e => toast('Command failed: ' + e)),
	}));
	showPalette(buildCommands().concat(extCmds), 'Type a command name');
}

async function pickTheme() {
	const items = [
		{ label: 'Dark+ (default dark)', icon: 'color-mode', run: () => applyBuiltinTheme('Dark+') },
		{ label: 'Light+ (default light)', icon: 'color-mode', run: () => applyBuiltinTheme('Light+') },
	];
	try { for (const ext of await invoke('ext_list')) for (const th of ext.themes) items.push({ label: th.label, detail: ext.id, icon: 'symbol-color', run: () => applyExtTheme(th.path, th.ui_theme, th.label) }); } catch { }
	showPalette(items, 'Select Color Theme');
}

/* ============ suggest a formatter/linter when the language has none ============ */
const BUILTIN_FMT = new Set(['json', 'jsonc', 'html', 'css', 'scss', 'less', 'javascript', 'typescript']);
const FMT_SUGGEST = {
	python: ['ms-python.black-formatter', 'Black Formatter'],
	rust: ['rust-lang.rust-analyzer', 'rust-analyzer'],
	go: ['golang.go', 'Go'],
	php: ['bmewburn.vscode-intelephense-client', 'Intelephense'],
	lua: ['sumneko.lua', 'Lua'],
	ruby: ['rebornix.ruby', 'Ruby'],
	cpp: ['ms-vscode.cpptools', 'C/C++'],
	c: ['ms-vscode.cpptools', 'C/C++'],
	java: ['redhat.java', 'Language Support for Java'],
	yaml: ['redhat.vscode-yaml', 'YAML'],
	shell: ['foxundermoon.shell-format', 'shell-format'],
};
const _suggested = new Set();
async function suggestTooling(langId) {
	if (!langId || langId === 'plaintext' || BUILTIN_FMT.has(langId)) return;
	if (_suggested.has(langId)) return;
	if (state.settings['formatter.command']) return; // user has a global formatter
	const s = FMT_SUGGEST[langId];
	if (!s) return;
	_suggested.add(langId);
	try { if ((await invoke('ext_list')).some(e => e.id === s[0])) return; } catch { }
	toast(`No formatter for ${langId}. Recommended: ${s[1]}. Open Extensions to install.`, 6000);
}

/* ================= Run active file ================= */
// commands follow each language's official CLI (node/bun/python/go/cargo/etc.)
async function runActiveFile() {
	const tab = findTab(state.active);
	if (tab && tab.dirty) await saveActive();
	// framework-aware: if the workspace has package.json scripts (next/nuxt/vite/vue/etc),
	// offer those first — that's how JS frameworks are actually run.
	if (state.root && !state.remote) {
		try {
			const pkg = JSON.parse(await invoke('read_file', { path: state.root + '\\package.json' }));
			const scripts = pkg.scripts || {};
			const keys = Object.keys(scripts);
			if (keys.length) {
				const runtime = state.settings['npm.runner'] || 'npm';
				const items = keys.map(k => ({
					label: `${runtime} run ${k}`, detail: scripts[k], icon: 'play',
					run: () => runInTerminal(`${runtime} run ${k}`),
				}));
				if (tab && tab.kind === 'file') items.push({ label: 'Run current file', icon: 'file', detail: tab.name, run: () => runFileByLang(tab) });
				Settings.showPalette(items, `Run script (${pkg.name || basename(state.root)})`);
				return;
			}
		} catch { /* no package.json */ }
	}
	if (!tab || tab.kind !== 'file' || !tab.path) { toast('Open a file to run'); return; }
	return runFileByLang(tab);
}

function runInTerminal(cmd) {
	Panel.showPanel('terminal');
	Panel.newTerminal(false).then(() => setTimeout(() => {
		const t = Panel.activeTerminal();
		if (t && t.ptyId) invoke('pty_write', { id: t.ptyId, data: cmd + '\r' });
	}, 700));
}

async function runFileByLang(tab) {
	if (!tab || tab.kind !== 'file' || !tab.path) { toast('Open a file to run'); return; }
	const rt = state.runtimes || (state.runtimes = await invoke('detect_runtimes').catch(() => ({})));
	const lang = tab.model.getLanguageId();
	const file = tab.path;
	const q = p => `"${p}"`;
	let cmd = null;
	const has = k => rt[k] !== undefined;
	switch (lang) {
		case 'javascript': cmd = has('node') ? `node ${q(file)}` : has('bun') ? `bun ${q(file)}` : null; break;
		case 'typescript': cmd = has('bun') ? `bun ${q(file)}` : has('deno') ? `deno run ${q(file)}` : has('node') ? `npx tsx ${q(file)}` : null; break;
		case 'python': cmd = has('python') ? `python ${q(file)}` : null; break;
		case 'go': cmd = has('go') ? `go run ${q(file)}` : null; break;
		case 'php': cmd = has('php') ? `php ${q(file)}` : null; break;
		case 'rust':
			// cargo run if inside a crate, else rustc single file
			cmd = has('cargo') && Git.repoOf(file) ? `cargo run` : has('rustc') ? `rustc ${q(file)} -o "%TEMP%\\cozyrun.exe" && "%TEMP%\\cozyrun.exe"` : null;
			break;
		case 'shell': cmd = `bash ${q(file)}`; break;
		case 'bat': cmd = q(file); break;
		case 'powershell': cmd = `powershell -File ${q(file)}`; break;
		default: cmd = null;
	}
	if (!cmd) {
		const need = { javascript: 'Node.js or Bun', typescript: 'Bun/Deno/tsx', python: 'Python', go: 'Go', rust: 'Rust', php: 'PHP' }[lang] || 'a runtime';
		toast(`No runtime to run ${lang}. Install ${need}.`, 5000);
		return;
	}
	Panel.showPanel('terminal');
	await Panel.newTerminal(false);
	setTimeout(() => {
		const t = Panel.activeTerminal();
		if (t && t.ptyId) invoke('pty_write', { id: t.ptyId, data: cmd + '\r' });
	}, 700);
}

/* ================= formatter ================= */
async function formatActive() { const tab = findTab(state.active); if (tab && tab.kind === 'file' && tab.path) await formatFile(tab.path, tab.model); }
async function formatFile(path, model) {
	// try monaco built-in formatter first (json/html/css/ts have it), then external command
	try { const action = state.editor.getAction('editor.action.formatDocument'); if (action && await action.isSupported()) { await action.run(); return; } } catch { }
	const cmd = state.settings['formatter.command'];
	if (!cmd || state.remote) return;
	try { await FS.writeFile(path, model.getValue()); await invoke('run_formatter', { command: cmd, path }); model.setValue(await FS.readFile(path)); toast('Formatted'); }
	catch (e) { toast('Format failed: ' + e); }
}

/* ================= GitHub account ================= */
function ghToken() { return localStorage.getItem('cozyGhToken') || ''; }

async function finishLogin(token) {
	const user = JSON.parse(await invoke('gh_api', { token, method: 'GET', path: '/user', body: null }));
	localStorage.setItem('cozyGhToken', token);
	localStorage.setItem('cozyGhUser', JSON.stringify({ login: user.login, avatar: user.avatar_url, name: user.name }));
	renderAccount();
	toast('Signed in as ' + user.login);
}

// GitHub OAuth Device Flow — opens github.com/login/device in the browser.
// Needs a GitHub OAuth App (client id) with Device Flow enabled. Falls back to PAT.
async function githubLogin() {
	const clientId = state.settings['github.clientId'];
	if (!clientId) {
		toast('Set a GitHub OAuth App Client ID in Settings for browser sign-in. Using token fallback.', 5000);
		return githubLoginPAT();
	}
	let dc;
	try { dc = await invoke('gh_device_start', { clientId, scope: 'repo read:user user:email' }); }
	catch (e) { toast('Device flow failed: ' + e + ' — falling back to token'); return githubLoginPAT(); }

	await invoke('open_url', { url: dc.verification_uri }).catch(() => { });
	// show the code and keep polling until the user authorizes in the browser
	openUiTab('gh-login', 'Sign in to GitHub', el => {
		el.innerHTML = `<h2>Sign in to GitHub</h2>
			<p style="margin:8px 0">1. A browser opened at <b>${esc(dc.verification_uri)}</b></p>
			<p style="margin:8px 0">2. Enter this code:</p>
			<div style="font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0;user-select:all">${esc(dc.user_code)}</div>
			<p class="desc">Waiting for authorization...</p>`;
	});

	const started = Date.now();
	const poll = async () => {
		if (Date.now() - started > 300000) { toast('Device login timed out'); return; }
		let tok = null;
		try { tok = await invoke('gh_device_poll', { clientId, deviceCode: dc.device_code }); }
		catch (e) { toast('GitHub: ' + e); return; }
		if (tok) { try { await finishLogin(tok); closeTab('gh-login'); } catch (e) { toast('Sign-in: ' + e); } return; }
		setTimeout(poll, (dc.interval || 5) * 1000);
	};
	setTimeout(poll, (dc.interval || 5) * 1000);
}

async function githubLoginPAT() {
	const token = await nativePrompt('GitHub Personal Access Token', '', 'ghp_... (repo scope, from github.com/settings/tokens)');
	if (!token) return;
	try { await finishLogin(token); } catch (e) { toast('GitHub sign-in failed: ' + e); }
}
function renderAccount() {
	const btn = $('#btn-account');
	const raw = localStorage.getItem('cozyGhUser');
	if (raw) {
		const u = JSON.parse(raw);
		btn.innerHTML = `<img src="${esc(u.avatar)}" alt="">`;
		btn.title = 'GitHub: ' + u.login;
	} else { btn.innerHTML = '<span class="codicon codicon-account"></span>'; btn.title = 'Accounts'; }
}
function accountMenu() {
	const raw = localStorage.getItem('cozyGhUser');
	if (raw) {
		const u = JSON.parse(raw);
		showPalette([
			{ label: 'Signed in as ' + u.login, icon: 'github', run: () => { } },
			{ label: 'View Pull Requests', icon: 'git-pull-request', run: listPRs },
			{ label: 'Sign Out', icon: 'sign-out', run: () => { localStorage.removeItem('cozyGhToken'); localStorage.removeItem('cozyGhUser'); renderAccount(); toast('Signed out'); } },
		], 'GitHub Account');
	} else showPalette([{ label: 'Sign in with GitHub', icon: 'github', run: githubLogin }], 'Accounts');
}

/* ================= AI commit message ================= */
function aiConfig() {
	const provider = state.settings['ai.provider'] || 'anthropic';
	const p = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
	return {
		base: state.settings['ai.baseUrl'] || p.base,
		anthropic: p.anthropic,
		model: state.settings['ai.model'] || p.model,
		key: state.settings['ai.apiKey'] || '',
	};
}
const COMMIT_SYSTEM_PROMPT =
	'You are a git commit message generator. Given a git diff, write ONE concise commit message ' +
	'following Conventional Commits (type(scope): summary). Output ONLY the commit message, no code fences, ' +
	'no explanation. Keep the subject under 72 chars. Add a short body only if the change is non-trivial.';

async function generateCommitMessage(repo, msgEl) {
	const cfg = aiConfig();
	if (!cfg.key) { toast('Set an AI API key in Settings first'); openSettings(); return; }
	if (!cfg.base) { toast('Set AI base URL in Settings'); return; }
	toast('Generating commit message...', 15000);
	try {
		const diff = await invoke('git_diff_all', { repo: repo.path, staged: true })
			.then(d => d.trim() || invoke('git_diff_all', { repo: repo.path, staged: false }));
		if (!diff.trim()) { toast('No changes to describe'); return; }
		const out = await invoke('ai_generate', {
			baseUrl: cfg.base, apiKey: cfg.key, model: cfg.model, anthropic: cfg.anthropic,
			system: COMMIT_SYSTEM_PROMPT,
			prompt: 'Generate a commit message for this diff:\n\n' + diff,
		});
		msgEl.value = out.trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
		toast('Commit message generated');
	} catch (e) { toast('AI failed: ' + e, 6000); }
}

/* ================= Pull Requests ================= */
async function createPR(repo) {
	const token = ghToken();
	if (!token) { toast('Sign in with GitHub first'); githubLogin(); return; }
	try {
		const url = await invoke('git_remote_url', { repo: repo.path });
		const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
		if (!m) { toast('origin is not a GitHub repo'); return; }
		const [, owner, name] = m;
		const base = await invoke('git_default_branch', { repo: repo.path });
		const title = await nativePrompt('Pull Request title', repo.branch.replace(/[-_]/g, ' '));
		if (!title) return;
		const body = (await nativePrompt('Description (optional)', '')) || '';
		await invoke('git_push', { repo: repo.path }).catch(() => { });
		const res = JSON.parse(await invoke('gh_api', {
			token, method: 'POST', path: `/repos/${owner}/${name}/pulls`,
			body: JSON.stringify({ title, body, head: repo.branch, base }),
		}));
		if (res.html_url) { toast('PR created: ' + res.html_url, 6000); }
		else toast('PR: ' + (res.message || 'check base/head branches'), 6000);
	} catch (e) { toast('Create PR failed: ' + e, 6000); }
}

async function listPRs() {
	const token = ghToken();
	const repo = state.repos[0];
	if (!token || !repo) { toast('Sign in and open a git repo'); return; }
	try {
		const url = await invoke('git_remote_url', { repo: repo.path });
		const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
		if (!m) { toast('Not a GitHub repo'); return; }
		const prs = JSON.parse(await invoke('gh_api', { token, method: 'GET', path: `/repos/${m[1]}/${m[2]}/pulls?state=open`, body: null }));
		if (!Array.isArray(prs) || !prs.length) { toast('No open pull requests'); return; }
		showPalette(prs.map(p => ({ label: `#${p.number} ${p.title}`, detail: p.user.login, icon: 'git-pull-request', run: () => toast(p.html_url, 6000) })), 'Open Pull Requests');
	} catch (e) { toast('List PRs failed: ' + e); }
}

/* ================= titlebar menus ================= */
const MENUS = {
	File: [
		{ label: 'New File', cmd: 'workbench.action.files.newUntitledFile', run: newFile },
		{ label: 'Open Folder...', key: () => KEYS['workbench.action.files.openFolder'], run: () => openFolder() },
		'-',
		{ label: 'Save', key: () => KEYS['workbench.action.files.save'], run: saveActive },
		{ label: 'Preferences: Settings', key: () => KEYS['workbench.action.openSettings'], run: openSettings },
		{ label: 'Preferences: Keyboard Shortcuts', run: openKeybindings },
		'-',
		{ label: 'Exit', run: () => appWindow.close() },
	],
	Edit: [
		{ label: 'Undo', key: () => 'Ctrl+Z', run: () => state.editor && state.editor.trigger('menu', 'undo') },
		{ label: 'Redo', key: () => 'Ctrl+Y', run: () => state.editor && state.editor.trigger('menu', 'redo') },
		'-',
		{ label: 'Find', key: () => 'Ctrl+F', run: () => state.editor && state.editor.trigger('menu', 'actions.find') },
		{ label: 'Replace', key: () => 'Ctrl+H', run: () => state.editor && state.editor.trigger('menu', 'editor.action.startFindReplaceAction') },
		{ label: 'Format Document', key: () => KEYS['editor.action.formatDocument'], run: formatActive },
	],
	Selection: [
		{ label: 'Select All', key: () => 'Ctrl+A', run: () => state.editor && state.editor.trigger('menu', 'editor.action.selectAll') },
	],
	View: [
		{ label: 'Command Palette...', key: () => KEYS['workbench.commandPalette2'], run: commandPalette },
		{ label: 'Quick Open...', key: () => KEYS['workbench.quickOpen'], run: quickOpen },
		'-',
		{ label: 'Explorer', key: () => KEYS['workbench.view.explorer'], run: () => switchView('explorer') },
		{ label: 'Search', key: () => KEYS['workbench.view.search'], run: () => switchView('search') },
		{ label: 'Source Control', key: () => KEYS['workbench.view.scm'], run: () => switchView('scm') },
		{ label: 'Extensions', key: () => KEYS['workbench.view.extensions'], run: () => switchView('extensions') },
		{ label: 'Problems', key: () => KEYS['workbench.action.showProblems'], run: () => Panel.showPanel('problems') },
		'-',
		{ label: 'Toggle Terminal', key: () => KEYS['workbench.action.terminal.toggle'], run: toggleTerminal },
		{ label: 'Toggle Sidebar', key: () => KEYS['workbench.action.toggleSidebar'], run: toggleSidebar },
	],
	Go: [
		{ label: 'Go to File...', key: () => KEYS['workbench.quickOpen'], run: quickOpen },
		{ label: 'Go to Line...', key: () => 'Ctrl+G', run: () => state.editor && state.editor.trigger('menu', 'editor.action.gotoLine') },
	],
	Terminal: [
		{ label: 'New Terminal', run: () => Panel.newTerminal(false) },
		{ label: 'Split Terminal', run: () => Panel.newTerminal(true) },
	],
	Help: [
		{ label: 'About CozyCode', run: () => showAbout() },
	],
};

let openMenu = null;
function closeMenus() { $$('.menu-dropdown').forEach(m => m.remove()); $$('.menu-btn.open').forEach(b => b.classList.remove('open')); openMenu = null; }
function showMenu(name, btn) {
	closeMenus();
	btn.classList.add('open'); openMenu = name;
	const dd = document.createElement('div');
	dd.className = 'menu-dropdown';
	const r = btn.getBoundingClientRect();
	dd.style.left = r.left + 'px'; dd.style.top = r.bottom + 'px';
	for (const item of MENUS[name]) {
		if (item === '-') { const s = document.createElement('div'); s.className = 'menu-sep'; dd.appendChild(s); continue; }
		const d = document.createElement('div');
		d.className = 'menu-item';
		const key = typeof item.key === 'function' ? item.key() : '';
		d.innerHTML = `<span>${esc(item.label)}</span><span class="keybind">${esc(key || '')}</span>`;
		d.onclick = () => { closeMenus(); item.run(); };
		dd.appendChild(d);
	}
	document.body.appendChild(dd);
}
for (const name of Object.keys(MENUS)) {
	const b = document.createElement('button');
	b.className = 'menu-btn';
	b.textContent = name;
	b.onclick = e => { e.stopPropagation(); openMenu === name ? closeMenus() : showMenu(name, b); };
	b.onmouseenter = () => { if (openMenu && openMenu !== name) showMenu(name, b); };
	$('#menubar').appendChild(b);
}
document.addEventListener('click', e => { if (!e.target.closest('.menu-dropdown, .menu-btn')) closeMenus(); });

/* ================= window controls + wiring ================= */
$('#tb-run').onclick = runActiveFile;
$('#win-min').onclick = () => appWindow.minimize();
$('#win-max').onclick = () => appWindow.toggleMaximize();
$('#win-close').onclick = () => appWindow.close();
$$('.act-btn[data-view]').forEach(b => b.onclick = () => switchView(b.dataset.view));
$('#activitybar').oncontextmenu = e => { e.preventDefault(); activityBarMenu(e.clientX, e.clientY); };
applyHiddenViews();
$('#btn-open-folder').onclick = () => openFolder();
$('#btn-refresh').onclick = () => { state.fileList = null; Explorer.renderTree(); };
$('#btn-new-file').onclick = newFile;
$('#btn-new-folder').onclick = newFolder;
$('#btn-scm-refresh').onclick = () => Git.discoverRepos().then(Git.refreshScm);
$('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
$('#st-branch').onclick = () => Git.pickBranch($('#st-branch')._repo);
$('#st-sync').onclick = async () => { const r = $('#st-branch')._repo; if (r) { await Git.gitNet(r, 'git_pull'); await Git.gitNet(r, 'git_push'); } };
$('#st-problems').onclick = () => Panel.showPanel('problems');
$('#st-lang').onclick = pickLanguage;
$('#st-encoding').onclick = pickEncoding;

// language mode selector with per-language file icons (vscode-icons)
async function pickLanguage() {
	await monacoReady;
	const tab = findTab(state.active);
	if (!tab || tab.kind !== 'file' || !tab.model) return;
	const langs = monaco.languages.getLanguages();
	showPalette(langs.map(l => ({
		label: l.aliases && l.aliases[0] ? l.aliases[0] : l.id,
		detail: (l.extensions || []).join(' '),
		fileIcon: 'x' + ((l.extensions && l.extensions[0]) || '.txt'),
		run: () => { monaco.editor.setModelLanguage(tab.model, l.id); $('#st-lang').textContent = l.id; },
	})), 'Select Language Mode');
}

// Save with Encoding (like VSCode)
function pickEncoding() {
	const tab = findTab(state.active);
	if (!tab || tab.kind !== 'file') return;
	const encs = [
		['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 with BOM'],
		['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'], ['latin1', 'Latin-1 (ISO 8859-1)'],
	];
	showPalette(encs.map(([id, label]) => ({
		label: 'Save with ' + label, detail: id === (tab.encoding || 'utf8') ? 'current' : '', icon: 'save',
		run: async () => {
			tab.encoding = id;
			$('#st-encoding').textContent = label.replace(/ \(.*\)/, '');
			try { await invoke('write_file_encoded', { path: tab.path, content: tab.model.getValue(), encoding: id }); tab.dirty = false; renderTabs(); HotExit.clear(tab.path); toast('Saved as ' + label); }
			catch (e) { toast('Save failed: ' + e); }
		},
	})), 'Save with Encoding');
}

/* ================= zoom (Ctrl+=, Ctrl+-, Ctrl+0) — whole-UI like VSCode ============ */
let zoomLevel = parseFloat(localStorage.getItem('cozyZoom') || '1');
function applyZoom() {
	document.documentElement.style.setProperty('zoom', zoomLevel);
	localStorage.setItem('cozyZoom', String(zoomLevel));
}
function zoomIn() { zoomLevel = Math.min(3, +(zoomLevel + 0.1).toFixed(2)); applyZoom(); }
function zoomOut() { zoomLevel = Math.max(0.5, +(zoomLevel - 0.1).toFixed(2)); applyZoom(); }
function zoomReset() { zoomLevel = 1; applyZoom(); }
applyZoom();

const APP_VERSION = '0.14.0';

// Self-update via the Tauri updater plugin. `silent` = startup auto-check (no UI
// unless an update is found and not skipped). Otherwise report status into `el`.
// silent = no error UI (startup). announce = toast "up to date" when current.
async function checkForUpdate(el, silent, announce) {
	const set = t => { if (el) el.textContent = t; };
	const uptodate = () => { set('You are on the latest version (' + APP_VERSION + ').'); if (announce) toast('CozyCode is up to date (v' + APP_VERSION + ')', 3000); };
	set('Checking for updates...');
	const U = window.__TAURI__ && window.__TAURI__.updater;
	try {
		if (U && U.check) {
			const update = await U.check();
			if (update && update.available) {
				if (silent && localStorage.getItem('cozySkipVersion') === update.version) return;
				promptUpdate(update);
				set('Update v' + update.version + ' available.');
			} else uptodate();
			return;
		}
	} catch (e) { if (!silent) set('Updater unavailable, checking GitHub...'); }
	try {
		const r = await invoke('check_update');
		const latest = (r.tag_name || '').replace(/^v/, '');
		if (latest && latest !== APP_VERSION) {
			if (silent && localStorage.getItem('cozySkipVersion') === latest) return;
			promptUpdateManual(latest, r.html_url);
			set('Update v' + latest + ' available.');
		} else uptodate();
	} catch (e) { if (!silent) set('Update check failed: ' + e); }
}

// VSCode-style update prompt: Install Now / Remind Me Later / Skip This Version
function promptUpdate(update) {
	modalPrompt(
		`Update Available`,
		`CozyCode v${update.version} is available (you have v${APP_VERSION}). Install now?`,
		[
			['Install Now', 'primary', async () => {
				const box = modalPrompt('Updating', 'Downloading update...', []);
				try {
					await update.downloadAndInstall();
					const P = window.__TAURI__ && window.__TAURI__.process;
					if (P && P.relaunch) await P.relaunch();
				} catch (e) { toast('Update failed: ' + e, 6000); box && box.remove(); }
			}],
			['Remind Me Later', '', () => { }],
			['Skip This Version', '', () => localStorage.setItem('cozySkipVersion', update.version)],
		]);
}
function promptUpdateManual(version, url) {
	modalPrompt('Update Available',
		`CozyCode v${version} is available. Download from GitHub?`,
		[
			['Download', 'primary', () => invoke('open_url', { url })],
			['Remind Me Later', '', () => { }],
			['Skip This Version', '', () => localStorage.setItem('cozySkipVersion', version)],
		]);
}

// generic 3-button modal (reuses the dialog button system — fixed-size buttons)
function modalPrompt(title, msg, buttons) {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.innerHTML = `<div class="modal">
		<div class="modal-title">${esc(title)}</div>
		<div class="modal-msg">${esc(msg)}</div>
		<div class="modal-btns"></div></div>`;
	const btns = overlay.querySelector('.modal-btns');
	for (const [label, cls, fn] of buttons) {
		const b = document.createElement('button');
		b.className = 'modal-btn' + (cls ? ' ' + cls : '');
		b.textContent = label;
		b.onclick = () => { overlay.remove(); fn(); };
		btns.appendChild(b);
	}
	document.body.appendChild(overlay);
	return overlay;
}

function showAbout() {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.innerHTML = `<div class="modal about-modal">
		<img src="cozycode.png" style="width:56px;height:56px">
		<div class="modal-title" style="font-size:22px;margin-top:8px">CozyCode</div>
		<div class="modal-msg">Version ${APP_VERSION}<br>Developed by <b>CozyDev</b> (Cozy-DEV-org)<br>Rust + Tauri rework of Code - OSS (MIT)<br>No telemetry. Cozy and light.</div>
		<div id="about-update" class="modal-msg" style="font-size:11px">github.com/Cozy-DEV-org/CozyCode</div>
		<div class="modal-btns">
			<button class="modal-btn" data-c="upd">Check for Update</button>
			<button class="modal-btn primary" data-c="ok">OK</button>
		</div>
	</div>`;
	overlay.querySelector('[data-c=ok]').onclick = () => overlay.remove();
	overlay.querySelector('[data-c=upd]').onclick = () => checkForUpdate($('#about-update'));
	overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
	document.body.appendChild(overlay);
}

// flush any pending hot-exit cache before the window closes
window.addEventListener('beforeunload', () => {
	const o = HotExit.read();
	for (const t of state.tabs) if (t.dirty && t.path && t.model) o[t.path] = t.model.getValue();
	HotExit.write(o);
});
$('#btn-account').onclick = accountMenu;
$('#btn-settings-gear').onclick = () => showPalette([
	{ label: 'Settings', icon: 'settings-gear', run: openSettings },
	{ label: 'Keyboard Shortcuts', icon: 'record-keys', run: openKeybindings },
	{ label: 'Color Theme', icon: 'symbol-color', run: pickTheme },
	{ label: 'Command Palette', icon: 'terminal', run: commandPalette },
], 'Manage');

/* ================= global keybinding dispatch ================= */
window.addEventListener('keydown', e => {
	if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !e.ctrlKey && e.key !== 'F1') {
		// let plain typing through in inputs; still allow Ctrl combos + F1
	}
	const combo = eventToCombo(e);
	for (const [cmd, key] of Object.entries(KEYS)) {
		if (key && key === combo && COMMAND_FNS[cmd]) {
			// don't hijack Ctrl+S etc while monaco focused for save (monaco has its own) — but our save is fine
			e.preventDefault();
			COMMAND_FNS[cmd]();
			return;
		}
	}
});

Object.assign(Settings, {
	showPalette, commandPalette, openSettings, openKeybindings, pickTheme,
	generateCommitMessage, createPR, formatFile, formatActive, suggestTooling, aiConfig, persistSettings,
});

/* ================= startup ================= */
// each step guarded so one failure can't halt the rest (prevents "frozen" UI)
(async () => {
	try { await loadSettings(); } catch (e) { console.error(e); }
	try { renderAccount(); Panel.updateProblemsStatus(); } catch (e) { console.error(e); }
	try { await restoreTheme(); } catch (e) { console.error(e); }

	// register the "Open with CozyCode" context menu + install CLI once (non-fatal)
	try {
		if (!localStorage.getItem('cozyCtxMenu'))
			invoke('register_context_menu').then(() => localStorage.setItem('cozyCtxMenu', '1')).catch(() => { });
		if (!localStorage.getItem('cozyCli'))
			invoke('install_cli').then(() => localStorage.setItem('cozyCli', '1')).catch(() => { });
		// one-time: ASK before importing VS Code extensions (never silently)
		if (!localStorage.getItem('cozyVscodeImport')) {
			localStorage.setItem('cozyVscodeImport', '1');
			setTimeout(async () => {
				if (await confirmDialog('Import VS Code extensions?', 'CozyCode found VS Code extensions on this machine. Copy them into CozyCode? Note: language servers and debuggers may not run yet.')) {
					try { const n = await invoke('import_vscode_extensions'); toast(n > 0 ? `Imported ${n} extension(s)` : 'Nothing to import', 4000); if (n > 0) Ext.startExtHost(true); }
					catch (e) { toast('Import failed: ' + e); }
				}
			}, 2500);
		}
	} catch { }

	// launched via "Open with CozyCode" / double-click a file or folder?
	let target = null;
	try { target = await invoke('launch_target'); } catch { }
	try {
		if (target && target.path) {
			if (target.is_dir) await openFolder(target.path);
			else {
				await openFolder(dirname(target.path.replace(/\//g, '\\')) || target.path);
				await openFile(target.path, { preview: false });
			}
		} else {
			const last = localStorage.getItem('cozyLastFolder');
			if (last) { try { await invoke('list_dir', { path: last }); await openFolder(last); } catch { localStorage.removeItem('cozyLastFolder'); } }
		}
	} catch (e) { console.error(e); }

	// check for updates on EVERY launch; toast "up to date" when current
	try { setTimeout(() => checkForUpdate(null, true, true), 3000); } catch { }
})();
