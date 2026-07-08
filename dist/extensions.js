// CozyCode native extensions.
//
// An extension is a folder (`cozy.json` + web files) packaged as `.cext` (a renamed
// .zip). It runs as a SANDBOXED IFRAME and talks to CozyCode only through the small
// `cozy` API injected below — it cannot reach the workbench DOM, Monaco, or `state`.
// No VS Code, no Node sidecar. See wiki/Writing-Extensions.md.
'use strict';

const convertFileSrc = window.__TAURI__.core.convertFileSrc;

// ---- the `cozy` API shim, injected into every extension iframe (runs first) ----
// Kept as a string so the same code runs inside the sandbox. Requests are id-matched
// promises; the host answers with {__cozyHost, res}. Commands the ext registers are
// invoked by the host with {__cozyHost, command}.
const COZY_SHIM = `(function(){
  var P=new URLSearchParams(location.hash.slice(1)), viewId=P.get('cozyView')||'';
  var _id=0, waiters={}, listeners={}, cmds={};
  function call(method,args){return new Promise(function(res){var id=++_id;waiters[id]=res;parent.postMessage({__cozy:1,viewId:viewId,req:{id:id,method:method,args:args||[]}},'*');});}
  window.addEventListener('message',function(ev){var d=ev.data;if(!d||!d.__cozyHost)return;
    if(d.res){var w=waiters[d.res.id];if(w){delete waiters[d.res.id];w(d.res.value);}}
    else if(d.event){(listeners[d.event.name]||[]).forEach(function(cb){try{cb(d.event.data);}catch(e){}});}
    else if(d.command){var fn=cmds[d.command.id];Promise.resolve(fn?fn.apply(null,d.command.args||[]):undefined).then(function(v){parent.postMessage({__cozy:1,viewId:viewId,cmdResult:{token:d.command.token,value:v}},'*');});}
  });
  window.cozy={
    view:{id:viewId, isHost:!viewId},
    commands:{register:function(id,fn){cmds[id]=fn;call('registerCommand',[id]);},execute:function(id){return call('executeCommand',[id,[].slice.call(arguments,1)]);}},
    workspace:{root:function(){return call('workspaceRoot');}, listDir:function(p){return call('listDir',[p]);}},
    fs:{readFile:function(p){return call('readFile',[p]);},writeFile:function(p,t){return call('writeFile',[p,t]);}},
    window:{
      showMessage:function(t){return call('showMessage',[t,[].slice.call(arguments,1)]);},
      showInput:function(prompt,value){return call('showInput',[prompt,value]);},
      showQuickPick:function(items,ph){return call('showQuickPick',[items,ph]);},
      openFile:function(p){return call('openFile',[p]);}
    },
    storage:{get:function(k){return call('storageGet',[k]);},set:function(k,v){return call('storageSet',[k,v]);}},
    on:function(name,cb){(listeners[name]=listeners[name]||[]).push(cb);}
  };
  parent.postMessage({__cozy:1,viewId:viewId,ready:1},'*');
})();`;

/* ================= state ================= */
let cozyExts = [];              // enabled ExtInfo currently loaded
const extCommands = [];         // {command, title, category, extId} — palette source
let extViews = [];              // {id, title, icon, location, extId, root, main}
const hostFrames = new Map();   // extId -> hidden iframe (the "activated" instance)
const viewFrames = new Map();   // viewId -> visible iframe
const frameInfo = new Map();    // iframe.contentWindow -> {extId, viewId}
const cmdReturns = new Map();   // token -> resolve (host -> ext command results)
let cmdToken = 0;
let loadedSig = '';

/* ================= loading ================= */
// `startExtHost` name kept: callers (explorer/settings/core) already use it. Loads or
// refreshes the native extensions. Lazy: nothing to do when the enabled set is unchanged.
async function startExtHost(force = false) {
	let list = [];
	try { list = await invoke('ext_list'); } catch { return; }
	const enabled = list.filter(e => e.enabled);
	const sig = JSON.stringify(enabled.map(e => e.id + '@' + e.version));
	if (!force && sig === loadedSig) return;
	loadedSig = sig;
	cozyExts = enabled;

	// tear down frames for extensions no longer present/enabled
	const ids = new Set(enabled.map(e => e.id));
	for (const [extId, f] of [...hostFrames]) if (!ids.has(extId)) { f.remove(); hostFrames.delete(extId); }
	for (const [vid, f] of [...viewFrames]) { const m = frameInfo.get(f.contentWindow); if (m && !ids.has(m.extId)) { f.remove(); viewFrames.delete(vid); } }

	// rebuild the view + command registries from manifests
	extViews = [];
	extCommands.length = 0;
	for (const ext of enabled) {
		const c = ext.contributes || {};
		for (const v of c.views || [])
			extViews.push({ id: v.id, title: v.title || v.id, icon: v.icon, location: v.location || 'left', extId: ext.id, root: ext.root, main: ext.main });
		for (const cmd of c.commands || [])
			extCommands.push({ command: cmd.command, title: cmd.title || cmd.command, category: cmd.category || ext.name, extId: ext.id });
	}
	placeViews();

	// activate each extension: a hidden host iframe runs main.html headless so its
	// commands/listeners register (like VS Code activate()). Theme-only exts (no main)
	// are skipped. Views get their own iframes lazily on reveal.
	for (const ext of enabled) if (ext.main && !hostFrames.has(ext.id)) spawnHostFrame(ext);
	broadcast('workspaceChanged', { root: state.root || '' });
	cozyLog('ext', `${enabled.length} extension(s), ${extViews.length} view(s), ${extCommands.length} command(s)`);
}

async function spawnHostFrame(ext) {
	const f = document.createElement('iframe');
	f.style.display = 'none';
	f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
	hostFrames.set(ext.id, f);
	document.body.appendChild(f);
	f.addEventListener('load', () => frameInfo.set(f.contentWindow, { extId: ext.id, viewId: '' }));
	try { f.src = await frameSrc(ext, ''); } catch { f.remove(); hostFrames.delete(ext.id); }
}

// read the extension entry, inject the cozy shim (must run before the ext's scripts),
// write the processed file BESIDE the original so relative asset paths still resolve,
// return its asset URL with the viewId in the hash.
async function frameSrc(ext, viewId) {
	const raw = await invoke('read_file', { path: ext.main });
	const shim = `<script>${COZY_SHIM}</script>`;
	let html;
	if (/<head[^>]*>/i.test(raw)) html = raw.replace(/<head[^>]*>/i, m => m + shim);
	else if (/<html[^>]*>/i.test(raw)) html = raw.replace(/<html[^>]*>/i, m => m + shim);
	else html = `<!doctype html><head>${shim}</head>` + raw;
	const out = ext.root + '\\__cozy_' + (viewId ? viewId.replace(/[^\w.-]/g, '_') : 'host') + '.html';
	await invoke('write_file', { path: out, content: html });
	return convertFileSrc(out) + '#cozyView=' + encodeURIComponent(viewId || '');
}

async function mountView(view, container) {
	container.innerHTML = '';
	if (!view.main) { container.innerHTML = '<div class="ext-tree-item" style="color:var(--fg-dim);padding:8px">This extension has no view entry.</div>'; return; }
	let existing = viewFrames.get(view.id);
	if (existing) { container.appendChild(existing); return; } // persistent — keep iframe state
	const f = document.createElement('iframe');
	f.className = 'ext-webview';
	f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
	f.addEventListener('load', () => frameInfo.set(f.contentWindow, { extId: view.extId, viewId: view.id }));
	viewFrames.set(view.id, f);
	container.appendChild(f);
	try { f.src = await frameSrc({ root: view.root, main: view.main }, view.id); }
	catch { container.innerHTML = '<div class="ext-tree-item" style="color:var(--fg-dim);padding:8px">Failed to load view.</div>'; }
}

/* ================= cozy bridge (iframe -> host) ================= */
window.addEventListener('message', async ev => {
	const d = ev.data;
	if (!d || !d.__cozy) return;
	const info = frameInfo.get(ev.source) || { extId: '', viewId: d.viewId };
	if (d.ready) return;
	if (d.cmdResult) { const r = cmdReturns.get(d.cmdResult.token); if (r) { cmdReturns.delete(d.cmdResult.token); r(d.cmdResult.value); } return; }
	if (!d.req) return;
	const reply = value => ev.source.postMessage({ __cozyHost: 1, res: { id: d.req.id, value } }, '*');
	try { reply(await handleCozy(d.req.method, d.req.args || [], info)); }
	catch (e) { cozyLog('ext', `${info.extId} ${d.req.method} failed: ${e}`); reply(undefined); }
});

const cmdOwner = new Map(); // commandId -> extId (whoever registered it)
async function handleCozy(method, args, info) {
	switch (method) {
		case 'registerCommand': cmdOwner.set(args[0], info.extId); return true;
		case 'executeCommand': return runExtCommand(args[0], ...(args[1] || []));
		case 'workspaceRoot': return state.root || '';
		case 'listDir': return invoke('list_dir', { path: args[0] }).catch(() => []);
		case 'readFile': return invoke('read_file', { path: args[0] });
		case 'writeFile': await invoke('write_file', { path: args[0], content: args[1] }); return true;
		case 'openFile': try { await openFile(args[0], { preview: false }); } catch { } return true;
		case 'storageGet': return JSON.parse(localStorage.getItem('cozyExtStore:' + info.extId + ':' + args[0]) || 'null');
		case 'storageSet': localStorage.setItem('cozyExtStore:' + info.extId + ':' + args[0], JSON.stringify(args[1])); return true;
		case 'showMessage': {
			const [text, buttons] = args;
			if (!buttons || !buttons.length) { toast(text); return undefined; }
			return new Promise(res => showPalette(buttons.map((b, i) => ({ label: b, run: () => res(i) })), text));
		}
		case 'showInput': { const v = await nativePrompt(args[0] || 'Input', args[1] || ''); return v === null ? undefined : v; }
		case 'showQuickPick': {
			const items = (args[0] || []).map(x => typeof x === 'string' ? { label: x } : x);
			return new Promise(res => { let done = false; showPalette(items.map((it, i) => ({ label: it.label, detail: it.detail || it.description || '', run: () => { done = true; res(it.value !== undefined ? it.value : it.label); } })), args[1] || 'Select...'); const w = setInterval(() => { if ($('#palette').classList.contains('hidden')) { clearInterval(w); if (!done) res(undefined); } }, 200); });
		}
		default: return undefined;
	}
}

// run an extension command: route to the owner's host frame, await its result.
function runExtCommand(command, ...cmdArgs) {
	const extId = cmdOwner.get(command) || (extCommands.find(c => c.command === command) || {}).extId;
	const frame = extId && hostFrames.get(extId);
	if (!frame || !frame.contentWindow) return Promise.resolve(undefined);
	return new Promise(resolve => {
		const token = ++cmdToken;
		cmdReturns.set(token, resolve);
		frame.contentWindow.postMessage({ __cozyHost: 1, command: { id: command, args: cmdArgs, token } }, '*');
		setTimeout(() => { if (cmdReturns.has(token)) { cmdReturns.delete(token); resolve(undefined); } }, 8000);
	});
}

function broadcast(name, data) {
	const msg = { __cozyHost: 1, event: { name, data } };
	for (const f of hostFrames.values()) try { f.contentWindow && f.contentWindow.postMessage(msg, '*'); } catch { }
	for (const f of viewFrames.values()) try { f.contentWindow && f.contentWindow.postMessage(msg, '*'); } catch { }
}

/* ================= view placement (left / right / bottom) ================= */
function placeViews() {
	renderLeftViews();
	renderRightViews();
	renderBottomViews();
	updateLayoutToggles();
}

function containerIcon(b, icon) {
	if (typeof icon === 'string' && icon.startsWith('$(')) {
		b.innerHTML = `<span class="codicon codicon-${esc(icon.slice(2, -1))}"></span>`;
	} else if (typeof icon === 'string' && icon) {
		b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
		invoke('read_file_base64', { path: icon }).then(b64 => {
			const ext = icon.toLowerCase().split('.').pop();
			const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/*';
			// render as a CSS MASK filled with currentColor so it matches the built-in
			// codicons exactly (grey / white-on-active), like the rest of the UI
			b.innerHTML = `<span class="act-ext-icon"></span>`;
			b.querySelector('.act-ext-icon').style.setProperty('--ext-icon', `url("data:${mime};base64,${b64}")`);
		}).catch(() => { });
	} else b.innerHTML = `<span class="codicon codicon-symbol-misc"></span>`;
}

function renderLeftViews() {
	const bar = $('#activitybar'), spacer = bar.querySelector('.act-spacer');
	const left = extViews.filter(v => v.location === 'left');
	bar.querySelectorAll('[data-extview]').forEach(b => { if (!left.some(v => v.id === b.dataset.extview)) b.remove(); });
	for (const v of left) {
		if (bar.querySelector(`[data-extview="${CSS.escape(v.id)}"]`)) continue;
		const b = document.createElement('button');
		b.className = 'act-btn';
		b.dataset.extview = v.id;
		b.title = v.title;
		containerIcon(b, v.icon);
		b.onclick = () => showLeftView(v.id);
		bar.insertBefore(b, spacer);
	}
}

function showLeftView(id) {
	const v = extViews.find(x => x.id === id && x.location === 'left');
	if (!v) return;
	$$('.act-btn').forEach(b => b.classList.remove('active'));
	$(`[data-extview="${CSS.escape(id)}"]`)?.classList.add('active');
	$$('#sidebar .view').forEach(el => el.classList.add('hidden'));
	$('#sidebar').style.display = 'flex'; $('#sidebar-resizer').style.display = 'block';
	const host = $('#ext-views');
	host.classList.remove('hidden');
	host.innerHTML = `<div class="view-title"><span>${esc(v.title.toUpperCase())}</span></div>`;
	const body = document.createElement('div');
	body.className = 'ext-webview-host';
	host.appendChild(body);
	mountView(v, body);
}

function renderRightViews() {
	const bar = $('#secondary-activitybar');
	const right = extViews.filter(v => v.location === 'right');
	bar.querySelectorAll('[data-secview]').forEach(b => { if (!right.some(v => v.id === b.dataset.secview)) b.remove(); });
	if (!right.length) { hideSecondary(); return; }
	for (const v of right) {
		if (bar.querySelector(`[data-secview="${CSS.escape(v.id)}"]`)) continue;
		const b = document.createElement('button');
		b.className = 'act-btn';
		b.dataset.secview = v.id;
		b.title = v.title;
		containerIcon(b, v.icon);
		b.onclick = () => { $('#secondary-activitybar .act-btn.active')?.dataset.secview === v.id ? hideSecondary() : showRightView(v.id); };
		bar.appendChild(b);
	}
}

function showRightView(id) {
	const v = extViews.find(x => x.id === id && x.location === 'right');
	if (!v) return;
	$('#secondary-sidebar').classList.remove('hidden');
	$('#secondary-resizer').classList.remove('hidden');
	$$('#secondary-activitybar .act-btn').forEach(b => b.classList.toggle('active', b.dataset.secview === id));
	const host = $('#secondary-views');
	host.innerHTML = `<div class="view-title"><span>${esc(v.title.toUpperCase())}</span></div>`;
	const body = document.createElement('div');
	body.className = 'ext-webview-host';
	host.appendChild(body);
	mountView(v, body);
}

function hideSecondary() {
	$('#secondary-sidebar').classList.add('hidden');
	$('#secondary-resizer').classList.add('hidden');
	$$('#secondary-activitybar .act-btn').forEach(b => b.classList.remove('active'));
}
function toggleSecondary() {
	if (!$('#secondary-sidebar').classList.contains('hidden')) return hideSecondary();
	const right = extViews.filter(v => v.location === 'right');
	if (right.length) showRightView(right[0].id);
	else toast('No extension contributes a right-side view');
}

function renderBottomViews() {
	const bottom = extViews.filter(v => v.location === 'bottom');
	$$('#panel-tabs .panel-tab').forEach(t => {
		const id = t.dataset.panel;
		if (['problems', 'output', 'terminal', 'ports'].includes(id)) return;
		if (!bottom.some(v => v.id === id)) { t.remove(); $('#pane-' + id)?.remove(); }
	});
	for (const v of bottom) {
		if ($(`.panel-tab[data-panel="${CSS.escape(v.id)}"]`)) continue;
		const tab = document.createElement('button');
		tab.className = 'panel-tab';
		tab.dataset.panel = v.id;
		tab.textContent = v.title.toUpperCase();
		const pane = document.createElement('div');
		pane.className = 'pane hidden';
		pane.id = 'pane-' + v.id;
		$('#panel-body').appendChild(pane);
		tab.onclick = () => { showPanel(); switchPanelTab(v.id); if (!pane.childElementCount) { const b = document.createElement('div'); b.className = 'ext-webview-host'; b.style.height = '100%'; pane.appendChild(b); mountView(v, b); } };
		$('#panel-tabs').appendChild(tab);
	}
}

/* ---------- secondary side bar resizer (zoom-aware, iframe-drag-safe) ---------- */
$('#secondary-resizer').addEventListener('mousedown', e => {
	e.preventDefault();
	document.body.classList.add('dragging-resize'); // disable iframe hit-testing while dragging
	const right = $('#secondary-sidebar').getBoundingClientRect().right;
	const move = ev => { const z = zoom(); $('#secondary-sidebar').style.width = Math.max(200, Math.min((window.innerWidth / z) - 400, (right - ev.clientX) / z)) + 'px'; };
	const up = () => { document.body.classList.remove('dragging-resize'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
	document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});

/* ---------- titlebar layout toggles (Left / Panel / Right) ---------- */
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
const _ltObs = new MutationObserver(() => updateLayoutToggles());
for (const sel of ['#panel', '#secondary-sidebar', '#sidebar']) _ltObs.observe($(sel), { attributes: true, attributeFilter: ['class', 'style'] });
updateLayoutToggles();

/* ================= Extensions view (Installed + workspace Marketplace) ================= */
async function renderView() {
	const box = $('#ext-results');
	box.innerHTML = '';
	let installed = [];
	try { installed = await invoke('ext_list'); } catch { }
	const filter = ($('#ext-input').value || '').toLowerCase();
	const match = t => !filter || String(t).toLowerCase().includes(filter);

	box.appendChild(importRow());

	const inst = installed.filter(e => match(e.name) || match(e.id) || match(e.description));
	box.appendChild(catHeader(`INSTALLED (${inst.length})`));
	if (!inst.length) box.appendChild(dim('No extensions installed. Import a .cext / .zip, or open a folder that lists some.'));
	for (const ext of inst) box.appendChild(installedCard(ext));

	// workspace marketplace: a repo can ship .cozycode/extensions.json listing others
	let market = [];
	try { market = await invoke('ext_marketplace', { root: state.root || '' }); } catch { }
	const installedIds = new Set(installed.map(x => x.id));
	const mkt = (Array.isArray(market) ? market : []).filter(m => match(m.name) || match(m.id) || match(m.description));
	if (mkt.length) {
		box.appendChild(catHeader('WORKSPACE MARKETPLACE'));
		for (const m of mkt) box.appendChild(marketCard(m, installedIds));
	}
}

function importRow() {
	const row = document.createElement('div');
	row.className = 'ext-import-row';
	const b = document.createElement('button');
	b.className = 'ext-btn primary';
	b.innerHTML = '<span class="codicon codicon-cloud-download"></span> Import Extension (.cext / .zip)';
	b.onclick = importExtension;
	row.appendChild(b);
	return row;
}

async function importExtension() {
	const path = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: 'CozyCode Extension', extensions: ['cext', 'zip'] }] });
	if (!path) return;
	try { const id = await invoke('ext_import', { path }); toast('Installed ' + id, 4000); refreshExtView(); startExtHost(true); }
	catch (e) { toast('Import failed: ' + e); }
}

const catHeader = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.textContent = t; return d; };
const dim = t => { const d = document.createElement('div'); d.className = 'scm-group-title'; d.style.cssText = 'padding:8px 12px;color:var(--fg-dim)'; d.textContent = t; return d; };
const extBtn = (label, cls, onclick) => { const b = document.createElement('button'); b.className = 'ext-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = onclick; return b; };

function extCard({ iconUrl, name, desc, metaText }) {
	const card = document.createElement('div');
	card.className = 'ext-card';
	const ic = document.createElement('div');
	ic.className = 'ext-icon';
	ic.innerHTML = `<span class="codicon codicon-extensions"></span>`;
	if (iconUrl) { const img = document.createElement('img'); img.src = iconUrl; img.onload = () => { ic.innerHTML = ''; ic.appendChild(img); }; }
	const info = document.createElement('div');
	info.className = 'ext-info';
	info.innerHTML = `<div class="ext-name">${esc(name)}</div><div class="ext-desc">${esc(desc || '')}</div><div class="ext-meta">${esc(metaText || '')}</div>`;
	const actions = document.createElement('div');
	actions.className = 'ext-actions';
	card.appendChild(ic); card.appendChild(info); card.appendChild(actions);
	return [card, actions];
}

function installedCard(ext) {
	const [card, actions] = extCard({
		iconUrl: ext.icon ? convertFileSrc(ext.icon) : '',
		name: ext.name, desc: ext.description,
		metaText: `${ext.id} v${ext.version}${ext.enabled ? '' : ' (disabled)'}`,
	});
	if (!ext.enabled) card.classList.add('ext-disabled');
	actions.appendChild(extBtn(ext.enabled ? 'Disable' : 'Enable', '', async () => {
		await invoke('ext_set_state', { id: ext.id, enabled: !ext.enabled });
		toast((ext.enabled ? 'Disabled ' : 'Enabled ') + ext.id);
		refreshExtView(); startExtHost(true);
	}));
	actions.appendChild(extBtn('Uninstall', 'uninstall', async () => {
		if (!(await confirmDialog('Uninstall ' + ext.id + '?'))) return;
		await invoke('ext_uninstall', { id: ext.id }); toast('Uninstalled ' + ext.id);
		refreshExtView(); startExtHost(true);
	}));
	for (const th of (ext.themes || []).slice(0, 2)) actions.appendChild(extBtn('Theme: ' + th.label, '', () => applyExtTheme(th.path, th.ui_theme, th.label)));
	return card;
}

function marketCard(m, installedIds) {
	const [card, actions] = extCard({ name: m.name || m.id, desc: m.description, metaText: m.id || m.repo || '' });
	if (m.id && installedIds.has(m.id)) { const b = extBtn('Installed', '', null); b.disabled = true; actions.appendChild(b); }
	else if (m.download) {
		actions.appendChild(extBtn('Install', '', async () => {
			if (!(await confirmDialog('Install ' + (m.name || m.id) + '?', 'Download ' + m.download + ' and install it?'))) return;
			try { const id = await invoke('ext_install_url', { url: m.download }); toast('Installed ' + id, 4000); refreshExtView(); startExtHost(true); }
			catch (e) { toast('Install failed: ' + e); }
		}));
	}
	if (m.repo) actions.appendChild(extBtn('Open Repo', '', () => invoke('open_url', { url: m.repo }).catch(() => { })));
	return card;
}

function refreshExtView() { renderView(); }

/* ================= workbench hooks ================= */
// tell extensions the workspace changed (folder open, host start)
function notifyWorkspace() { broadcast('workspaceChanged', { root: state.root || '' }); }

// core.js calls this when a file opens — surface it to extensions as an event
function activateLanguage(lang) {
	const t = state.tabs && state.tabs.find(x => x.key === state.active);
	broadcast('activeFileChanged', { languageId: lang || '', path: (t && t.path) || '' });
}

/* ---------- completions: keyword + document words (no LSP without extensions) ---------- */
const K = {
	js: 'const let var function return if else for while do switch case break continue class extends new this super import export default from async await try catch finally throw typeof instanceof void delete yield static get set null undefined true false Promise Array Object String Number Boolean Map Set Symbol JSON Math console document window setTimeout setInterval fetch',
	ts: 'const let var function return if else for while class interface type enum extends implements new this super import export default from async await try catch finally throw typeof keyof readonly public private protected abstract as namespace declare string number boolean any unknown never void null undefined Promise Array Record Partial',
	py: 'def class return if elif else for while break continue import from as with try except finally raise lambda yield async await global nonlocal pass del True False None self print len range enumerate zip map filter list dict set tuple str int float bool open input isinstance super property staticmethod classmethod',
	rust: 'fn let mut const static struct enum trait impl for while loop if else match return break continue use mod pub crate self super as ref move async await dyn where unsafe Some None Ok Err Result Option Vec String str i32 i64 u32 u64 usize f64 bool println! vec! format! derive',
	go: 'func return if else for range switch case break continue package import var const type struct interface map chan go defer select fallthrough nil true false make new len cap append copy panic recover string int int64 float64 bool byte rune error fmt',
	java: 'public private protected class interface extends implements abstract final static void return if else for while do switch case break continue new this super import package try catch finally throw throws null true false int long double float boolean String System println',
	c: 'int char float double void long short unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue sizeof NULL include define printf scanf malloc free',
	cpp: 'int char float double void long short bool auto struct class union enum template typename namespace using return if else for while switch case break continue new delete const static virtual public private protected this nullptr true false std vector string cout cin endl include',
};
K.javascript = K.js; K.typescript = K.ts; K.python = K.py; K.csharp = K.java;
const _kwCache = {};
function langKeywords(lang) { return _kwCache[lang] || (_kwCache[lang] = (K[lang] || '').split(/\s+/).filter(Boolean)); }

const _wordCache = new WeakMap();
function documentWords(model) {
	const v = model.getVersionId(), c = _wordCache.get(model);
	if (c && c.v === v) return c.words;
	const words = [...new Set(model.getValue().match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [])].slice(0, 2000);
	_wordCache.set(model, { v, words });
	return words;
}

async function provideCompletions(model, position) {
	const word = model.getWordUntilPosition(position);
	const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
	const suggestions = [], seen = new Set();
	for (const kw of langKeywords(model.getLanguageId())) {
		if (seen.has(kw)) continue;
		suggestions.push({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw, range, sortText: '0' + kw });
		seen.add(kw);
	}
	for (const w of documentWords(model)) {
		if (seen.has(w) || w === word.word) continue;
		suggestions.push({ label: w, kind: monaco.languages.CompletionItemKind.Text, insertText: w, range, sortText: '1' + w });
		if (suggestions.length > 300) break;
	}
	return { suggestions };
}

Object.assign(Ext, { renderView, startExtHost, notifyWorkspace, provideCompletions, activateLanguage, contributedCommands: extCommands, runExtCommand });
$('#ext-input').addEventListener('input', () => refreshExtView());
