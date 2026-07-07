// CozyCode extensions — Open VSX browse/install, categories (Installed/Recommended),
// extension host (Node sidecar) + IntelliSense completions.
'use strict';

// recommendations by language/toolchain the user is likely working in
const RECOMMENDED = [
	{ id: 'esbenp.prettier-vscode', label: 'Prettier', why: 'Code formatter' },
	{ id: 'dbaeumer.vscode-eslint', label: 'ESLint', why: 'JavaScript linting' },
	{ id: 'rust-lang.rust-analyzer', label: 'rust-analyzer', why: 'Rust language support' },
	{ id: 'ms-python.python', label: 'Python', why: 'Python language support' },
	{ id: 'redhat.vscode-yaml', label: 'YAML', why: 'YAML language support' },
	{ id: 'zhuangtongfa.material-theme', label: 'One Dark Pro', why: 'Popular theme' },
	{ id: 'pkief.material-icon-theme', label: 'Material Icons', why: 'File icons' },
	{ id: 'eamodio.gitlens', label: 'GitLens', why: 'Git supercharged' },
];

async function renderView(searchResults) {
	const box = $('#ext-results');
	box.innerHTML = '';
	let installed = [];
	try { installed = await invoke('ext_list'); } catch { /* ignore */ }
	const installedIds = new Set(installed.map(x => x.id));

	// INSTALLED
	const ih = catHeader(`INSTALLED (${installed.length})`);
	box.appendChild(ih);
	if (!installed.length) box.appendChild(dim('No extensions installed yet.'));
	for (const ext of installed) box.appendChild(installedCard(ext, searchResults));

	if (searchResults && searchResults.extensions) {
		box.appendChild(catHeader('MARKETPLACE RESULTS (Open VSX)'));
		for (const e of searchResults.extensions) box.appendChild(marketCard(e, installedIds, searchResults));
	} else {
		// RECOMMENDED
		box.appendChild(catHeader('RECOMMENDED'));
		for (const r of RECOMMENDED) {
			if (installedIds.has(r.id)) continue;
			const card = document.createElement('div');
			card.className = 'ext-card';
			card.innerHTML = `<span class="codicon codicon-extensions" style="font-size:32px;color:var(--fg-dim)"></span>`;
			const info = document.createElement('div');
			info.className = 'ext-info';
			info.innerHTML = `<div class="ext-name">${esc(r.label)}</div><div class="ext-desc">${esc(r.why)}</div>`;
			const meta = document.createElement('div');
			meta.className = 'ext-meta';
			meta.innerHTML = `<span>${esc(r.id)}</span>`;
			const btn = document.createElement('button');
			btn.className = 'ext-btn';
			btn.textContent = 'Search';
			btn.onclick = () => { $('#ext-input').value = r.label; searchExtensions(); };
			meta.appendChild(btn);
			info.appendChild(meta);
			card.appendChild(info);
			box.appendChild(card);
		}
	}
}

const catHeader = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.textContent = t; return d; };
const dim = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.style.cssText = 'padding:8px 12px;color:var(--fg-dim)'; d.textContent = t; return d; };

function installedCard(ext, searchResults) {
	const card = document.createElement('div');
	card.className = 'ext-card';
	card.innerHTML = `<span class="codicon codicon-extensions" style="font-size:32px"></span>`;
	const info = document.createElement('div');
	info.className = 'ext-info';
	info.innerHTML = `<div class="ext-name">${esc(ext.display_name)}</div><div class="ext-desc">${esc(ext.description)}</div>`;
	const meta = document.createElement('div');
	meta.className = 'ext-meta';
	meta.innerHTML = `<span>${esc(ext.id)} v${esc(ext.version)}</span>`;
	const un = document.createElement('button');
	un.className = 'ext-btn uninstall';
	un.textContent = 'Uninstall';
	un.onclick = async () => { await invoke('ext_uninstall', { id: ext.id }); toast('Uninstalled ' + ext.id); renderView(searchResults); startExtHost(); };
	meta.appendChild(un);
	for (const th of ext.themes) {
		const b = document.createElement('button');
		b.className = 'ext-btn';
		b.textContent = 'Theme: ' + th.label;
		b.onclick = () => applyExtTheme(th.path, th.ui_theme, th.label);
		meta.appendChild(b);
	}
	info.appendChild(meta);
	card.appendChild(info);
	return card;
}

function marketCard(e, installedIds, searchResults) {
	const id = `${e.namespace}.${e.name}`;
	const card = document.createElement('div');
	card.className = 'ext-card';
	if (e.files && e.files.icon) { const img = document.createElement('img'); img.src = e.files.icon; img.onerror = () => img.remove(); card.appendChild(img); }
	else card.innerHTML = `<span class="codicon codicon-extensions" style="font-size:32px"></span>`;
	const info = document.createElement('div');
	info.className = 'ext-info';
	info.innerHTML = `<div class="ext-name">${esc(e.displayName || e.name)}</div><div class="ext-desc">${esc(e.description || '')}</div>`;
	const meta = document.createElement('div');
	meta.className = 'ext-meta';
	meta.innerHTML = `<span>${esc(id)}</span><span>v${esc(e.version)}</span><span><span class="codicon codicon-cloud-download"></span> ${e.downloadCount || 0}</span>`;
	const btn = document.createElement('button');
	btn.className = 'ext-btn';
	if (installedIds.has(id)) { btn.textContent = 'Installed'; btn.disabled = true; }
	else {
		btn.textContent = 'Install';
		btn.onclick = async () => {
			btn.disabled = true; btn.textContent = 'Installing...';
			try {
				await invoke('ext_install', { namespace: e.namespace, name: e.name, version: e.version });
				toast(`Installed ${id}`, 4000);
				renderView(searchResults);
				startExtHost();
			} catch (err) { btn.disabled = false; btn.textContent = 'Install'; toast('Install failed: ' + err); }
		};
	}
	meta.appendChild(btn);
	info.appendChild(meta);
	card.appendChild(info);
	return card;
}

async function searchExtensions() {
	const q = $('#ext-input').value.trim();
	if (!q) { renderView(null); return; }
	$('#ext-results').innerHTML = '<div class="scm-group-title" style="padding:12px">Searching Open VSX...</div>';
	try { renderView(JSON.parse(await invoke('ext_search', { query: q }))); }
	catch (e) { $('#ext-results').innerHTML = `<div class="scm-group-title" style="padding:12px">${esc(String(e))}</div>`; }
}

/* ================= extension host (lazy, background) ================= */
let extHostBound = false, extHostStarting = null;

// perf: only spawn Node if there are code extensions to run, and never block the
// caller — fire and forget. No extensions installed => host never starts.
async function startExtHost(force = false) {
	let installed = [];
	try { installed = await invoke('ext_list'); } catch { /* ignore */ }
	// theme-only extensions need no host; start only if something might contribute code
	if (!force && installed.length === 0) { state.exthostReady = false; return; }
	if (state.exthostReady || extHostStarting) return extHostStarting;
	if (!extHostBound) {
		extHostBound = true;
		listen('exthost-line', e => onExtLine(e.payload));
		listen('exthost-stderr', e => console.warn('[exthost]', e.payload));
		listen('exthost-exit', () => { state.exthostReady = false; });
	}
	extHostStarting = invoke('exthost_start', { extDir: '' })
		.then(() => { state.exthostReady = true; })
		.catch(() => { state.exthostReady = false; /* Node missing -> word-based only */ })
		.finally(() => { extHostStarting = null; });
	return extHostStarting;
}

function onExtLine(line) {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id !== undefined && state.rpcWaiters.has(msg.id)) {
		state.rpcWaiters.get(msg.id)(msg.result);
		state.rpcWaiters.delete(msg.id);
		return;
	}
	if (msg.event === 'message') toast(`[ext] ${msg.params.text}`);
	else if (msg.event === 'diagnostics') Panel.setProblems(msg.params.uri, msg.params.items);
	else if (msg.event === 'loaded') {
		const active = msg.params.filter(x => x.status === 'activated').length;
		if (active) toast(`Extension host: ${active} extension(s) active`, 2500);
	}
	else if (msg.event === 'log') console.log('[ext]', msg.params);
}

function rpc(method, params, timeout = 4000) {
	return new Promise(resolve => {
		if (!state.exthostReady) return resolve(null);
		const id = state.rpcId++;
		state.rpcWaiters.set(id, resolve);
		invoke('exthost_send', { line: JSON.stringify({ id, method, params }) }).catch(() => resolve(null));
		setTimeout(() => { if (state.rpcWaiters.has(id)) { state.rpcWaiters.delete(id); resolve(null); } }, timeout);
	});
}

// per-language keyword + builtin suggestions so completion feels language-aware
// even without a full LSP (merged with document words + extension-host results).
const K = {
	js: 'const let var function return if else for while do switch case break continue class extends new this super import export default from async await try catch finally throw typeof instanceof void delete yield static get set null undefined true false Promise Array Object String Number Boolean Map Set Symbol JSON Math console document window setTimeout setInterval fetch',
	ts: 'const let var function return if else for while class interface type enum extends implements new this super import export default from async await try catch finally throw typeof keyof readonly public private protected abstract as namespace declare string number boolean any unknown never void null undefined Promise Array Record Partial',
	py: 'def class return if elif else for while break continue import from as with try except finally raise lambda yield async await global nonlocal pass del True False None self print len range enumerate zip map filter list dict set tuple str int float bool open input isinstance super property staticmethod classmethod',
	php: 'function return if else elseif endif for foreach while do switch case break continue class interface trait extends implements new public private protected static abstract final const namespace use echo print isset unset empty array null true false __construct __destruct public function $this self parent try catch finally throw',
	rust: 'fn let mut const static struct enum trait impl for while loop if else match return break continue use mod pub crate self super as ref move async await dyn where unsafe Some None Ok Err Result Option Vec String str i32 i64 u32 u64 usize f64 bool println! vec! format! derive',
	go: 'func return if else for range switch case break continue package import var const type struct interface map chan go defer select fallthrough nil true false make new len cap append copy panic recover string int int64 float64 bool byte rune error fmt',
	java: 'public private protected class interface extends implements abstract final static void return if else for while do switch case break continue new this super import package try catch finally throw throws null true false int long double float boolean String System println',
	lua: 'function local return if then else elseif end for while do repeat until break in and or not nil true false pairs ipairs print type tostring tonumber table string math require',
	c: 'int char float double void long short unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue sizeof NULL include define printf scanf malloc free',
	cpp: 'int char float double void long short bool auto struct class union enum template typename namespace using return if else for while switch case break continue new delete const static virtual public private protected this nullptr true false std vector string cout cin endl include',
};
K.javascript = K.js; K.typescript = K.ts; K.python = K.py; K.csharp = K.java;
const _kwCache = {};
function langKeywords(lang) {
	if (_kwCache[lang]) return _kwCache[lang];
	return (_kwCache[lang] = (K[lang] || '').split(/\s+/).filter(Boolean));
}

const _wordCache = new WeakMap();
function documentWords(model) {
	const v = model.getVersionId();
	const c = _wordCache.get(model);
	if (c && c.v === v) return c.words;
	const words = [...new Set(model.getValue().match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [])].slice(0, 2000);
	_wordCache.set(model, { v, words });
	return words;
}

async function provideCompletions(model, position) {
	const word = model.getWordUntilPosition(position);
	const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
	const suggestions = [];
	const seen = new Set();

	if (state.exthostReady) {
		const tab = findTab(state.active);
		const items = await rpc('completions', {
			uri: tab && tab.path ? tab.path : 'untitled',
			languageId: model.getLanguageId(),
			text: model.getValue(),
			line: position.lineNumber - 1,
			character: position.column - 1,
		}, 1500);
		for (const it of items || []) {
			suggestions.push({
				label: it.label,
				kind: (monaco.languages.CompletionItemKind[Object.keys(monaco.languages.CompletionItemKind)[it.kind]] ?? monaco.languages.CompletionItemKind.Text),
				insertText: it.insertText ?? it.label,
				insertTextRules: it.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
				detail: it.detail, documentation: it.documentation, range,
			});
			seen.add(it.label);
		}
	} else {
		// first completion in this session triggers a background host start for next time
		startExtHost();
	}

	// language keywords/builtins (ranked above plain document words)
	for (const kw of langKeywords(model.getLanguageId())) {
		if (seen.has(kw)) continue;
		const snippet = kw.endsWith('!') || kw.endsWith('()');
		suggestions.push({
			label: kw,
			kind: monaco.languages.CompletionItemKind.Keyword,
			insertText: kw, range, sortText: '0' + kw,
		});
		seen.add(kw);
	}
	for (const w of documentWords(model)) {
		if (seen.has(w) || w === word.word) continue;
		suggestions.push({ label: w, kind: monaco.languages.CompletionItemKind.Text, insertText: w, range, sortText: '1' + w });
		if (suggestions.length > 300) break;
	}
	return { suggestions };
}

Object.assign(Ext, { renderView, startExtHost, provideCompletions, RECOMMENDED });
window.searchExtensions = searchExtensions;
$('#ext-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchExtensions(); });
