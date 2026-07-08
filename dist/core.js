// CozyCode core — shared state, helpers, editor, tabs, themes, file icons.
// No telemetry. No emoji (codicons only). Modules attach to globals defined here.
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const state = {
	root: null,
	remote: null,          // { id, host, path } when browsing an SSH remote
	editor: null, diffEditor: null,
	tabs: [],
	active: null,
	repos: [],
	expanded: new Set(),
	fileList: null,
	monacoTheme: 'vs-dark',
	settings: {},
	problems: {},          // uri -> [ {message, severity, startLine, ...} ]
};

// Safety net: a single unhandled error must never silently freeze the whole UI.
// Surface it instead of leaving the app looking "stuck / can't type".
window.addEventListener('error', e => {
	// cross-origin script errors (CDN/iframe) surface as opaque "Script error." — ignore noise
	if (e.message === 'Script error.' || (!e.filename && !e.error)) return;
	try { console.error('[cozy]', e.error || e.message); } catch { }
});
window.addEventListener('unhandledrejection', e => {
	try { console.error('[cozy] promise', e.reason); } catch { }
});

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---- hide the fact this is a WebView: no browser context menu, no devtools ----
window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('keydown', e => {
	const k = (e.key || '').toLowerCase();
	if (k === 'f12') { e.preventDefault(); return; }
	if (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) { e.preventDefault(); return; }
	if (e.ctrlKey && !e.shiftKey && k === 'u') { e.preventDefault(); return; } // view-source
}, true);

// ---- Output console: capture logs + app events, shown in the OUTPUT panel ----
const _logBuf = [];
const _logSources = new Set();
function outputFilter() { const s = document.getElementById('output-src'); return s ? s.value : ''; }
function cozyLog(source, msg, level = 'info') {
	const time = new Date().toTimeString().slice(0, 8);
	const entry = { time, source, msg: String(msg).slice(0, 2000), level };
	_logBuf.push(entry);
	if (_logBuf.length > 2000) _logBuf.shift();
	if (!_logSources.has(source)) { _logSources.add(source); refreshLogSources(); }
	const pane = document.getElementById('pane-output');
	if (pane && !pane.classList.contains('hidden')) {
		const f = outputFilter();
		if (!f || f === source) appendLog(document.getElementById('output-log'), entry);
	}
}
function refreshLogSources() {
	const sel = document.getElementById('output-src');
	if (!sel) return;
	const cur = sel.value;
	sel.innerHTML = '<option value="">All sources</option>' + [..._logSources].sort().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
	sel.value = cur;
}
function appendLog(box, e) {
	const d = document.createElement('div');
	d.className = 'log-line log-' + e.level;
	d.innerHTML = `<span class="log-time">${e.time}</span><span class="log-src">[${esc(e.source)}]</span> ${esc(e.msg)}`;
	box.appendChild(d);
	box.scrollTop = 1e9;
}
function renderOutput() {
	const box = document.getElementById('output-log');
	box.innerHTML = '';
	const f = outputFilter();
	for (const e of _logBuf) if (!f || f === e.source) appendLog(box, e);
}
// mirror console.* into the output panel (keep native console too)
for (const lvl of ['log', 'warn', 'error']) {
	const orig = console[lvl].bind(console);
	console[lvl] = (...a) => { orig(...a); try { cozyLog('console', a.join(' '), lvl === 'log' ? 'info' : lvl); } catch { } };
}

// links must not navigate the whole app. Ctrl/middle-click -> external browser;
// plain click -> internal browser tab inside the IDE.
window.addEventListener('click', e => {
	const a = e.target.closest && e.target.closest('a[href]');
	if (!a) return;
	const href = a.getAttribute('href');
	if (!href || href.startsWith('#')) return;
	e.preventDefault();
	if (!/^https?:\/\//i.test(href)) return;
	if (e.ctrlKey || e.metaKey) invoke('open_url', { url: href });
	else openWebTab(href);
}, true);
window.addEventListener('auxclick', e => {
	const a = e.target.closest && e.target.closest('a[href]');
	if (a && e.button === 1) { e.preventDefault(); const h = a.getAttribute('href'); if (/^https?:/i.test(h)) invoke('open_url', { url: h }); }
}, true);

// internal browser: an editor tab that shows a URL in an iframe with a small toolbar
function openWebTab(url) {
	const key = 'web:' + url;
	let tab = findTab(key);
	if (!tab) { tab = { key, kind: 'web', name: url.replace(/^https?:\/\//, '').slice(0, 30), url, dirty: false }; state.tabs.push(tab); }
	else tab.url = url;
	activateTab(key);
}
function renderWebTab(tab, box) {
	box.innerHTML = '';
	const bar = document.createElement('div');
	bar.className = 'web-bar';
	bar.innerHTML = `<button class="web-btn" data-a="back" title="Back"><span class="codicon codicon-arrow-left"></span></button>` +
		`<button class="web-btn" data-a="fwd" title="Forward"><span class="codicon codicon-arrow-right"></span></button>` +
		`<button class="web-btn" data-a="reload" title="Reload"><span class="codicon codicon-refresh"></span></button>` +
		`<input class="web-url" value="${esc(tab.url)}">` +
		`<button class="web-btn" data-a="ext" title="Open in external browser"><span class="codicon codicon-link-external"></span></button>`;
	const frame = document.createElement('iframe');
	frame.className = 'web-frame';
	frame.src = tab.url;
	bar.querySelector('[data-a=back]').onclick = () => { try { frame.contentWindow.history.back(); } catch { } };
	bar.querySelector('[data-a=fwd]').onclick = () => { try { frame.contentWindow.history.forward(); } catch { } };
	bar.querySelector('[data-a=reload]').onclick = () => frame.src = frame.src;
	bar.querySelector('[data-a=ext]').onclick = () => invoke('open_url', { url: tab.url });
	const inp = bar.querySelector('.web-url');
	inp.onkeydown = e => { if (e.key === 'Enter') { let u = inp.value.trim(); if (!/^https?:/i.test(u)) u = 'https://' + u; tab.url = u; frame.src = u; } };
	box.appendChild(bar);
	box.appendChild(frame);
}

// native-looking context menu built from our own components (not the WebView's)
function contextMenu(x, y, items) {
	$$('.ctx-menu').forEach(m => m.remove());
	const menu = document.createElement('div');
	menu.className = 'ctx-menu menu-dropdown';
	for (const it of items) {
		if (it === '-') { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
		const d = document.createElement('div');
		d.className = 'menu-item' + (it.disabled ? ' disabled' : '') + (it.checkbox ? ' menu-check' : '');
		const mark = it.checkbox ? `<span class="menu-tick codicon ${it.checked ? 'codicon-check' : ''}"></span>` : '';
		d.innerHTML = `${mark}<span>${esc(it.label)}</span><span class="keybind">${esc(it.key || '')}</span>`;
		if (!it.disabled) d.onclick = () => {
			if (it.checkbox) {
				// toggle in place, keep the menu open (VSCode-style checkbox menu)
				it.checked = !it.checked;
				d.querySelector('.menu-tick').className = 'menu-tick codicon ' + (it.checked ? 'codicon-check' : '');
				it.run(it.checked);
			} else { menu.remove(); it.run(); }
		};
		menu.appendChild(d);
	}
	document.body.appendChild(menu);
	// keep on-screen
	const r = menu.getBoundingClientRect();
	menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
	menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
	const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
	setTimeout(() => document.addEventListener('mousedown', close), 0);
	return menu;
}
const basename = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const dirname = p => { const parts = String(p).split(/[\\/]/); parts.pop(); return parts.join('/'); };
const esc = s => { const d = document.createElement('span'); d.textContent = s == null ? '' : s; return d.innerHTML; };
const joinPath = (a, b) => state.remote ? (a.replace(/\/+$/, '') + '/' + b) : (a.replace(/[\\/]+$/, '') + '\\' + b);

function toast(msg, ms = 3500) {
	const t = $('#toast');
	t.textContent = String(msg).slice(0, 800);
	t.classList.remove('hidden');
	clearTimeout(t._h);
	t._h = setTimeout(() => t.classList.add('hidden'), ms);
	try { cozyLog('app', msg); } catch { }
}

/* ---- filesystem abstraction: local (Rust fs) or remote (Rust sftp) ---- */
const FS = {
	listDir: p => state.remote
		? invoke('ssh_list_dir', { id: state.remote.id, path: p }).then(es => es.map(e => ({ name: e.name, path: e.path, is_dir: e.is_dir })))
		: invoke('list_dir', { path: p }),
	readFile: p => state.remote ? invoke('ssh_read_file', { id: state.remote.id, path: p }) : invoke('read_file', { path: p }),
	writeFile: (p, content) => state.remote ? invoke('ssh_write_file', { id: state.remote.id, path: p, content }) : invoke('write_file', { path: p, content }),
};

/* ================= file icons (vscode-icons) ================= */
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@master/icons/';
const ICON_BY_NAME = {
	'package.json': 'npm', 'package-lock.json': 'npm', 'tsconfig.json': 'tsconfig',
	'cargo.toml': 'cargo', 'cargo.lock': 'cargo', 'dockerfile': 'docker', 'docker-compose.yml': 'docker',
	'.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
	'license': 'license', 'license.txt': 'license', 'license.md': 'license',
	'.env': 'dotenv', 'makefile': 'makefile', 'readme.md': 'markdown',
	'webpack.config.js': 'webpack', 'vite.config.js': 'vite', 'vite.config.ts': 'vite',
	'.eslintrc': 'eslint', 'eslint.config.js': 'eslint', '.prettierrc': 'prettier', 'tauri.conf.json': 'tauri',
};
const ICON_BY_EXT = {
	js: 'js', mjs: 'js', cjs: 'js', jsx: 'reactjs', ts: 'typescript', tsx: 'reactts',
	json: 'json', jsonc: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
	md: 'markdown', markdown: 'markdown', rs: 'rust', py: 'python', toml: 'toml',
	yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'svg', sh: 'shell', bash: 'shell', zsh: 'shell',
	bat: 'bat', cmd: 'bat', ps1: 'powershell', psm1: 'powershell', sql: 'sql', go: 'go',
	java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
	rb: 'ruby', vue: 'vue', dart: 'dartlang', kt: 'kotlin', swift: 'swift', lua: 'lua', r: 'r',
	ini: 'ini', cfg: 'config', conf: 'config', txt: 'text', pdf: 'pdf', log: 'log',
	png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', ico: 'image', webp: 'image', bmp: 'image',
	zip: 'zip', gz: 'zip', tar: 'zip', '7z': 'zip', exe: 'binary', dll: 'binary',
	csv: 'text', lock: 'text', map: 'json',
};
function iconUrlFor(name, isDir, open) {
	if (isDir) return ICON_CDN + (open ? 'default_folder_opened.svg' : 'default_folder.svg');
	const key = String(name).toLowerCase();
	let icon = ICON_BY_NAME[key] || ICON_BY_EXT[key.split('.').pop()];
	return ICON_CDN + (icon ? `file_type_${icon}.svg` : 'default_file.svg');
}
function fileIconImg(name, isDir = false, open = false) {
	const img = document.createElement('img');
	img.className = 'file-icon';
	img.src = iconUrlFor(name, isDir, open);
	img.onerror = () => { img.onerror = null; img.src = ICON_CDN + (isDir ? 'default_folder.svg' : 'default_file.svg'); };
	return img;
}

/* ================= language map ================= */
const LANG = {
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
	ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json', html: 'html', htm: 'html',
	css: 'css', scss: 'scss', less: 'less', md: 'markdown', rs: 'rust', py: 'python',
	toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', yml: 'yaml', yaml: 'yaml', xml: 'xml',
	svg: 'xml', sh: 'shell', bash: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',
	sql: 'sql', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
	cs: 'csharp', php: 'php', rb: 'ruby', lua: 'lua', r: 'r', swift: 'swift', kt: 'kotlin',
	dart: 'dart', vue: 'html', diff: 'diff', patch: 'diff', txt: 'plaintext', log: 'plaintext',
	dockerfile: 'dockerfile', graphql: 'graphql',
};
const langOf = p => {
	const n = basename(p).toLowerCase();
	if (n === 'dockerfile') return 'dockerfile';
	return LANG[n.split('.').pop()] || 'plaintext';
};

/* ================= monaco + themes ================= */
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
const monacoReady = new Promise(res => require(['vs/editor/editor.main'], res));

async function ensureEditor() {
	await monacoReady;
	if (state.editor) return;
	// perf: mirror VSCode largeFileOptimizations + viewport tokenization defaults.
	// bracketPairColorization + heavy guides off by default keep open/scroll smooth.
	const opts = () => ({
		tabSize: state.settings['editor.tabSize'] || 4,
		fontSize: state.settings['editor.fontSize'] || 13,
		wordWrap: state.settings['editor.wordWrap'] || 'off',
		minimap: { enabled: state.settings['editor.minimap'] === true }, // off by default = faster open
		renderWhitespace: 'none',
		smoothScrolling: true,
		cursorSmoothCaretAnimation: 'on',
		bracketPairColorization: { enabled: state.settings['editor.bracketPairColorization'] === true },
		guides: { bracketPairs: false, indentation: state.settings['editor.indentGuides'] !== false },
		unicodeHighlight: { ambiguousCharacters: false },
		largeFileOptimizations: true,
		maxTokenizationLineLength: 5000,
		occurrencesHighlight: 'off',
		renderValidationDecorations: 'editable',
		quickSuggestionsDelay: 60,
	});
	state.editor = monaco.editor.create($('#editor'), { theme: state.monacoTheme, automaticLayout: true, ...opts() });
	state.diffEditor = monaco.editor.createDiffEditor($('#diffeditor'), { theme: state.monacoTheme, automaticLayout: true, readOnly: true, fontSize: state.settings['editor.fontSize'] || 13 });
	state.editor.onDidChangeCursorPosition(e =>
		$('#st-pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`);
	state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
	// completions from extension host + built-in word-based (registered once, lazy host)
	monaco.languages.registerCompletionItemProvider('*', {
		triggerCharacters: ['.', ':', '/', '<', '"', "'", '@'],
		provideCompletionItems: (model, position) => Ext.provideCompletions(model, position),
		resolveCompletionItem: (item) => Ext.resolveCompletion(item),
	});
	applyEditorSettings();
}

function applyEditorSettings() {
	if (!state.editor) return;
	state.editor.updateOptions({
		tabSize: state.settings['editor.tabSize'] || 4,
		fontSize: state.settings['editor.fontSize'] || 13,
		wordWrap: state.settings['editor.wordWrap'] || 'off',
		minimap: { enabled: state.settings['editor.minimap'] === true },
		bracketPairColorization: { enabled: state.settings['editor.bracketPairColorization'] === true },
		guides: { bracketPairs: false, indentation: state.settings['editor.indentGuides'] !== false },
		fontFamily: state.settings['editor.fontFamily'] || 'Consolas, "Courier New", monospace',
	});
}

// string-aware JSONC -> JSON (VS Code theme files are JSONC with // and /* */ and
// trailing commas). Must not strip // inside string values (e.g. "http://...").
function stripJsonComments(s) {
	let out = '', inStr = false, esc = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i], n = s[i + 1];
		if (inStr) {
			out += c;
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') { inStr = true; out += c; continue; }
		if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
		if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
}

const CSS_VAR_MAP = {
	'editor.background': '--bg', 'sideBar.background': '--sidebar', 'activityBar.background': '--activity',
	'statusBar.background': '--status', 'titleBar.activeBackground': '--titlebar',
	'editorGroupHeader.tabsBackground': '--tabbar', 'tab.activeBackground': '--tab-active',
	'input.background': '--input', 'list.hoverBackground': '--hover',
	'list.activeSelectionBackground': '--list-sel', 'button.background': '--accent',
	'foreground': '--fg', 'sideBar.border': '--border', 'titleBar.activeForeground': '--titlebar-fg',
	'list.inactiveSelectionBackground': '--active',
};
const DEFAULT_VARS = {
	'--bg': '#1e1e1e', '--sidebar': '#252526', '--activity': '#333333', '--status': '#007acc',
	'--titlebar': '#3c3c3c', '--tabbar': '#2d2d2d', '--tab-active': '#1e1e1e', '--input': '#3c3c3c',
	'--hover': '#2a2d2e', '--list-sel': '#094771', '--accent': '#0e639c', '--fg': '#cccccc',
	'--border': '#3c3c3c', '--titlebar-fg': '#cccccc', '--active': '#37373d',
};

const LIGHT_VARS = {
	'--bg': '#ffffff', '--sidebar': '#f3f3f3', '--activity': '#2c2c2c', '--tabbar': '#f3f3f3',
	'--tab-active': '#ffffff', '--input': '#ffffff', '--hover': '#e8e8e8', '--fg': '#333333',
	'--border': '#e5e5e5', '--titlebar': '#dddddd', '--titlebar-fg': '#333333',
	'--list-sel': '#0060c0', '--active': '#e4e6f1',
};
function resetWorkbenchVars(type) {
	const base = type === 'light' ? { ...DEFAULT_VARS, ...LIGHT_VARS } : DEFAULT_VARS;
	for (const [k, v] of Object.entries(base)) document.documentElement.style.setProperty(k, v);
}

// Apply a parsed VS Code theme JSON to Monaco + the workbench CSS vars. `save` is the
// localStorage descriptor (null = transient preview); `silent` suppresses the toast.
async function applyThemeJson(json, uiTheme, label, save, silent) {
	await monacoReady;
	const base = uiTheme === 'vs' ? 'vs' : uiTheme === 'hc-black' ? 'hc-black' : 'vs-dark';
	const rules = [];
	for (const tc of json.tokenColors || []) {
		if (!tc.scope || !tc.settings) continue;
		const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope).split(',');
		for (const sc of scopes) {
			const r = { token: sc.trim() };
			if (tc.settings.foreground) r.foreground = tc.settings.foreground.replace('#', '').slice(0, 6);
			if (tc.settings.fontStyle) r.fontStyle = tc.settings.fontStyle;
			if (r.token) rules.push(r);
		}
	}
	const colors = {};
	for (const [k, v] of Object.entries(json.colors || {}))
		if (typeof v === 'string') colors[k] = v.length === 9 ? v.slice(0, 7) : v;
	try {
		monaco.editor.defineTheme('cozy-ext', { base, inherit: true, rules, colors });
		monaco.editor.setTheme('cozy-ext');
		state.monacoTheme = 'cozy-ext';
	} catch (e) { toast('Theme define failed: ' + e); return; }
	// start from type-appropriate defaults so a theme that omits a var doesn't inherit
	// the previous theme's value, then layer the theme's own workbench colors on top
	resetWorkbenchVars(base === 'vs' ? 'light' : 'dark');
	for (const [k, cssVar] of Object.entries(CSS_VAR_MAP))
		if (colors[k]) document.documentElement.style.setProperty(cssVar, colors[k]);
	if (save) localStorage.setItem('cozyTheme', JSON.stringify(save));
	if (!silent) toast('Theme: ' + label);
}

async function applyExtTheme(themePath, uiTheme, label, preview) {
	let json;
	try { json = JSON.parse(stripJsonComments(await invoke('read_file', { path: themePath }))); }
	catch (e) { if (!preview) toast('Theme load failed: ' + e); return; }
	await applyThemeJson(json, uiTheme, label, preview ? null : { path: themePath, uiTheme, label }, preview);
}

// Bundled themes (dist/themes/<file>, the rainglow collection). opts.preview = don't
// persist; opts.silent = no toast.
const _bundledThemeCache = {};
async function loadBundledTheme(file) {
	if (_bundledThemeCache[file]) return _bundledThemeCache[file];
	const json = await (await fetch('themes/' + file)).json();
	_bundledThemeCache[file] = json;
	return json;
}
async function applyBundledTheme(file, label, type, opts) {
	opts = opts || {};
	try {
		const json = await loadBundledTheme(file);
		await applyThemeJson(json, type === 'light' ? 'vs' : 'vs-dark', label, opts.preview ? null : { bundled: file, label, type }, opts.silent);
	} catch (e) { if (!opts.silent) toast('Theme load failed: ' + e); }
}

function applyBuiltinTheme(name, preview) {
	const monacoName = name === 'Light+' ? 'vs' : 'vs-dark';
	state.monacoTheme = monacoName;
	if (state.editor) monaco.editor.setTheme(monacoName);
	resetWorkbenchVars(name === 'Light+' ? 'light' : 'dark');
	if (!preview) localStorage.setItem('cozyTheme', JSON.stringify({ builtin: name }));
}

async function restoreTheme() {
	const saved = localStorage.getItem('cozyTheme');
	if (!saved) return;
	try {
		const t = JSON.parse(saved);
		if (t.builtin) applyBuiltinTheme(t.builtin);
		else if (t.bundled) await applyBundledTheme(t.bundled, t.label, t.type, { silent: true });
		else if (t.path) await applyExtTheme(t.path, t.uiTheme, t.label);
	} catch { /* ignore */ }
}

/* ================= tabs ================= */
function findTab(key) { return state.tabs.find(t => t.key === key); }

// media/binary file categories that get a viewer instead of the text editor
const MEDIA_EXT = {
	png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image', avif: 'image',
	mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', m4v: 'video',
	mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
	pdf: 'pdf', csv: 'csv', tsv: 'csv', xlsx: 'xlsx', xls: 'xlsx',
};
const MIME = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
	mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/mp4',
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
	pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
};
const mediaCat = p => MEDIA_EXT[basename(p).toLowerCase().split('.').pop()];

// preview tabs (VSCode single-click): at most one preview tab; opening another
// file in preview reuses that slot. Editing or double-click pins it (keeps open).
async function openFile(path, opts = {}) {
	const preview = opts.preview === true;
	let tab = findTab(path);
	if (tab) {
		if (!preview && tab.preview) { tab.preview = false; state.previewTab = null; }
		activateTab(tab.key);
		return;
	}
	// route media/binary files to a viewer (local only)
	const cat = mediaCat(path);
	if (cat && !state.remote) { return openMediaTab(path, cat, preview); }
	let content;
	try { content = await FS.readFile(path); }
	catch (e) { toast('Cannot open: ' + e); return; }
	await ensureEditor();

	// replace the existing preview tab (unless it has unsaved edits)
	if (preview && state.previewTab) {
		const old = findTab(state.previewTab);
		if (old && !old.dirty) { removeTab(state.previewTab); }
		state.previewTab = null;
	}
	const model = monaco.editor.createModel(content, langOf(path));
	tab = { key: path, kind: 'file', path, name: basename(path), model, dirty: false, readOnly: false, viewState: null, preview };
	model.onDidChangeContent(() => {
		if (tab.preview) { tab.preview = false; state.previewTab = null; renderTabs(); } // edit pins it
		if (!tab.dirty && !tab.readOnly) { tab.dirty = true; renderTabs(); }
		if (tab.path) HotExit.mark(tab);
	});
	if (preview) state.previewTab = path;
	state.tabs.push(tab);
	activateTab(tab.key);
	Settings.suggestTooling(langOf(path));
	Ext.activateLanguage(langOf(path)); // fire onLanguage for lazy extensions
}

// media viewer tab (image/video/audio/pdf/csv/xlsx) rendered with native browser + SheetJS
async function openMediaTab(path, cat, preview) {
	if (preview && state.previewTab) {
		const old = findTab(state.previewTab);
		if (old && !old.dirty) removeTab(state.previewTab);
		state.previewTab = null;
	}
	const tab = { key: path, kind: 'media', path, name: basename(path), cat, dirty: false, readOnly: true, preview: !!preview, _rendered: false };
	if (preview) state.previewTab = path;
	state.tabs.push(tab);
	activateTab(path);
}

async function renderMedia(tab) {
	const box = $('#mediatab');
	box.innerHTML = '<div class="media-loading">Loading...</div>';
	const ext = basename(tab.path).toLowerCase().split('.').pop();
	const mime = MIME[ext] || 'application/octet-stream';
	try {
		if (tab.cat === 'csv') {
			const text = await FS.readFile(tab.path);
			box.innerHTML = '';
			box.appendChild(renderTable(parseCsv(text, ext === 'tsv' ? '\t' : ',')));
		} else if (tab.cat === 'xlsx') {
			const b64 = await invoke('read_file_base64', { path: tab.path });
			const wb = XLSX.read(b64, { type: 'base64' });
			box.innerHTML = '';
			const tabs = document.createElement('div'); tabs.className = 'sheet-tabs';
			const view = document.createElement('div'); view.className = 'sheet-view';
			wb.SheetNames.forEach((name, i) => {
				const b = document.createElement('button');
				b.className = 'sheet-tab' + (i === 0 ? ' active' : '');
				b.textContent = name;
				b.onclick = () => {
					$$('.sheet-tab').forEach(x => x.classList.remove('active'));
					b.classList.add('active');
					view.innerHTML = '';
					view.appendChild(renderTable(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 })));
				};
				tabs.appendChild(b);
			});
			box.appendChild(tabs); box.appendChild(view);
			view.appendChild(renderTable(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })));
		} else {
			const b64 = await invoke('read_file_base64', { path: tab.path });
			const url = `data:${mime};base64,${b64}`;
			box.innerHTML = '';
			let el;
			if (tab.cat === 'image') { el = document.createElement('img'); el.src = url; el.className = 'media-img'; }
			else if (tab.cat === 'video') { el = document.createElement('video'); el.src = url; el.controls = true; el.className = 'media-video'; }
			else if (tab.cat === 'audio') { el = document.createElement('audio'); el.src = url; el.controls = true; }
			else if (tab.cat === 'pdf') { el = document.createElement('embed'); el.src = url; el.type = 'application/pdf'; el.className = 'media-pdf'; }
			box.appendChild(el);
		}
	} catch (e) { box.innerHTML = `<div class="media-loading">Cannot open: ${esc(String(e))}</div>`; }
}

function parseCsv(text, delim) {
	const rows = [];
	let row = [], cur = '', q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
		else if (c === '"') q = true;
		else if (c === delim) { row.push(cur); cur = ''; }
		else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
		else if (c !== '\r') cur += c;
	}
	if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
	return rows;
}

function renderTable(rows) {
	const t = document.createElement('table');
	t.className = 'data-table';
	rows.slice(0, 5000).forEach((r, ri) => {
		const tr = document.createElement('tr');
		const cells = Array.isArray(r) ? r : [];
		const head = document.createElement('td'); head.className = 'row-num'; head.textContent = ri === 0 ? '' : ri;
		tr.appendChild(head);
		for (const cell of cells) {
			const td = document.createElement(ri === 0 ? 'th' : 'td');
			td.textContent = cell == null ? '' : String(cell);
			tr.appendChild(td);
		}
		t.appendChild(tr);
	});
	return t;
}

// double-click a file in the tree/tab = pin (keep open)
function pinFile(path) {
	const tab = findTab(path);
	if (tab) { tab.preview = false; if (state.previewTab === path) state.previewTab = null; renderTabs(); }
	else openFile(path, { preview: false });
}

async function openDiffTab(key, name, originalText, modifiedText, lang) {
	await ensureEditor();
	let tab = findTab(key);
	if (tab) { tab.original.setValue(originalText); tab.modified.setValue(modifiedText); }
	else {
		tab = {
			key, kind: 'diff', name,
			original: monaco.editor.createModel(originalText, lang),
			modified: monaco.editor.createModel(modifiedText, lang),
			dirty: false, readOnly: true, viewState: null,
		};
		state.tabs.push(tab);
	}
	activateTab(key);
}

async function openTextTab(key, name, text, lang) {
	await ensureEditor();
	let tab = findTab(key);
	if (tab) tab.model.setValue(text);
	else {
		tab = { key, kind: 'file', name, model: monaco.editor.createModel(text, lang), dirty: false, readOnly: true, viewState: null };
		state.tabs.push(tab);
	}
	activateTab(key);
}

// generic HTML tab (settings, keybindings, extension detail)
function openUiTab(key, name, renderFn) {
	let tab = findTab(key);
	if (!tab) {
		tab = { key, kind: 'ui', name, render: renderFn, dirty: false };
		state.tabs.push(tab);
	}
	activateTab(key);
}

function activateTab(key) {
	const prev = findTab(state.active);
	if (prev && prev.kind === 'file' && state.editor) prev.viewState = state.editor.saveViewState();
	state.active = key;
	const tab = findTab(key);
	$('#welcome').style.display = tab ? 'none' : 'grid';
	$('#editor').classList.toggle('hidden', !tab || tab.kind !== 'file');
	$('#diffeditor').classList.toggle('hidden', !tab || tab.kind !== 'diff');
	$('#uitab').classList.toggle('hidden', !tab || tab.kind !== 'ui');
	$('#mediatab').classList.toggle('hidden', !tab || tab.kind !== 'media');
	$('#webtab').classList.toggle('hidden', !tab || tab.kind !== 'web');
	if (tab) {
		if (tab.kind === 'web') {
			if ($('#webtab').dataset.key !== tab.key) { renderWebTab(tab, $('#webtab')); $('#webtab').dataset.key = tab.key; }
			$('#st-lang').textContent = 'web';
		} else if (tab.kind === 'media') {
			renderMedia(tab);
			$('#st-lang').textContent = tab.cat;
		} else if (tab.kind === 'diff') {
			state.diffEditor.setModel({ original: tab.original, modified: tab.modified });
			$('#st-lang').textContent = tab.modified.getLanguageId();
		} else if (tab.kind === 'ui') {
			$('#uitab').innerHTML = '';
			tab.render($('#uitab'));
			$('#st-lang').textContent = '';
		} else {
			state.editor.setModel(tab.model);
			state.editor.updateOptions({ readOnly: tab.readOnly });
			if (tab.viewState) state.editor.restoreViewState(tab.viewState);
			state.editor.focus();
			$('#st-lang').textContent = tab.model.getLanguageId();
			if (tab.path) { scheduleTimeline(tab.path); scheduleGutter(tab); }
		}
		$('#st-encoding').style.display = tab.kind === 'file' ? '' : 'none';
		$('#st-encoding').textContent = ENCODING_LABELS[tab.encoding || 'utf8'];
	} else { $('#st-lang').textContent = ''; $('#st-pos').textContent = ''; }
	renderTabs();
}

// perf: git log spawns a subprocess. Gate on in-memory repoOf (no spawn) to show
// the Timeline header; only actually run git log when the user expanded it, and
// then debounced + on idle so rapid tab switching coalesces to one call.
let _tlTimer = null;
state.timelineOpen = false;
function scheduleTimeline(path) {
	const section = $('#timeline-section');
	const repo = Git.repoOf(path);
	if (!repo) { section.classList.add('hidden'); return; }
	section.classList.remove('hidden');
	if (!state.timelineOpen) return;
	clearTimeout(_tlTimer);
	_tlTimer = setTimeout(() => {
		const cb = window.requestIdleCallback || (f => setTimeout(f, 1));
		cb(() => Git.loadTimeline(path));
	}, 200);
}

// VSCode-style dirty gutter: colour the margin of added/modified/deleted lines
// from the file's git diff. Debounced; no spawn when the file isn't in a repo.
let _gutTimer = null;
function scheduleGutter(tab) {
	if (state.remote) return;
	const repo = Git.repoOf(tab.path);
	if (!repo) { if (tab._decos && state.editor) tab._decos = state.editor.deltaDecorations(tab._decos, []); return; }
	clearTimeout(_gutTimer);
	_gutTimer = setTimeout(async () => {
		if (findTab(state.active) !== tab) return;
		let diff = '';
		try { diff = await invoke('git_diff_file', { repo: repo.path, path: Git.relPath(repo.path, tab.path), staged: false }); } catch { return; }
		applyGutter(tab, gutterFromDiff(diff));
	}, 300);
}

function gutterFromDiff(diff) {
	const out = [];
	let nl = 0, pendingDel = 0;
	for (const line of diff.split('\n')) {
		const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
		if (h) { nl = +h[1]; pendingDel = 0; continue; }
		if (nl === 0) continue;
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line[0] === '+') { out.push({ line: nl, type: pendingDel > 0 ? 'mod' : 'add' }); if (pendingDel > 0) pendingDel--; nl++; }
		else if (line[0] === '-') { pendingDel++; out.push({ line: nl, type: 'del' }); }
		else { nl++; pendingDel = 0; }
	}
	return out;
}

function applyGutter(tab, marks) {
	if (!state.editor || findTab(state.active) !== tab) return;
	const decos = marks.map(m => ({
		range: new monaco.Range(Math.max(1, m.line), 1, Math.max(1, m.line), 1),
		options: { linesDecorationsClassName: 'gutter-' + m.type },
	}));
	tab._decos = state.editor.deltaDecorations(tab._decos || [], decos);
}

// dispose + splice a tab without prompting (internal)
function removeTab(key) {
	const i = state.tabs.findIndex(t => t.key === key);
	if (i < 0) return -1;
	const tab = state.tabs[i];
	if (tab.model) tab.model.dispose();
	if (tab.original) tab.original.dispose();
	if (tab.modified) tab.modified.dispose();
	if (tab.path) HotExit.clear(tab.path);
	if (state.previewTab === key) state.previewTab = null;
	state.tabs.splice(i, 1);
	return i;
}

async function closeTab(key) {
	const tab = findTab(key);
	if (!tab) return;
	if (tab.dirty) {
		const choice = await confirmSave(tab.name);
		if (choice === 'cancel') return;
		if (choice === 'save') { activateTab(key); await saveActive(); }
	}
	const i = removeTab(key);
	if (i < 0) return;
	if (state.active === key) {
		const next = state.tabs[i] || state.tabs[i - 1];
		activateTab(next ? next.key : null);
	} else renderTabs();
}

// native-looking prompt (replaces window.prompt so no "tauri.localhost says")
function nativePrompt(title, initial = '', placeholder = '') {
	return new Promise(resolve => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `<div class="modal">
			<div class="modal-title">${esc(title)}</div>
			<input class="modal-input" type="text" value="${esc(initial)}" placeholder="${esc(placeholder)}">
			<div class="modal-btns">
				<button class="modal-btn" data-c="cancel">Cancel</button>
				<button class="modal-btn primary" data-c="ok">OK</button>
			</div></div>`;
		const inp = overlay.querySelector('.modal-input');
		const done = v => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
		overlay.querySelector('[data-c=ok]').onclick = () => done(inp.value);
		overlay.querySelector('[data-c=cancel]').onclick = () => done(null);
		const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } if (e.key === 'Escape') done(null); };
		document.addEventListener('keydown', onKey, true);
		document.body.appendChild(overlay);
		inp.focus(); inp.select();
	});
}

// native-looking confirm (replaces window.confirm)
function confirmDialog(title, msg = '') {
	return new Promise(resolve => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `<div class="modal">
			<div class="modal-title">${esc(title)}</div>
			${msg ? `<div class="modal-msg">${esc(msg)}</div>` : ''}
			<div class="modal-btns">
				<button class="modal-btn" data-c="no">Cancel</button>
				<button class="modal-btn primary" data-c="yes">OK</button>
			</div></div>`;
		const done = v => { overlay.remove(); resolve(v); };
		overlay.querySelector('[data-c=yes]').onclick = () => done(true);
		overlay.querySelector('[data-c=no]').onclick = () => done(false);
		document.body.appendChild(overlay);
		overlay.querySelector('[data-c=yes]').focus();
	});
}

// VSCode-style 3-button unsaved dialog: Save / Don't Save / Cancel
function confirmSave(name) {
	return new Promise(resolve => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `<div class="modal">
			<div class="modal-title">Do you want to save the changes you made to ${esc(name)}?</div>
			<div class="modal-msg">Your changes will be lost if you don't save them.</div>
			<div class="modal-btns">
				<button class="modal-btn primary" data-c="save">Save</button>
				<button class="modal-btn" data-c="dont">Don't Save</button>
				<button class="modal-btn" data-c="cancel">Cancel</button>
			</div></div>`;
		const done = c => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(c); };
		overlay.querySelectorAll('.modal-btn').forEach(b => b.onclick = () => done(b.dataset.c === 'dont' ? 'dont' : b.dataset.c));
		const onKey = e => { if (e.key === 'Escape') done('cancel'); if (e.key === 'Enter') done('save'); };
		document.addEventListener('keydown', onKey);
		document.body.appendChild(overlay);
		overlay.querySelector('[data-c=save]').focus();
	});
}

function renderTabs() {
	const el = $('#tabs');
	el.innerHTML = '';
	for (const t of state.tabs) {
		const d = document.createElement('div');
		d.className = 'tab' + (t.key === state.active ? ' active' : '') + (t.preview ? ' preview' : '');
		if (t.kind === 'diff') { const ic = document.createElement('span'); ic.className = 'codicon codicon-diff'; d.appendChild(ic); }
		else if (t.kind === 'ui') { const ic = document.createElement('span'); ic.className = 'codicon codicon-settings-gear'; d.appendChild(ic); }
		else if (t.kind === 'web') { const ic = document.createElement('span'); ic.className = 'codicon codicon-globe'; d.appendChild(ic); }
		else d.appendChild(fileIconImg(t.name));
		const label = document.createElement('span');
		label.textContent = t.name;
		d.appendChild(label);
		const close = document.createElement('button');
		close.className = 'close';
		close.innerHTML = t.dirty ? '<span class="codicon codicon-circle-filled"></span>' : '<span class="codicon codicon-close"></span>';
		close.onclick = e => { e.stopPropagation(); closeTab(t.key); };
		d.appendChild(close);
		d.onclick = () => activateTab(t.key);
		d.ondblclick = () => { if (t.path) pinFile(t.path); };
		d.onauxclick = e => { if (e.button === 1) closeTab(t.key); };
		d.oncontextmenu = e => {
			e.preventDefault();
			contextMenu(e.clientX, e.clientY, [
				{ label: 'Close', key: 'Ctrl+W', run: () => closeTab(t.key) },
				{ label: 'Close Others', run: () => state.tabs.filter(x => x.key !== t.key).map(x => x.key).forEach(closeTab) },
				{ label: 'Close All', run: () => state.tabs.map(x => x.key).forEach(closeTab) },
				'-',
				{ label: 'Copy Path', run: () => t.path && navigator.clipboard.writeText(t.path), disabled: !t.path },
			]);
		};
		el.appendChild(d);
	}
}

const ENCODING_LABELS = {
	utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', latin1: 'Latin-1',
};

async function saveActive() {
	const tab = findTab(state.active);
	if (!tab || tab.kind !== 'file' || tab.readOnly || !tab.path) return;
	if (tab.encoding && tab.encoding !== 'utf8' && !state.remote) {
		await invoke('write_file_encoded', { path: tab.path, content: tab.model.getValue(), encoding: tab.encoding });
	} else {
		await FS.writeFile(tab.path, tab.model.getValue());
	}
	tab.dirty = false;
	HotExit.clear(tab.path);
	renderTabs();
	// format on save
	if (state.settings['editor.formatOnSave']) await Settings.formatFile(tab.path, tab.model);
	Git.refreshScm();
	scheduleGutter(tab);
	if (state.remote) toast('Saved to remote: ' + tab.name, 1500);
}

/* ================= hot exit (cache unsaved per workspace) ================= */
const HotExit = {
	_timer: null,
	key() { return 'cozyHotExit:' + (state.remote ? 'ssh:' + state.remote.host + ':' : '') + (state.root || ''); },
	read() { try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); } catch { return {}; } },
	write(o) { try { localStorage.setItem(this.key(), JSON.stringify(o)); } catch { /* quota */ } },
	// debounced: persist a dirty tab's content so it survives an unexpected close
	mark(tab) {
		clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			if (!tab.dirty || !tab.path) return;
			const o = this.read();
			o[tab.path] = tab.model.getValue();
			this.write(o);
		}, 400);
	},
	clear(path) {
		const o = this.read();
		if (o[path] !== undefined) { delete o[path]; this.write(o); }
	},
	// on folder open: reopen any files that had unsaved changes last session
	async restore() {
		const o = this.read();
		const paths = Object.keys(o);
		if (!paths.length) return;
		await ensureEditor();
		for (const path of paths) {
			if (findTab(path)) continue;
			const cached = o[path];
			let disk = '';
			try { disk = await FS.readFile(path); } catch { /* file gone; keep cached anyway */ }
			const model = monaco.editor.createModel(cached, langOf(path));
			const tab = { key: path, kind: 'file', path, name: basename(path), model, dirty: cached !== disk, readOnly: false, viewState: null, preview: false };
			model.onDidChangeContent(() => {
				if (tab.preview) { tab.preview = false; state.previewTab = null; renderTabs(); }
				if (!tab.dirty) { tab.dirty = true; renderTabs(); }
				HotExit.mark(tab);
			});
			state.tabs.push(tab);
		}
		renderTabs();
		if (paths.length) toast(`Restored ${paths.length} unsaved file(s) from last session`, 3000);
	},
};

/* ================= view switching ================= */
let currentView = 'explorer';
function switchView(name) {
	const sbHidden = $('#sidebar').style.display === 'none';
	// click the already-active view button = collapse/expand sidebar (VSCode behavior)
	if (name === currentView && !sbHidden) { toggleSidebar(); return; }
	currentView = name;
	$$('.act-btn').forEach(b => b.classList.remove('active'));
	$$('.act-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
	$$('#sidebar .view').forEach(v => v.classList.add('hidden'));
	const ev = $('#ext-views'); if (ev) ev.classList.add('hidden');
	$('#view-' + name).classList.remove('hidden');
	$('#sidebar').style.display = 'flex';
	$('#sidebar-resizer').style.display = 'block';
	if (name === 'scm') Git.refreshScm();
	if (name === 'search') $('#search-input').focus();
	if (name === 'extensions') { Ext.renderView(); $('#ext-input').focus(); }
	if (name === 'remote') Remote.renderView();
}
// right-click the activity bar to hide/show view icons (like VSCode)
function loadHiddenViews() { try { return new Set(JSON.parse(localStorage.getItem('cozyHiddenViews') || '[]')); } catch { return new Set(); } }
let hiddenViews = loadHiddenViews();
function applyHiddenViews() {
	$$('.act-btn[data-view]').forEach(b => b.classList.toggle('hidden', hiddenViews.has(b.dataset.view)));
	$$('.act-btn[data-extview]').forEach(b => b.classList.toggle('hidden', hiddenViews.has('ext:' + b.dataset.extview)));
}
function activityBarMenu(x, y) {
	const items = [];
	const builtin = { explorer: 'Explorer', search: 'Search', scm: 'Source Control', extensions: 'Extensions', remote: 'Remote SSH' };
	for (const [v, label] of Object.entries(builtin)) items.push(toggleItem(v, label));
	$$('.act-btn[data-extview]').forEach(b => items.push(toggleItem('ext:' + b.dataset.extview, b.title)));
	contextMenu(x, y, items);
}
// checkbox item: checked = visible. Toggling only hides the icon (extension keeps running).
function toggleItem(key, label) {
	return {
		label, checkbox: true, checked: !hiddenViews.has(key),
		run: (checked) => {
			checked ? hiddenViews.delete(key) : hiddenViews.add(key);
			localStorage.setItem('cozyHiddenViews', JSON.stringify([...hiddenViews]));
			applyHiddenViews();
			if (!checked && currentView === key) switchView('explorer');
		},
	};
}

function toggleSidebar() {
	const sb = $('#sidebar'), rz = $('#sidebar-resizer');
	const hidden = sb.style.display === 'none';
	sb.style.display = hidden ? 'flex' : 'none';
	rz.style.display = hidden ? 'block' : 'none';
}

// namespaces filled by other module files
const Explorer = {}, Git = {}, Panel = {}, Remote = {}, Ext = {}, Settings = {}, Claude = {};
