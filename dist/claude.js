// CozyCode Claude AI panel — right sidebar. Two modes:
//  - Chat: Anthropic/OpenAI-compatible API (reuses AI settings), sees active file context.
//  - Claude Code: runs the `claude` CLI in a pty terminal inside the workspace.
'use strict';

const CHAT_SYSTEM =
	'You are Claude, a coding assistant embedded in the CozyCode editor. Be concise. ' +
	'When you show code, use fenced code blocks. You are given the active file for context when relevant.';

let auxOpen = false, auxMode = 'chat';
let chatHistory = []; // {role, content}
let claudeTerm = null, claudeFit = null, claudePty = null, claudeBound = false;

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
	if (mode === 'chat') { updateContext(); $('#chat-input').focus(); }
	else startClaudeCli();
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
	const r = document.createElement('div'); r.className = 'role'; r.textContent = role === 'user' ? 'You' : 'Claude';
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
		$('#chat-messages').scrollTop = 1e9;
	} catch (e) { bubble.innerHTML = renderMarkdown('Error: ' + e); }
}

function newChat() { chatHistory = []; attachments = []; $('#chat-messages').innerHTML = ''; renderAttachments(); updateContext(); }

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

/* ---------- Claude Code CLI ---------- */
async function startClaudeCli() {
	// resolve the real path (claude is a claude.cmd npm shim on Windows)
	const claudePath = await invoke('resolve_command', { name: 'claude' }).catch(() => null);
	const cli = $('#aux-cli');
	if (!claudePath) {
		cli.innerHTML = `<div class="cli-install">
			<div class="codicon codicon-sparkle" style="font-size:32px;color:#d98a4b"></div>
			<div>Claude Code CLI is not installed.</div>
			<button class="set-btn" id="cli-install-btn">Install Claude Code</button>
			<div class="desc">Runs: npm i -g @anthropic-ai/claude-code</div>
		</div>`;
		$('#cli-install-btn').onclick = installClaude;
		return;
	}
	cli.innerHTML = '<div id="claude-term"></div>';
	if (typeof Terminal === 'undefined') { toast('Terminal lib not loaded'); return; }
	if (!claudeBound) {
		claudeBound = true;
		listen('pty-output', e => { if (e.payload.id === claudePty) claudeTerm.write(e.payload.data); });
		listen('pty-exit', e => { if (e.payload === claudePty) { claudeTerm && claudeTerm.write('\r\n[claude exited]\r\n'); claudePty = null; } });
	}
	claudeTerm = new Terminal({ fontSize: 12, theme: { background: '#1e1e1e' }, cursorBlink: true });
	claudeFit = new FitAddon.FitAddon();
	claudeTerm.loadAddon(claudeFit);
	claudeTerm.open($('#claude-term'));
	claudeFit.fit();
	claudeTerm.onData(d => claudePty && invoke('pty_write', { id: claudePty, data: d }));
	claudeTerm.onResize(({ cols, rows }) => claudePty && invoke('pty_resize', { id: claudePty, cols, rows }));
	new ResizeObserver(() => claudeFit && claudeFit.fit()).observe($('#claude-term'));
	try {
		claudePty = await invoke('pty_spawn', { cwd: state.root || '', cols: claudeTerm.cols, rows: claudeTerm.rows, shell: claudePath, args: null });
	} catch (e) {
		claudeTerm.write('\r\nFailed to start Claude Code: ' + e + '\r\n');
	}
	claudeTerm.focus();
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
$('#aux-clear').onclick = () => auxMode === 'chat' ? newChat() : (claudePty && invoke('pty_write', { id: claudePty, data: '\x0c' }));
$$('.aux-mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('#chat-send').onclick = sendChat;
$('#chat-attach').onclick = attachFilePick;
$('#chat-addsel').onclick = addSelectionToChat;

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
	const move = ev => { let w = Math.max(240, Math.min(window.innerWidth - 400, startW + (startX - ev.clientX))); $('#aux').style.width = w + 'px'; claudeFit && claudeFit.fit(); };
	const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
	document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});

Object.assign(Claude, { toggleAux, openAux, closeAux });
