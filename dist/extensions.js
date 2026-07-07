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

	// browse mode — collapsible INSTALLED section
	const [ih, ib] = collapsible(`INSTALLED (${installed.length})`, 'ext-cat-installed');
	box.appendChild(ih); box.appendChild(ib);
	if (!installed.length) ib.appendChild(dim('No extensions installed yet.'));
	for (const ext of installed) ib.appendChild(installedCard(ext));

	// workspace recommendations from .vscode/extensions.json
	const wr = (state.workspaceRecommend || []).filter(id => !installedIds.has(id));
	if (wr.length) {
		box.appendChild(catHeader('WORKSPACE RECOMMENDED'));
		for (const id of wr) {
			const [card, actions] = extCard({ name: id, desc: 'Recommended by this workspace (.vscode/extensions.json)' });
			actions.appendChild(extBtn('Search', '', () => { $('#ext-input').value = id.split('.').pop(); searchExtensions(); }));
			box.appendChild(card);
		}
	}

	const [rh, rb] = collapsible('RECOMMENDED', 'ext-cat-recommended');
	box.appendChild(rh); box.appendChild(rb);
	const recBox = rb;
	for (const r of RECOMMENDED) {
		if (installedIds.has(r.id)) continue;
		const [card, actions] = extCard({ name: r.label, desc: r.why, metaText: r.id });
		actions.appendChild(extBtn('Search', '', () => { $('#ext-input').value = r.label; searchExtensions(); }));
		recBox.appendChild(card);
	}
}

const catHeader = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.textContent = t; return d; };
const dim = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.style.cssText = 'padding:8px 12px;color:var(--fg-dim)'; d.textContent = t; return d; };
// collapsible category: returns [header, body]; remembers open/closed in localStorage
function collapsible(title, key) {
	const collapsed = localStorage.getItem('cozyExtCat:' + key) === '0';
	const h = document.createElement('div');
	h.className = 'ext-cat-header';
	h.innerHTML = `<span class="codicon codicon-chevron-${collapsed ? 'right' : 'down'}"></span> ${esc(title)}`;
	const b = document.createElement('div');
	b.className = 'ext-cat-body' + (collapsed ? ' hidden' : '');
	h.onclick = () => {
		const hid = b.classList.toggle('hidden');
		h.querySelector('.codicon').className = `codicon codicon-chevron-${hid ? 'right' : 'down'}`;
		localStorage.setItem('cozyExtCat:' + key, hid ? '0' : '1');
	};
	return [h, b];
}

let lastSearch = null;
function refreshExtView() { renderView(lastSearch); }

// card skeleton: [icon | info(name/desc/meta, ellipsised) | actions column pinned
// right] — long text can never push the buttons around.
function extCard({ iconUrl, name, desc, metaText }) {
	const card = document.createElement('div');
	card.className = 'ext-card';
	const ic = document.createElement('div');
	ic.className = 'ext-icon';
	ic.innerHTML = `<span class="codicon codicon-extensions"></span>`;
	if (iconUrl) {
		const img = document.createElement('img');
		img.src = iconUrl;
		img.onload = () => { ic.innerHTML = ''; ic.appendChild(img); };
	}
	const info = document.createElement('div');
	info.className = 'ext-info';
	info.innerHTML = `<div class="ext-name">${esc(name)}</div><div class="ext-desc">${esc(desc || '')}</div><div class="ext-meta">${esc(metaText || '')}</div>`;
	const actions = document.createElement('div');
	actions.className = 'ext-actions';
	card.appendChild(ic); card.appendChild(info); card.appendChild(actions);
	return [card, actions, info];
}
const extBtn = (label, cls, onclick) => { const b = document.createElement('button'); b.className = 'ext-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = onclick; return b; };

function installedCard(ext) {
	const [card, actions] = extCard({
		iconUrl: ext.icon ? window.__TAURI__.core.convertFileSrc(ext.icon) : '',
		name: ext.display_name, desc: ext.description,
		metaText: `${ext.id} v${ext.version}${ext.enabled ? '' : ' (disabled)'}`,
	});
	if (!ext.enabled) card.classList.add('ext-disabled');
	actions.appendChild(extBtn(ext.enabled ? 'Disable' : 'Enable', '', async () => {
		await invoke('ext_set_state', { id: ext.id, enabled: !ext.enabled, autoUpdate: ext.auto_update });
		toast((ext.enabled ? 'Disabled ' : 'Enabled ') + ext.id);
		refreshExtView();
		state.exthostReady = false; startExtHost(true); // restart host to apply
	}));
	actions.appendChild(extBtn('Uninstall', 'uninstall', async () => {
		if (!(await confirmDialog('Uninstall ' + ext.id + '?'))) return;
		await invoke('ext_uninstall', { id: ext.id }); toast('Uninstalled ' + ext.id);
		refreshExtView(); state.exthostReady = false; startExtHost(true);
	}));
	const au = document.createElement('label');
	au.className = 'ext-auto';
	au.innerHTML = `<input type="checkbox" ${ext.auto_update ? 'checked' : ''}> auto-update`;
	au.querySelector('input').onchange = e => invoke('ext_set_state', { id: ext.id, enabled: ext.enabled, autoUpdate: e.target.checked });
	actions.appendChild(au);
	for (const th of ext.themes.slice(0, 2)) actions.appendChild(extBtn('Theme: ' + th.label, '', () => applyExtTheme(th.path, th.ui_theme, th.label)));
	return card;
}

function marketCard(e, installedIds) {
	const id = `${e.namespace}.${e.name}`;
	const [card, actions] = extCard({
		iconUrl: (e.files && e.files.icon) || '',
		name: e.displayName || e.name, desc: e.description,
		metaText: `${id} v${e.version} | ${e.downloadCount || 0} downloads`,
	});
	const btn = extBtn('Install', '', null);
	if (installedIds.has(id)) { btn.textContent = 'Installed'; btn.disabled = true; }
	else btn.onclick = async () => {
		btn.disabled = true; btn.textContent = 'Installing...';
		try {
			await invoke('ext_install', { namespace: e.namespace, name: e.name, version: e.version });
			toast(`Installed ${id}`, 4000);
			refreshExtView();
			startExtHost();
		} catch (err) { btn.disabled = false; btn.textContent = 'Install'; toast('Install failed: ' + err); }
	};
	actions.appendChild(btn);
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
const extContainers = [];       // activitybar (left) {id, title, icon, views:[{id,name,ready}]}
const secondaryContainers = []; // secondarySidebar (right)
const panelContainers = [];     // panel (bottom)
const treeReady = new Set();    // viewIds whose provider registered

const explorerViews = []; // views contributed into the built-in "explorer" container
const BUILTIN_CONTAINERS = new Set(['explorer', 'scm', 'debug', 'test', 'remote']);

// context keys (extension setContext) drive `when`-clause visibility, like VSCode:
// Claude Code's left container has when:"claude-code:doesNotSupportSecondarySidebar"
// so with a secondary sidebar present it must NOT appear on the left.
let contextKeys = {};
let extConfig = {};   // configuration defaults from every extension (exthost configStore)
// context key resolution, VSCode semantics: extension setContext keys first, then
// workbench built-ins, then config.* lookups. Unknown = undefined (falsy).
function ctxValue(k) {
	if (k in contextKeys) return contextKeys[k];
	if (k === 'workspaceFolderCount') return state.root ? 1 : 0;
	if (k === 'isWeb') return false;
	if (k === 'isWindows') return true;
	if (k === 'remoteName') return state.remote ? 'ssh-remote' : undefined;
	if (k === 'true') return true;
	if (k === 'false') return false;
	// git context keys normally come from VSCode's built-in git extension — CozyCode
	// has a native git backend (SCM view), so surface its state under the same keys
	if (k === 'git.state') return 'initialized';
	if (k === 'gitOpenRepositoryCount') return (state.repos || []).length;
	if (k === 'git.parentRepositoryCount' || k === 'git.unsafeRepositoryCount' || k === 'git.closedRepositoryCount') return 0;
	if (k === 'gitNotInstalled') return false;
	if (k.startsWith('config.')) return extConfig[k.slice(7)];
	return undefined;
}
// real when-clause parser: !, &&, ||, parentheses, ==/!=/</>/<=/>= with quoted or
// bare literals and numbers (GitHub PR uses `workspaceFolderCount > 0`, GitLens
// uses nested parens). `=~` regex matches are treated as false.
function evalWhen(w) {
	if (!w) return true;
	try {
		const toks = String(w).match(/&&|\|\||==|!=|<=|>=|=~|[!()<>]|'[^']*'|[^\s!()&|<>=]+/g) || [];
		let i = 0;
		const peek = () => toks[i], next = () => toks[i++];
		const literal = t => { if (/^'.*'$/.test(t)) return t.slice(1, -1); if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t); if (t === 'true') return true; if (t === 'false') return false; return t; };
		function unary() {
			const t = next();
			if (t === '!') return !unary();
			if (t === '(') { const v = or(); next(); return v; }
			// key [op literal]
			const op = peek();
			if (['==', '!=', '<', '>', '<=', '>=', '=~'].includes(op)) {
				next();
				const rhs = literal(next());
				const lhs = ctxValue(t);
				if (op === '=~') return false;
				if (typeof rhs === 'number') {
					const ln = Number(lhs);
					return op === '==' ? ln === rhs : op === '!=' ? ln !== rhs : op === '<' ? ln < rhs : op === '>' ? ln > rhs : op === '<=' ? ln <= rhs : ln >= rhs;
				}
				const eq = String(lhs ?? 'undefined') === String(rhs);
				return op === '==' ? eq : op === '!=' ? !eq : false;
			}
			return !!ctxValue(t);
		}
		function and() { let v = unary(); while (peek() === '&&') { next(); const r = unary(); v = v && r; } return v; }
		function or() { let v = and(); while (peek() === '||') { next(); const r = and(); v = v || r; } return v; }
		return or();
	} catch { return true; }
}

let allContribs = [];
// viewsWelcome: view id -> [{contents, when}] — rendered when a tree view has
// nothing to show (VSCode behavior: Sign in / Connect / Open Folder buttons)
function welcomeFor(viewId) {
	const out = [];
	for (const c of allContribs) for (const w of c.welcome || []) if (w.view === viewId && evalWhen(w.when)) out.push(w);
	return out;
}
function renderViewsWelcome(viewId, container) {
	const entries = welcomeFor(viewId);
	if (!entries.length) return false;
	container.innerHTML = '';
	const box = document.createElement('div');
	box.className = 'views-welcome';
	for (const w of entries) {
		for (const line of String(w.contents).split('\n')) {
			const t = line.trim();
			if (!t) continue;
			const cmd = t.match(/^\[([^\]]+)\]\(command:([^)]+)\)$/);
			if (cmd) { // a line that is ONLY a command link renders as a button (VSCode)
				const b = document.createElement('button');
				b.className = 'welcome-btn';
				b.textContent = cmd[1];
				b.onclick = () => rpc('executeCommand', { command: cmd[2].split('?')[0], args: [] }, 8000).catch(() => { });
				box.appendChild(b);
				continue;
			}
			const p = document.createElement('div');
			p.className = 'welcome-text';
			// inline links: [text](command:x) -> clickable; [text](https://x) -> external
			p.innerHTML = esc(t)
				.replace(/\[([^\]]+)\]\(command:([^)]+)\)/g, (_, txt, c2) => `<a href="#" data-cmd="${esc(c2.split('?')[0])}">${txt}</a>`)
				.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, txt, url) => `<a href="#" data-url="${esc(url)}">${txt}</a>`);
			p.querySelectorAll('a[data-cmd]').forEach(a => a.onclick = ev => { ev.preventDefault(); rpc('executeCommand', { command: a.dataset.cmd, args: [] }, 8000).catch(() => { }); });
			p.querySelectorAll('a[data-url]').forEach(a => a.onclick = ev => { ev.preventDefault(); invoke('open_url', { url: a.dataset.url }).catch(() => { }); });
			box.appendChild(p);
		}
	}
	container.appendChild(box);
	return true;
}

// context keys arrive in bursts while extensions activate — refresh any view
// currently showing welcome/(empty) content once things settle
let _welcomeT = 0;
function scheduleWelcomeRefresh() {
	clearTimeout(_welcomeT);
	_welcomeT = setTimeout(() => {
		$$('[data-welcome-view]').forEach(el => { if (el.isConnected) loadTreeChildren(el.dataset.welcomeView, null, el, 0); });
	}, 700);
}

function applyContributions(list) {
	for (const c of list || []) {
		if (!allContribs.some(x => x.id === c.id)) allContribs.push(c);
		for (const cmd of c.commands || []) if (!contributedCommands.some(x => x.command === cmd.command)) contributedCommands.push(cmd);
	}
	placeContainers();
	cozyLog('exthost', `contributions: ${extContainers.length} left, ${secondaryContainers.length} right, ${panelContainers.length} panel container(s), ${explorerViews.length} explorer view(s), ${contributedCommands.length} command(s)`);
}

// (re)compute container placement from raw contributes + current context keys
function placeContainers() {
	extContainers.length = 0; secondaryContainers.length = 0; panelContainers.length = 0; explorerViews.length = 0;
	for (const c of allContribs) {
		for (const vc of c.viewsContainers || []) {
			if (!evalWhen(vc.when)) continue;
			const bucket = vc.location === 'secondarySidebar' ? secondaryContainers
				: vc.location === 'panel' ? panelContainers : extContainers;
			if (bucket.some(x => x.id === vc.id)) continue;
			const views = (c.views || []).filter(v => v.container === vc.id && evalWhen(v.when));
			if (!views.length) continue; // a container with no visible views = hidden (VSCode)
			bucket.push({ id: vc.id, title: vc.title || vc.id, icon: vc.icon, views });
		}
		for (const v of (c.views || [])) {
			if (v.container === 'explorer' && evalWhen(v.when) && !explorerViews.some(x => x.id === v.id))
				explorerViews.push(v);
		}
	}
	// an extension whose main surface is the secondary sidebar (e.g. Claude Code)
	// gets its auxiliary LEFT containers hidden by default, like the user's real
	// VSCode setup — right-click the activity bar to re-enable (choice persists).
	const defaulted = new Set(JSON.parse(localStorage.getItem('cozyHiddenDefaults') || '[]'));
	let defChanged = false;
	for (const c of allContribs) {
		if (!(c.viewsContainers || []).some(vc => vc.location === 'secondarySidebar' && evalWhen(vc.when))) continue;
		for (const vc of c.viewsContainers || []) {
			if (vc.location !== 'activitybar') continue;
			const key = 'ext:' + vc.id;
			if (!defaulted.has(key)) { defaulted.add(key); hiddenViews.add(key); defChanged = true; }
		}
	}
	if (defChanged) {
		localStorage.setItem('cozyHiddenDefaults', JSON.stringify([...defaulted]));
		localStorage.setItem('cozyHiddenViews', JSON.stringify([...hiddenViews]));
	}
	renderExtActivityButtons();
	renderSecondaryContainers();
	renderPanelContainers();
	renderExplorerExtViews();
	applyHiddenViews();
	updateLayoutToggles();
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
		body.className = (v.type === 'webview' ? 'ext-webview-host' : 'ext-tree') + ' hidden';
		hdr.onclick = () => {
			const hid = body.classList.toggle('hidden');
			hdr.querySelector('.codicon').className = `codicon codicon-chevron-${hid ? 'right' : 'down'}`;
			if (!hid && !body.childElementCount) { v.type === 'webview' ? renderWebviewView(v.id, body) : loadTreeChildren(v.id, null, body, 0); }
		};
		sec.appendChild(hdr); sec.appendChild(body);
		host.appendChild(sec);
	}
}

// set an activity-bar button's icon from the container's contributed icon
// ($(codicon), an svg/png file path, else a generic glyph)
function containerIcon(b, ct) {
	if (typeof ct.icon === 'string' && ct.icon.startsWith('$(')) {
		b.innerHTML = `<span class="codicon codicon-${esc(ct.icon.slice(2, -1))}"></span>`;
	} else if (typeof ct.icon === 'string' && ct.icon) {
		b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
		invoke('read_file_base64', { path: ct.icon }).then(b64 => {
			const ext = ct.icon.toLowerCase().split('.').pop();
			const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/*';
			// render the extension icon as a CSS MASK filled with currentColor so it
			// takes the activity bar's own colour (grey / white-on-active) exactly like
			// the built-in codicons — uniform monochrome UI, no per-extension tinting
			b.innerHTML = `<span class="act-ext-icon"></span>`;
			b.querySelector('.act-ext-icon').style.setProperty('--ext-icon', `url("data:${mime};base64,${b64}")`);
		}).catch(() => { });
	} else b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
}

// persistent per-container hosts (VSCode overlayWebview: webviews are retained,
// hidden — not destroyed — when the user switches views, so iframe state survives)
function containerHost(parent, ct, render) {
	let host = parent.querySelector(`[data-cthost="${CSS.escape(ct.id)}"]`);
	parent.querySelectorAll('[data-cthost]').forEach(h => h.classList.add('hidden'));
	if (!host) {
		host = document.createElement('div');
		host.dataset.cthost = ct.id;
		host.className = 'ct-host';
		parent.appendChild(host);
		render(host);
	}
	host.classList.remove('hidden');
	return host;
}

// render a container's views into a host element (single webview fills the pane,
// otherwise a collapsible section per view). Shared by left/right sidebars.
function fillContainerHost(host, ct) {
	host.innerHTML = `<div class="view-title"><span>${esc(ct.title.toUpperCase())}</span></div>`;
	if (ct.views.length === 1 && ct.views[0].type === 'webview') {
		const body = document.createElement('div');
		body.className = 'ext-webview-host';
		host.appendChild(body);
		renderWebviewView(ct.views[0].id, body);
		return;
	}
	for (const v of ct.views) {
		const sec = document.createElement('div');
		sec.className = 'ext-tree-sec';
		const hdr = document.createElement('div');
		hdr.className = 'scm-sec-header';
		hdr.innerHTML = `<span class="codicon codicon-chevron-down"></span> ${esc((v.name || v.id).toUpperCase())}`;
		const body = document.createElement('div');
		body.className = v.type === 'webview' ? 'ext-webview-host' : 'ext-tree';
		hdr.onclick = () => { const h = body.classList.toggle('hidden'); hdr.querySelector('.codicon').className = `codicon codicon-chevron-${h ? 'right' : 'down'}`; };
		sec.appendChild(hdr); sec.appendChild(body);
		host.appendChild(sec);
		if (v.type === 'webview') renderWebviewView(v.id, body);
		else loadTreeChildren(v.id, null, body, 0);
	}
}

function renderExtActivityButtons() {
	// add an activity-bar icon per contributed container; drop ones whose when-clause
	// turned false (e.g. Claude Code's left container once the extension sets context)
	const bar = $('#activitybar');
	const spacer = bar.querySelector('.act-spacer');
	bar.querySelectorAll('[data-extview]').forEach(b => { if (!extContainers.some(c => c.id === b.dataset.extview)) b.remove(); });
	for (const ct of extContainers) {
		if (bar.querySelector(`[data-extview="${ct.id}"]`)) continue;
		const b = document.createElement('button');
		b.className = 'act-btn';
		b.dataset.extview = ct.id;
		b.title = ct.title;
		containerIcon(b, ct);
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
	const views = $('#ext-views');
	views.classList.remove('hidden');
	containerHost(views, ct, h => fillContainerHost(h, ct));
}

/* ---------- secondary side bar (right) ---------- */
function renderSecondaryContainers() {
	const bar = $('#secondary-activitybar');
	bar.querySelectorAll('[data-secview]').forEach(b => { if (!secondaryContainers.some(c => c.id === b.dataset.secview)) b.remove(); });
	if (!secondaryContainers.length) { hideSecondary(); return; }
	for (const ct of secondaryContainers) {
		if (bar.querySelector(`[data-secview="${ct.id}"]`)) continue;
		const b = document.createElement('button');
		b.className = 'act-btn';
		b.dataset.secview = ct.id;
		b.title = ct.title;
		containerIcon(b, ct);
		b.onclick = () => { $('#secondary-activitybar .act-btn.active')?.dataset.secview === ct.id ? hideSecondary() : showSecondaryContainer(ct.id); };
		bar.appendChild(b);
	}
	// VSCode does not force the secondary side bar open on startup — the titlebar
	// toggle (and Ctrl+Alt+B) reveals it.
}

function showSecondaryContainer(id) {
	const ct = secondaryContainers.find(x => x.id === id);
	if (!ct) return;
	$('#secondary-sidebar').classList.remove('hidden');
	$('#secondary-resizer').classList.remove('hidden');
	$$('#secondary-activitybar .act-btn').forEach(b => b.classList.toggle('active', b.dataset.secview === id));
	containerHost($('#secondary-views'), ct, h => fillContainerHost(h, ct));
}

// hiding only hides (iframes stay alive); the titlebar button brings it back
function hideSecondary() {
	$('#secondary-sidebar').classList.add('hidden');
	$('#secondary-resizer').classList.add('hidden');
	$$('#secondary-activitybar .act-btn').forEach(b => b.classList.remove('active'));
}
function toggleSecondary() {
	if (!$('#secondary-sidebar').classList.contains('hidden')) return hideSecondary();
	if (secondaryContainers.length) showSecondaryContainer(secondaryContainers[0].id);
	else toast('No extension contributes a secondary side bar view');
}

/* ---------- panel (bottom) containers ---------- */
function renderPanelContainers() {
	$$('#panel-tabs .panel-tab').forEach(t => {
		const id = t.dataset.panel;
		if (['problems', 'output', 'terminal', 'ports'].includes(id)) return; // built-ins
		if (!panelContainers.some(c => c.id === id)) { t.remove(); $('#pane-' + id)?.remove(); }
	});
	for (const ct of panelContainers) {
		if ($(`.panel-tab[data-panel="${ct.id}"]`)) continue;
		const tab = document.createElement('button');
		tab.className = 'panel-tab';
		tab.dataset.panel = ct.id;
		tab.textContent = ct.title.toUpperCase();
		const pane = document.createElement('div');
		pane.className = 'pane hidden';
		pane.id = 'pane-' + ct.id;
		$('#panel-body').appendChild(pane);
		// lazy like VSCode: resolve the view only when its tab first becomes visible
		tab.onclick = () => { showPanel(); switchPanelTab(ct.id); if (!pane.childElementCount) fillContainerHost(pane, ct); };
		$('#panel-tabs').appendChild(tab);
	}
}

// secondary side bar resizer: width = distance from the panel's fixed right edge
// to the cursor, divided by zoom — keeps the drag edge exactly under the mouse
// (a start+delta approach drifts when CSS zoom != 1)
$('#secondary-resizer').addEventListener('mousedown', e => {
	e.preventDefault();
	// iframes swallow mousemove when the cursor crosses them mid-drag, which made
	// the panel "run away" from the mouse — disable their hit-testing while dragging
	document.body.classList.add('dragging-resize');
	const right = $('#secondary-sidebar').getBoundingClientRect().right;
	const move = ev => {
		const z = zoom();
		$('#secondary-sidebar').style.width = Math.max(200, Math.min((window.innerWidth / z) - 400, (right - ev.clientX) / z)) + 'px';
	};
	const up = () => { document.body.classList.remove('dragging-resize'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
	document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});
/* ---------- titlebar layout toggles (VSCode-style Left / Panel / Right) ---------- */
// reflect actual visibility: filled icon = visible, -off icon = hidden
function updateLayoutToggles() {
	const set = (btn, on, name) => { const el = $(btn); if (el) { el.classList.toggle('on', on); el.querySelector('.codicon').className = `codicon codicon-${name}${on ? '' : '-off'}`; } };
	set('#tgl-left', $('#sidebar').style.display !== 'none', 'layout-sidebar-left');
	set('#tgl-panel', !$('#panel').classList.contains('hidden'), 'layout-panel');
	set('#tgl-right', !$('#secondary-sidebar').classList.contains('hidden'), 'layout-sidebar-right');
}
$('#tgl-left').onclick = () => { toggleSidebar(); updateLayoutToggles(); };
$('#tgl-panel').onclick = () => { const p = $('#panel'); p.classList.contains('hidden') ? Panel.showPanel('terminal') : Panel.hidePanel(); updateLayoutToggles(); };
$('#tgl-right').onclick = () => toggleSecondary();
document.addEventListener('keydown', e => { if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSecondary(); } });
// panels get shown/hidden from many paths (menu, Ctrl+`, close buttons, resizer
// drag-to-hide) — observe them so the titlebar icons always match reality
const _ltObs = new MutationObserver(() => updateLayoutToggles());
for (const sel of ['#panel', '#secondary-sidebar', '#sidebar']) _ltObs.observe($(sel), { attributes: true, attributeFilter: ['class', 'style'] });
updateLayoutToggles();

/* ---------- webview views (Claude Code / Copilot etc.) ---------- */
const webviewFrames = new Map(); // viewId -> iframe
let webviewBound = false;
function bindWebview() {
	if (webviewBound) return;
	webviewBound = true;
	// extension -> webview
	// NOTE: webviewToView/webviewHtml arrive as exthost STDOUT lines routed through
	// onExtLine (the 'exthost-line' Tauri event) — see the cases there. Nothing
	// emits Tauri events by those names.
	// webview -> extension (from the iframe's acquireVsCodeApi().postMessage)
	window.addEventListener('message', ev => {
		const d = ev.data;
		if (!d || !d.__cozyWv || !d.viewId) return;
		if ((bindWebview._n = (bindWebview._n || 0) + 1) <= 10) cozyLog('webview', `-> ext [${d.viewId}] ${JSON.stringify(d.msg).slice(0, 120)}`);
		invoke('exthost_send', { line: JSON.stringify({ method: 'webviewMessage', params: { viewId: d.viewId, msg: d.msg } }) })
			.catch(err => cozyLog('webview', 'exthost_send FAILED: ' + err));
	});
}

// exthost writes the (shim-injected, CSP-stripped) html to a file; load it via
// the asset protocol so multi-MB webviews never cross the IPC boundary.
const toAssetUrl = p => window.__TAURI__.core.convertFileSrc(p) + '?t=' + Date.now();

// a webview provider whose resolveWebviewView never yields (e.g. Flutter's
// DevTools sidebar busy-waiting for a server it can't reach) freezes the whole
// extension host. If a resolve times out we mark the view and restart the host so
// the OTHER extensions recover, and never re-resolve the offending view.
const hungWebviews = new Set();
const webviewQueues = new Map();   // viewId -> queued extension->webview messages until iframe ready
const webviewResolved = new Set(); // viewIds already resolved (never re-run resolveWebviewView; VSCode resolves once)
async function restartExtHost() {
	state.rpcWaiters.forEach(fn => { try { fn(null); } catch { } }); state.rpcWaiters.clear();
	state.exthostReady = false; extHostStarting = null;
	webviewResolved.clear(); webviewFrames.clear(); webviewQueues.clear();
	hungWebviews.clear(); // give every view a fresh chance on the new host
	try { await startExtHost(true); } catch { }
}
function deliverToWebview(viewId, m) {
	const f = webviewFrames.get(viewId);
	if (f && f.dataset.ready === '1' && f.contentWindow) f.contentWindow.postMessage(m, '*');
	else { if (!webviewQueues.has(viewId)) webviewQueues.set(viewId, []); webviewQueues.get(viewId).push(m); }
}
function flushWebviewQueue(viewId) {
	const f = webviewFrames.get(viewId), q = webviewQueues.get(viewId);
	if (!f || !f.contentWindow || !q) return;
	webviewQueues.delete(viewId);
	cozyLog('webview', `flush ${q.length} queued msg(s) -> [${viewId}]`);
	for (const m of q) f.contentWindow.postMessage(m, '*');
}
async function renderWebviewView(viewId, container) {
	bindWebview();
	// like VSCode's overlayWebview: the iframe survives hide/show — if we already
	// resolved this view, its iframe is still in `container` (hosts are persistent),
	// so there is nothing to do. Never destroy/re-resolve on reveal.
	if (webviewResolved.has(viewId) && container.querySelector('iframe')) return;
	const msg = m => { container.innerHTML = '<div class="ext-tree-item" style="color:var(--fg-dim);padding:8px">' + m + '</div>'; };
	if (hungWebviews.has(viewId)) return msg('This view could not be loaded.<br>Click the view icon again to retry.');
	msg('Loading...');
	let res;
	try { res = await rpc('resolveWebview', { viewId }, 30000); } catch { res = null; }
	if (res === null) { // timeout: the provider likely froze the host -> recover it
		hungWebviews.add(viewId);
		msg('This view could not be loaded (timed out). Restarting extension host - click the view icon to retry.');
		restartExtHost();
		return;
	}
	if (!res.file) {
		if (res.error) cozyLog('exthost', 'webview ' + viewId + ': ' + res.error);
		// no webview provider -> the extension's viewsWelcome is the right fallback
		if (!renderViewsWelcome(viewId, container)) msg('This view is not available yet.');
		return;
	}
	container.innerHTML = '';
	const frame = document.createElement('iframe');
	frame.className = 'ext-webview';
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
	frame.dataset.ready = '';
	frame.dataset.file = res.file;
	// flush queued extension messages once the document (incl. its scripts) loaded
	frame.addEventListener('load', () => { frame.dataset.ready = '1'; flushWebviewQueue(viewId); });
	frame.src = toAssetUrl(res.file);
	container.appendChild(frame);
	webviewFrames.set(viewId, frame);
	webviewResolved.add(viewId);
	if (res.error) cozyLog('exthost', 'webview ' + viewId + ': ' + res.error);
}

async function loadTreeChildren(viewId, nodeKey, container, depth) {
	container.innerHTML = depth === 0 ? '<div class="ext-tree-item" style="color:var(--fg-dim)">Loading...</div>' : '';
	const nodes = await rpc('treeChildren', { viewId, nodeKey }, 6000) || [];
	container.innerHTML = '';
	if (!nodes.length && depth === 0) {
		// empty tree -> render the extension's viewsWelcome content (like VSCode);
		// mark the host so late setContext/config updates can re-evaluate it
		container.dataset.welcomeView = viewId;
		if (!renderViewsWelcome(viewId, container)) container.innerHTML = '<div class="ext-tree-item" style="color:var(--fg-dim)">(empty)</div>';
		return;
	}
	if (depth === 0) delete container.dataset.welcomeView;
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
		.then(() => { state.exthostReady = true; notifyWorkspace(); })
		.catch(() => { state.exthostReady = false; /* Node missing -> word-based only */ })
		.finally(() => { extHostStarting = null; });
	return extHostStarting;
}

// tell the host which folder is open: publishes workspaceFolders + fires
// workspaceContains:* activation (called on host start and every folder open)
function notifyWorkspace() {
	if (!state.exthostReady) return;
	invoke('exthost_send', { line: JSON.stringify({ method: 'setWorkspace', params: { root: state.root || '' } }) }).catch(() => { });
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
	// extension asked for interactive UI (quick pick / input / message buttons /
	// file dialogs) — show the real workbench UI and send the answer back
	else if (msg.event === 'uiRequest') handleUiRequest(msg.params);
	// extension opened a webview PANEL (createWebviewPanel) -> editor tab
	else if (msg.event === 'webviewPanel') openExtPanelTab(msg.params);
	// extension setContext -> re-evaluate when-clauses -> re-place containers
	else if (msg.event === 'contextKeys') { contextKeys = msg.params || {}; placeContainers(); scheduleWelcomeRefresh(); }
	else if (msg.event === 'configStore') { extConfig = msg.params || {}; placeContainers(); scheduleWelcomeRefresh(); }
	// extension -> webview message: buffered until the iframe is ready (VSCode
	// pendingMessages pattern) — see deliverToWebview/flushWebviewQueue
	else if (msg.event === 'webviewToView') { bindWebview(); deliverToWebview(msg.params.viewId, msg.params.msg); }
	// live html update (extension re-set webview.html -> exthost rewrote the file);
	// skip if the iframe already shows this file or a reload would wipe the app
	else if (msg.event === 'webviewHtml') {
		const f = webviewFrames.get(msg.params.viewId);
		if (f && msg.params.file && f.dataset.file !== msg.params.file) {
			f.dataset.file = msg.params.file; f.dataset.ready = '';
			f.src = toAssetUrl(msg.params.file);
		}
	}
}

/* ---------- webview panels (createWebviewPanel) as editor tabs ---------- */
function openExtPanelTab(p) {
	bindWebview();
	openUiTab('extpanel:' + p.panelId, p.title || 'Extension', box => {
		box.innerHTML = '';
		const frame = document.createElement('iframe');
		frame.className = 'ext-webview';
		frame.style.cssText = 'width:100%;height:100%;border:none;background:#1e1e1e;display:block';
		frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
		frame.dataset.ready = ''; frame.dataset.file = p.file;
		frame.addEventListener('load', () => { frame.dataset.ready = '1'; flushWebviewQueue(p.panelId); });
		frame.src = toAssetUrl(p.file);
		box.appendChild(frame);
		webviewFrames.set(p.panelId, frame);
	});
}

/* ---------- interactive UI bridge (exthost -> workbench -> user -> back) ---------- */
async function handleUiRequest(p) {
	let value;
	try {
		if (p.kind === 'quickPick') {
			value = await new Promise(resolve => {
				let answered = false;
				const done = v => { if (!answered) { answered = true; resolve(v); } };
				showPalette(p.items.map((it, i) => ({ label: it.label, detail: it.description || it.detail || '', run: () => done(p.canPickMany ? [i] : i) })), p.placeholder || 'Select...');
				// closing the palette without choosing = cancel
				const watch = setInterval(() => { if ($('#palette').classList.contains('hidden')) { clearInterval(watch); setTimeout(() => done(undefined), 50); } }, 200);
			});
		} else if (p.kind === 'input') {
			const v = await nativePrompt(p.prompt || 'Input', p.value || '', p.placeholder || '');
			value = v === null ? undefined : v;
		} else if (p.kind === 'message') {
			// modal -> center dialog; otherwise a VSCode-style notification toast
			value = p.modal ? await choiceDialog(p.text, p.detail, p.buttons, p.type)
				: await notifyChoice(p.type, p.text, p.detail, p.buttons);
		} else if (p.kind === 'openDialog') {
			const r = await window.__TAURI__.dialog.open({ directory: !!p.directory, multiple: !!p.multiple, title: p.title || undefined });
			value = r == null ? undefined : (Array.isArray(r) ? r : [r]);
		} else if (p.kind === 'saveDialog') {
			value = await window.__TAURI__.dialog.save({ title: p.title || undefined }) || undefined;
		}
	} catch { value = undefined; }
	invoke('exthost_send', { line: JSON.stringify({ method: 'uiResponse', params: { id: p.id, value } }) }).catch(() => { });
}

// modal with arbitrary buttons; resolves the clicked index or undefined on dismiss
// modal message dialog (only for showXMessage(..., {modal:true}, ...))
function choiceDialog(text, detail, buttons, type) {
	return new Promise(resolve => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `<div class="modal"><div class="modal-title">${esc(text)}</div>` +
			(detail ? `<div class="modal-msg">${esc(detail)}</div>` : '') +
			`<div class="modal-btns"></div></div>`;
		const btns = overlay.querySelector('.modal-btns');
		const done = v => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
		buttons.forEach((b, i) => {
			const el = document.createElement('button');
			el.className = 'modal-btn' + (i === 0 ? ' primary' : '');
			el.textContent = b;
			el.title = b;
			el.onclick = () => done(i);
			btns.appendChild(el);
		});
		const cancel = document.createElement('button');
		cancel.className = 'modal-btn';
		cancel.textContent = buttons.length ? 'Cancel' : 'OK';
		cancel.onclick = () => done(undefined);
		btns.appendChild(cancel);
		const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(undefined); } };
		document.addEventListener('keydown', onKey, true);
		overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(undefined); });
		document.body.appendChild(overlay);
	});
}

// VSCode-style notification (bottom-right toast with action links); resolves the
// clicked button index, or undefined when dismissed / auto-hidden
function notifyChoice(type, text, detail, buttons) {
	return new Promise(resolve => {
		let host = $('#notifications');
		if (!host) { host = document.createElement('div'); host.id = 'notifications'; document.body.appendChild(host); }
		const n = document.createElement('div');
		n.className = 'notif notif-' + (type || 'info');
		const icon = type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'info';
		let settled = false;
		const done = v => { if (settled) return; settled = true; clearTimeout(timer); n.classList.add('leaving'); setTimeout(() => n.remove(), 180); resolve(v); };
		const head = document.createElement('div');
		head.className = 'notif-head';
		head.innerHTML = `<span class="codicon codicon-${icon} notif-icon"></span><span class="notif-text">${esc(text)}${detail ? '<br><span class="notif-detail">' + esc(detail) + '</span>' : ''}</span>` +
			`<button class="notif-close" title="Clear"><span class="codicon codicon-close"></span></button>`;
		head.querySelector('.notif-close').onclick = () => done(undefined);
		n.appendChild(head);
		if (buttons.length) {
			const row = document.createElement('div');
			row.className = 'notif-actions';
			buttons.forEach((b, i) => { const el = document.createElement('button'); el.className = 'notif-btn' + (i === 0 ? ' primary' : ''); el.textContent = b; el.onclick = () => done(i); row.appendChild(el); });
			n.appendChild(row);
		}
		host.appendChild(n);
		// auto-dismiss info/warn without pending choice after 12s (like VSCode)
		const timer = setTimeout(() => done(undefined), buttons.length ? 20000 : 8000);
	});
}

async function rpc(method, params, timeout = 4000) {
	// wait for the host instead of failing instantly — clicking a view right after
	// launch used to produce a bogus "timed out" before the host even started
	if (!state.exthostReady) { try { await startExtHost(); } catch { } }
	if (!state.exthostReady && extHostStarting) { try { await extHostStarting; } catch { } }
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

Object.assign(Ext, { renderView, startExtHost, notifyWorkspace, provideCompletions, RECOMMENDED, applyContributions, contributedCommands, activateLanguage, runExtCommand: (cmd, ...args) => rpc('executeCommand', { command: cmd, args }, 8000) });
window.searchExtensions = searchExtensions;
$('#ext-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchExtensions(); });
