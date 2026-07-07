// CozyCode panel — terminals (multi + split), Problems, Ports, resizers.
'use strict';

const terminals = []; // { id, term, fit, box, name, ptyId }
let activeTerm = null;
let ptyListenerBound = false;

function bindPtyListeners() {
	if (ptyListenerBound) return;
	ptyListenerBound = true;
	listen('pty-output', e => { const t = terminals.find(t => t.ptyId === e.payload.id); if (t) t.term.write(e.payload.data); });
	listen('pty-exit', e => { const t = terminals.find(t => t.ptyId === e.payload); if (t) { t.term.write('\r\n[process exited]\r\n'); t.ptyId = null; } });
}

function showPanel(tab) {
	$('#panel').classList.remove('hidden');
	if (tab) switchPanelTab(tab);
}
function hidePanel() { $('#panel').classList.add('hidden'); }

function switchPanelTab(name) {
	$$('.panel-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
	$$('#panel-body .pane').forEach(p => p.classList.add('hidden'));
	$('#pane-' + name).classList.remove('hidden');
	if (name === 'terminal') { if (!terminals.length) newTerminal(); else { activeTerm && activeTerm.fit.fit(); activeTerm && activeTerm.term.focus(); } }
	if (name === 'ports') renderPorts();
	if (name === 'problems') renderProblems();
	if (name === 'output') renderOutput();
}

// auto-detect installed shells once; cache on state
async function ensureShells() {
	if (state.shells) return state.shells;
	try { state.shells = await invoke('detect_shells'); } catch { state.shells = []; }
	return state.shells;
}

async function newTerminal(split = false, shell = null) {
	bindPtyListeners();
	await ensureShells();
	// pick shell: explicit arg > settings default-by-name > first detected
	if (!shell) {
		const def = state.settings['terminal.defaultShell'];
		shell = state.shells.find(s => s.name === def) || state.shells[0] || null;
	}
	const area = $('#term-area');
	if (!split) area.innerHTML = '';
	const id = Date.now() + Math.floor(Math.random() * 1000);
	const box = document.createElement('div');
	box.className = 'term-box';
	area.appendChild(box);
	const term = new Terminal({ fontSize: state.settings['terminal.fontSize'] || 13, theme: { background: '#1e1e1e' }, cursorBlink: true });
	const fit = new FitAddon.FitAddon();
	term.loadAddon(fit);
	term.open(box);
	fit.fit();
	let ptyId;
	try {
		ptyId = await invoke('pty_spawn', {
			cwd: state.remote ? '' : (state.root || ''),
			cols: term.cols, rows: term.rows,
			shell: shell ? shell.path : (state.settings['terminal.shell'] || null),
			args: shell ? shell.args : null,
		});
	} catch (e) { toast('Terminal failed: ' + e); return; }
	term.onData(d => ptyId && invoke('pty_write', { id: ptyId, data: d }));
	term.onResize(({ cols, rows }) => ptyId && invoke('pty_resize', { id: ptyId, cols, rows }));
	new ResizeObserver(() => fit.fit()).observe(box);
	const entry = { id, term, fit, box, name: (shell ? shell.name : 'shell'), ptyId };
	terminals.push(entry);
	setActiveTerm(entry);
	renderTermTabs();
	box.onclick = () => setActiveTerm(entry);
	cozyLog('terminal:' + entry.name, 'started (' + (shell ? shell.name : 'default') + ')');
}

// dropdown to pick which shell to launch (VSCode "+" caret)
async function pickShellTerminal() {
	await ensureShells();
	if (!state.shells.length) { newTerminal(false); return; }
	Settings.showPalette(state.shells.map(s => ({
		label: s.name, detail: s.path, icon: 'terminal',
		run: () => { Panel.showPanel('terminal'); newTerminal(false, s); },
	})), 'Select shell to launch');
}

function setActiveTerm(entry) {
	activeTerm = entry;
	// in non-split mode, show only active; in split mode all boxes stay
	entry.fit.fit();
	entry.term.focus();
	renderTermTabs();
}

let dragIdx = null;
function renderTermTabs() {
	const el = $('#term-tabs');
	el.innerHTML = '';
	terminals.forEach((t, idx) => {
		const d = document.createElement('div');
		d.className = 'term-tab' + (t === activeTerm ? ' active' : '');
		d.draggable = true;
		d.innerHTML = `<span class="codicon codicon-terminal"></span><span class="tt-name">${esc(t.name)}</span>`;
		const kill = document.createElement('button');
		kill.className = 'tt-kill';
		kill.title = 'Kill Terminal';
		kill.innerHTML = '<span class="codicon codicon-trash"></span>';
		kill.onclick = e => { e.stopPropagation(); killTerminalEntry(t); };
		d.appendChild(kill);
		d.onclick = () => {
			const area = $('#term-area');
			if (![...area.children].includes(t.box)) { area.innerHTML = ''; area.appendChild(t.box); }
			setActiveTerm(t);
		};
		// drag to reorder within the sidebar
		d.ondragstart = () => { dragIdx = idx; d.classList.add('dragging'); };
		d.ondragend = () => { dragIdx = null; d.classList.remove('dragging'); };
		d.ondragover = e => { e.preventDefault(); d.classList.add('drop-target'); };
		d.ondragleave = () => d.classList.remove('drop-target');
		d.ondrop = e => {
			e.preventDefault();
			d.classList.remove('drop-target');
			if (dragIdx === null || dragIdx === idx) return;
			const [moved] = terminals.splice(dragIdx, 1);
			terminals.splice(idx, 0, moved);
			renderTermTabs();
		};
		el.appendChild(d);
	});
}

function killTerminalEntry(entry) {
	if (!entry) return;
	if (entry.ptyId) invoke('pty_kill', { id: entry.ptyId });
	entry.box.remove();
	const i = terminals.indexOf(entry);
	terminals.splice(i, 1);
	if (activeTerm === entry) {
		activeTerm = terminals[i] || terminals[i - 1] || null;
		if (activeTerm) { const area = $('#term-area'); if (![...area.children].includes(activeTerm.box)) { area.innerHTML = ''; area.appendChild(activeTerm.box); } setActiveTerm(activeTerm); }
	}
	renderTermTabs();
	if (!terminals.length) hidePanel();
}
function killTerminal() { killTerminalEntry(activeTerm); }

function toggleTerminal() {
	if (!$('#panel').classList.contains('hidden') && $('#pane-terminal').classList.contains('hidden') === false) hidePanel();
	else showPanel('terminal');
}

/* ================= Problems ================= */
function setProblems(uri, items) {
	if (!items || !items.length) delete state.problems[uri];
	else state.problems[uri] = items;
	renderProblems();
	updateProblemsStatus();
}

function updateProblemsStatus() {
	let err = 0, warn = 0;
	for (const items of Object.values(state.problems))
		for (const p of items) { if (p.severity === 0) err++; else if (p.severity === 1) warn++; }
	$('#st-err').textContent = err;
	$('#st-warn').textContent = warn;
	const c = $('#problems-count');
	const total = err + warn;
	c.textContent = total;
	c.classList.toggle('hidden', total === 0);
}

function renderProblems() {
	const box = $('#pane-problems');
	box.innerHTML = '';
	const uris = Object.keys(state.problems);
	if (!uris.length) { box.innerHTML = '<div class="prob-file" style="color:var(--fg-dim)">No problems detected in the workspace.</div>'; return; }
	for (const uri of uris) {
		const fh = document.createElement('div');
		fh.className = 'prob-file';
		fh.appendChild(fileIconImg(basename(uri)));
		const s = document.createElement('span'); s.textContent = basename(uri); fh.appendChild(s);
		box.appendChild(fh);
		for (const p of state.problems[uri]) {
			const row = document.createElement('div');
			row.className = 'prob-item';
			const sevIcon = p.severity === 0 ? 'error' : p.severity === 1 ? 'warning' : 'info';
			row.innerHTML = `<span class="codicon codicon-${sevIcon}"></span><span>${esc(p.message)}</span>` +
				`<span class="dim">${esc(p.source || '')} [Ln ${p.startLine + 1}, Col ${p.startCol + 1}]</span>`;
			row.onclick = async () => { await openFile(uri); state.editor.revealLineInCenter(p.startLine + 1); state.editor.setPosition({ lineNumber: p.startLine + 1, column: p.startCol + 1 }); };
			box.appendChild(row);
		}
	}
}

/* ================= Ports (SSH forward + public tunnel) ================= */
const forwardedPorts = []; // { local, host, remote }
const publicTunnels = [];  // { port, provider, url }
let tunnelListenerBound = false;

function bindTunnel() {
	if (tunnelListenerBound) return;
	tunnelListenerBound = true;
	listen('tunnel-url', e => {
		const t = publicTunnels.find(t => t.port === e.payload.port);
		if (t) { t.url = e.payload.url; toast('Tunnel ready: ' + t.url, 6000); renderPorts(); }
	});
	listen('tunnel-log', e => toast(String(e.payload), 4000));
}

const PILL = {
	cloudflared: { label: 'Cloudflare', color: '#f38020' },
	ngrok: { label: 'ngrok', color: '#1f1e37' },
	tailscale: { label: 'Tailscale', color: '#4b5563' },
	ssh: { label: 'SSH', color: '#2f855a' },
};
function pill(kind) {
	const p = PILL[kind] || { label: kind, color: '#555' };
	return `<span class="port-pill" style="background:${p.color}">${esc(p.label)}</span>`;
}

function renderPorts() {
	const box = $('#pane-ports');
	box.innerHTML = '';

	// ---- add-forward toolbar ----
	const bar = document.createElement('div');
	bar.className = 'ports-bar';
	const prov = state.settings['tunnel.provider'] || 'cloudflared';
	bar.innerHTML =
		`<div class="ports-group"><span class="ports-label">Public tunnel</span>` +
		`<input id="tn-port" type="number" placeholder="Port" value="3000">` +
		`<select id="tn-prov">${['cloudflared', 'ngrok', 'tailscale'].map(p => `<option ${p === prov ? 'selected' : ''}>${p}</option>`).join('')}</select>` +
		`<button class="set-btn" id="tn-add">Create</button></div>` +
		`<div class="ports-group"><span class="ports-label">SSH forward</span>` +
		`<input id="pf-local" type="number" placeholder="Local" value="3000">` +
		`<span class="codicon codicon-arrow-left" style="color:var(--fg-dim)"></span>` +
		`<input id="pf-host" type="text" placeholder="Host" value="localhost">` +
		`<input id="pf-remote" type="number" placeholder="Remote" value="3000">` +
		`<button class="set-btn" id="pf-add">Forward</button></div>`;
	box.appendChild(bar);
	$('#tn-add').onclick = addTunnel;
	$('#pf-add').onclick = addForward;

	// ---- unified table ----
	const rows = [
		...publicTunnels.map(t => ({ kind: t.provider, port: t.port, target: t.url || `starting ${t.provider}...`, url: t.url, live: !!t.url, stop: () => { invoke('tunnel_stop', { port: t.port }); publicTunnels.splice(publicTunnels.indexOf(t), 1); } })),
		...forwardedPorts.map(p => ({ kind: 'ssh', port: p.local, target: `${p.host}:${p.remote}`, url: `http://localhost:${p.local}`, live: true, stop: () => { invoke('ssh_forward_stop', { localPort: p.local }); forwardedPorts.splice(forwardedPorts.indexOf(p), 1); } })),
	];

	if (!rows.length) {
		const e = document.createElement('div');
		e.className = 'scm-empty';
		e.textContent = state.remote ? 'No forwarded ports yet.' : 'cloudflared needs no login. ngrok/tailscale need a token in Settings. SSH forward needs an active Remote SSH connection.';
		box.appendChild(e);
		return;
	}

	const table = document.createElement('table');
	table.className = 'ports-table';
	table.innerHTML = `<thead><tr><th>Type</th><th>Port</th><th>Address</th><th></th></tr></thead>`;
	const tb = document.createElement('tbody');
	for (const r of rows) {
		const tr = document.createElement('tr');
		tr.innerHTML =
			`<td>${pill(r.kind)}</td>` +
			`<td>${r.port}</td>` +
			`<td>${r.live && r.url ? `<a href="${esc(r.url)}" style="color:var(--status)">${esc(r.target)}</a>` : `<span style="color:var(--fg-dim)">${esc(r.target)}</span>`}</td>`;
		const act = document.createElement('td');
		act.className = 'ports-actions';
		if (r.url && r.live) {
			const cp = document.createElement('button');
			cp.className = 'inline-act'; cp.title = 'Copy';
			cp.innerHTML = '<span class="codicon codicon-copy"></span>';
			cp.onclick = () => { navigator.clipboard.writeText(r.url); toast('Copied'); };
			act.appendChild(cp);
		}
		const rm = document.createElement('button');
		rm.className = 'inline-act'; rm.title = 'Stop';
		rm.innerHTML = '<span class="codicon codicon-close"></span>';
		rm.onclick = () => { r.stop(); renderPorts(); };
		act.appendChild(rm);
		tr.appendChild(act);
		tb.appendChild(tr);
	}
	table.appendChild(tb);
	box.appendChild(table);
}

async function addTunnel() {
	bindTunnel();
	const port = +$('#tn-port').value;
	const provider = $('#tn-prov').value;
	if (!port) return;
	if (publicTunnels.some(t => t.port === port)) { toast('Port already tunneled'); return; }
	try {
		await invoke('tunnel_start', { provider, port, token: state.settings['tunnel.token'] || null });
		publicTunnels.push({ port, provider, url: null });
		toast(`Starting ${provider} tunnel for :${port}...`, 4000);
		renderPorts();
	} catch (e) { toast(String(e), 6000); }
}

async function addForward() {
	if (!state.remote) { toast('Connect via Remote SSH first'); return; }
	const local = +$('#pf-local').value, host = $('#pf-host').value.trim(), remote = +$('#pf-remote').value;
	if (!local || !remote) return;
	try {
		await invoke('ssh_forward_start', { id: state.remote.id, localPort: local, remoteHost: host, remotePort: remote });
		forwardedPorts.push({ local, host, remote });
		toast(`Forwarding localhost:${local} -> ${host}:${remote}`);
		renderPorts();
	} catch (e) { toast('Forward failed: ' + e); }
}

/* ================= resizers ================= */
// track the pointer in the zoomed coordinate space, then divide by zoom to get
// layout px for style.* — keeps the drag edge exactly under the cursor.
const zoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

// bottom panel: height = distance from status bar top up to the cursor.
// dragging below a threshold hides the panel WITHOUT killing terminals.
function makeVResizer(el) {
	el.addEventListener('mousedown', e => {
		e.preventDefault();
		showPanel();
		el.classList.add('dragging');
		document.body.style.cursor = 'ns-resize';
		const bottom = $('#statusbar').getBoundingClientRect().top;
		const move = ev => {
			const z = zoom();
			let h = (bottom - ev.clientY) / z;
			if (h < 40) { hidePanel(); return; }
			h = Math.min((window.innerHeight / z) - 120, h);
			$('#panel').style.height = h + 'px';
			activeTerm && activeTerm.fit.fit();
		};
		const up = () => {
			el.classList.remove('dragging'); document.body.style.cursor = '';
			document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	});
}

// left sidebar: width = cursor X minus sidebar left. Dragging narrow hides it.
function makeHResizer(el, target) {
	el.addEventListener('mousedown', e => {
		e.preventDefault();
		const left = target.getBoundingClientRect().left;
		const move = ev => {
			const z = zoom();
			let w = (ev.clientX - left) / z;
			if (w < 100) { target.style.display = 'none'; el.style.display = 'none'; return; }
			w = Math.min((window.innerWidth / z) - 400, Math.max(150, w));
			target.style.display = 'flex';
			target.style.width = w + 'px';
		};
		const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	});
}

Object.assign(Panel, { showPanel, hidePanel, switchPanelTab, newTerminal, toggleTerminal, setProblems, updateProblemsStatus, activeTerminal: () => activeTerm });
window.toggleTerminal = toggleTerminal;

/* wire up */
$$('.panel-tab').forEach(b => b.onclick = () => { showPanel(); switchPanelTab(b.dataset.panel); });
$('#btn-term-new').onclick = () => { showPanel(); switchPanelTab('terminal'); newTerminal(false); };
$('#btn-term-select').onclick = pickShellTerminal;
$('#btn-term-split').onclick = () => { showPanel(); switchPanelTab('terminal'); newTerminal(true); };
$('#btn-term-kill').onclick = killTerminal;
$('#btn-panel-close').onclick = hidePanel;
$('#output-src').onchange = renderOutput;
$('#output-clear').onclick = () => { _logBuf.length = 0; renderOutput(); };
makeVResizer($('#panel-resizer'));
makeVResizer($('#panel-open-strip'));
makeHResizer($('#sidebar-resizer'), $('#sidebar'));
