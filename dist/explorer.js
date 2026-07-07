// CozyCode explorer — file tree, quick open, search.
'use strict';

async function openFolder(dir) {
	if (!dir) dir = await dialog.open({ directory: true });
	if (!dir) return;
	state.remote = null;
	$('#st-remote').classList.add('hidden');
	state.root = dir;
	state.expanded = new Set([dir]);
	state.fileList = null;
	localStorage.setItem('cozyLastFolder', dir);
	setWindowTitle(basename(dir));
	$('#explorer-title').textContent = basename(dir).toUpperCase();
	$('#no-folder').style.display = 'none';
	await renderTree();
	await loadWorkspaceConfig(dir);
	await Git.discoverRepos();
	Git.refreshScm();
	Ext.startExtHost();
	HotExit.restore();
}

// Interop with other IDEs: read .vscode/settings.json, .editorconfig,
// .vscode/extensions.json recommendations. .cursor/.claude/.github show in the tree.
async function loadWorkspaceConfig(dir) {
	// .vscode/settings.json -> editor settings
	try {
		const raw = await FS.readFile(dir + '\\.vscode\\settings.json');
		const vs = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
		const map = {
			'editor.tabSize': 'editor.tabSize', 'editor.fontSize': 'editor.fontSize',
			'editor.wordWrap': 'editor.wordWrap', 'editor.formatOnSave': 'editor.formatOnSave',
			'editor.fontFamily': 'editor.fontFamily',
		};
		let changed = false;
		for (const k in map) if (vs[k] !== undefined) { state.settings[k] = vs[k]; changed = true; }
		if (changed) { applyEditorSettings(); toast('Applied .vscode/settings.json', 2000); }
	} catch { /* none */ }

	// .editorconfig -> indent
	try {
		const ec = await FS.readFile(dir + '\\.editorconfig');
		const size = ec.match(/indent_size\s*=\s*(\d+)/);
		const style = ec.match(/indent_style\s*=\s*(tab|space)/);
		if (size) state.settings['editor.tabSize'] = +size[1];
		applyEditorSettings();
	} catch { /* none */ }

	// .vscode/extensions.json recommendations -> stash for Extensions view
	try {
		const rec = JSON.parse(await FS.readFile(dir + '\\.vscode\\extensions.json'));
		state.workspaceRecommend = rec.recommendations || [];
	} catch { state.workspaceRecommend = []; }
}

function setWindowTitle(name) {
	const t = (state.remote ? '[SSH] ' : '') + name + ' - CozyCode';
	document.title = t;
	$('#tb-title').textContent = t;
}

async function renderTree() {
	const tree = $('#tree');
	tree.innerHTML = '';
	if (!state.root) return;
	await renderDir(state.root, tree, 0);
}

async function renderDir(dir, container, depth) {
	let entries;
	try { entries = await FS.listDir(dir); } catch (e) { return; }
	for (const e of entries) {
		if (e.name === '.git') continue;
		const item = document.createElement('div');
		item.className = 'tree-item';
		item.style.paddingLeft = (depth * 10 + 4) + 'px';
		const open = state.expanded.has(e.path);
		const twist = document.createElement('span');
		twist.className = e.is_dir ? `twist codicon codicon-chevron-${open ? 'down' : 'right'}` : 'twist';
		item.appendChild(twist);
		item.appendChild(fileIconImg(e.name, e.is_dir, open));
		const label = document.createElement('span');
		label.textContent = e.name;
		item.appendChild(label);
		container.appendChild(item);
		if (e.is_dir) {
			const childBox = document.createElement('div');
			container.appendChild(childBox);
			if (open) await renderDir(e.path, childBox, depth + 1);
			item.onclick = async () => {
				if (state.expanded.has(e.path)) {
					state.expanded.delete(e.path); childBox.innerHTML = '';
					twist.className = 'twist codicon codicon-chevron-right';
				} else {
					state.expanded.add(e.path);
					twist.className = 'twist codicon codicon-chevron-down';
					await renderDir(e.path, childBox, depth + 1);
				}
			};
		} else {
			// single click = preview (VSCode), double click = pin (keep open)
			item.onclick = () => {
				$$('.tree-item.selected').forEach(x => x.classList.remove('selected'));
				item.classList.add('selected');
				openFile(e.path, { preview: true });
			};
			item.ondblclick = () => pinFile(e.path);
			item.oncontextmenu = ev => { ev.preventDefault(); fileContextMenu(e, ev.clientX, ev.clientY); };
		}
		if (e.is_dir) item.oncontextmenu = ev => { ev.preventDefault(); dirContextMenu(e, item.nextElementSibling, depth, ev.clientX, ev.clientY); };
	}
}

/* ---- context menus ---- */
function fileContextMenu(e, x, y) {
	const repo = Git.repoOf ? Git.repoOf(e.path) : null;
	contextMenu(x, y, [
		{ label: 'Open', run: () => pinFile(e.path) },
		{ label: 'Open to the Side', key: 'Ctrl+Enter', run: () => openFile(e.path, { preview: false }) },
		'-',
		{ label: 'Add File to Chat', run: () => Claude.addFileToChat && Claude.addFileToChat(e.path) },
		'-',
		{ label: 'Copy Path', key: 'Shift+Alt+C', run: () => navigator.clipboard.writeText(e.path) },
		{ label: 'Copy Relative Path', run: () => navigator.clipboard.writeText(state.root ? e.path.replace(state.root, '').replace(/^[\\/]/, '') : e.path) },
		'-',
		{ label: 'Rename...', key: 'F2', run: () => renameEntry(e) },
		{ label: 'Delete', key: 'Del', run: () => deleteEntry(e) },
	]);
}
function dirContextMenu(e, childBox, depth, x, y) {
	contextMenu(x, y, [
		{ label: 'New File...', run: () => { expandDir(e, childBox, depth); inlineCreate(childBox, depth + 1, false, e.path); } },
		{ label: 'New Folder...', run: () => { expandDir(e, childBox, depth); inlineCreate(childBox, depth + 1, true, e.path); } },
		'-',
		{ label: 'Copy Path', run: () => navigator.clipboard.writeText(e.path) },
		'-',
		{ label: 'Rename...', key: 'F2', run: () => renameEntry(e) },
		{ label: 'Delete', key: 'Del', run: () => deleteEntry(e) },
	]);
}

async function expandDir(e, childBox, depth) {
	if (!state.expanded.has(e.path)) { state.expanded.add(e.path); await renderDir(e.path, childBox, depth + 1); }
}

async function deleteEntry(e) {
	if (!(await confirmDialog(`Delete '${e.name}'?`, 'This cannot be undone.'))) return;
	try { state.remote ? await invoke('ssh_exec', { id: state.remote.id, cmd: `rm -rf ${JSON.stringify(e.path)}` }) : await invoke('delete_path', { path: e.path }); }
	catch (err) { toast(err); return; }
	state.fileList = null; renderTree();
}
async function renameEntry(e) {
	const val = await nativePrompt('Rename', e.name);
	if (!val || val === e.name) return;
	const dir = e.path.slice(0, e.path.length - e.name.length);
	try { await invoke('rename_path', { from: e.path, to: dir + val }); } catch (err) { toast(err); return; }
	state.fileList = null; renderTree();
}

// inline create: add a tree row with an <input> to type the name directly
function inlineCreate(container, depth, isDir, parentPath) {
	const row = document.createElement('div');
	row.className = 'tree-item';
	row.style.paddingLeft = (depth * 10 + 4) + 'px';
	row.innerHTML = `<span class="twist"></span>`;
	row.appendChild(fileIconImg(isDir ? 'newfolder' : 'newfile', isDir));
	const input = document.createElement('input');
	input.className = 'tree-input';
	container.prepend(row);
	row.appendChild(input);
	input.focus();
	let done = false;
	const submit = async () => {
		if (done) return; done = true;
		const name = input.value.trim();
		row.remove();
		if (!name) return;
		const p = joinPath(parentPath || state.root, name);
		try {
			if (isDir) { state.remote ? await invoke('ssh_exec', { id: state.remote.id, cmd: `mkdir -p ${JSON.stringify(p)}` }) : await invoke('create_dir', { path: p }); }
			else { state.remote ? await FS.writeFile(p, '') : await invoke('create_file', { path: p }); }
		} catch (e) { toast(e); return; }
		state.fileList = null;
		await renderTree();
		if (!isDir) openFile(p);
	};
	input.onkeydown = ev => { if (ev.key === 'Enter') submit(); if (ev.key === 'Escape') { done = true; row.remove(); } };
	input.onblur = submit;
}

async function newFile() { if (state.root) inlineCreate($('#tree'), 0, false, state.root); }
async function newFolder() { if (state.root) inlineCreate($('#tree'), 0, true, state.root); }

/* ================= search ================= */
const searchOpts = { regex: false, case: false };
async function runSearch() {
	if (!state.root) return;
	const q = $('#search-input').value;
	const box = $('#search-results');
	if (state.remote) {
		box.innerHTML = '<div class="search-file">Remote search via grep...</div>';
		try {
			const out = await invoke('ssh_exec', { id: state.remote.id, cmd: `grep -rniI --line-number --include='*' -- ${JSON.stringify(q)} ${JSON.stringify(state.root)} | head -500` });
			renderGrepLines(out, box);
		} catch (e) { box.innerHTML = `<div class="search-file">${esc(String(e))}</div>`; }
		return;
	}
	box.innerHTML = '<div class="search-file">Searching...</div>';
	let results;
	try { results = await invoke('search_text', { root: state.root, query: q, regex: searchOpts.regex, case: searchOpts.case }); }
	catch (e) { box.innerHTML = `<div class="search-file">${esc(String(e))}</div>`; return; }
	box.innerHTML = '';
	let lastFile = null;
	for (const m of results) {
		if (m.path !== lastFile) {
			lastFile = m.path;
			const f = document.createElement('div');
			f.className = 'search-file';
			f.appendChild(fileIconImg(basename(m.path)));
			const s = document.createElement('span');
			s.textContent = m.path.replace(state.root, '').replace(/^[\\/]/, '');
			f.appendChild(s);
			box.appendChild(f);
		}
		const r = document.createElement('div');
		r.className = 'search-match';
		r.textContent = `${m.line}: ${m.text}`;
		r.onclick = async () => {
			await openFile(m.path);
			state.editor.revealLineInCenter(m.line);
			state.editor.setPosition({ lineNumber: m.line, column: 1 });
		};
		box.appendChild(r);
	}
	if (!results.length) box.innerHTML = '<div class="search-file">No results</div>';
}

function renderGrepLines(out, box) {
	box.innerHTML = '';
	for (const line of out.split('\n')) {
		const m = line.match(/^(.*?):(\d+):(.*)$/);
		if (!m) continue;
		const r = document.createElement('div');
		r.className = 'search-match';
		r.textContent = `${basename(m[1])}:${m[2]}: ${m[3].trim().slice(0, 200)}`;
		r.title = m[1];
		r.onclick = async () => { await openFile(m[1]); state.editor.revealLineInCenter(+m[2]); state.editor.setPosition({ lineNumber: +m[2], column: 1 }); };
		box.appendChild(r);
	}
	if (!box.childElementCount) box.innerHTML = '<div class="search-file">No results</div>';
}

/* ================= quick open (Ctrl+P) ================= */
async function quickOpen() {
	if (!state.root) { Settings.commandPalette(); return; }
	if (!state.fileList) {
		try {
			if (state.remote) {
				const out = await invoke('ssh_exec', { id: state.remote.id, cmd: `cd ${JSON.stringify(state.root)} && find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | head -20000` });
				state.fileList = out.split('\n').map(f => f.replace(/^\.\//, '')).filter(Boolean);
			} else {
				state.fileList = await invoke('list_files', { root: state.root });
			}
		} catch { state.fileList = []; }
	}
	$('#palette')._mode = 'files';
	Settings.showPalette(state.fileList.map(f => ({
		label: f, fileIcon: basename(f),
		run: () => openFile(joinPath(state.root, f.replace(/\//g, state.remote ? '/' : '\\'))),
	})), 'Search files by name (type > for commands)');
}

async function replaceAll() {
	if (!state.root || state.remote) { toast('Replace: local workspace only'); return; }
	const find = $('#search-input').value, replace = $('#replace-input').value;
	if (!find) return;
	if (!(await confirmDialog(`Replace all "${find}" with "${replace}"?`, 'Applies across the workspace. This cannot be undone.'))) return;
	try {
		const n = await invoke('search_replace', { root: state.root, find, replace, regex: searchOpts.regex, case: searchOpts.case });
		toast(`Replaced in ${n} file(s)`);
		// reload any open tabs whose content changed on disk
		for (const t of state.tabs) if (t.kind === 'file' && t.path && !t.dirty) { try { t.model.setValue(await FS.readFile(t.path)); } catch { } }
		runSearch();
	} catch (e) { toast('Replace failed: ' + e); }
}

// wire search toggles + replace
$('#search-case').onclick = () => { searchOpts.case = !searchOpts.case; $('#search-case').classList.toggle('on', searchOpts.case); runSearch(); };
$('#search-regex').onclick = () => { searchOpts.regex = !searchOpts.regex; $('#search-regex').classList.toggle('on', searchOpts.regex); runSearch(); };
$('#replace-all').onclick = replaceAll;
$('#replace-input').addEventListener('keydown', e => { if (e.key === 'Enter') replaceAll(); });

Object.assign(Explorer, { openFolder, renderTree, runSearch });
window.openFolder = openFolder;
window.newFile = newFile;
window.newFolder = newFolder;
window.quickOpen = quickOpen;
window.runSearch = runSearch;
window.setWindowTitle = setWindowTitle;
