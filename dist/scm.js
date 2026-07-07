// CozyCode source control — multi-repo, timeline, diff, AI commit, PR helpers.
'use strict';

function repoOf(path) {
	if (!path) return null;
	const p = String(path).toLowerCase().replace(/\//g, '\\');
	let best = null;
	for (const r of state.repos) {
		const rp = r.path.toLowerCase().replace(/\//g, '\\');
		if ((p === rp || p.startsWith(rp + '\\')) && (!best || rp.length > best.path.length)) best = r;
	}
	return best;
}
const relPath = (repo, path) => path.slice(repo.length + 1).replace(/\\/g, '/');

async function discoverRepos() {
	state.repos = [];
	if (!state.root || state.remote) { updateBranchStatus(); return; }
	const paths = await invoke('find_repos', { root: state.root });
	for (const p of paths) {
		const info = await invoke('git_info', { repo: p });
		if (info.is_repo) state.repos.push({ path: p, name: basename(p), branch: info.branch });
	}
	updateBranchStatus();
}

function updateBranchStatus() {
	const el = $('#st-branch');
	const activeTab = findTab(state.active);
	const repo = (activeTab && activeTab.path && repoOf(activeTab.path)) || state.repos[0];
	if (repo) {
		el.innerHTML = `<span class="codicon codicon-git-branch"></span> ${esc(repo.branch)}` +
			(state.repos.length > 1 ? ` <span style="opacity:.7">(${esc(repo.name)})</span>` : '');
		el._repo = repo;
		$('#st-sync').classList.remove('hidden');
	} else { el.textContent = ''; el._repo = null; $('#st-sync').classList.add('hidden'); }
}

/* ---------- timeline (per file) ---------- */
async function loadTimeline(path) {
	const section = $('#timeline-section');
	const repo = repoOf(path);
	if (!repo) { section.classList.add('hidden'); return; }
	section.classList.remove('hidden');
	const rel = relPath(repo.path, path);
	let commits;
	try { commits = await invoke('git_log', { repo: repo.path, path: rel, limit: 30 }); }
	catch { section.classList.add('hidden'); return; }
	const list = $('#timeline-list');
	list.innerHTML = '';
	for (const c of commits) {
		const d = document.createElement('div');
		d.className = 'tl-item';
		d.innerHTML = `<span class="tl-msg">${esc(c.message)}</span><span class="tl-meta">${esc(c.author)}, ${esc(c.date)} (${esc(c.short)})</span>`;
		d.onclick = async () => {
			let old = '';
			try { old = await invoke('git_file_at', { repo: repo.path, rev: c.hash, path: rel }); } catch { /* new */ }
			const cur = findTab(path) ? findTab(path).model.getValue() : await FS.readFile(path);
			openDiffTab(`tl:${c.short}:${path}`, `${basename(path)} (${c.short})`, old, cur, langOf(path));
		};
		list.appendChild(d);
	}
	if (!commits.length) list.innerHTML = '<div class="tl-item"><span class="tl-meta">No history</span></div>';
}

/* ---------- SCM view: REPOSITORIES / CHANGES / GRAPH (VSCode layout) ---------- */
function activeRepo() {
	return state.repos.find(r => r.path === state.activeRepo) || state.repos[0] || null;
}

async function refreshScm() {
	if (!state.repos.length) {
		$('#scm-repos-list').innerHTML = '<div class="scm-empty">No source control providers registered.</div>';
		$('#scm-changes').innerHTML = '';
		$('#scm-graph').innerHTML = '';
		$('#repos-count').textContent = '';
		$('#scm-badge').classList.add('hidden');
		return;
	}
	if (!activeRepo()) state.activeRepo = state.repos[0].path;

	// refresh branch + status for all repos (for the repo list badges + total)
	let total = 0;
	const statuses = {};
	for (const repo of state.repos) {
		try { repo.branch = (await invoke('git_info', { repo: repo.path })).branch; } catch { }
		try { statuses[repo.path] = await invoke('git_status', { repo: repo.path }); } catch { statuses[repo.path] = []; }
		total += statuses[repo.path].length;
	}
	renderReposList(statuses);
	renderChanges(activeRepo(), statuses[activeRepo().path] || []);
	renderGraph(activeRepo());
	updateBranchStatus();
	$('#repos-count').textContent = state.repos.length;
	const badge = $('#scm-badge');
	badge.textContent = total;
	badge.classList.toggle('hidden', total === 0);
}

function renderReposList(statuses) {
	const box = $('#scm-repos-list');
	box.innerHTML = '';
	for (const repo of state.repos) {
		const count = (statuses[repo.path] || []).length;
		const row = document.createElement('div');
		row.className = 'repo-row' + (repo.path === state.activeRepo ? ' selected' : '');
		row.innerHTML =
			`<span class="codicon codicon-repo"></span>` +
			`<span class="repo-name">${esc(repo.name)}</span>` +
			`<span class="repo-branch"><span class="codicon codicon-git-branch"></span> ${esc(repo.branch)}</span>` +
			(count ? `<span class="repo-count">${count}</span>` : '') +
			`<span class="repo-acts">` +
			`<button title="Pull" data-a="pull"><span class="codicon codicon-arrow-down"></span></button>` +
			`<button title="Push" data-a="push"><span class="codicon codicon-arrow-up"></span></button>` +
			`<button title="Refresh" data-a="refresh"><span class="codicon codicon-refresh"></span></button>` +
			`<button title="More..." data-a="more"><span class="codicon codicon-ellipsis"></span></button>` +
			`</span>`;
		row.querySelector('[data-a=pull]').onclick = e => { e.stopPropagation(); gitNet(repo, 'git_pull'); };
		row.querySelector('[data-a=push]').onclick = e => { e.stopPropagation(); gitNet(repo, 'git_push'); };
		row.querySelector('[data-a=refresh]').onclick = e => { e.stopPropagation(); refreshScm(); };
		row.querySelector('[data-a=more]').onclick = e => { e.stopPropagation(); repoMenu(repo); };
		row.onclick = () => { state.activeRepo = repo.path; refreshScm(); };
		box.appendChild(row);
	}
}

function renderChanges(repo, files) {
	const box = $('#scm-changes');
	box.innerHTML = '';
	if (!repo) return;

	const msgWrap = document.createElement('div');
	msgWrap.className = 'commit-box';
	const msg = document.createElement('textarea');
	msg.className = 'commit-msg';
	msg.rows = 1;
	msg.placeholder = `Message (Ctrl+Enter to commit on "${repo.branch}")`;
	msg.value = repo._draft || '';
	msg.oninput = () => { repo._draft = msg.value; };
	msg.onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) doCommit(); };
	repo._msgEl = msg;
	const gen = document.createElement('button');
	gen.className = 'commit-gen';
	gen.title = 'Generate Commit Message (AI)';
	gen.innerHTML = '<span class="codicon codicon-sparkle"></span>';
	gen.onclick = () => Settings.generateCommitMessage(repo, msg);
	msgWrap.appendChild(msg);
	msgWrap.appendChild(gen);
	box.appendChild(msgWrap);

	async function doCommit() {
		const m = msg.value.trim();
		if (!m) { toast('Commit message required'); return; }
		try {
			if (!files.some(f => f.staged)) await invoke('git_stage_all', { repo: repo.path });
			await invoke('git_commit', { repo: repo.path, message: m });
			repo._draft = ''; msg.value = '';
			toast('Committed on ' + repo.branch);
			refreshScm();
		} catch (e) { toast('Commit failed: ' + e); }
	}

	// Commit split-button (Commit | dropdown of more actions)
	const commitRow = document.createElement('div');
	commitRow.className = 'commit-split';
	const commitBtn = document.createElement('button');
	commitBtn.className = 'primary commit-main';
	commitBtn.innerHTML = '<span class="codicon codicon-check"></span> Commit';
	commitBtn.onclick = doCommit;
	const caret = document.createElement('button');
	caret.className = 'primary commit-caret';
	caret.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
	caret.onclick = () => Settings.showPalette([
		{ label: 'Commit', icon: 'check', run: doCommit },
		{ label: 'Commit & Push', icon: 'arrow-up', run: async () => { await doCommit(); gitNet(repo, 'git_push'); } },
		{ label: 'Stage All Changes', icon: 'add', run: async () => { await invoke('git_stage_all', { repo: repo.path }); refreshScm(); } },
		{ label: 'Merge Branch...', icon: 'git-merge', run: () => mergeBranch(repo) },
		{ label: 'Create Pull Request', icon: 'git-pull-request', run: () => Settings.createPR(repo) },
	], 'Commit actions');
	commitRow.appendChild(commitBtn);
	commitRow.appendChild(caret);
	box.appendChild(commitRow);

	for (const [title, list, staged] of [
		['Staged Changes', files.filter(f => f.staged), true],
		['Changes', files.filter(f => !f.staged), false],
	]) {
		if (!list.length) continue;
		const g = document.createElement('div');
		g.className = 'scm-group-title';
		g.innerHTML = `<span>${title}</span><span class="scm-sec-count">${list.length}</span>`;
		box.appendChild(g);
		for (const f of list) box.appendChild(renderScmItem(repo, f));
	}
	if (!files.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'scm-empty', textContent: 'No changes' }));
}

// GRAPH: commit history with a single-lane graph rail (dots + line), branch tag on HEAD
async function renderGraph(repo) {
	const box = $('#scm-graph');
	box.innerHTML = '';
	if (!repo) return;
	let commits;
	try { commits = await invoke('git_log', { repo: repo.path, path: null, limit: 80 }); }
	catch { box.innerHTML = '<div class="scm-empty">No history</div>'; return; }
	commits.forEach((c, i) => {
		const row = document.createElement('div');
		row.className = 'graph-row';
		const rail = `<span class="graph-rail"><span class="graph-dot"></span>${i < commits.length - 1 ? '<span class="graph-line"></span>' : ''}</span>`;
		const tag = i === 0 ? `<span class="graph-tag">${esc(repo.branch)}</span>` : '';
		row.innerHTML = rail +
			`<span class="graph-msg">${tag}${esc(c.message)}</span>` +
			`<span class="graph-meta">${esc(c.author)}, ${esc(c.date)}</span>`;
		row.title = `${c.short}  ${c.author}\n${c.message}`;
		row.onclick = async () => {
			const text = await invoke('git_show_commit', { repo: repo.path, hash: c.hash });
			openTextTab(`commit:${c.hash}`, `${c.short} ${c.message.slice(0, 30)}`, text, 'diff');
		};
		box.appendChild(row);
	});
	if (!commits.length) box.innerHTML = '<div class="scm-empty">No history</div>';
}

function repoMenu(repo) {
	Settings.showPalette([
		{ label: 'Pull', icon: 'arrow-down', run: () => gitNet(repo, 'git_pull') },
		{ label: 'Push', icon: 'arrow-up', run: () => gitNet(repo, 'git_push') },
		{ label: 'Sync (Pull + Push)', icon: 'sync', run: async () => { await gitNet(repo, 'git_pull'); gitNet(repo, 'git_push'); } },
		{ label: 'Checkout to...', icon: 'git-branch', run: () => pickBranch(repo) },
		{ label: 'Merge Branch...', icon: 'git-merge', run: () => mergeBranch(repo) },
		{ label: 'Stage All Changes', icon: 'add', run: async () => { await invoke('git_stage_all', { repo: repo.path }); refreshScm(); } },
		{ label: 'Create Pull Request', icon: 'git-pull-request', run: () => Settings.createPR(repo) },
	], repo.name + ' actions');
}

function renderScmItem(repo, f) {
	const row = document.createElement('div');
	row.className = 'scm-item';
	row.appendChild(fileIconImg(basename(f.path)));
	const name = document.createElement('span');
	name.className = 'scm-name';
	name.textContent = f.path;
	name.title = f.path;
	row.appendChild(name);
	const mk = (icon, title, fn) => {
		const b = document.createElement('button');
		b.className = 'inline-act scm-act';
		b.title = title;
		b.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
		b.onclick = async e => { e.stopPropagation(); await fn(); refreshScm(); };
		return b;
	};
	if (f.staged) row.appendChild(mk('remove', 'Unstage', () => invoke('git_unstage', { repo: repo.path, path: f.path })));
	else {
		row.appendChild(mk('discard', 'Discard Changes', async () => {
			if (!confirm(`Discard changes in ${f.path}? This cannot be undone.`)) return;
			await invoke('git_discard', { repo: repo.path, path: f.path });
		}));
		row.appendChild(mk('add', 'Stage', () => invoke('git_stage', { repo: repo.path, path: f.path })));
	}
	const letter = document.createElement('span');
	letter.className = `scm-letter letter-${f.status}`;
	letter.textContent = f.status;
	row.appendChild(letter);
	row.onclick = () => openScmDiff(repo, f);
	return row;
}

async function openScmDiff(repo, f) {
	const lang = langOf(f.path);
	const abs = repo.path + '\\' + f.path.replace(/\//g, '\\');
	let oldText = '', newText = '';
	if (f.staged) {
		try { oldText = await invoke('git_file_at', { repo: repo.path, rev: 'HEAD', path: f.path }); } catch { /* new */ }
		try { newText = await invoke('git_file_at', { repo: repo.path, rev: '', path: f.path }); } catch { /* deleted */ }
	} else {
		try { oldText = await invoke('git_file_at', { repo: repo.path, rev: '', path: f.path }); } catch { /* untracked */ }
		try { newText = await invoke('read_file', { path: abs }); } catch { /* deleted */ }
	}
	openDiffTab(`scm:${f.staged ? 'i' : 'w'}:${abs}`, `${basename(f.path)} (${f.staged ? 'Index' : 'Working Tree'})`, oldText, newText, lang);
}

async function gitNet(repo, cmd) {
	toast(cmd.replace('git_', '') + '...', 10000);
	try { toast((await invoke(cmd, { repo: repo.path })) || 'Done'); refreshScm(); }
	catch (e) { toast(String(e)); }
}

async function pickBranch(repo) {
	if (!repo) return;
	let branches;
	try { branches = await invoke('git_branches', { repo: repo.path }); } catch (e) { toast(e); return; }
	Settings.showPalette(branches.map(b => ({
		label: b, icon: 'git-branch', detail: b === repo.branch ? 'current' : '',
		run: async () => {
			try { await invoke('git_checkout', { repo: repo.path, branch: b }); toast('Checked out ' + b); await discoverRepos(); refreshScm(); renderTree(); }
			catch (e) { toast('Checkout failed: ' + e); }
		},
	})), 'Checkout branch (' + repo.name + ')');
}

async function mergeBranch(repo) {
	if (!repo) return;
	let branches;
	try { branches = await invoke('git_branches', { repo: repo.path }); } catch (e) { toast(e); return; }
	Settings.showPalette(branches.filter(b => b !== repo.branch).map(b => ({
		label: b, icon: 'git-merge', detail: `merge into ${repo.branch}`,
		run: async () => { try { toast(await invoke('git_merge', { repo: repo.path, branch: b }) || 'Merged'); refreshScm(); } catch (e) { toast('Merge: ' + e); } },
	})), `Merge branch into ${repo.branch}`);
}

$('#timeline-header').onclick = () => {
	const list = $('#timeline-list'), chev = $('#timeline-header .codicon');
	state.timelineOpen = list.classList.contains('hidden');
	list.classList.toggle('hidden', !state.timelineOpen);
	chev.className = `codicon codicon-chevron-${state.timelineOpen ? 'down' : 'right'}`;
	// load history for the active file when the user expands it
	if (state.timelineOpen) {
		const tab = findTab(state.active);
		if (tab && tab.path) Git.loadTimeline(tab.path);
	}
};

// collapse/expand SCM sections (REPOSITORIES / CHANGES / GRAPH)
$$('.scm-sec-header').forEach(h => h.onclick = () => {
	const body = h.nextElementSibling;
	const hide = !body.classList.contains('hidden');
	body.classList.toggle('hidden', hide);
	h.querySelector('.codicon').className = `codicon codicon-chevron-${hide ? 'right' : 'down'}`;
});
$('#btn-scm-commit-all').onclick = () => { const r = activeRepo(); if (r && r._msgEl) { r._msgEl.focus(); } };
$('#btn-scm-more').onclick = () => { const r = activeRepo(); if (r) repoMenu(r); };

Object.assign(Git, { repoOf, relPath, discoverRepos, updateBranchStatus, loadTimeline, refreshScm, gitNet, pickBranch });
