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
class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
class EventEmitter {
	constructor() { this._h = []; this.event = h => { this._h.push(h); return new Disposable(); }; }
	fire(e) { this._h.forEach(h => { try { h(e); } catch {} }); }
}

const completionProviders = []; // { selector, provider }
const commands = new Map();
const diagCollections = [];
const treeProviders = new Map(); // viewId -> provider
const treeItemCache = new Map(); // nodeKey -> element (so clicks can resolve back)
let _nodeSeq = 1;

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

const vscode = {
	version: '1.90.0',
	Position, Range, SnippetString, CompletionItem, Diagnostic, Disposable, EventEmitter,
	Uri: {
		file: p => ({ fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', toString: () => 'file://' + p }),
		parse: s => ({ fsPath: s, path: s, scheme: 'file', toString: () => s }),
	},
	CompletionItemKind: new Proxy({}, { get: (_, k) => ({ Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17 })[k] ?? 0 }),
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	commands: {
		registerCommand: (id, fn) => { commands.set(id, fn); return new Disposable(); },
		executeCommand: async (id, ...args) => { const f = commands.get(id); return f ? f(...args) : undefined; },
		getCommands: async () => [...commands.keys()],
	},
	window: {
		showInformationMessage: (m, ...rest) => { send({ event: 'message', params: { type: 'info', text: String(m) } }); return Promise.resolve(undefined); },
		showWarningMessage: (m) => { send({ event: 'message', params: { type: 'warn', text: String(m) } }); return Promise.resolve(undefined); },
		showErrorMessage: (m) => { send({ event: 'message', params: { type: 'error', text: String(m) } }); return Promise.resolve(undefined); },
		createOutputChannel: name => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {}, clear: () => {} }),
		createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {}, text: '', tooltip: '' }),
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
			return { reveal: async () => {}, dispose: () => treeProviders.delete(viewId), onDidChangeSelection: () => new Disposable(), onDidChangeVisibility: () => new Disposable(), visible: true, message: '', title: viewId };
		},
		registerWebviewViewProvider: () => new Disposable(),
		showQuickPick: async (items) => Array.isArray(items) ? (await items)[0] : undefined,
		showInputBox: async () => undefined,
		withProgress: async (opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
		setStatusBarMessage: () => new Disposable(),
		registerUriHandler: () => new Disposable(),
		registerCustomEditorProvider: () => new Disposable(),
		terminals: [], onDidOpenTerminal: () => new Disposable(), onDidCloseTerminal: () => new Disposable(),
	},
	workspace: {
		getConfiguration: () => ({ get: (k, d) => d, has: () => false, update: async () => {}, inspect: () => undefined }),
		onDidChangeConfiguration: () => new Disposable(),
		onDidOpenTextDocument: () => new Disposable(),
		onDidChangeTextDocument: () => new Disposable(),
		onDidSaveTextDocument: () => new Disposable(),
		workspaceFolders: [],
		textDocuments: [],
		fs: { readFile: async u => fs.readFileSync(u.fsPath) },
		openTextDocument: async () => { throw new Error('not supported'); },
	},
	languages: {
		registerCompletionItemProvider: (selector, provider, ...triggers) => {
			completionProviders.push({ selector, provider, triggers });
			return new Disposable();
		},
		registerHoverProvider: () => new Disposable(),
		registerDefinitionProvider: () => new Disposable(),
		registerDocumentFormattingEditProvider: () => new Disposable(),
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
	extensions: { getExtension: () => undefined, all: [] },
	env: { appName: 'CozyCode', machineId: 'cozy', language: 'en', clipboard: { writeText: async () => {}, readText: async () => '' } },
	ProgressLocation: { Notification: 15, Window: 10 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	MarkdownString: class { constructor(v) { this.value = v || ''; } appendMarkdown(v) { this.value += v; return this; } },
	ThemeColor: class { constructor(id) { this.id = id; } },
	TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState || 0; } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(id) { this.id = id; } },
	CodeLens: class {}, Hover: class { constructor(c) { this.contents = [c]; } },
	Location: class {}, TextEdit: class { static replace(r, t) { return { range: r, newText: t }; } },
};

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
const extIndex = new Map(); // dir -> { base, pkg, events:Set, activated:bool }

function makeContext(base) {
	return {
		subscriptions: [], extensionPath: base,
		globalState: { get: (k, d) => d, update: async () => {}, keys: () => [], setKeysForSync: () => {} },
		workspaceState: { get: (k, d) => d, update: async () => {}, keys: () => [] },
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => new Disposable() },
		asAbsolutePath: r => path.join(base, r),
		extensionUri: vscode.Uri.file(base), extensionMode: 1, extension: { id: base, packageJSON: {} },
		environmentVariableCollection: { replace: () => {}, append: () => {}, prepend: () => {}, clear: () => {}, getScoped: () => ({ replace: () => {}, append: () => {}, prepend: () => {} }) },
		storageUri: vscode.Uri.file(base), globalStorageUri: vscode.Uri.file(base), logUri: vscode.Uri.file(base),
	};
}
function setStatus(id, status) { const e = loaded.find(x => x.id === id); if (e) e.status = status; sendLoaded(); }

function activateExt(dir) {
	const rec = extIndex.get(dir);
	if (!rec || rec.activated) return;
	rec.activated = true;
	try {
		const mod = require(path.join(rec.base, rec.pkg.main));
		if (typeof mod.activate === 'function') {
			Promise.resolve(mod.activate(makeContext(rec.base))).then(
				() => setStatus(dir, 'activated'),
				e => setStatus(dir, 'activate failed: ' + String(e && e.message).slice(0, 100)),
			);
		} else setStatus(dir, 'loaded');
	} catch (e) { setStatus(dir, 'load failed: ' + String(e && e.message).slice(0, 100)); }
}

// fire an activation event -> activate any extension registered for it
function activateByEvent(event) {
	for (const [dir, rec] of extIndex) {
		if (rec.activated) continue;
		if (rec.events.has('*') || rec.events.has(event)) activateExt(dir);
	}
}

if (extRoot && fs.existsSync(extRoot)) {
	for (const dir of fs.readdirSync(extRoot)) {
		const base = path.join(extRoot, dir, 'extension');
		const pkgPath = path.join(base, 'package.json');
		if (!fs.existsSync(pkgPath)) continue;
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
		const c = pkg.contributes || {};

		// explicit + implicit activation events (VSCode auto-generates from contributes)
		const events = new Set(pkg.activationEvents || []);
		for (const cm of c.commands || []) events.add('onCommand:' + cm.command);
		for (const container in (c.views || {})) for (const v of c.views[container]) events.add('onView:' + v.id);
		for (const l of c.languages || []) if (l.id) events.add('onLanguage:' + l.id);
		if (!pkg.activationEvents && !events.size) events.add('*'); // very old extensions

		// contributions for the native adapter (resolve container icon paths to absolute)
		const vc = ((c.viewsContainers && c.viewsContainers.activitybar) || []).map(x => ({
			id: x.id, title: x.title,
			icon: (typeof x.icon === 'string' && !x.icon.startsWith('$(')) ? path.join(base, x.icon) : x.icon,
		}));
		const views = [];
		for (const container in (c.views || {})) for (const v of c.views[container]) views.push({ container, id: v.id, name: v.name });
		if (vc.length || views.length || (c.commands || []).length)
			contributions.push({ id: dir, viewsContainers: vc, views, commands: (c.commands || []).map(cm => ({ command: cm.command, title: cm.title, category: cm.category })) });

		if (pkg.main) { extIndex.set(dir, { base, pkg, events, activated: false }); loaded.push({ id: dir, status: 'registered' }); }
		else loaded.push({ id: dir, status: 'no-code (themes/snippets)' });
	}
}
function sendLoaded() { send({ event: 'loaded', params: loaded }); }
sendLoaded();
send({ event: 'contributes', params: contributions });
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
		if (!nodeKey) { activateByEvent('onView:' + viewId); await new Promise(r => setTimeout(r, 120)); }
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
	if (msg.method === 'executeCommand') {
		if (!commands.has(msg.params.command)) { activateByEvent('onCommand:' + msg.params.command); await new Promise(r => setTimeout(r, 120)); }
		try { const r = await vscode.commands.executeCommand(msg.params.command, ...(msg.params.args || [])); send({ id: msg.id, result: r === undefined ? null : (typeof r === 'object' ? '[object]' : r) }); }
		catch (e) { send({ id: msg.id, result: null, error: e.message }); }
		return;
	}
});
