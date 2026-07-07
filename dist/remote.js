// CozyCode Remote SSH — connect, browse & edit files over sftp; realtime save to remote.
'use strict';

// stored connections: { name, host, port, user, authType, keyPath, password, defaultPath, saveMode }
function loadConns() { try { return JSON.parse(localStorage.getItem('cozySshConns') || '[]'); } catch { return []; } }
function saveConns(list) { localStorage.setItem('cozySshConns', JSON.stringify(list)); }

function renderView() {
	const box = $('#ssh-list');
	box.innerHTML = '';
	const conns = loadConns();
	if (!conns.length) {
		box.innerHTML = '<div class="ssh-item"><span class="dim" style="padding:8px">No SSH connections. Click + to add.</span></div>';
	}
	for (const c of conns) {
		const item = document.createElement('div');
		item.className = 'ssh-item';
		item.innerHTML = `<span class="codicon codicon-vm"></span><div><div>${esc(c.name || c.host)}</div><div class="dim">${esc(c.user)}@${esc(c.host)}:${c.port}</div></div>` +
			`<span class="view-actions">` +
			`<button data-a="edit" title="Edit"><span class="codicon codicon-edit"></span></button>` +
			`<button data-a="del" title="Delete"><span class="codicon codicon-trash"></span></button>` +
			`</span>`;
		item.querySelector('[data-a=edit]').onclick = e => { e.stopPropagation(); editConn(c); };
		item.querySelector('[data-a=del]').onclick = e => { e.stopPropagation(); const list = loadConns().filter(x => x !== c && x.name !== c.name); saveConns(list); renderView(); };
		item.onclick = () => connect(c);
		box.appendChild(item);
	}
	if (state.remote) {
		const dis = document.createElement('button');
		dis.className = 'primary';
		dis.style.margin = '8px 12px';
		dis.style.width = 'calc(100% - 24px)';
		dis.textContent = 'Disconnect (' + state.remote.host + ')';
		dis.onclick = disconnect;
		box.appendChild(dis);
	}
}

function editConn(existing) {
	openUiTab('ssh-edit', existing ? 'Edit SSH' : 'New SSH', el => {
		const c = existing || { port: 22, authType: 'key', saveMode: 'remote', defaultPath: '~' };
		el.innerHTML = `<h2>SSH Connection</h2>`;
		const fields = [
			['Name', 'name', 'text', c.name || ''],
			['Host', 'host', 'text', c.host || ''],
			['Port', 'port', 'number', c.port || 22],
			['User', 'user', 'text', c.user || ''],
			['Auth type', 'authType', 'select', c.authType || 'key', ['key', 'password']],
			['Private key path', 'keyPath', 'text', c.keyPath || ''],
			['Key passphrase / Password', 'password', 'password', c.password || ''],
			['Default path (cwd on connect)', 'defaultPath', 'text', c.defaultPath || '~'],
			['Save mode', 'saveMode', 'select', c.saveMode || 'remote', ['remote', 'local', 'both']],
		];
		const inputs = {};
		for (const [label, key, type, val, opts] of fields) {
			const row = document.createElement('div');
			row.className = 'set-row';
			if (type === 'select') {
				row.innerHTML = `<label>${label}</label><select>${opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
			} else {
				row.innerHTML = `<label>${label}</label><input type="${type}" value="${esc(val)}">`;
			}
			el.appendChild(row);
			inputs[key] = row.querySelector('input,select');
		}
		const note = document.createElement('div');
		note.className = 'desc';
		note.style.margin = '8px 0';
		note.innerHTML = 'Save mode: <b>remote</b> = write back over SFTP (realtime), <b>local</b> = cache to disk, <b>both</b> = save both places.';
		el.appendChild(note);
		const save = document.createElement('button');
		save.className = 'set-btn';
		save.textContent = 'Save Connection';
		save.onclick = () => {
			const obj = {}; for (const k in inputs) obj[k] = inputs[k].value;
			obj.port = +obj.port || 22;
			const list = loadConns().filter(x => existing ? x !== existing : true);
			list.push(obj);
			saveConns(list);
			toast('Saved connection ' + obj.name);
			closeTab('ssh-edit');
			switchView('remote');
		};
		el.appendChild(save);
	});
}

async function connect(c) {
	toast('Connecting to ' + c.host + '...', 15000);
	try {
		const home = await invoke('ssh_connect', {
			id: c.name || c.host,
			auth: {
				host: c.host, port: +c.port || 22, user: c.user,
				key_path: c.authType === 'key' ? c.keyPath : null,
				password: (c.authType === 'password' || c.keyPath) ? c.password : (c.password || null),
			},
		});
		let path = c.defaultPath && c.defaultPath !== '~' ? c.defaultPath : (home || '/root');
		state.remote = { id: c.name || c.host, host: c.host, path, conn: c };
		state.root = path;
		state.repos = [];
		state.fileList = null;
		state.expanded = new Set([path]);
		setWindowTitle(basename(path) + ' (' + c.host + ')');
		$('#explorer-title').textContent = 'SSH: ' + esc(c.host);
		$('#no-folder').style.display = 'none';
		$('#st-remote').classList.remove('hidden');
		$('#st-remote').innerHTML = `<span class="codicon codicon-remote"></span> SSH: ${esc(c.host)}`;
		switchView('explorer');
		await Explorer.renderTree();
		Git.updateBranchStatus();
		toast('Connected to ' + c.host);
	} catch (e) { toast('SSH connect failed: ' + e, 6000); }
}

async function disconnect() {
	if (!state.remote) return;
	await invoke('ssh_disconnect', { id: state.remote.id });
	state.remote = null;
	$('#st-remote').classList.add('hidden');
	toast('Disconnected');
	renderView();
}

// realtime save handled in core saveActive via FS.writeFile; both-mode extra local copy:
async function afterRemoteSave(path, content) {
	const mode = state.remote && state.remote.conn.saveMode;
	if (mode === 'both' || mode === 'local') {
		try {
			const localDir = (await invoke('settings_read').then(JSON.parse).catch(() => ({})))['remote.localCache'] || '';
			if (localDir) await invoke('write_file', { path: localDir + '\\' + basename(path), content });
		} catch { /* ignore */ }
	}
}

Object.assign(Remote, { renderView, connect, disconnect, editConn, afterRemoteSave });
$('#btn-ssh-add').onclick = () => editConn(null);
$('#st-remote').onclick = () => switchView('remote');
