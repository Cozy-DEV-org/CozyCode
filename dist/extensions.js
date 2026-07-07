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

// no-arg = browse mode (Installed + Recommended). with results = search mode.
async function renderView(searchResults) {
	const box = $('#ext-results');
	box.innerHTML = '';
	let installed = [];
	try { installed = await invoke('ext_list'); } catch { /* ignore */ }
	const installedIds = new Set(installed.map(x => x.id));

	if (searchResults && Array.isArray(searchResults.extensions)) {
		const n = searchResults.extensions.length;
		box.appendChild(catHeader(`RESULTS (${n}${searchResults.totalSize > n ? ' of ' + searchResults.totalSize : ''})`));
		if (!n) { box.appendChild(dim('No extensions found. Try another term.')); return; }
		for (const e of searchResults.extensions) box.appendChild(marketCard(e, installedIds));
		return;
	}

	// browse mode
	box.appendChild(catHeader(`INSTALLED (${installed.length})`));
	if (!installed.length) box.appendChild(dim('No extensions installed yet.'));
	for (const ext of installed) box.appendChild(installedCard(ext));

	// workspace recommendations from .vscode/extensions.json
	const wr = (state.workspaceRecommend || []).filter(id => !installedIds.has(id));
	if (wr.length) {
		box.appendChild(catHeader('WORKSPACE RECOMMENDED'));
		for (const id of wr) {
			const card = document.createElement('div');
			card.className = 'ext-card';
			card.innerHTML = `<span class="codicon codicon-extensions" style="font-size:32px;color:var(--fg-dim)"></span>`;
			const info = document.createElement('div');
			info.className = 'ext-info';
			info.innerHTML = `<div class="ext-name">${esc(id)}</div><div class="ext-desc">Recommended by this workspace (.vscode/extensions.json)</div>`;
			const meta = document.createElement('div');
			meta.className = 'ext-meta';
			const btn = document.createElement('button');
			btn.className = 'ext-btn';
			btn.textContent = 'Search';
			btn.onclick = () => { $('#ext-input').value = id.split('.').pop(); searchExtensions(); };
			meta.appendChild(btn);
			info.appendChild(meta);
			card.appendChild(info);
			box.appendChild(card);
		}
	}

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

const catHeader = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.textContent = t; return d; };
const dim = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.style.cssText = 'padding:8px 12px;color:var(--fg-dim)'; d.textContent = t; return d; };

let lastSearch = null;
function refreshExtView() { renderView(lastSearch); }

function installedCard(ext) {
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
	un.onclick = async () => { await invoke('ext_uninstall', { id: ext.id }); toast('Uninstalled ' + ext.id); refreshExtView(); startExtHost(); };
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

function marketCard(e, installedIds) {
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
				refreshExtView();
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
	if (!q) { lastSearch = null; renderView(null); return; }
	$('#ext-results').innerHTML = '<div class="scm-group-title" style="padding:12px">Searching Open VSX...</div>';
	try {
		const parsed = JSON.parse(await invoke('ext_search', { query: q }));
		lastSearch = parsed;
		renderView(parsed);
	} catch (e) { $('#ext-results').innerHTML = `<div class="scm-group-title" style="padding:12px">${esc(String(e))}</div>`; }
}

/* ============ native adapter: contributed views / commands / trees ============ */
const contributedCommands = []; // {command, title, category}
const extContainers = [];       // {id, title, icon, views:[{id,name,ready}]}
const treeReady = new Set();    // viewIds whose provider registered

const explorerViews = []; // views contributed into the built-in "explorer" container
const BUILTIN_CONTAINERS = new Set(['explorer', 'scm', 'debug', 'test', 'remote']);

function applyContributions(list) {
	for (const c of list || []) {
		for (const cmd of c.commands || []) if (!contributedCommands.some(x => x.command === cmd.command)) contributedCommands.push(cmd);
		// only extensions that contribute their OWN activity-bar container get an icon
		for (const vc of c.viewsContainers || []) {
			if (extContainers.some(x => x.id === vc.id)) continue;
			const views = (c.views || []).filter(v => v.container === vc.id);
			if (!views.length) continue; // a container with no views = nothing to show
			extContainers.push({ id: vc.id, title: vc.title || vc.id, icon: vc.icon, views });
		}
		// views placed into the built-in Explorer show up under the file tree (like VSCode).
		// views in other built-in containers (debug/test/scm) are skipped — we don't fabricate icons.
		for (const v of (c.views || [])) {
			if (BUILTIN_CONTAINERS.has(v.container) && v.container === 'explorer' && !explorerViews.some(x => x.id === v.id))
				explorerViews.push(v);
		}
	}
	renderExtActivityButtons();
	renderExplorerExtViews();
	applyHiddenViews();
	cozyLog('exthost', `contributions: ${extContainers.length} activity-bar container(s), ${explorerViews.length} explorer view(s), ${contributedCommands.length} command(s)`);
}

function renderExplorerExtViews() {
	let host = $('#explorer-ext-views');
	if (!host) { host = document.createElement('div'); host.id = 'explorer-ext-views'; $('#view-explorer').appendChild(host); }
	host.innerHTML = '';
	for (const v of explorerViews) {
		const sec = document.createElement('div');
		sec.className = 'ext-tree-sec';
		const hdr = document.createElement('div');
		hdr.className = 'scm-sec-header';
		hdr.innerHTML = `<span class="codicon codicon-chevron-right"></span> ${esc((v.name || v.id).toUpperCase())}`;
		const body = document.createElement('div');
		body.className = 'ext-tree hidden';
		hdr.onclick = () => {
			const hid = body.classList.toggle('hidden');
			hdr.querySelector('.codicon').className = `codicon codicon-chevron-${hid ? 'right' : 'down'}`;
			if (!hid && !body.childElementCount) loadTreeChildren(v.id, null, body, 0);
		};
		sec.appendChild(hdr); sec.appendChild(body);
		host.appendChild(sec);
	}
}

function renderExtActivityButtons() {
	// add an activity-bar icon per contributed container (once)
	const bar = $('#activitybar');
	const spacer = bar.querySelector('.act-spacer');
	for (const ct of extContainers) {
		if (bar.querySelector(`[data-extview="${ct.id}"]`)) continue;
		const b = document.createElement('button');
		b.className = 'act-btn';
		b.dataset.extview = ct.id;
		b.title = ct.title;
		// use the extension's own icon: $(codicon), an svg/png file, else generic
		if (typeof ct.icon === 'string' && ct.icon.startsWith('$(')) {
			b.innerHTML = `<span class="codicon codicon-${esc(ct.icon.slice(2, -1))}"></span>`;
		} else if (typeof ct.icon === 'string' && ct.icon) {
			b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
			invoke('read_file_base64', { path: ct.icon }).then(b64 => {
				const ext = ct.icon.toLowerCase().split('.').pop();
				const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/*';
				b.innerHTML = `<img class="act-ext-icon" src="data:${mime};base64,${b64}">`;
			}).catch(() => { });
		} else b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
		b.onclick = () => showExtContainer(ct.id);
		bar.insertBefore(b, spacer);
	}
}

function showExtContainer(id) {
	const ct = extContainers.find(x => x.id === id);
	if (!ct) return;
	$$('.act-btn').forEach(b => b.classList.remove('active'));
	$(`[data-extview="${id}"]`).classList.add('active');
	$$('#sidebar .view').forEach(v => v.classList.add('hidden'));
	$('#sidebar').style.display = 'flex'; $('#sidebar-resizer').style.display = 'block';
	const host = $('#ext-views');
	host.classList.remove('hidden');
	host.innerHTML = `<div class="view-title"><span>${esc(ct.title.toUpperCase())}</span></div>`;
	for (const v of ct.views) {
		const sec = document.createElement('div');
		sec.className = 'ext-tree-sec';
		const hdr = document.createElement('div');
		hdr.className = 'scm-sec-header';
		hdr.innerHTML = `<span class="codicon codicon-chevron-down"></span> ${esc((v.name || v.id).toUpperCase())}`;
		const body = document.createElement('div');
		body.className = 'ext-tree';
		hdr.onclick = () => { const h = body.classList.toggle('hidden'); hdr.querySelector('.codicon').className = `codicon codicon-chevron-${h ? 'right' : 'down'}`; };
		sec.appendChild(hdr); sec.appendChild(body);
		host.appendChild(sec);
		loadTreeChildren(v.id, null, body, 0);
	}
}

async function loadTreeChildren(viewId, nodeKey, container, depth) {
	container.innerHTML = depth === 0 ? '<div class="ext-tree-item" style="color:var(--fg-dim)">Loading...</div>' : '';
	const nodes = await rpc('treeChildren', { viewId, nodeKey }, 6000) || [];
	container.innerHTML = '';
	if (!nodes.length && depth === 0) { container.innerHTML = '<div class="ext-tree-item" style="color:var(--fg-dim)">(empty)</div>'; return; }
	for (const n of nodes) {
		const row = document.createElement('div');
		row.className = 'ext-tree-item';
		row.style.paddingLeft = (depth * 12 + 8) + 'px';
		const canExpand = n.collapsible > 0;
		row.innerHTML = `<span class="twist codicon ${canExpand ? 'codicon-chevron-right' : ''}"></span>` +
			`<span class="codicon codicon-${n.icon || (canExpand ? 'folder' : 'circle-small')}"></span>` +
			`<span class="et-label">${esc(n.label)}</span>` + (n.description ? `<span class="et-desc">${esc(n.description)}</span>` : '');
		if (n.tooltip) row.title = n.tooltip;
		const child = document.createElement('div');
		container.appendChild(row); container.appendChild(child);
		let open = false;
		row.onclick = async () => {
			if (canExpand) {
				open = !open;
				row.querySelector('.twist').className = `twist codicon codicon-chevron-${open ? 'down' : 'right'}`;
				if (open && !child.childElementCount) await loadTreeChildren(viewId, n.nodeKey, child, depth + 1);
				else if (!open) child.innerHTML = '';
			}
			if (n.command) { try { await rpc('executeCommand', { command: n.command.command, args: n.command.args }, 8000); } catch { } }
		};
	}
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
	if (msg.event === 'message') { toast(`[ext] ${msg.params.text}`); cozyLog('exthost', msg.params.text); }
	else if (msg.event === 'diagnostics') Panel.setProblems(msg.params.uri, msg.params.items);
	else if (msg.event === 'contributes') applyContributions(msg.params);
	else if (msg.event === 'treeReady') { treeReady.add(msg.params.viewId); const b = $(`#ext-views:not(.hidden)`); if (b) { /* a container may be showing this view; refresh */ } }
	else if (msg.event === 'treeRefresh') { const host = $('#ext-views'); if (host && !host.classList.contains('hidden')) { const active = $('.act-btn.active[data-extview]'); if (active) showExtContainer(active.dataset.extview); } }
	else if (msg.event === 'loaded') {
		const active = msg.params.filter(x => x.status === 'activated').length;
		cozyLog('exthost', `${msg.params.length} extension(s), ${active} activated`);
		if (active) toast(`Extension host: ${active} extension(s) active`, 2500);
	}
	else if (msg.event === 'log') cozyLog('exthost', msg.params);
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

function activateLanguage(lang) {
	if (!state.exthostReady || !lang || lang === 'plaintext') return;
	invoke('exthost_send', { line: JSON.stringify({ method: 'activateEvent', params: { event: 'onLanguage:' + lang } }) }).catch(() => { });
}

Object.assign(Ext, { renderView, startExtHost, provideCompletions, RECOMMENDED, applyContributions, contributedCommands, activateLanguage, runExtCommand: (cmd, ...args) => rpc('executeCommand', { command: cmd, args }, 8000) });
window.searchExtensions = searchExtensions;
$('#ext-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchExtensions(); });
