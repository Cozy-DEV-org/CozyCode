// CozyCode built-in Prettier — Format Document with zero external tools.
//
// Prettier's standalone browser build + plugins are vendored under dist/prettier and
// loaded lazily on first format, then run entirely in the webview (offline, no node,
// no npx). Registers a Monaco document-formatting provider per language so Format
// Document (Shift+Alt+F / right-click / palette / format-on-save) just works.
'use strict';

// Monaco languageId -> Prettier parser
const PRETTIER_PARSER = {
	javascript: 'babel', javascriptreact: 'babel',
	typescript: 'typescript', typescriptreact: 'typescript',
	json: 'json', jsonc: 'json', json5: 'json5',
	css: 'css', scss: 'scss', less: 'less',
	html: 'html', vue: 'vue',
	markdown: 'markdown', mdx: 'mdx',
	yaml: 'yaml', graphql: 'graphql',
};

let _prettierLoad = null;
function loadPrettier() {
	if (window.prettier && window.prettierPlugins) return Promise.resolve();
	if (_prettierLoad) return _prettierLoad;
	const files = ['standalone.js', 'plugins/babel.js', 'plugins/estree.js', 'plugins/typescript.js', 'plugins/postcss.js', 'plugins/html.js', 'plugins/markdown.js', 'plugins/yaml.js', 'plugins/graphql.js'];
	const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s); });
	_prettierLoad = (async () => {
		// Prettier's UMD registers as an AMD module when Monaco's loader.js define.amd
		// is present -> temporarily hide it so it attaches to window instead.
		const amd = window.define && window.define.amd;
		if (window.define) window.define.amd = undefined;
		try { for (const f of files) await load('prettier/' + f); }
		finally { if (window.define) window.define.amd = amd; }
	})();
	return _prettierLoad;
}

// Prettier config from the workspace (.prettierrc(.json) / package.json#prettier),
// like prettier-vscode. Editor tab size seeds tabWidth only when config omits it.
async function prettierOptions() {
	const opts = {};
	const root = state.root;
	if (root && !state.remote) {
		for (const name of ['.prettierrc', '.prettierrc.json', '.prettierrc.json5']) {
			try { Object.assign(opts, JSON.parse(stripJsonComments(await FS.readFile(root + '\\' + name)))); break; } catch { }
		}
		if (!Object.keys(opts).length) {
			try { const pkg = JSON.parse(await FS.readFile(root + '\\package.json')); if (pkg.prettier && typeof pkg.prettier === 'object') Object.assign(opts, pkg.prettier); } catch { }
		}
	}
	if (opts.tabWidth == null && state.settings['editor.tabSize']) opts.tabWidth = state.settings['editor.tabSize'];
	return opts;
}

async function formatWithPrettier(langId, code) {
	const parser = PRETTIER_PARSER[langId];
	if (!parser) return null;
	await loadPrettier();
	const opts = await prettierOptions();
	// config may set formatting options, but the parser + plugins come from the language
	opts.parser = parser;
	opts.plugins = Object.values(window.prettierPlugins);
	return window.prettier.format(code, opts);
}

const prettierSupports = langId => !!PRETTIER_PARSER[langId];

// register a Monaco formatter for every supported language (native Format Document)
monacoReady.then(() => {
	for (const lang of Object.keys(PRETTIER_PARSER)) {
		monaco.languages.registerDocumentFormattingEditProvider(lang, {
			provideDocumentFormattingEdits: async (model) => {
				try {
					const text = await formatWithPrettier(model.getLanguageId(), model.getValue());
					if (text == null || text === model.getValue()) return [];
					return [{ range: model.getFullModelRange(), text }];
				} catch (e) { toast('Prettier: ' + (e && e.message || e)); return []; }
			},
		});
	}
});

window.Prettier = { format: formatWithPrettier, supports: prettierSupports, options: prettierOptions, languages: Object.keys(PRETTIER_PARSER) };
