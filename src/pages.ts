const CSS = `
:root {
	--bg: #16120e;
	--panel: #1f1913;
	--ink: #ece4d6;
	--dim: #8d8172;
	--accent: #e8a33d;
	--accent-ink: #16120e;
	--line: #342a20;
	--danger: #c8543a;
}
* { box-sizing: border-box; margin: 0; }
body {
	background: var(--bg);
	color: var(--ink);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 14px;
	line-height: 1.5;
	min-height: 100vh;
	padding: 24px 16px 64px;
}
a { color: var(--accent); }
.wrap { max-width: 860px; margin: 0 auto; }
.topbar {
	display: flex; justify-content: space-between; align-items: baseline;
	border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 32px;
}
.wordmark { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; }
.wordmark span { color: var(--accent); }
.topbar form button {
	background: none; border: 1px solid var(--line); color: var(--dim);
	font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
}
.topbar form button:hover { color: var(--ink); border-color: var(--dim); }
.panel { background: var(--panel); border: 1px solid var(--line); padding: 24px; }
h1 { font-size: 20px; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 6px; }
.sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
.tabs { display: flex; gap: 0; border: 1px solid var(--line); width: fit-content; margin-bottom: 16px; }
.tabs button {
	background: none; border: none; color: var(--dim); font: inherit;
	font-size: 12px; padding: 6px 16px; cursor: pointer; letter-spacing: 0.06em;
}
.tabs button.active { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
label { display: block; font-size: 11px; letter-spacing: 0.08em; color: var(--dim); margin-bottom: 6px; }
textarea, input[type=url], input[type=number], input[type=password], select {
	width: 100%; background: var(--bg); border: 1px solid var(--line); color: var(--ink);
	font: inherit; font-size: 13px; padding: 10px 12px; outline: none;
}
textarea:focus, input:focus, select:focus { border-color: var(--accent); }
textarea { min-height: 240px; resize: vertical; }
.row { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 16px; }
.field { flex: 1; min-width: 120px; }
.check { display: flex; align-items: center; gap: 8px; margin-top: 26px; font-size: 12px; color: var(--dim); }
.check input { accent-color: var(--accent); }
.cta {
	margin-top: 20px; width: 100%; background: var(--accent); color: var(--accent-ink);
	border: none; font: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.1em;
	padding: 14px; cursor: pointer;
}
.cta:disabled { opacity: 0.5; cursor: wait; }
.cta.secondary { background: none; border: 1px solid var(--line); color: var(--ink); }
.error { color: var(--danger); font-size: 12px; margin-top: 12px; }
.result { margin-top: 24px; border-top: 1px dashed var(--line); padding-top: 20px; display: none; }
.result.show { display: block; }
.result img { max-width: 100%; border: 1px solid var(--line); display: block; margin-top: 12px; }
.result .meta { color: var(--dim); font-size: 12px; word-break: break-all; margin-top: 8px; }
.consent { max-width: 520px; margin: 48px auto 0; }
.consent dl { margin: 16px 0; font-size: 13px; }
.consent dt { color: var(--dim); font-size: 11px; letter-spacing: 0.08em; }
.consent dd { margin: 2px 0 12px; }
.warn { border: 1px solid var(--danger); color: var(--danger); font-size: 12px; padding: 10px 12px; margin-bottom: 16px; }
.actions { display: flex; gap: 12px; margin-top: 20px; }
.actions .cta { margin-top: 0; }
`;

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · render-html</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="topbar"><div class="wordmark">render<span>-html</span></div></header>
${body}
</div>
</body>
</html>`;
}

export function loginPage(error?: string): string {
	return page(
		"Sign in",
		`<main class="panel consent">
<h1>Sign in</h1>
<p class="sub">Single-user access. Enter the admin password.</p>
<form method="post" action="/login">
<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<button class="cta" type="submit">Sign in</button>
</form>
</main>`,
	);
}

export interface ConsentView {
	clientName: string;
	clientDomain?: string;
	redirectHost: string;
	redirectIsLoopback: boolean;
	scopes: string[];
	handle: string;
	action: string;
	needsPassword: boolean;
	error?: string;
}

export function consentPage(view: ConsentView): string {
	const scopes = view.scopes.length
		? view.scopes.map((s) => `<dd>${escapeHtml(s)}</dd>`).join("")
		: "<dd>full render access</dd>";
	const publisher = view.clientDomain
		? `Published by <strong>${escapeHtml(view.clientDomain)}</strong>.`
		: "This client registered itself; its name is not verified.";
	const loopback = view.redirectIsLoopback
		? `<p class="warn">Access will be sent to an app on your computer (${escapeHtml(
				view.redirectHost,
			)}). Continue only if you just started signing in from it.</p>`
		: `<p class="sub">Access will be sent to <strong>${escapeHtml(view.redirectHost)}</strong>.</p>`;
	const password = view.needsPassword
		? `<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>`
		: "";
	return page(
		"Authorize",
		`<main class="panel consent">
<h1>Allow ${escapeHtml(view.clientName)}?</h1>
<p class="sub">${publisher}</p>
${loopback}
<dl><dt>Scopes</dt>${scopes}</dl>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="handle" value="${escapeHtml(view.handle)}">
${password}
${view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : ""}
<div class="actions">
<button class="cta" name="decision" value="approve" type="submit">Allow</button>
<button class="cta secondary" name="decision" value="deny" type="submit">Deny</button>
</div>
</form>
</main>`,
	);
}

export function appPage(): string {
	return page(
		"Render",
		`<main>
<div class="panel">
<h1>Render HTML to an image or PDF</h1>
<p class="sub">Paste markup or point at a page. Files are stored for 30 days.</p>
<div class="tabs">
<button type="button" id="tab-html" class="active">HTML</button>
<button type="button" id="tab-url">URL</button>
</div>
<div id="pane-html">
<label for="html">HTML source</label>
<textarea id="html" spellcheck="false" placeholder="<h1 style=&quot;font-family: sans-serif&quot;>Hello</h1>"></textarea>
</div>
<div id="pane-url" hidden>
<label for="url">Page URL</label>
<input id="url" type="url" placeholder="https://example.com">
</div>
<div class="row">
<div class="field">
<label for="format">Format</label>
<select id="format">
<option value="png">PNG</option>
<option value="jpeg">JPEG</option>
<option value="webp">WebP</option>
<option value="pdf">PDF</option>
</select>
</div>
<div class="field">
<label for="width">Viewport width</label>
<input id="width" type="number" value="1280" min="16" max="4000">
</div>
<div class="field">
<label for="height">Viewport height</label>
<input id="height" type="number" value="800" min="16" max="4000">
</div>
<div class="check"><input id="fullPage" type="checkbox"><label for="fullPage" style="margin:0">Full page capture</label></div>
</div>
<p class="error" id="error"></p>
<button class="cta" id="render">RENDER</button>
<div class="result" id="result">
<a id="result-link" href="#" target="_blank" rel="noopener">Open file</a>
<div class="meta" id="result-meta"></div>
<img id="result-img" alt="Rendered output" hidden>
</div>
</div>
</main>
<script>
const tabHtml = document.getElementById('tab-html');
const tabUrl = document.getElementById('tab-url');
const paneHtml = document.getElementById('pane-html');
const paneUrl = document.getElementById('pane-url');
let mode = 'html';
function setMode(next) {
	mode = next;
	tabHtml.classList.toggle('active', mode === 'html');
	tabUrl.classList.toggle('active', mode === 'url');
	paneHtml.hidden = mode !== 'html';
	paneUrl.hidden = mode !== 'url';
}
tabHtml.onclick = () => setMode('html');
tabUrl.onclick = () => setMode('url');
const btn = document.getElementById('render');
const err = document.getElementById('error');
const result = document.getElementById('result');
const link = document.getElementById('result-link');
const meta = document.getElementById('result-meta');
const img = document.getElementById('result-img');
const format = document.getElementById('format');
const fullPage = document.getElementById('fullPage');
function syncFormat() {
	const isPdf = format.value === 'pdf';
	fullPage.disabled = isPdf;
	if (isPdf) fullPage.checked = false;
}
format.onchange = syncFormat;
syncFormat();
btn.onclick = async () => {
	err.textContent = '';
	result.classList.remove('show');
	const body = {
		format: format.value,
		width: Number(document.getElementById('width').value),
		height: Number(document.getElementById('height').value),
		fullPage: fullPage.checked,
	};
	if (mode === 'html') body.html = document.getElementById('html').value;
	else body.url = document.getElementById('url').value;
	btn.disabled = true;
	btn.textContent = 'RENDERING…';
	try {
		const res = await fetch('/api/render', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || 'Render failed');
		link.href = data.url;
		link.textContent = data.url;
		meta.textContent = data.bytes.toLocaleString() + ' bytes · expires in 30 days';
		if (body.format === 'pdf') img.hidden = true;
		else { img.src = data.url; img.hidden = false; }
		result.classList.add('show');
	} catch (e) {
		err.textContent = e.message;
	} finally {
		btn.disabled = false;
		btn.textContent = 'RENDER';
	}
};
</script>`,
	);
}
