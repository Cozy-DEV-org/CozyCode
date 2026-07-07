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
	TreeItem: class {}, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	CodeLens: class {}, Hover: class { constructor(c) { this.contents = [c]; } },
	Location: class {}, TextEdit: class { static replace(r, t) { return { range: r, newText: t }; } },
};

// intercept require('vscode')
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'vscode') return 'vscode';
	return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

/* ---------- load extensions ---------- */
const loaded = [];
if (extRoot && fs.existsSync(extRoot)) {
	for (const dir of fs.readdirSync(extRoot)) {
		const base = path.join(extRoot, dir, 'extension');
		const pkgPath = path.join(base, 'package.json');
		if (!fs.existsSync(pkgPath)) continue;
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
		if (!pkg.main) { loaded.push({ id: dir, status: 'no-code (themes/snippets only)' }); continue; }
		try {
			const mod = require(path.join(base, pkg.main));
			if (typeof mod.activate === 'function') {
				Promise.resolve(mod.activate({
					subscriptions: [], extensionPath: base,
					globalState: { get: (k, d) => d, update: async () => {} },
					workspaceState: { get: (k, d) => d, update: async () => {} },
					asAbsolutePath: r => path.join(base, r),
					extensionUri: vscode.Uri.file(base),
				})).then(
					() => { loaded.push({ id: dir, status: 'activated' }); sendLoaded(); },
					e => { loaded.push({ id: dir, status: 'activate failed: ' + e.message }); sendLoaded(); },
				);
			} else loaded.push({ id: dir, status: 'loaded (no activate)' });
		} catch (e) {
			loaded.push({ id: dir, status: 'load failed: ' + String(e.message).slice(0, 120) });
		}
	}
}
function sendLoaded() { send({ event: 'loaded', params: loaded }); }
sendLoaded();

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
	if (msg.method === 'completions') {
		const { languageId } = msg.params;
		const doc = makeDocument(msg.params);
		const pos = new Position(msg.params.line, msg.params.character);
		const items = [];
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
});
