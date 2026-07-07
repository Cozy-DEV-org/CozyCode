// CozyCode extension host — Node sidecar with a minimal 'vscode' API shim.
// ponytail: supports the API surface simple extensions actually use (commands,
// messages, completion providers, diagnostics, snippets). Full parity with the
// VSCode extension host (LSP client, debug, webviews) is a later, bigger job.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const readline = require('readline');

const extRoot = process.argv[2];
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const log = m => send({ event: 'log', params: String(m).slice(0, 500) });

// An extension throwing asynchronously must NOT kill the whole host (which would
// take down every other extension + IntelliSense). Log and stay alive, like VSCode.
process.on('uncaughtException', e => { try { log('uncaught: ' + ((e && e.stack) || e)); } catch { } });
process.on('unhandledRejection', e => { try { log('unhandledRejection: ' + ((e && e.stack) || e)); } catch { } });

/* ---------- minimal vscode API ---------- */
class Position {
	constructor(line, character) { this.line = line; this.character = character; }
	translate(ld = 0, cd = 0) { return new Position(this.line + ld, this.character + cd); }
	with(line, character) { return new Position(line ?? this.line, character ?? this.character); }
}
class Range {
	constructor(a, b, c, d) {
		if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
		else { this.start = a; this.end = b; }
	}
}
class SnippetString { constructor(value) { this.value = value || ''; } appendText(t) { this.value += t; return this; } }
class CompletionItem {
	constructor(label, kind) { this.label = label; this.kind = kind; }
}
class Diagnostic {
	constructor(range, message, severity = 0) { this.range = range; this.message = message; this.severity = severity; }
}
class Disposable {
	constructor(fn) { this.dispose = fn || (() => {}); }
	static from(...items) { return new Disposable(() => { for (const d of items) { try { d && d.dispose && d.dispose(); } catch {} } }); }
}
class EventEmitter {
	constructor() { this._h = []; this.event = h => { this._h.push(h); return new Disposable(); }; }
	fire(e) { this._h.forEach(h => { try { h(e); } catch {} }); }
}

// permissive stubs: unknown APIs resolve to a callable/constructable no-op so
// extensions don't crash. `permObj` gives a returned object a permissive prototype.
const UNIVERSAL = new Proxy(function () {}, {
	get: (_t, p) => {
		if (p === 'then' || p === '__esModule') return undefined;
		// coercion + iteration must not throw: `${stub}` needs Symbol.toPrimitive,
		// `[...stub]` / `for..of stub` need Symbol.iterator (empty)
		if (p === Symbol.toPrimitive) return () => '';
		if (p === Symbol.iterator) return function* () {};
		if (p === Symbol.asyncIterator) return async function* () {};
		if (typeof p === 'symbol') return undefined;
		if (p === 'toString' || p === 'toLocaleString') return () => '';
		if (p === 'valueOf') return () => 0;
		return UNIVERSAL;
	},
	has: () => true,
	apply: () => UNIVERSAL,
	construct: () => UNIVERSAL,
	// swallow writes so `stub.name = x` (name is read-only on functions) doesn't throw
	set: () => true, defineProperty: () => true, deleteProperty: () => true,
});
const PERMISSIVE = new Proxy({}, {
	get: (_t, p) => {
		if (p === Symbol.toPrimitive) return () => '';
		if (p === 'then' || typeof p === 'symbol' || p === '__esModule') return undefined;
		return UNIVERSAL;
	},
});
const permObj = o => Object.assign(Object.create(PERMISSIVE), o);

const completionProviders = []; // { selector, provider }
const commands = new Map();
const contextKeys = {}; // set via executeCommand('setContext', k, v); drives when-clauses

// interactive UI bridge: exthost asks the workbench to show a picker/input/dialog
// and awaits the user's answer (uiResponse RPC). VSCode does the same over its
// extension-host protocol — a no-op answer here makes extension flows dead-end.
let _uiSeq = 1;
const uiWaiters = new Map();
function uiRequest(kind, params) {
	return new Promise(resolve => {
		const id = 'ui' + (_uiSeq++);
		uiWaiters.set(id, resolve);
		send({ event: 'uiRequest', params: Object.assign({ id, kind }, params) });
		setTimeout(() => { if (uiWaiters.has(id)) { uiWaiters.delete(id); resolve(undefined); } }, 180000);
	});
}
// info/warn/error with action buttons -> modal with those buttons; without -> toast
async function uiMessage(type, m, rest) {
	rest = rest || [];
	// signature: showXMessage(message, options?, ...items). options is an object
	// WITHOUT a `title` (MessageItems have title); it carries { modal, detail }.
	let modal = false, detail = '';
	if (rest.length && rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) {
		modal = !!rest[0].modal; detail = rest[0].detail || ''; rest = rest.slice(1);
	}
	const items = rest.filter(x => x != null);
	const buttons = items.map(x => typeof x === 'object' ? String(x.title) : String(x));
	// no buttons + not modal -> plain notification toast (VSCode fires-and-forgets)
	if (!buttons.length && !modal) { send({ event: 'message', params: { type, text: String(m) } }); return undefined; }
	const idx = await uiRequest('message', { type, text: String(m), detail, buttons, modal });
	return (idx == null || idx < 0) ? undefined : items[idx];
}
const configStore = {}; // setting key -> default value, from every ext's contributes.configuration

// a real appRoot with product.json — extensions read `${env.appRoot}/product.json`
// (remote-containers does at activate); an empty appRoot resolved to cwd and crashed
const APP_ROOT = path.join(path.dirname(extRoot), 'appRoot');
try {
	fs.mkdirSync(APP_ROOT, { recursive: true });
	fs.writeFileSync(path.join(APP_ROOT, 'product.json'), JSON.stringify({
		nameShort: 'CozyCode', nameLong: 'CozyCode', applicationName: 'cozycode',
		version: '1.106.0', quality: 'stable', commit: 'cozycode',
		extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery', itemUrl: 'https://open-vsx.org/vscode/item' },
	}, null, 2));
} catch {}
const diagCollections = [];
const treeProviders = new Map(); // viewId -> provider
const treeItemCache = new Map(); // nodeKey -> element (so clicks can resolve back)
let _nodeSeq = 1;
const webviewProviders = new Map(); // viewId -> provider
const webviews = new Map();         // viewId -> { view, onMsg }

const MIME = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json' };
function fileToDataUri(p) {
	try {
		const ext = String(p).toLowerCase().split('.').pop();
		const mime = MIME[ext] || 'application/octet-stream';
		return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
	} catch { return ''; }
}

// asWebviewUri must return a real URL (not a data: URI) or the extension's React
// app can't code-split: dynamic import()/webpack chunks resolve relative to the
// document origin, and a data: origin is opaque -> chunks 404 -> only the shell
// renders. Map the file to Tauri's asset protocol (same origin as the iframe's
// html file), so both static resources and lazy chunks load. Matches the format
// of window.__TAURI__.core.convertFileSrc (proven: the html file loads this way).
const ASSET_BASE = process.platform === 'win32' ? 'http://asset.localhost/' : 'asset://localhost/';
function assetUrl(p) { return ASSET_BASE + encodeURIComponent(path.normalize(String(p))); }

// Webview html can be multi-MB (all resources inlined as data URIs). Shipping it
// through the IPC event pipe stalls/overflows, so write it to a file the frontend
// loads via the asset protocol instead. Also strip CSP + inject the vscode API shim.
const WEBVIEW_DIR = path.join(path.dirname(extRoot), 'webviews');

// VSCode injects the current theme as --vscode-* CSS variables onto the webview's
// documentElement; extension UIs style everything with them (dropdown/menu/input
// backgrounds...). Without them var() resolves empty -> transparent popovers.
// ponytail: curated Dark+ subset covering the widely used vars, not all 700.
const VSCODE_THEME_CSS = `<style id="cozy-vscode-theme">:root{
--vscode-font-family:"Segoe WPC","Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-font-weight:normal;
--vscode-editor-font-family:Consolas,"Courier New",monospace;--vscode-editor-font-size:14px;
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-errorForeground:#f48771;--vscode-disabledForeground:#888;
--vscode-focusBorder:#007fd4;--vscode-contrastBorder:transparent;--vscode-widget-border:#454545;
--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#cccccc;--vscode-editorWidget-background:#252526;--vscode-editorWidget-foreground:#cccccc;--vscode-editorWidget-border:#454545;
--vscode-sideBar-background:#181818;--vscode-sideBar-foreground:#cccccc;--vscode-sideBar-border:#2b2b2b;--vscode-sideBarTitle-foreground:#bbbbbb;--vscode-sideBarSectionHeader-background:#00000000;--vscode-sideBarSectionHeader-foreground:#cccccc;
--vscode-panel-background:#181818;--vscode-panel-border:#2b2b2b;
--vscode-dropdown-background:#313131;--vscode-dropdown-foreground:#cccccc;--vscode-dropdown-border:#3c3c3c;--vscode-dropdown-listBackground:#252526;
--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#888888;
--vscode-inputOption-activeBackground:#2489db82;--vscode-inputOption-activeBorder:#007acc;--vscode-inputOption-activeForeground:#ffffff;
--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#1177bb;--vscode-button-border:transparent;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;--vscode-button-secondaryHoverBackground:#45494e;
--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-list-hoverForeground:#cccccc;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-list-focusBackground:#04395e;--vscode-list-focusForeground:#ffffff;--vscode-list-highlightForeground:#2aaaff;--vscode-list-focusOutline:#007fd4;
--vscode-menu-background:#252526;--vscode-menu-foreground:#cccccc;--vscode-menu-border:#454545;--vscode-menu-selectionBackground:#04395e;--vscode-menu-selectionForeground:#ffffff;--vscode-menu-separatorBackground:#454545;
--vscode-quickInput-background:#252526;--vscode-quickInput-foreground:#cccccc;--vscode-quickInputTitle-background:#ffffff1b;--vscode-quickInputList-focusBackground:#04395e;--vscode-quickInputList-focusForeground:#ffffff;
--vscode-widget-shadow:#0000005c;--vscode-scrollbar-shadow:#000000;
--vscode-scrollbarSlider-background:#79797966;--vscode-scrollbarSlider-hoverBackground:#646464b3;--vscode-scrollbarSlider-activeBackground:#bfbfbf66;
--vscode-textLink-foreground:#3794ff;--vscode-textLink-activeForeground:#3794ff;--vscode-textCodeBlock-background:#0a0a0a66;--vscode-textBlockQuote-background:#7f7f7f1a;--vscode-textBlockQuote-border:#007acc80;--vscode-textPreformat-foreground:#d7ba7d;--vscode-textPreformat-background:#ffffff1a;--vscode-textSeparator-foreground:#ffffff2e;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-toolbar-activeBackground:#63666750;
--vscode-icon-foreground:#c5c5c5;--vscode-keybindingLabel-background:#8080802b;--vscode-keybindingLabel-foreground:#cccccc;--vscode-keybindingLabel-border:#33333399;--vscode-keybindingLabel-bottomBorder:#44444499;
--vscode-checkbox-background:#313131;--vscode-checkbox-foreground:#cccccc;--vscode-checkbox-border:#3c3c3c;
--vscode-progressBar-background:#0e70c0;
--vscode-notifications-background:#252526;--vscode-notifications-foreground:#cccccc;--vscode-notifications-border:#303031;
--vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-foreground:#cccccc;--vscode-editorHoverWidget-border:#454545;
--vscode-editorGroup-border:#444444;--vscode-tab-activeBackground:#1e1e1e;--vscode-tab-activeForeground:#ffffff;--vscode-tab-inactiveBackground:#2d2d2d;--vscode-tab-inactiveForeground:#ffffff80;
--vscode-banner-background:#04395e;--vscode-banner-foreground:#cccccc;--vscode-banner-iconForeground:#3794ff;
--vscode-charts-blue:#3794ff;--vscode-charts-red:#f14c4c;--vscode-charts-green:#89d185;--vscode-charts-yellow:#cca700;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-foreground:#cccccc;--vscode-charts-lines:#cccccc80;
--vscode-terminal-background:#181818;--vscode-terminal-foreground:#cccccc;
}
body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);}
</style>`;

function processWebviewHtml(html, viewId) {
	if (!html) return '<body style="color:#888;font-family:sans-serif;padding:12px">Webview provided no content.</body>';
	html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
	const shim = VSCODE_THEME_CSS + `<script>(function(){var _s;var _api={postMessage:function(m){parent.postMessage({__cozyWv:true,viewId:${JSON.stringify(viewId)},msg:m},'*');},getState:function(){return _s;},setState:function(s){_s=s;return s;}};window.acquireVsCodeApi=function(){return _api;};
document.addEventListener('DOMContentLoaded',function(){document.body.classList.add('vscode-dark');document.body.dataset.vscodeThemeKind='vscode-dark';document.body.dataset.vscodeThemeName='Dark+';});})();</script>`;
	return html.includes('</head>') ? html.replace('</head>', shim + '</head>') : shim + html;
}
function writeWebviewFile(viewId, html) {
	try {
		fs.mkdirSync(WEBVIEW_DIR, { recursive: true });
		const file = path.join(WEBVIEW_DIR, String(viewId).replace(/[^a-zA-Z0-9_.-]/g, '_') + '.html');
		fs.writeFileSync(file, processWebviewHtml(html, viewId));
		return file;
	} catch (e) { log('webview write error: ' + e.message); return ''; }
}

/* ---------- real LSP client (IntelliSense) ---------- */
const cp = require('child_process');
const languageClients = []; // started LanguageClient instances

function selectorLang(sel) {
	// documentSelector -> list of language ids
	const out = [];
	const add = s => { if (typeof s === 'string') out.push(s); else if (s && s.language) out.push(s.language); };
	if (Array.isArray(sel)) sel.forEach(add); else add(sel);
	return out;
}

class LspClient {
	constructor(id, name, serverOptions, clientOptions) {
		this.id = id; this.name = name || id;
		this.serverOptions = serverOptions;
		this.langs = selectorLang((clientOptions && clientOptions.documentSelector) || []);
		this.initOptions = clientOptions && clientOptions.initializationOptions;
		this.proc = null; this.seq = 1; this.pending = new Map(); this.buf = Buffer.alloc(0);
		this.opened = new Map(); // uri -> version
		this.ready = false;
	}
	async start() {
		const so = this.serverOptions;
		let cmd, args = [];
		const exe = (so && so.run) || so;
		if (exe && exe.command) { cmd = exe.command; args = exe.args || []; }
		else if (exe && exe.module) { cmd = process.execPath; args = [exe.module, ...(exe.args || [])]; }
		else { throw new Error('unsupported serverOptions'); }
		this.proc = cp.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.proc.on('error', e => log('lsp ' + this.name + ' spawn error: ' + e.message));
		this.proc.stdout.on('data', d => this._onData(d));
		languageClients.push(this);
		try {
			await this._req('initialize', {
				processId: process.pid, rootUri: null, workspaceFolders: null,
				initializationOptions: this.initOptions,
				capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } }, hover: { contentFormat: ['plaintext', 'markdown'] }, publishDiagnostics: {} }, workspace: {} },
			}, 8000);
			this._notify('initialized', {});
			this.ready = true;
			log('lsp ' + this.name + ' ready (' + this.langs.join(',') + ')');
		} catch (e) { log('lsp ' + this.name + ' init failed: ' + e.message); }
		return { dispose: () => this.stop() };
	}
	stop() { try { this.proc && this.proc.kill(); } catch {} }
	handles(lang) { return this.ready && this.langs.includes(lang); }
	_frame(obj) { const s = JSON.stringify(obj); return Buffer.concat([Buffer.from('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n'), Buffer.from(s)]); }
	_notify(method, params) { try { this.proc.stdin.write(this._frame({ jsonrpc: '2.0', method, params })); } catch {} }
	_req(method, params, timeout = 4000) {
		const id = this.seq++;
		try { this.proc.stdin.write(this._frame({ jsonrpc: '2.0', id, method, params })); } catch { return Promise.resolve(null); }
		return new Promise(res => { this.pending.set(id, res); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res(null); } }, timeout); });
	}
	_onData(chunk) {
		this.buf = Buffer.concat([this.buf, chunk]);
		while (true) {
			const sep = this.buf.indexOf('\r\n\r\n');
			if (sep < 0) break;
			const m = this.buf.slice(0, sep).toString().match(/Content-Length: (\d+)/i);
			if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
			const len = +m[1], start = sep + 4;
			if (this.buf.length < start + len) break;
			const body = this.buf.slice(start, start + len).toString();
			this.buf = this.buf.slice(start + len);
			let msg; try { msg = JSON.parse(body); } catch { continue; }
			if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg.result); this.pending.delete(msg.id); }
			else if (msg.method === 'textDocument/publishDiagnostics') this._diag(msg.params);
			else if (msg.id !== undefined && msg.method) { this._frame && this.proc.stdin.write(this._frame({ jsonrpc: '2.0', id: msg.id, result: null })); } // answer server requests with null
		}
	}
	_diag(p) {
		const uri = decodeURIComponent((p.uri || '').replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\');
		const items = (p.diagnostics || []).map(d => ({
			message: d.message, severity: (d.severity ? d.severity - 1 : 0),
			startLine: d.range.start.line, startCol: d.range.start.character,
			endLine: d.range.end.line, endCol: d.range.end.character, source: d.source || this.name,
		}));
		send({ event: 'diagnostics', params: { uri, items } });
	}
	ensureOpen(uri, lang, text) {
		const fileUri = 'file:///' + String(uri).replace(/\\/g, '/');
		if (!this.opened.has(fileUri)) { this.opened.set(fileUri, 1); this._notify('textDocument/didOpen', { textDocument: { uri: fileUri, languageId: lang, version: 1, text } }); }
		else { const v = this.opened.get(fileUri) + 1; this.opened.set(fileUri, v); this._notify('textDocument/didChange', { textDocument: { uri: fileUri, version: v }, contentChanges: [{ text }] }); }
		return fileUri;
	}
	async completion(uri, lang, text, line, character) {
		const fileUri = this.ensureOpen(uri, lang, text);
		const res = await this._req('textDocument/completion', { textDocument: { uri: fileUri }, position: { line, character } }, 3000);
		const items = res ? (Array.isArray(res) ? res : (res.items || [])) : [];
		return items.map(it => ({
			label: typeof it.label === 'object' ? it.label.label : it.label,
			kind: it.kind ? it.kind - 1 : 0,
			insertText: (it.textEdit && it.textEdit.newText) || it.insertText || (typeof it.label === 'object' ? it.label.label : it.label),
			isSnippet: it.insertTextFormat === 2,
			detail: it.detail, documentation: typeof it.documentation === 'string' ? it.documentation : (it.documentation && it.documentation.value),
		}));
	}
}

function selectorMatches(sel, languageId) {
	if (!sel) return true;
	if (Array.isArray(sel)) return sel.some(s => selectorMatches(s, languageId));
	if (typeof sel === 'string') return sel === '*' || sel === languageId;
	if (sel.language) return sel.language === '*' || sel.language === languageId;
	return true;
}

// vscode.Uri as a REAL class — extensions subclass it (`class GitUri extends
// vscode.Uri` in GitLens) and call `super({scheme})`, so a plain object breaks
// whole extension families at load time.
class Uri {
	constructor(c) {
		c = c || {};
		this.scheme = c.scheme || 'file'; this.authority = c.authority || '';
		this.path = c.path || ''; this.query = c.query || ''; this.fragment = c.fragment || '';
		if (c.fsPath != null) this._fsPath = c.fsPath;
	}
	get fsPath() {
		if (this._fsPath != null) return this._fsPath;
		let p = this.path;
		if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/x -> C:/x
		return p.replace(/\//g, path.sep);
	}
	with(c) {
		c = c || {};
		return new Uri({
			scheme: c.scheme != null ? c.scheme : this.scheme,
			authority: c.authority != null ? c.authority : this.authority,
			path: c.path != null ? c.path : this.path,
			query: c.query != null ? c.query : this.query,
			fragment: c.fragment != null ? c.fragment : this.fragment,
		});
	}
	toString() { return (this.scheme || 'file') + '://' + (this.authority || '') + (this.path && !this.path.startsWith('/') && this.scheme === 'file' ? '/' : '') + this.path + (this.query ? '?' + this.query : '') + (this.fragment ? '#' + this.fragment : ''); }
	toJSON() { return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath }; }
	static file(p) { return new Uri({ scheme: 'file', path: String(p).replace(/\\/g, '/'), fsPath: p }); }
	static parse(s) {
		const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(s));
		return m ? new Uri({ scheme: m[1], authority: m[2] || '', path: m[3] || '', query: m[4] || '', fragment: m[5] || '' })
			: new Uri({ scheme: 'file', path: String(s), fsPath: String(s) });
	}
	static from(c) { return new Uri(c); }
	static joinPath(base, ...parts) { return Uri.file(path.join((base && base.fsPath) || String(base), ...parts)); }
	static isUri(u) { return u instanceof Uri; }
}

const vscode = {
	version: '1.106.0', // >=1.106: extensions detect secondary-sidebar support from this (Claude Code does)
	Position, Range, SnippetString, CompletionItem, Diagnostic, Disposable, EventEmitter,
	Uri,
	CompletionItemKind: new Proxy({}, { get: (_, k) => ({ Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17 })[k] ?? 0 }),
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	commands: {
		registerCommand: (id, fn) => { commands.set(id, fn); return new Disposable(); },
		// setContext feeds `when`-clause visibility (containers/views) in the frontend
		executeCommand: async (id, ...args) => {
			if (id === 'setContext') { contextKeys[args[0]] = args[1]; send({ event: 'contextKeys', params: contextKeys }); return; }
			const f = commands.get(id); return f ? f(...args) : undefined;
		},
		getCommands: async () => [...commands.keys()],
	},
	window: {
		showInformationMessage: (m, ...rest) => uiMessage('info', m, rest),
		showWarningMessage: (m, ...rest) => uiMessage('warn', m, rest),
		showErrorMessage: (m, ...rest) => uiMessage('error', m, rest),
		// forward extension output channels to the app's Output console — extensions
		// log their own diagnostics there (e.g. Claude Code logs every webview message)
		createOutputChannel: name => { const fwd = lvl => (...a) => log(`[${name}]${lvl} ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 400)); return permObj({ name, appendLine: fwd(''), append: () => {}, replace: () => {}, show: () => {}, hide: () => {}, dispose: () => {}, clear: () => {}, info: fwd(''), warn: fwd(' warn:'), error: fwd(' error:'), debug: () => {}, trace: () => {}, logLevel: 3, onDidChangeLogLevel: () => new Disposable() }); },
		createStatusBarItem: () => permObj({ show: () => {}, hide: () => {}, dispose: () => {}, text: '', tooltip: '', command: undefined, color: undefined, backgroundColor: undefined }),
		onDidChangeActiveTextEditor: () => new Disposable(),
		activeTextEditor: undefined,
		createTextEditorDecorationType: () => new Disposable(),
		registerTreeDataProvider: (viewId, provider) => {
			treeProviders.set(viewId, provider);
			if (provider.onDidChangeTreeData) { try { provider.onDidChangeTreeData(() => send({ event: 'treeRefresh', params: { viewId } })); } catch {} }
			send({ event: 'treeReady', params: { viewId } });
			return new Disposable(() => treeProviders.delete(viewId));
		},
		createTreeView: (viewId, opts) => {
			if (opts && opts.treeDataProvider) vscode.window.registerTreeDataProvider(viewId, opts.treeDataProvider);
			return permObj({ reveal: async () => {}, dispose: () => treeProviders.delete(viewId), onDidChangeSelection: () => new Disposable(), onDidChangeVisibility: () => new Disposable(), onDidExpandElement: () => new Disposable(), onDidCollapseElement: () => new Disposable(), visible: true, message: '', title: viewId, description: '', badge: undefined, selection: [] });
		},
		registerWebviewViewProvider: (viewId, provider) => { webviewProviders.set(viewId, provider); send({ event: 'webviewReady', params: { viewId } }); return new Disposable(() => webviewProviders.delete(viewId)); },
		// real interactive UI, bridged to the workbench (palette / modal / dialogs) —
		// no-op stubs here made every extension button look dead
		showQuickPick: async (items, opts) => {
			items = await Promise.resolve(items);
			if (!Array.isArray(items) || !items.length) return undefined;
			const labels = items.map(x => typeof x === 'string' ? { label: x } : { label: String(x.label || ''), description: x.description ? String(x.description) : '', detail: x.detail ? String(x.detail) : '' });
			const idx = await uiRequest('quickPick', { items: labels, placeholder: (opts && opts.placeHolder) || '', canPickMany: !!(opts && opts.canPickMany) });
			if (idx === undefined || idx === null) return undefined;
			return Array.isArray(idx) ? idx.map(i => items[i]) : items[idx];
		},
		showInputBox: async (opts) => {
			const v = await uiRequest('input', { prompt: (opts && (opts.prompt || opts.title)) || 'Input', value: (opts && opts.value) || '', placeholder: (opts && opts.placeHolder) || '' });
			return v == null ? undefined : String(v);
		},
		showOpenDialog: async (opts) => {
			const r = await uiRequest('openDialog', { directory: !!(opts && opts.canSelectFolders), multiple: !!(opts && opts.canSelectMany), title: (opts && opts.title) || '' });
			return Array.isArray(r) && r.length ? r.map(p => Uri.file(p)) : undefined;
		},
		showSaveDialog: async (opts) => {
			const r = await uiRequest('saveDialog', { title: (opts && opts.title) || '' });
			return r ? Uri.file(r) : undefined;
		},
		withProgress: async (opts, task) => {
			if (opts && opts.title) send({ event: 'message', params: { type: 'info', text: String(opts.title) } });
			return task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() });
		},
		setStatusBarMessage: () => new Disposable(),
		registerUriHandler: () => new Disposable(),
		registerCustomEditorProvider: () => new Disposable(),
		registerTerminalLinkProvider: () => new Disposable(),
		registerFileDecorationProvider: () => new Disposable(),
		// real webview panels: rendered as an editor tab in the workbench (MongoDB's
		// Add Connection page, GitLens welcome, etc. all arrive through here)
		createWebviewPanel: (viewType, title, _showOpts, options) => {
			const panelId = ('panel.' + viewType + '.' + (_uiSeq++));
			let htmlValue = '', filePath = '';
			const disposeListeners = [];
			webviews.set(panelId, { onMsg: null, pendingIn: [] });
			const tabTitle = () => String(title || viewType);
			const webview = {
				options: options || {}, cspSource: "data: https: 'unsafe-inline' 'unsafe-eval'",
				get html() { return htmlValue; },
				set html(v) { htmlValue = v; filePath = writeWebviewFile(panelId, v); send({ event: 'webviewPanel', params: { panelId, title: tabTitle(), file: filePath } }); },
				asWebviewUri: (uri) => assetUrl(uri && uri.fsPath ? uri.fsPath : String(uri)),
				postMessage: async (m) => { send({ event: 'webviewToView', params: { viewId: panelId, msg: m } }); return true; },
				onDidReceiveMessage: (fn) => {
					const w = webviews.get(panelId);
					if (w) { w.onMsg = fn; const q = w.pendingIn || []; w.pendingIn = []; for (const m of q) { try { fn(m); } catch {} } }
					return new Disposable();
				},
			};
			return permObj({
				viewType, webview, active: true, visible: true, viewColumn: 1,
				get title() { return String(title); }, set title(t) { title = t; },
				reveal: () => { if (filePath) send({ event: 'webviewPanel', params: { panelId, title: tabTitle(), file: filePath } }); },
				onDidDispose: (fn) => { disposeListeners.push(fn); return new Disposable(); },
				onDidChangeViewState: () => new Disposable(),
				dispose: () => { webviews.delete(panelId); for (const f of disposeListeners) { try { f(); } catch {} } },
			});
		},
		createQuickPick: () => ({ items: [], onDidChangeValue: () => new Disposable(), onDidAccept: () => new Disposable(), onDidHide: () => new Disposable(), onDidChangeSelection: () => new Disposable(), show: () => {}, hide: () => {}, dispose: () => {}, value: '', placeholder: '', busy: false }),
		createInputBox: () => ({ onDidAccept: () => new Disposable(), onDidHide: () => new Disposable(), onDidChangeValue: () => new Disposable(), show: () => {}, hide: () => {}, dispose: () => {}, value: '' }),
		createTerminal: () => ({ sendText: () => {}, show: () => {}, hide: () => {}, dispose: () => {}, name: '', processId: Promise.resolve(undefined) }),
		showTextDocument: async () => undefined,
		visibleTextEditors: [], onDidChangeVisibleTextEditors: () => new Disposable(),
		onDidChangeTextEditorSelection: () => new Disposable(), onDidChangeTextEditorVisibleRanges: () => new Disposable(),
		onDidChangeActiveColorTheme: () => new Disposable(), activeColorTheme: { kind: 2 },
		onDidChangeWindowState: () => new Disposable(), state: { focused: true },
		tabGroups: { all: [], activeTabGroup: { tabs: [] }, onDidChangeTabs: () => new Disposable(), onDidChangeTabGroups: () => new Disposable(), close: async () => true },
		terminals: [], onDidOpenTerminal: () => new Disposable(), onDidCloseTerminal: () => new Disposable(), onDidChangeActiveTerminal: () => new Disposable(),
		activeTerminal: undefined, showWorkspaceFolderPick: async () => undefined,
	},
	workspace: {
		// real VSCode semantics: configuration values come from each extension's own
		// contributes.configuration DEFAULTS (collected into configStore at scan time),
		// so `config.get('x')` / `config.x.y` return what the extension declared
		// instead of undefined (which crashed e.g. vscode-icons, discord presence).
		getConfiguration: (section) => {
			const prefix = section ? section + '.' : '';
			const obj = {};
			for (const k in configStore) {
				if (!k.startsWith(prefix)) continue;
				const parts = k.slice(prefix.length).split('.');
				let o = obj;
				for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = (typeof o[parts[i]] === 'object' && o[parts[i]]) || {};
				if (o[parts[parts.length - 1]] === undefined) o[parts[parts.length - 1]] = configStore[k];
			}
			const lookup = k => {
				if ((prefix + k) in configStore) return configStore[prefix + k];
				return String(k).split('.').reduce((a, b) => (a == null ? a : a[b]), obj);
			};
			return Object.assign(Object.create(PERMISSIVE), obj, {
				get: (k, d) => { const v = lookup(k); return v === undefined ? d : v; },
				has: k => lookup(k) !== undefined,
				update: async () => {},
				inspect: k => ({ key: prefix + k, defaultValue: configStore[prefix + k] }),
			});
		},
		onDidChangeConfiguration: () => new Disposable(),
		onDidOpenTextDocument: () => new Disposable(),
		onDidChangeTextDocument: () => new Disposable(),
		onDidSaveTextDocument: () => new Disposable(),
		workspaceFolders: [],
		textDocuments: [],
		name: undefined, workspaceFile: undefined,
		fs: {
			readFile: async u => fs.readFileSync(u.fsPath || String(u)),
			writeFile: async (u, data) => fs.writeFileSync(u.fsPath || String(u), Buffer.from(data)),
			stat: async u => { const s = fs.statSync(u.fsPath || String(u)); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; },
			readDirectory: async u => fs.readdirSync(u.fsPath || String(u), { withFileTypes: true }).map(d => [d.name, d.isDirectory() ? 2 : 1]),
			createDirectory: async u => fs.mkdirSync(u.fsPath || String(u), { recursive: true }),
			delete: async u => fs.rmSync(u.fsPath || String(u), { recursive: true, force: true }),
			rename: async (a, b) => fs.renameSync(a.fsPath || String(a), b.fsPath || String(b)),
			copy: async (a, b) => fs.copyFileSync(a.fsPath || String(a), b.fsPath || String(b)),
		},
		openTextDocument: async () => { throw new Error('not supported'); },
		findFiles: async () => [],
		saveAll: async () => true,
		applyEdit: async () => true,
		createFileSystemWatcher: () => ({ onDidCreate: () => new Disposable(), onDidChange: () => new Disposable(), onDidDelete: () => new Disposable(), dispose: () => {} }),
		getWorkspaceFolder: (u) => vscode.workspace.workspaceFolders[0],
		asRelativePath: p => (p && p.fsPath) || String(p),
		onDidChangeWorkspaceFolders: h => { workspaceFolderListeners.push(h); return new Disposable(); },
		onDidCreateFiles: () => new Disposable(), onDidDeleteFiles: () => new Disposable(), onDidRenameFiles: () => new Disposable(),
		registerTextDocumentContentProvider: () => new Disposable(),
		registerFileSystemProvider: () => new Disposable(),
		registerTaskProvider: () => new Disposable(),
		onWillSaveTextDocument: () => new Disposable(),
		isTrusted: true, onDidGrantWorkspaceTrust: () => new Disposable(),
	},
	languages: {
		registerCompletionItemProvider: (selector, provider, ...triggers) => {
			completionProviders.push({ selector, provider, triggers });
			return new Disposable();
		},
		registerHoverProvider: () => new Disposable(),
		registerDefinitionProvider: () => new Disposable(),
		registerDocumentFormattingEditProvider: () => new Disposable(),
		registerCodeActionsProvider: () => new Disposable(),
		registerDocumentSymbolProvider: () => new Disposable(),
		registerReferenceProvider: () => new Disposable(),
		registerRenameProvider: () => new Disposable(),
		registerCodeLensProvider: () => new Disposable(),
		registerSignatureHelpProvider: () => new Disposable(),
		registerDocumentRangeFormattingEditProvider: () => new Disposable(),
		registerFoldingRangeProvider: () => new Disposable(),
		registerColorProvider: () => new Disposable(),
		registerDocumentLinkProvider: () => new Disposable(),
		registerImplementationProvider: () => new Disposable(),
		registerTypeDefinitionProvider: () => new Disposable(),
		registerDeclarationProvider: () => new Disposable(),
		registerInlayHintsProvider: () => new Disposable(),
		registerWorkspaceSymbolProvider: () => new Disposable(),
		registerOnTypeFormattingEditProvider: () => new Disposable(),
		registerSelectionRangeProvider: () => new Disposable(),
		registerCallHierarchyProvider: () => new Disposable(),
		registerDocumentSemanticTokensProvider: () => new Disposable(),
		registerEvaluatableExpressionProvider: () => new Disposable(),
		onDidChangeDiagnostics: () => new Disposable(),
		getDiagnostics: () => [],
		match: () => 10,
		createDiagnosticCollection: name => {
			const col = {
				name,
				set: (uri, diags) => {
					const items = (diags || []).map(d => ({
						message: d.message, severity: d.severity ?? 0,
						startLine: d.range.start.line, startCol: d.range.start.character,
						endLine: d.range.end.line, endCol: d.range.end.character,
						source: name,
					}));
					send({ event: 'diagnostics', params: { uri: uri.fsPath || String(uri), items } });
				},
				delete: uri => send({ event: 'diagnostics', params: { uri: uri.fsPath || String(uri), items: [] } }),
				clear: () => {}, dispose: () => {},
			};
			diagCollections.push(col);
			return col;
		},
		setTextDocumentLanguage: async d => d,
	},
	// Many extensions read getExtension(self/dependency).extensionPath|exports at
	// module-load time; returning undefined crashes them before activate. Return a
	// permissive stub (real string paths so path.join is safe; permissive exports so
	// dependent extensions degrade instead of throwing).
	extensions: {
		getExtension: (id) => {
			const info = extById.get(String(id).toLowerCase());
			if (!info) return permObj({ id, isActive: false, extensionKind: 1, extensionPath: '', extensionUri: vscode.Uri.file(''), packageJSON: permObj({ name: id, version: '0.0.0', publisher: String(id).split('.')[0], contributes: {} }), exports: PERMISSIVE, activate: async () => PERMISSIVE });
			const rec = extIndex.get(info.dir);
			const exp = () => (rec && rec.exports !== undefined) ? rec.exports : PERMISSIVE;
			return permObj({
				id, isActive: !!(rec && rec.activated), extensionKind: 1,
				extensionPath: info.base, extensionUri: vscode.Uri.file(info.base),
				packageJSON: info.pkg, get exports() { return exp(); },
				activate: async () => { if (rec) activateExt(info.dir); return exp(); },
			});
		},
		all: [], onDidChange: () => new Disposable(),
	},
	env: {
		appName: 'CozyCode', appRoot: APP_ROOT, appHost: 'desktop', uriScheme: 'cozycode', machineId: 'cozy', sessionId: 'cozy', language: 'en',
		clipboard: { writeText: async () => {}, readText: async () => '' },
		openExternal: async () => true, asExternalUri: async u => u, remoteName: undefined, shell: process.env.ComSpec || 'cmd.exe',
		isTelemetryEnabled: false, onDidChangeTelemetryEnabled: () => new Disposable(),
	},
	tasks: { registerTaskProvider: () => new Disposable(), onDidStartTask: () => new Disposable(), onDidEndTask: () => new Disposable(), taskExecutions: [], executeTask: async () => ({ terminate() {} }) },
	debug: { registerDebugConfigurationProvider: () => new Disposable(), registerDebugAdapterDescriptorFactory: () => new Disposable(), onDidStartDebugSession: () => new Disposable(), onDidTerminateDebugSession: () => new Disposable(), onDidChangeActiveDebugSession: () => new Disposable(), onDidReceiveDebugSessionCustomEvent: () => new Disposable(), startDebugging: async () => false, activeDebugSession: undefined, breakpoints: [], addBreakpoints: () => {}, removeBreakpoints: () => {} },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
	SymbolKind: new Proxy({}, { get: () => 0 }),
	CodeActionKind: new Proxy({ Empty: { value: '' } }, { get: (t, k) => t[k] ?? { value: String(k), append: () => ({ value: String(k) }) } }),
	DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
	MarkdownString: class { constructor(v) { this.value = v || ''; this.isTrusted = false; this.supportThemeIcons = false; } appendText(t) { this.value += t; return this; } appendMarkdown(v) { this.value += v; return this; } appendCodeblock(c) { this.value += '\n```\n' + c + '\n```\n'; return this; } },
	ThemeColor: class { constructor(id) { this.id = id; } },
	TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState || 0; } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
	Hover: class { constructor(c) { this.contents = Array.isArray(c) ? c : [c]; } },
	Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
	TextEdit: class { static replace(r, t) { return { range: r, newText: t }; } static insert(p, t) { return { range: new Range(p, p), newText: t }; } static delete(r) { return { range: r, newText: '' }; } },
	WorkspaceEdit: class { constructor() { this._e = []; } replace() {} insert() {} delete() {} set() {} },
	RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
	CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }; } cancel() {} dispose() {} },
	CompletionList: class { constructor(items, incomplete) { this.items = items || []; this.isIncomplete = !!incomplete; } },
	SymbolInformation: class {}, DocumentSymbol: class {}, CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
	Selection: class { constructor(a, b, c, d) { this.anchor = a; this.active = b; this.start = a; this.end = b; } },
	QuickInputButtons: { Back: {} },
	SignatureHelp: class { constructor() { this.signatures = []; } }, SignatureInformation: class {}, ParameterInformation: class {},
	FileSystemError: Object.assign(class extends Error {}, { FileNotFound: () => new Error('FileNotFound'), FileExists: () => new Error('FileExists'), NoPermissions: () => new Error('NoPermissions') }),
	FoldingRange: class {}, FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
	InlayHint: class {}, SemanticTokensBuilder: class { push() {} build() { return {}; } }, SemanticTokensLegend: class {},
};

// Wrap the vscode API in a Proxy: any API we haven't implemented returns a
// permissive universal stub (callable/constructable, any property returns itself)
// instead of undefined. This is why VSCode extensions can access APIs like
// NotebookCellOutputItem at load time without crashing — mimic "everything exists".
// set vscode's PROTOTYPE to the permissive proxy so missing APIs resolve to a stub.
// esbuild's __toESM copies own props into `__create(getPrototypeOf(mod))`, so the
// copied module inherits this prototype and missing keys (NotebookCellOutputItem,
// tests, l10n, ...) resolve to UNIVERSAL instead of undefined -> no load crash.
Object.setPrototypeOf(vscode, PERMISSIVE);
// also give each namespace a permissive prototype so missing methods
// (workspace.onDidCloseTextDocument, window.onDidChangeX, languages.registerY, ...)
// resolve to a no-op stub instead of throwing "is not a function"
// namespaces: give existing ones a permissive prototype; create missing ones as
// own permissive objects. Own-ness matters because interop copies keep the value's
// own prototype, so `vscode.lm.registerX` resolves to a stub instead of crashing.
for (const ns of ['workspace', 'window', 'languages', 'commands', 'env', 'debug', 'tasks', 'extensions', 'scm', 'comments', 'authentication', 'notebooks', 'tests', 'l10n', 'lm', 'chat', 'interactive', 'speech', 'aiRelatedInformation']) {
	if (vscode[ns] && typeof vscode[ns] === 'object') Object.setPrototypeOf(vscode[ns], PERMISSIVE);
	else vscode[ns] = Object.create(PERMISSIVE);
}

// The PERMISSIVE prototype only helps extensions that `require('vscode')` directly.
// Bundlers wrap it: babel `_interopRequireWildcard` / esbuild `__toESM` copy OWN
// ENUMERABLE props to a fresh object and DROP the prototype, so any class an
// extension `extends` (e.g. `class X extends vscode.DocumentLink`) or any enum it
// reads must exist as an OWN prop or it becomes undefined -> load crash.
// permissive constructable stub: `class X extends stubClass()` works AND
// `Stub.staticFactory()` (e.g. NotebookCellOutputItem.error) resolves to a no-op.
function stubClass() {
	const C = class {};
	return new Proxy(C, { get: (t, p) => (p in t || typeof p === 'symbol') ? t[p] : UNIVERSAL, set: () => true, defineProperty: () => true });
}
for (const n of ('DocumentLink DocumentHighlight DiagnosticRelatedInformation LocationLink ' +
	'CallHierarchyItem CallHierarchyIncomingCall CallHierarchyOutgoingCall TypeHierarchyItem ' +
	'SemanticTokens SemanticTokensEdit SemanticTokensEdits Color ColorInformation ColorPresentation ' +
	'SelectionRange InlayHintLabelPart InlineValueText InlineValueVariableLookup InlineValueEvaluatableExpression ' +
	'EvaluatableExpression InlineCompletionItem InlineCompletionList DataTransfer DataTransferItem ' +
	'DocumentDropEdit DocumentPasteEdit ProcessExecution ShellExecution CustomExecution TaskGroup ' +
	'NotebookCellData NotebookData NotebookEdit NotebookRange NotebookCellOutput NotebookCellOutputItem ' +
	'NotebookCellStatusBarItem TerminalLink TerminalProfile FileDecoration DebugAdapterExecutable ' +
	'DebugAdapterServer DebugAdapterNamedPipeServer DebugAdapterInlineImplementation LinkedEditingRanges ' +
	'TestMessage TestTag FileCoverage StatementCoverage BranchCoverage DeclarationCoverage TestCoverageCount ' +
	'DocumentSymbolProvider CompletionItemProvider').split(' ')) {
	if (!Object.prototype.hasOwnProperty.call(vscode, n)) vscode[n] = stubClass();
}
// missing enums with their real numeric members (interop-copied exts read these)
const ENUMS = {
	EndOfLine: { LF: 1, CRLF: 2 }, ExtensionKind: { UI: 1, Workspace: 2 }, UIKind: { Desktop: 1, Web: 2 },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 }, LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
	TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
	DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
	OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 }, CompletionItemTag: { Deprecated: 1 }, SymbolTag: { Deprecated: 1 },
	SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 }, InlayHintKind: { Type: 1, Parameter: 2 },
	CodeActionTriggerKind: { Invoke: 1, Automatic: 2 }, TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
	FileChangeType: { Changed: 1, Created: 2, Deleted: 3 }, ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 }, TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
	CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 }, QuickPickItemKind: { Separator: -1, Default: 0 },
	TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 },
	TextEditorLineNumbersStyle: { Off: 0, On: 1, Relative: 2, Interval: 3 }, InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
	TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 }, DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
	NotebookControllerAffinity: { Default: 1, Preferred: 2 }, NotebookCellKind: { Markup: 1, Code: 2 }, NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
	DebugConsoleMode: { Separate: 0, MergeWithParent: 1 }, CommentMode: { Editing: 0, Preview: 1 }, TextSearchCompleteMessageType: { Information: 1, Warning: 2 },
};
for (const k in ENUMS) if (!Object.prototype.hasOwnProperty.call(vscode, k)) vscode[k] = ENUMS[k];

// intercept require('vscode') + stub common deps we don't fully implement so an
// extension's require() doesn't hard-crash (LSP/nls stay no-ops but activate runs)
const STUBS = {
	vscode,
	'vscode-nls': (() => { const f = () => (k, m) => m || k; const o = { loadMessageBundle: () => (k, m) => m || k, config: () => () => (k, m) => m || k }; return o; })(),
};
const NOOP_MODULES = ['vscode-languageclient', 'vscode-languageclient/node', 'vscode-languageclient/browser'];
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode' || STUBS[request]) return request;
	if (NOOP_MODULES.includes(request)) return request;
	return origResolve.call(this, request, ...rest);
};
for (const k of Object.keys(STUBS)) require.cache[k] = { id: k, filename: k, loaded: true, exports: STUBS[k] };
// vscode-languageclient: real LSP client so extensions get IntelliSense.
// Extensions call `new LanguageClient(id, name, serverOptions, clientOptions).start()`.
class LanguageClient {
	constructor(a, b, c, d) {
		// signatures: (id, name, serverOptions, clientOptions) or (name, serverOptions, clientOptions)
		if (typeof c === 'object' && d === undefined && typeof b === 'object') { this._c = new LspClient(a, a, b, c); }
		else { this._c = new LspClient(a, b, c, d); }
	}
	start() { return this._c.start(); }
	stop() { this._c.stop(); return Promise.resolve(); }
	onReady() { return Promise.resolve(); }
	onNotification() {} sendNotification() {} onRequest() {}
	sendRequest() { return Promise.resolve(null); }
	registerProposedFeatures() {} registerFeature() {}
	get initializeResult() { return {}; }
}
const lcModule = {
	LanguageClient,
	TransportKind: { ipc: 0, stdio: 1, pipe: 2, socket: 3 },
	RevealOutputChannelOn: { Info: 1, Warn: 2, Error: 3, Never: 4 },
	State: { Stopped: 1, Starting: 3, Running: 2 },
	SettingMonitor: class { constructor() {} start() { return { dispose() {} }; } },
	ErrorAction: { Continue: 1, Shutdown: 2 }, CloseAction: { DoNotRestart: 1, Restart: 2 },
};
for (const k of NOOP_MODULES) require.cache[k] = { id: k, filename: k, loaded: true, exports: lcModule };

/* ---------- load extensions (LAZY activation like VSCode) ---------- */
const loaded = [];
const contributions = [];   // { id, viewsContainers, views, commands }
const extIndex = new Map(); // dir -> { base, pkg, events:Set, activated:bool, exports }
const extById = new Map();  // "publisher.name" (lc) -> { base, pkg, dir } (for getExtension)

function makeContext(base, pkg) {
	pkg = pkg || {};
	const uri = vscode.Uri.file(base);
	const extId = (pkg.publisher && pkg.name) ? pkg.publisher + '.' + pkg.name : base;
	// permObj on the context and its sub-objects: missing methods (e.g.
	// environmentVariableCollection.get, context.languageModelAccessInformation)
	// resolve to no-op stubs instead of throwing during activate.
	const envColl = () => permObj({ persistent: true, replace: () => {}, append: () => {}, prepend: () => {}, get: () => undefined, forEach: () => {}, delete: () => {}, clear: () => {} });
	return permObj({
		subscriptions: [], extensionPath: base, extensionUri: uri, extensionMode: 1,
		globalState: permObj({ get: (k, d) => d, update: async () => {}, keys: () => [], setKeysForSync: () => {} }),
		workspaceState: permObj({ get: (k, d) => d, update: async () => {}, keys: () => [] }),
		secrets: permObj({ get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => new Disposable() }),
		asAbsolutePath: r => path.join(base, r),
		extension: permObj({ id: extId, extensionPath: base, extensionUri: uri, isActive: true, packageJSON: pkg, exports: PERMISSIVE }),
		environmentVariableCollection: Object.assign(envColl(), { getScoped: () => envColl() }),
		storageUri: uri, globalStorageUri: uri, logUri: uri,
		storagePath: base, globalStoragePath: base, logPath: base,
	});
}
function setStatus(id, status) { const e = loaded.find(x => x.id === id); if (e) e.status = status; sendLoaded(); }

function activateExt(dir) {
	const rec = extIndex.get(dir);
	if (!rec || rec.activated) return;
	rec.activated = true;
	try {
		if (process.env.COZY_TRACE) process.stderr.write('ACTIVATE ' + dir + '\n');
		const mod = require(path.join(rec.base, rec.pkg.main));
		if (process.env.COZY_TRACE) process.stderr.write('LOADED ' + dir + '\n');
		if (typeof mod.activate === 'function') {
			const _p = mod.activate(makeContext(rec.base, rec.pkg));
			if (process.env.COZY_TRACE) process.stderr.write('SYNC-OK ' + dir + '\n');
			Promise.resolve(_p).then(
				(api) => { rec.exports = api === undefined ? {} : api; setStatus(dir, 'activated'); }, // exports for dependent extensions (getExtension().exports)
				e => setStatus(dir, 'activate failed: ' + String(e && e.message).slice(0, 260)),
			);
		} else { rec.exports = mod && mod.exports !== undefined ? mod.exports : {}; setStatus(dir, 'loaded'); }
	} catch (e) { if (process.env.COZY_STACK) process.stderr.write('LOADFAIL ' + dir + '\n' + (e && e.stack) + '\n'); setStatus(dir, 'load failed: ' + String(e && e.message).slice(0, 100)); }
}

// fire an activation event -> activate any extension registered for it
function activateByEvent(event) {
	for (const [dir, rec] of extIndex) {
		if (rec.activated) continue;
		if (rec.events.has('*') || rec.events.has(event)) activateExt(dir);
	}
}

// workspaceContains:<glob> activation — VSCode scans the opened folder for the
// pattern and activates matching extensions. Shallow BFS (depth 3, capped) covers
// the real-world patterns (pubspec.yaml, */pom.xml, **/*.csproj).
const workspaceFolderListeners = [];
function setWorkspaceRoot(root) {
	const folders = root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : [];
	vscode.workspace.workspaceFolders = folders;
	vscode.workspace.rootPath = root || undefined;
	vscode.workspace.name = root ? path.basename(root) : undefined;
	for (const h of workspaceFolderListeners) { try { h({ added: folders, removed: [] }); } catch {} }
	if (!root) return;
	// ONE shallow scan of the folder, then match every extension's patterns against
	// it — a scan per pattern per extension blocked the event loop for 20s+ on
	// workspaces with a Rust target/ dir, freezing every pending RPC.
	const names = [];
	const queue = [[root, 0]];
	let seen = 0;
	while (queue.length && seen < 4000) {
		const [dir, depth] = queue.shift();
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			if (++seen > 4000) break;
			names.push(e.name);
			if (e.isDirectory() && depth < 2 && e.name !== 'node_modules' && e.name !== 'target' && e.name[0] !== '.') queue.push([path.join(dir, e.name), depth + 1]);
		}
	}
	const nameSet = new Set(names);
	const toActivate = [];
	for (const [dir, rec] of extIndex) {
		if (rec.activated) continue;
		for (const ev of rec.events) {
			if (!ev.startsWith('workspaceContains:')) continue;
			const pat = ev.slice(18).replace(/^\*\*\//, '').replace(/^(\*\/)+/, '');
			let hit;
			if (pat.includes('*')) {
				const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*') + '$', 'i');
				hit = names.some(n => rx.test(n));
			} else hit = nameSet.has(pat);
			if (hit) { toActivate.push(dir); break; }
		}
	}
	// activate one per tick: each require() of a big bundle blocks the loop for a
	// while, and doing them back-to-back froze every pending RPC for 20s+
	let ai = 0;
	const step = () => { if (ai >= toActivate.length) return; try { activateExt(toActivate[ai++]); } catch {} setImmediate(step); };
	setImmediate(step);
}

let disabledExts = {};
try { disabledExts = JSON.parse(fs.readFileSync(path.join(extRoot, '.state.json'), 'utf8')); } catch {}
const isDisabled = id => disabledExts[id] && disabledExts[id].enabled === false;

// platform-incompatible: Microsoft's remote-* extensions are proprietary and only
// function inside official VS Code (WSL even says so at runtime); remote-containers
// additionally busy-loops against our shim. Every fork (VSCodium, Cursor) blocks
// these — CozyCode ships its own SSH remote instead.
const UNSUPPORTED = ['ms-vscode-remote.', 'ms-vscode.remote-', 'github.codespaces', 'ms-vsliveshare.'];
const isUnsupported = id => UNSUPPORTED.some(p => id.toLowerCase().startsWith(p));

if (extRoot && fs.existsSync(extRoot)) {
	for (const dir of fs.readdirSync(extRoot)) {
		if (dir.startsWith('.') || isDisabled(dir)) continue; // skip .state.json + partial/temp install dirs
		if (isUnsupported(dir)) { loaded.push({ id: dir, status: 'unsupported (requires VS Code remote infrastructure)' }); continue; }
		const base = path.join(extRoot, dir, 'extension');
		const pkgPath = path.join(base, 'package.json');
		if (!fs.existsSync(pkgPath)) continue;
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
		if (pkg.name && pkg.publisher) extById.set((pkg.publisher + '.' + pkg.name).toLowerCase(), { base, pkg, dir });
		// resolve NLS %key% strings from package.nls.json (like VSCode)
		let nls = {};
		try { nls = JSON.parse(fs.readFileSync(path.join(base, 'package.nls.json'), 'utf8')); } catch {}
		const loc = s => (typeof s === 'string' && s.length > 1 && s[0] === '%' && s[s.length - 1] === '%')
			? (typeof nls[s.slice(1, -1)] === 'string' ? nls[s.slice(1, -1)] : (nls[s.slice(1, -1)] && nls[s.slice(1, -1)].message) || s)
			: s;
		const c = pkg.contributes || {};

		// collect configuration DEFAULTS (contributes.configuration is an object or array)
		for (const cfg of Array.isArray(c.configuration) ? c.configuration : (c.configuration ? [c.configuration] : [])) {
			for (const key in cfg.properties || {}) {
				const d = cfg.properties[key].default;
				if (d !== undefined) configStore[key] = d;
			}
		}

		// explicit + implicit activation events (VSCode auto-generates from contributes)
		const events = new Set(pkg.activationEvents || []);
		for (const cm of c.commands || []) events.add('onCommand:' + cm.command);
		for (const container in (c.views || {})) for (const v of c.views[container]) events.add('onView:' + v.id);
		for (const l of c.languages || []) if (l.id) events.add('onLanguage:' + l.id);
		if (!pkg.activationEvents && !events.size) events.add('*'); // very old extensions

		// contributions for the native adapter (localize titles, resolve icon paths).
		// keep the container's real location so the UI places it correctly:
		// activitybar -> left, secondarySidebar -> right, panel -> bottom.
		const vc = [];
		for (const location of ['activitybar', 'secondarySidebar', 'panel']) {
			for (const x of (c.viewsContainers && c.viewsContainers[location]) || []) {
				vc.push({
					id: x.id, title: loc(x.title), location, when: x.when || '',
					icon: (typeof x.icon === 'string' && !x.icon.startsWith('$(')) ? path.join(base, x.icon) : x.icon,
				});
			}
		}
		const views = [];
		for (const container in (c.views || {})) for (const v of c.views[container]) views.push({ container, id: v.id, name: loc(v.name), type: v.type || 'tree', when: v.when || '' });
		// viewsWelcome: what VSCode renders in an empty tree view (Sign in / Connect /
		// Open Folder buttons) — markdown subset, command: links become buttons
		const welcome = (c.viewsWelcome || []).map(w => ({ view: w.view, contents: loc(w.contents), when: w.when || '' }));
		if (vc.length || views.length || welcome.length || (c.commands || []).length)
			contributions.push({ id: dir, viewsContainers: vc, views, welcome, commands: (c.commands || []).map(cm => ({ command: cm.command, title: loc(cm.title), category: loc(cm.category) })) });

		if (pkg.main) { extIndex.set(dir, { base, pkg, events, activated: false }); loaded.push({ id: dir, status: 'registered' }); }
		else loaded.push({ id: dir, status: 'no-code (themes/snippets)' });
	}
}
function sendLoaded() { send({ event: 'loaded', params: loaded }); }
sendLoaded();
send({ event: 'contributes', params: contributions });
send({ event: 'configStore', params: configStore }); // config defaults drive config.* when-clauses
// activate startup extensions only (lazy for the rest)
setTimeout(() => activateByEvent('onStartupFinished'), 50);

/* ---------- rpc ---------- */
function makeDocument(p) {
	const lines = p.text.split('\n');
	return {
		uri: vscode.Uri.file(p.uri), fileName: p.uri, languageId: p.languageId, version: 1,
		getText: range => range ? lines.slice(range.start.line, range.end.line + 1).join('\n') : p.text,
		lineAt: l => {
			const line = typeof l === 'number' ? l : l.line;
			return { text: lines[line] || '', lineNumber: line, range: new Range(line, 0, line, (lines[line] || '').length) };
		},
		lineCount: lines.length,
		offsetAt: pos => lines.slice(0, pos.line).reduce((a, x) => a + x.length + 1, 0) + pos.character,
		positionAt: off => { let l = 0, c = off; for (const ln of lines) { if (c <= ln.length) break; c -= ln.length + 1; l++; } return new Position(l, c); },
		getWordRangeAtPosition: () => undefined,
		save: async () => true, isDirty: false, isUntitled: false, eol: 1,
	};
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.method === 'shutdown') process.exit(0);
	if (msg.method === 'activateEvent') { activateByEvent(msg.params.event); if (msg.id) send({ id: msg.id, result: true }); return; }
	// answer to a uiRequest (quick pick selection, input text, dialog result)
	if (msg.method === 'uiResponse') {
		const w = uiWaiters.get(msg.params.id);
		if (w) { uiWaiters.delete(msg.params.id); w(msg.params.value); }
		return;
	}
	// workspace opened/changed in the workbench: publish real workspaceFolders and
	// fire workspaceContains:* activation (VSCode scans the folder for the patterns)
	if (msg.method === 'setWorkspace') {
		setWorkspaceRoot(msg.params.root || '');
		if (msg.id) send({ id: msg.id, result: true });
		return;
	}
	if (msg.method === 'completions') {
		const { languageId, uri, text, line, character } = msg.params;
		activateByEvent('onLanguage:' + languageId);
		const doc = makeDocument(msg.params);
		const pos = new Position(msg.params.line, msg.params.character);
		const items = [];
		// LSP language servers first (real IntelliSense)
		for (const client of languageClients) {
			if (!client.handles(languageId)) continue;
			try { for (const it of await client.completion(uri, languageId, text, line, character)) { items.push(it); if (items.length > 300) break; } }
			catch (e) { log('lsp completion error: ' + e.message); }
		}
		for (const { selector, provider } of completionProviders) {
			if (!selectorMatches(selector, languageId)) continue;
			try {
				let res = await provider.provideCompletionItems(doc, pos, { isCancellationRequested: false }, { triggerKind: 0 });
				if (res && res.items) res = res.items;
				for (const it of res || []) {
					items.push({
						label: typeof it.label === 'object' ? it.label.label : it.label,
						kind: it.kind ?? 0,
						insertText: it.insertText && it.insertText.value !== undefined ? it.insertText.value : (it.insertText ?? undefined),
						isSnippet: !!(it.insertText && it.insertText.value !== undefined),
						detail: it.detail, documentation: typeof it.documentation === 'string' ? it.documentation : undefined,
					});
					if (items.length > 200) break;
				}
			} catch (e) { log('completion provider error: ' + e.message); }
		}
		send({ id: msg.id, result: items });
	}
	if (msg.method === 'listLoaded') send({ id: msg.id, result: loaded });

	// tree data for a contributed view: children of a node (or roots when no node)
	if (msg.method === 'treeChildren') {
		const { viewId, nodeKey } = msg.params;
		if (!nodeKey) {
			activateByEvent('onView:' + viewId);
			// wait for the extension to register its tree provider (activation is async)
			for (let i = 0; i < 40 && !treeProviders.has(viewId); i++) await new Promise(r => setTimeout(r, 50));
		}
		const provider = treeProviders.get(viewId);
		if (!provider) { send({ id: msg.id, result: [] }); return; }
		try {
			const element = nodeKey ? treeItemCache.get(nodeKey) : undefined;
			const children = (await provider.getChildren(element)) || [];
			const out = [];
			for (const ch of children) {
				let item = await provider.getTreeItem(ch);
				if (!item) continue;
				const key = 'n' + (_nodeSeq++);
				treeItemCache.set(key, ch);
				const label = typeof item.label === 'object' ? item.label.label : (item.label || item.title || '');
				out.push({
					nodeKey: key,
					label: String(label),
					description: item.description ? String(item.description) : '',
					tooltip: item.tooltip ? String(item.tooltip.value || item.tooltip) : '',
					collapsible: item.collapsibleState || 0,
					icon: item.iconPath && item.iconPath.id ? item.iconPath.id : '',
					command: item.command ? { command: item.command.command, args: item.command.arguments || [] } : null,
					contextValue: item.contextValue || '',
				});
			}
			send({ id: msg.id, result: out });
		} catch (e) { log('tree error: ' + e.message); send({ id: msg.id, result: [] }); }
		return;
	}
	// resolve a webview view: activate its extension, run resolveWebviewView, return html
	if (msg.method === 'resolveWebview') {
		const { viewId } = msg.params;
		activateByEvent('onView:' + viewId);
		for (let i = 0; i < 160 && !webviewProviders.has(viewId); i++) await new Promise(r => setTimeout(r, 50));
		const provider = webviewProviders.get(viewId);
		if (!provider) { send({ id: msg.id, result: { file: '', error: 'no webview provider (extension may not have registered it)' } }); return; }
		let htmlValue = '', filePath = '', responded = false;
		// respond as soon as html is first set (VSCode paints immediately); the rest of
		// resolveWebviewView often awaits slow init (analysis server, DevTools) that may
		// never settle without a project open, so we must not block the RPC on it.
		const respond = (error) => { if (responded) return; responded = true; log(`webview resolve done ${viewId}${error ? ' err: ' + error : ''}`); send({ id: msg.id, result: { file: filePath, error } }); };
		log('webview resolve start ' + viewId);
		const webview = {
			options: {}, cspSource: "data: https: 'unsafe-inline' 'unsafe-eval'",
			get html() { return htmlValue; },
			set html(v) { htmlValue = v; filePath = writeWebviewFile(viewId, v); send({ event: 'webviewHtml', params: { viewId, file: filePath } }); respond(); },
			asWebviewUri: (uri) => assetUrl(uri && uri.fsPath ? uri.fsPath : String(uri)),
			postMessage: async (m) => { send({ event: 'webviewToView', params: { viewId, msg: m } }); return true; },
			// drain messages that arrived before the provider registered its handler —
			// the webview's init request often lands while resolveWebviewView is still
			// awaiting setup, and dropping it deadlocks the webview UI
			onDidReceiveMessage: (fn) => {
				const w = webviews.get(viewId);
				if (w) { w.onMsg = fn; const q = w.pendingIn || []; w.pendingIn = []; for (const m of q) { try { fn(m); } catch (e) { log('webview msg error: ' + e.message); } } }
				return new Disposable();
			},
		};
		const view = {
			viewType: viewId, webview, title: '', description: '', badge: undefined, visible: true, show: () => {},
			onDidChangeVisibility: () => new Disposable(), onDidDispose: () => new Disposable(),
		};
		webviews.set(viewId, { view, onMsg: null, pendingIn: [] });
		Promise.resolve().then(() => provider.resolveWebviewView(view, { state: undefined }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }))
			.then(() => respond(), e => respond(String(e && e.message).slice(0, 200)));
		// safety net: if html never gets set and resolve never settles, answer anyway
		setTimeout(() => respond(filePath ? undefined : 'resolveWebviewView produced no html'), 7000);
		return;
	}
	// message from the webview iframe -> extension's onDidReceiveMessage handler.
	// buffered until the handler registers (VSCode buffers both directions).
	if (msg.method === 'webviewMessage') {
		const w = webviews.get(msg.params.viewId);
		if (!w) return;
		if (w.onMsg) { try { w.onMsg(msg.params.msg); } catch (e) { log('webview msg error: ' + e.message); } }
		else (w.pendingIn = w.pendingIn || []).push(msg.params.msg);
		return;
	}
	if (msg.method === 'executeCommand') {
		if (!commands.has(msg.params.command)) { activateByEvent('onCommand:' + msg.params.command); await new Promise(r => setTimeout(r, 120)); }
		try { const r = await vscode.commands.executeCommand(msg.params.command, ...(msg.params.args || [])); send({ id: msg.id, result: r === undefined ? null : (typeof r === 'object' ? '[object]' : r) }); }
		catch (e) { send({ id: msg.id, result: null, error: e.message }); }
		return;
	}
});
