// CozyCode Claude AI panel — right sidebar. Two modes:
//  - Chat: Anthropic/OpenAI-compatible API (reuses AI settings), sees active file context.
//  - Claude Code: runs the `claude` CLI in a pty terminal inside the workspace.
'use strict';

const CHAT_SYSTEM =
	'You are Claude, a coding assistant embedded in the CozyCode editor. Be concise. ' +
	'When you show code, use fenced code blocks. You are given the active file for context when relevant.';

let auxOpen = false, auxMode = 'chat';
let chatHistory = []; // {role, content} — current session
let cliBound = false;

// ---- chat sessions: cache/log/restore all conversations ----
function loadSessions() { try { return JSON.parse(localStorage.getItem('cozyChatSessions') || '[]'); } catch { return []; } }
function saveSessions(s) { try { localStorage.setItem('cozyChatSessions', JSON.stringify(s.slice(-40))); } catch { } }
let sessions = loadSessions();
let curSessionId = localStorage.getItem('cozyChatCur') || null;

function currentSession() { return sessions.find(s => s.id === curSessionId); }
function persistCurrent() {
	let s = currentSession();
	if (!s) { s = { id: curSessionId || String(Date.now()), title: 'New Chat', history: [] }; curSessionId = s.id; sessions.push(s); localStorage.setItem('cozyChatCur', curSessionId); }
	s.history = chatHistory;
	if (chatHistory[0]) s.title = chatHistory[0].content.slice(0, 40) || 'New Chat';
	saveSessions(sessions);
}
function loadSession(id) {
	const s = sessions.find(x => x.id === id);
	if (!s) return;
	curSessionId = id; localStorage.setItem('cozyChatCur', id);
	chatHistory = s.history.slice();
	$('#chat-messages').innerHTML = '';
	for (const m of chatHistory) addMsg(m.role, m.content);
	updateContext();
}

function providerCfg() {
	const provider = state.settings['ai.provider'] || 'anthropic';
	const map = {
		anthropic: { base: 'https://api.anthropic.com', anthropic: true, model: 'claude-sonnet-4-5' },
		openai: { base: 'https://api.openai.com/v1', anthropic: false, model: 'gpt-4o-mini' },
		openrouter: { base: 'https://openrouter.ai/api/v1', anthropic: false, model: 'anthropic/claude-3.5-sonnet' },
		zai: { base: 'https://api.z.ai/api/paas/v4', anthropic: false, model: 'glm-4.6' },
		groq: { base: 'https://api.groq.com/openai/v1', anthropic: false, model: 'llama-3.3-70b-versatile' },
		ollama: { base: 'http://localhost:11434/v1', anthropic: false, model: 'qwen2.5-coder' },
		custom: { base: '', anthropic: false, model: '' },
	};
	const p = map[provider] || map.custom;
	return { base: state.settings['ai.baseUrl'] || p.base, anthropic: p.anthropic, model: state.settings['ai.model'] || p.model, key: state.settings['ai.apiKey'] || '' };
}

function toggleAux() { auxOpen ? closeAux() : openAux(); }
function openAux() {
	auxOpen = true;
	$('#aux').classList.remove('hidden');
	$('#aux-resizer').classList.remove('hidden');
	$('#tb-claude').classList.add('active');
	setMode(auxMode);
}
function closeAux() {
	auxOpen = false;
	$('#aux').classList.add('hidden');
	$('#aux-resizer').classList.add('hidden');
	$('#tb-claude').classList.remove('active');
}

function setMode(mode) {
	auxMode = mode;
	$$('.aux-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
	$('#aux-chat').classList.toggle('hidden', mode !== 'chat');
	$('#aux-cli').classList.toggle('hidden', mode !== 'cli');
	if (mode === 'chat') {
		// restore the last session's messages if the view is empty
		if (!$('#chat-messages').childElementCount && currentSession() && currentSession().history.length) loadSession(curSessionId);
		updateContext(); updateModelLabel(); $('#chat-input').focus();
	} else startClaudeCli();
}

/* ---------- context + attachments ---------- */
let attachments = []; // { kind:'file'|'selection'|'image', name, content?, dataUrl?, path? }

function activeFileContext() {
	const tab = findTab(state.active);
	if (!tab || tab.kind !== 'file' || !tab.path) return null;
	const sel = state.editor && state.editor.getSelection();
	const selText = sel && !sel.isEmpty() ? state.editor.getModel().getValueInRange(sel) : '';
	return { name: tab.name, path: tab.path, content: tab.model.getValue(), selection: selText };
}
function updateContext() {
	const ctx = activeFileContext();
	const el = $('#chat-ctxinfo');
	el.textContent = ctx ? (ctx.name + (ctx.selection ? ' (sel)' : '')) : '';
	renderAttachments();
}
function renderAttachments() {
	const box = $('#chat-attachments');
	box.innerHTML = '';
	attachments.forEach((a, i) => {
		const chip = document.createElement('span');
		chip.className = 'chat-chip';
		const icon = a.kind === 'image' ? 'file-media' : a.kind === 'selection' ? 'selection' : 'file';
		chip.innerHTML = `<span class="codicon codicon-${icon}"></span>${esc(a.name)}`;
		const x = document.createElement('button');
		x.innerHTML = '<span class="codicon codicon-close"></span>';
		x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
		chip.appendChild(x);
		box.appendChild(chip);
	});
}

async function attachFilePick() {
	const path = await dialog.open({ multiple: false });
	if (!path) return;
	const name = basename(path);
	if (mediaCat(path) === 'image') {
		try { const b64 = await invoke('read_file_base64', { path }); attachments.push({ kind: 'image', name, dataUrl: `data:${MIME[name.split('.').pop().toLowerCase()] || 'image/png'};base64,${b64}` }); }
		catch (e) { toast(e); return; }
	} else {
		try { attachments.push({ kind: 'file', name, path, content: await invoke('read_file', { path }) }); }
		catch (e) { toast(e); return; }
	}
	renderAttachments();
}

async function addFileToChat(path) {
	try {
		const content = await FS.readFile(path);
		attachments.push({ kind: 'file', name: basename(path), path, content });
		openAux(); setMode('chat'); renderAttachments();
		toast('Added ' + basename(path) + ' to chat', 2000);
	} catch (e) { toast(e); }
}

function addSelectionToChat() {
	const ctx = activeFileContext();
	if (!ctx || !ctx.selection) { toast('Select text in the editor first'); return; }
	attachments.push({ kind: 'selection', name: `${ctx.name}: focus`, content: ctx.selection, path: ctx.path });
	renderAttachments();
	openAux(); setMode('chat');
}

/* ---------- chat ---------- */
function addMsg(role, content) {
	const el = document.createElement('div');
	el.className = 'chat-msg ' + role;
	const r = document.createElement('div'); r.className = 'role'; r.textContent = role === 'user' ? 'You' : 'AI';
	const b = document.createElement('div'); b.className = 'bubble';
	b.innerHTML = renderMarkdown(content);
	el.appendChild(r); el.appendChild(b);
	$('#chat-messages').appendChild(el);
	$('#chat-messages').scrollTop = 1e9;
	return b;
}

// minimal, safe markdown: escape then re-apply code fences/inline code
function renderMarkdown(text) {
	let html = esc(text);
	html = html.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.replace(/^\n/, '')}</code></pre>`);
	html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
	return html;
}

// resolve @mentions in the text to workspace files, append their content
async function resolveMentions(text) {
	const mentions = [...text.matchAll(/@([^\s@]+)/g)].map(m => m[1]);
	let extra = '';
	for (const rel of [...new Set(mentions)]) {
		try {
			const abs = joinPath(state.root, rel.replace(/\//g, state.remote ? '/' : '\\'));
			const content = await FS.readFile(abs);
			extra += `\n\n@${rel}:\n\`\`\`\n${content.length > 12000 ? content.slice(0, 12000) + '\n...(truncated)' : content}\n\`\`\``;
		} catch { /* not a file */ }
	}
	return extra;
}

async function sendChat() {
	const input = $('#chat-input');
	const text = input.value.trim();
	if (!text && !attachments.length) return;
	const cfg = providerCfg();
	if (!cfg.key && !(cfg.base || '').includes('localhost')) { toast('Set an AI API key in Settings'); Settings.openSettings(); return; }
	input.value = '';
	input.style.height = 'auto';
	const shownAtt = attachments.slice();
	addMsg('user', text + (shownAtt.length ? '\n' + shownAtt.map(a => '[' + a.name + ']').join(' ') : ''));
	chatHistory.push({ role: 'user', content: text });

	// build the prompt: text + @mentions + attachments + active-file/selection context
	let prompt = text;
	prompt += await resolveMentions(text);
	const images = [];
	for (const a of shownAtt) {
		if (a.kind === 'image') images.push(a.dataUrl);
		else prompt += `\n\n[${a.kind === 'selection' ? 'Focus selection from ' : 'Attached '}${a.name}]:\n\`\`\`\n${(a.content || '').slice(0, 12000)}\n\`\`\``;
	}
	const ctx = activeFileContext();
	if (ctx && chatHistory.length === 1 && !text.includes('@')) {
		const body = ctx.content.length > 12000 ? ctx.content.slice(0, 12000) + '\n...(truncated)' : ctx.content;
		prompt = `Active file ${ctx.path}:\n\`\`\`\n${body}\n\`\`\`\n\n${prompt}`;
	}
	const convo = chatHistory.slice(-6, -1).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
	const full = convo ? convo + '\n\nUser: ' + prompt : prompt;

	attachments = []; renderAttachments();
	const bubble = addMsg('assistant', '...');
	try {
		const out = await invoke('ai_generate', {
			baseUrl: cfg.base, apiKey: cfg.key, model: cfg.model, anthropic: cfg.anthropic,
			system: CHAT_SYSTEM, prompt: full, images: images.length ? images : null,
		});
		bubble.innerHTML = renderMarkdown(out.trim());
		chatHistory.push({ role: 'assistant', content: out.trim() });
		persistCurrent();
		$('#chat-messages').scrollTop = 1e9;
	} catch (e) { bubble.innerHTML = renderMarkdown('Error: ' + e); }
	persistCurrent();
}

function newChat() { chatHistory = []; attachments = []; curSessionId = String(Date.now()); localStorage.setItem('cozyChatCur', curSessionId); $('#chat-messages').innerHTML = ''; renderAttachments(); updateContext(); }

function showSessions() {
	if (auxMode === 'cli') return; // cli sessions handled by tab bar
	const items = [{ label: 'New Chat', icon: 'add', run: newChat }];
	for (const s of sessions.slice().reverse()) items.push({ label: s.title || 'Chat', detail: `${s.history.length} msgs`, icon: 'comment', run: () => loadSession(s.id) });
	Settings.showPalette(items, 'Chat Sessions');
}

/* ---------- model picker (from the provider's model list) ---------- */
async function pickModel() {
	const cfg = providerCfg();
	toast('Loading models...', 3000);
	let models = [];
	try { models = await invoke('ai_models', { baseUrl: cfg.base, apiKey: cfg.key, anthropic: cfg.anthropic }); } catch (e) { /* provider may not list */ }
	if (!models.length) { models = [cfg.model, 'claude-sonnet-4-5', 'gpt-4o-mini', 'glm-4.6'].filter(Boolean); }
	Settings.showPalette(models.map(m => ({ label: m, icon: m === cfg.model ? 'check' : 'symbol-misc', run: () => { state.settings['ai.model'] = m; Settings.persistSettings && Settings.persistSettings(); updateModelLabel(); toast('Model: ' + m); } })), 'Select Model');
}
function updateModelLabel() { const b = $('#chat-model'); if (b) b.textContent = (providerCfg().model || 'model').split('/').pop().slice(0, 18); }

/* ---------- @ mention autocomplete ---------- */
let mentionActive = false, mentionSel = 0, mentionItems = [];
async function updateMention() {
	const input = $('#chat-input');
	const pos = input.selectionStart;
	const before = input.value.slice(0, pos);
	const m = before.match(/@([^\s@]*)$/);
	const pop = $('#mention-pop');
	if (!m || !state.root) { pop.classList.add('hidden'); mentionActive = false; return; }
	if (!state.fileList) { try { state.fileList = await invoke('list_files', { root: state.root }); } catch { state.fileList = []; } }
	const q = m[1].toLowerCase();
	mentionItems = state.fileList.filter(f => f.toLowerCase().includes(q)).slice(0, 8);
	if (!mentionItems.length) { pop.classList.add('hidden'); mentionActive = false; return; }
	mentionActive = true; mentionSel = 0;
	renderMention();
}
function renderMention() {
	const pop = $('#mention-pop');
	pop.innerHTML = '';
	mentionItems.forEach((f, i) => {
		const d = document.createElement('div');
		d.className = 'mention-item' + (i === mentionSel ? ' selected' : '');
		d.appendChild(fileIconImg(basename(f)));
		const s = document.createElement('span'); s.textContent = f; d.appendChild(s);
		d.onclick = () => pickMention(f);
		pop.appendChild(d);
	});
	pop.classList.remove('hidden');
}
function pickMention(f) {
	const input = $('#chat-input');
	const pos = input.selectionStart;
	const before = input.value.slice(0, pos).replace(/@([^\s@]*)$/, '@' + f + ' ');
	input.value = before + input.value.slice(pos);
	$('#mention-pop').classList.add('hidden');
	mentionActive = false;
	input.focus();
}

/* ---------- Claude Code CLI: multi-session, keep-alive (restore) ---------- */
const cliSessions = []; // { id, term, fit, box, ptyId, name }
let cliActive = null;

function bindCli() {
	if (cliBound) return;
	cliBound = true;
	listen('pty-output', e => { const s = cliSessions.find(s => s.ptyId === e.payload.id); if (s) s.term.write(e.payload.data); });
	listen('pty-exit', e => { const s = cliSessions.find(s => s.ptyId === e.payload); if (s) { s.term.write('\r\n[claude exited]\r\n'); s.ptyId = null; } });
}

async function startClaudeCli() {
	// terminals persist across open/close (restore) — just show existing ones
	if (cliSessions.length) { setActiveCli(cliActive || cliSessions[0]); renderCliTabs(); return; }
	const claudePath = await invoke('resolve_command', { name: 'claude' }).catch(() => null);
	if (!claudePath) {
		$('#cli-terms').innerHTML = `<div class="cli-install">
			<div class="codicon codicon-sparkle" style="font-size:32px;color:#d98a4b"></div>
			<div>Claude Code CLI is not installed.</div>
			<button class="set-btn" id="cli-install-btn">Install Claude Code</button>
			<div class="desc">Runs: npm i -g @anthropic-ai/claude-code</div>
		</div>`;
		$('#cli-install-btn').onclick = installClaude;
		$('#cli-tabs').innerHTML = '';
		return;
	}
	newCliSession(claudePath);
}

async function newCliSession(claudePath) {
	if (typeof Terminal === 'undefined') { toast('Terminal lib not loaded'); return; }
	bindCli();
	claudePath = claudePath || await invoke('resolve_command', { name: 'claude' }).catch(() => null);
	if (!claudePath) { toast('Claude Code CLI not found'); return; }
	const id = Date.now() + Math.floor(Math.random() * 999);
	const box = document.createElement('div');
	box.className = 'cli-term';
	$('#cli-terms').appendChild(box);
	const term = new Terminal({ fontSize: 12, theme: { background: '#1e1e1e' }, cursorBlink: true });
	const fit = new FitAddon.FitAddon();
	term.loadAddon(fit);
	term.open(box);
	fit.fit();
	const sess = { id, term, fit, box, ptyId: null, name: 'claude ' + (cliSessions.length + 1) };
	cliSessions.push(sess);
	term.onData(d => sess.ptyId && invoke('pty_write', { id: sess.ptyId, data: d }));
	term.onResize(({ cols, rows }) => sess.ptyId && invoke('pty_resize', { id: sess.ptyId, cols, rows }));
	new ResizeObserver(() => { if (cliActive === sess) fit.fit(); }).observe(box);
	try { sess.ptyId = await invoke('pty_spawn', { cwd: state.root || '', cols: term.cols, rows: term.rows, shell: claudePath, args: null }); }
	catch (e) { term.write('\r\nFailed to start Claude Code: ' + e + '\r\n'); }
	setActiveCli(sess);
	renderCliTabs();
}

function setActiveCli(sess) {
	cliActive = sess;
	cliSessions.forEach(s => s.box.classList.toggle('hidden', s !== sess));
	sess.fit.fit();
	sess.term.focus();
	renderCliTabs();
}

function killCliSession(sess) {
	if (sess.ptyId) invoke('pty_kill', { id: sess.ptyId });
	sess.box.remove();
	const i = cliSessions.indexOf(sess);
	cliSessions.splice(i, 1);
	if (cliActive === sess) { const n = cliSessions[i] || cliSessions[i - 1]; if (n) setActiveCli(n); else cliActive = null; }
	renderCliTabs();
	if (!cliSessions.length) startClaudeCli();
}

function renderCliTabs() {
	const bar = $('#cli-tabs');
	bar.innerHTML = '';
	for (const s of cliSessions) {
		const t = document.createElement('div');
		t.className = 'cli-tab' + (s === cliActive ? ' active' : '');
		t.innerHTML = `<span class="codicon codicon-terminal"></span><span>${esc(s.name)}</span>`;
		const k = document.createElement('button');
		k.className = 'cli-kill'; k.title = 'Kill Session';
		k.innerHTML = '<span class="codicon codicon-trash"></span>';
		k.onclick = ev => { ev.stopPropagation(); killCliSession(s); };
		t.appendChild(k);
		t.onclick = () => setActiveCli(s);
		bar.appendChild(t);
	}
	const add = document.createElement('button');
	add.className = 'cli-newtab'; add.title = 'New Claude Code Session';
	add.innerHTML = '<span class="codicon codicon-add"></span>';
	add.onclick = () => newCliSession();
	bar.appendChild(add);
}

// install Claude Code CLI in a terminal (visible so the user sees npm progress)
async function installClaude() {
	toast('Installing Claude Code CLI...', 4000);
	Panel.showPanel('terminal');
	await Panel.newTerminal(false);
	setTimeout(() => {
		const t = Panel.activeTerminal && Panel.activeTerminal();
		if (t && t.ptyId) invoke('pty_write', { id: t.ptyId, data: 'npm i -g @anthropic-ai/claude-code\r' });
	}, 800);
}

/* ---------- wiring ---------- */
$('#tb-claude').onclick = toggleAux;
$('#aux-close').onclick = closeAux;
$('#aux-clear').onclick = () => auxMode === 'chat' ? newChat() : newCliSession();
$('#aux-sessions').onclick = showSessions;
$$('.aux-mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('#chat-send').onclick = sendChat;
$('#chat-attach').onclick = attachFilePick;
$('#chat-addsel').onclick = addSelectionToChat;
$('#chat-model').onclick = pickModel;
updateModelLabel();

const chatInput = $('#chat-input');
chatInput.addEventListener('input', () => {
	chatInput.style.height = 'auto';
	chatInput.style.height = Math.min(160, chatInput.scrollHeight) + 'px';
	updateMention();
});
chatInput.addEventListener('keydown', e => {
	if (mentionActive) {
		if (e.key === 'ArrowDown') { mentionSel = Math.min(mentionSel + 1, mentionItems.length - 1); renderMention(); e.preventDefault(); return; }
		if (e.key === 'ArrowUp') { mentionSel = Math.max(mentionSel - 1, 0); renderMention(); e.preventDefault(); return; }
		if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionItems[mentionSel]); e.preventDefault(); return; }
		if (e.key === 'Escape') { $('#mention-pop').classList.add('hidden'); mentionActive = false; return; }
	}
	if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
// paste an image from the clipboard -> attach (vision, if the model supports it)
chatInput.addEventListener('paste', e => {
	const items = e.clipboardData && e.clipboardData.items;
	if (!items) return;
	for (const it of items) {
		if (it.type.startsWith('image/')) {
			const blob = it.getAsFile();
			const reader = new FileReader();
			reader.onload = () => { attachments.push({ kind: 'image', name: 'pasted-image.png', dataUrl: reader.result }); renderAttachments(); toast('Image attached (works if the model supports vision)', 3500); };
			reader.readAsDataURL(blob);
			e.preventDefault();
		}
	}
});
chatInput.addEventListener('focus', updateContext);

// resizer (drag left edge)
$('#aux-resizer').addEventListener('mousedown', e => {
	e.preventDefault();
	const startX = e.clientX, startW = $('#aux').offsetWidth;
	const move = ev => { let w = Math.max(240, Math.min(window.innerWidth - 400, startW + (startX - ev.clientX))); $('#aux').style.width = w + 'px'; cliActive && cliActive.fit.fit(); };
	const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
	document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});

Object.assign(Claude, { toggleAux, openAux, closeAux, addFileToChat });
