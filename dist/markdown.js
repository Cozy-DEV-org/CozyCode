// CozyCode built-in Markdown: rendered preview (Ctrl+Shift+V / right-click) and an
// Obsidian-style relation graph of the workspace's .md files ([[wikilinks]] and
// [text](x.md) links). Rendering: marked (CDN) + DOMPurify sanitize.
'use strict';
const MD = {};

const mdDir = p => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const mdStem = p => { const b = p.split(/[\\/]/).pop() || ''; return b.replace(/\.md$/i, ''); };
const mdAsset = p => window.__TAURI__.core.convertFileSrc(p);

let mdIndex = null; // [{path,name,links}] from the last md_graph scan
async function mdScan() {
	if (!state.root) return [];
	try { mdIndex = await invoke('md_graph', { root: state.root }); } catch { mdIndex = []; }
	return mdIndex;
}
// find a note by wikilink target ("Changelog" or "sub/Changelog")
function mdFindNote(target) {
	if (!mdIndex) return null;
	const t = target.toLowerCase().replace(/\\/g, '/');
	return mdIndex.find(n => n.name.toLowerCase() === t)
		|| mdIndex.find(n => n.path.toLowerCase().replace(/\\/g, '/').endsWith('/' + t + '.md'))
		|| mdIndex.find(n => n.path.toLowerCase().replace(/\\/g, '/').endsWith('/' + t));
}

/* ================= preview ================= */
async function openMarkdownPreview(path) {
	openUiTab('mdpreview:' + path, 'Preview ' + (path.split(/[\\/]/).pop() || ''), async box => {
		box.innerHTML = '<div class="markdown-body" style="color:var(--fg-dim)">Rendering...</div>';
		// prefer the (possibly unsaved) editor buffer over the file on disk
		let text = '';
		const open = state.tabs.find(t => t.path === path && t.model);
		if (open) text = open.model.getValue();
		else { try { text = await invoke('read_file', { path }); } catch (e) { box.innerHTML = `<div class="markdown-body">${esc(String(e))}</div>`; return; } }

		// [[wikilink]] / [[wikilink|alias]] -> markdown links on a wiki: scheme
		text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
			(_, target, alias) => `[${alias || target}](wiki:${encodeURIComponent(target.trim())})`);

		// allow our wiki:/asset: link schemes through sanitization (default policy strips them)
		const html = DOMPurify.sanitize(marked.parse(text), {
			ADD_ATTR: ['align'],
			ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|wiki|asset|data|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
		});
		const body = document.createElement('div');
		body.className = 'markdown-body';
		body.innerHTML = html;

		// resolve relative resources + route link clicks
		const dir = mdDir(path);
		body.querySelectorAll('img').forEach(img => {
			const src = img.getAttribute('src') || '';
			if (src && !/^(https?:|data:|asset)/i.test(src)) img.src = mdAsset(dir + decodeURIComponent(src).replace(/\//g, '\\'));
		});
		body.querySelectorAll('a').forEach(a => {
			const href = a.getAttribute('href') || '';
			a.onclick = async ev => {
				ev.preventDefault();
				if (href.startsWith('wiki:')) {
					if (!mdIndex) await mdScan();
					const n = mdFindNote(decodeURIComponent(href.slice(5)));
					n ? openMarkdownPreview(n.path) : toast('Note not found: ' + decodeURIComponent(href.slice(5)));
				} else if (/^https?:/i.test(href)) invoke('open_url', { url: href });
				else if (/\.md(#.*)?$/i.test(href)) openMarkdownPreview(dir + decodeURIComponent(href.split('#')[0]).replace(/\//g, '\\'));
				else if (href.startsWith('#')) { const el = body.querySelector(`[id="${CSS.escape(href.slice(1))}"]`); el && el.scrollIntoView({ behavior: 'smooth' }); }
			};
		});

		const bar = document.createElement('div');
		bar.className = 'md-toolbar';
		bar.innerHTML = `<span class="codicon codicon-markdown"></span><span class="md-path">${esc(path.split(/[\\/]/).pop())}</span>` +
			`<span style="flex:1"></span>` +
			`<button class="md-btn" title="Open source"><span class="codicon codicon-go-to-file"></span></button>` +
			`<button class="md-btn" title="Graph View"><span class="codicon codicon-type-hierarchy-sub"></span></button>`;
		bar.querySelectorAll('.md-btn')[0].onclick = () => openFile(path, { preview: false });
		bar.querySelectorAll('.md-btn')[1].onclick = () => openMarkdownGraph(path);
		box.innerHTML = '';
		const wrap = document.createElement('div');
		wrap.className = 'md-preview-wrap';
		wrap.appendChild(bar); wrap.appendChild(body);
		box.appendChild(wrap);
	});
}

/* ================= graph view (Obsidian-style) ================= */
async function openMarkdownGraph(focusPath) {
	openUiTab('mdgraph', 'Markdown Graph', async box => {
		box.innerHTML = '<div class="markdown-body" style="color:var(--fg-dim)">Scanning notes...</div>';
		const notes = await mdScan();
		if (!notes.length) { box.innerHTML = '<div class="markdown-body" style="color:var(--fg-dim)">No .md files in this workspace.</div>'; return; }

		// build nodes + resolved edges
		const byPath = new Map();
		const nodes = notes.slice(0, 800).map((n, i) => {
			const node = { i, path: n.path, name: n.name, x: Math.cos(i * 2.4) * (60 + i), y: Math.sin(i * 2.4) * (60 + i), vx: 0, vy: 0, deg: 0 };
			byPath.set(n.path.toLowerCase().replace(/\\/g, '/'), node);
			return node;
		});
		const edges = [];
		const seen = new Set();
		for (const n of notes) {
			const from = byPath.get(n.path.toLowerCase().replace(/\\/g, '/'));
			if (!from) continue;
			for (const l of n.links) {
				let to = null;
				const t = l.toLowerCase().replace(/\\/g, '/');
				if (t.endsWith('.md')) { // relative path link
					const abs = (mdDir(n.path) + decodeURIComponent(l).replace(/\//g, '\\')).toLowerCase().replace(/\\/g, '/').replace(/\/[^/]+\/\.\.\//g, '/');
					to = byPath.get(abs) || null;
				}
				if (!to) { const f = mdFindNote(l); if (f) to = byPath.get(f.path.toLowerCase().replace(/\\/g, '/')); }
				if (to && to !== from) {
					const k = from.i + '-' + to.i;
					if (!seen.has(k)) { seen.add(k); edges.push([from, to]); from.deg++; to.deg++; }
				}
			}
		}

		box.innerHTML = '';
		const canvas = document.createElement('canvas');
		canvas.className = 'md-graph';
		box.appendChild(canvas);
		const ctx = canvas.getContext('2d');
		let W = 0, H = 0, dpr = window.devicePixelRatio || 1;
		const fit = () => { W = box.clientWidth; H = box.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; };
		fit();
		new ResizeObserver(fit).observe(box);

		let scale = 1, ox = 0, oy = 0; // view transform (world -> screen: x*scale + W/2 + ox)
		let hover = null, dragNode = null, panning = false, px = 0, py = 0;
		const focus = focusPath ? byPath.get(focusPath.toLowerCase().replace(/\\/g, '/')) : null;

		// ponytail: naive O(n^2) force sim, fine for hundreds of notes; quadtree if
		// someone opens a 5k-note vault
		let alive = 240;
		function tick() {
			for (let a = 0; a < nodes.length; a++) {
				const n = nodes[a];
				for (let b = a + 1; b < nodes.length; b++) {
					const m = nodes[b];
					let dx = n.x - m.x, dy = n.y - m.y;
					let d2 = dx * dx + dy * dy || 1;
					if (d2 < 250000) { const f = 900 / d2; dx *= f; dy *= f; n.vx += dx; n.vy += dy; m.vx -= dx; m.vy -= dy; }
				}
				n.vx -= n.x * 0.0015; n.vy -= n.y * 0.0015; // gravity to center
			}
			for (const [a, b] of edges) {
				const dx = b.x - a.x, dy = b.y - a.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 1;
				const f = (d - 90) * 0.004;
				a.vx += dx / d * f * 90; a.vy += dy / d * f * 90;
				b.vx -= dx / d * f * 90; b.vy -= dy / d * f * 90;
			}
			for (const n of nodes) {
				if (n === dragNode) { n.vx = n.vy = 0; continue; }
				n.vx *= 0.85; n.vy *= 0.85;
				n.x += Math.max(-12, Math.min(12, n.vx));
				n.y += Math.max(-12, Math.min(12, n.vy));
			}
		}
		const sx = n => n.x * scale + W / 2 + ox, sy = n => n.y * scale + H / 2 + oy;
		function draw() {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, W, H);
			const hi = hover || focus;
			const neigh = new Set();
			if (hi) for (const [a, b] of edges) { if (a === hi) neigh.add(b); if (b === hi) neigh.add(a); }
			ctx.lineWidth = 1;
			for (const [a, b] of edges) {
				const lit = hi && (a === hi || b === hi);
				ctx.strokeStyle = lit ? 'rgba(217,138,75,.75)' : 'rgba(140,140,140,.16)';
				ctx.beginPath(); ctx.moveTo(sx(a), sy(a)); ctx.lineTo(sx(b), sy(b)); ctx.stroke();
			}
			for (const n of nodes) {
				const r = (3 + Math.min(9, n.deg)) * Math.max(.6, Math.min(1.6, scale));
				const lit = n === hi || neigh.has(n);
				ctx.fillStyle = n === hi ? '#d98a4b' : lit ? '#e0b48a' : 'rgba(160,160,170,.85)';
				ctx.beginPath(); ctx.arc(sx(n), sy(n), r, 0, 7); ctx.fill();
				if (scale > .7 || lit || n.deg >= 3) {
					ctx.fillStyle = lit ? '#eee' : 'rgba(200,200,200,.55)';
					ctx.font = `${Math.max(10, 11 * Math.min(1.2, scale))}px sans-serif`;
					ctx.fillText(n.name, sx(n) + r + 3, sy(n) + 3);
				}
			}
		}
		function loop() {
			if (!canvas.isConnected) return;
			if (alive > 0) { alive--; tick(); }
			draw();
			requestAnimationFrame(loop);
		}
		loop();

		// mouse coords must be divided by the app's CSS zoom (same rule as the
		// resizers) — the canvas thinks in layout px, events arrive in visual px
		const evPos = e => { const r = canvas.getBoundingClientRect(), z = zoom(); return [(e.clientX - r.left) / z, (e.clientY - r.top) / z]; };
		const pick = (mx, my) => nodes.find(n => { const dx = sx(n) - mx, dy = sy(n) - my; return dx * dx + dy * dy < 150; });
		canvas.onmousemove = e => {
			const [mx, my] = evPos(e);
			if (dragNode) { dragNode.x = (mx - W / 2 - ox) / scale; dragNode.y = (my - H / 2 - oy) / scale; alive = Math.max(alive, 30); return; }
			if (panning) { ox += mx - px; oy += my - py; px = mx; py = my; return; }
			hover = pick(mx, my);
			canvas.style.cursor = hover ? 'pointer' : 'grab';
		};
		canvas.onmousedown = e => {
			const [mx, my] = evPos(e);
			const n = pick(mx, my);
			if (n) dragNode = n; else { panning = true; px = mx; py = my; }
		};
		window.addEventListener('mouseup', () => { dragNode = null; panning = false; });
		canvas.onclick = e => {
			const [mx, my] = evPos(e);
			const n = pick(mx, my);
			if (n) openMarkdownPreview(n.path);
		};
		canvas.onwheel = e => {
			e.preventDefault();
			const [px2, py2] = evPos(e);
			const mx = px2 - W / 2, my = py2 - H / 2;
			const f = e.deltaY < 0 ? 1.15 : 0.87;
			const ns = Math.max(.15, Math.min(4, scale * f));
			ox = mx + (ox - mx) * (ns / scale); oy = my + (oy - my) * (ns / scale);
			scale = ns;
		};
	});
}

Object.assign(MD, { openMarkdownPreview, openMarkdownGraph });
