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

/* ---------- context chip ---------- */
function activeFileContext() {
	const tab = findTab(state.active);
	if (!tab || tab.kind !== 'file' || !tab.path) return null;
	const sel = state.editor && state.editor.getSelection();
	const selText = sel && !sel.isEmpty() ? state.editor.getModel().getValueInRange(sel) : '';
	return { name: tab.name, path: tab.path, content: tab.model.getValue(), selection: selText };
}
function updateContext() {
	const ctx = activeFileContext();
	const el = $('#chat-context');
	if (ctx) el.innerHTML = `<span class="codicon codicon-file"></span> ${esc(ctx.name)}${ctx.selection ? ' (selection)' : ''} attached as context`;
	else el.innerHTML = '<span class="codicon codicon-info"></span> No file open';
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

async function sendChat() {
	const input = $('#chat-input');
	const text = input.value.trim();
	if (!text) return;
	const cfg = providerCfg();
	if (!cfg.key && !(cfg.base || '').includes('localhost')) { toast('Set an AI API key in Settings'); Settings.openSettings(); return; }
	input.value = '';
	addMsg('user', text);
	chatHistory.push({ role: 'user', content: text });

	// attach active file context on first turn or when selection present
	let prompt = text;
	const ctx = activeFileContext();
	if (ctx && (chatHistory.length === 1 || ctx.selection)) {
		const body = ctx.selection || (ctx.content.length > 12000 ? ctx.content.slice(0, 12000) + '\n...(truncated)' : ctx.content);
		prompt = `File: ${ctx.path}\n\`\`\`\n${body}\n\`\`\`\n\n${text}`;
	}
	// include short history as plain text (keeps ai_generate single-shot simple)
	const convo = chatHistory.slice(-6, -1).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
	const full = convo ? convo + '\n\nUser: ' + prompt : prompt;

	const bubble = addMsg('assistant', '...');
	try {
		const out = await invoke('ai_generate', {
			baseUrl: cfg.base, apiKey: cfg.key, model: cfg.model, anthropic: cfg.anthropic,
			system: CHAT_SYSTEM, prompt: full,
		});
		bubble.innerHTML = renderMarkdown(out.trim());
		chatHistory.push({ role: 'assistant', content: out.trim() });
		$('#chat-messages').scrollTop = 1e9;
	} catch (e) { bubble.innerHTML = renderMarkdown('Error: ' + e); }
}

function newChat() { chatHistory = []; $('#chat-messages').innerHTML = ''; updateContext(); }

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
$('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
// keep context chip fresh when switching tabs handled via focus
$('#chat-input').addEventListener('focus', updateContext);

// resizer (drag left edge)
$('#aux-resizer').addEventListener('mousedown', e => {
	e.preventDefault();
	const startX = e.clientX, startW = $('#aux').offsetWidth;
	const move = ev => { let w = Math.max(240, Math.min(window.innerWidth - 400, startW + (startX - ev.clientX))); $('#aux').style.width = w + 'px'; claudeFit && claudeFit.fit(); };
	const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
	document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});

Object.assign(Claude, { toggleAux, openAux, closeAux });
