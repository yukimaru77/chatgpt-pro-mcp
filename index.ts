#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
//
// macOS port: this server no longer drives Chrome via playwright-cli + CDP.
// Instead it speaks the camofox-browser HTTP API (`camofox-mcp` fork's
// browser server) at $CAMOFOX_URL. That backend wraps Camoufox (Firefox)
// with anti-detection, and importantly the user's ChatGPT-Pro login is
// persisted in Camoufox's profile dir — so this MCP reuses the same logged-
// in session that camofox-mcp already uses. See docs/macos.md.

const CAMOFOX_URL = (process.env.CAMOFOX_URL || "http://127.0.0.1:9377").replace(/\/$/, "");
const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY || "";
const CAMOFOX_USER_ID = process.env.CHATGPT_MCP_USER_ID || "default";
const CAMOFOX_SESSION_KEY =
	process.env.CHATGPT_MCP_SESSION_KEY || `chatgpt-pro-mcp-${process.pid}`;

const LOG_FILE = process.env.CHATGPT_MCP_LOG || "/tmp/chatgpt-mcp.log";
const VERBOSE = process.env.CHATGPT_MCP_VERBOSE === "1";
const MAX_WAIT_THINKER_MS =
	(Number(process.env.CHATGPT_MCP_THINKER_MAX_MIN) || 120) * 60 * 1000;
const MAX_WAIT_RESEARCHER_MS =
	(Number(process.env.CHATGPT_MCP_RESEARCHER_MAX_MIN) || 120) * 60 * 1000;
const COMPOSER_WAIT_MS = 30_000;
const URL_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const EVAL_TIMEOUT_MS = 45_000;

// ----------------------------------------------------------------------------
// Logging
// ----------------------------------------------------------------------------

const log = (msg: string) => {
	const ts = new Date().toISOString();
	const line = `${ts} ${msg}`;
	console.error(`[chatgpt-mcp] ${line}`);
	try {
		appendFileSync(LOG_FILE, line + "\n");
	} catch {}
};
const vlog = (msg: string) => {
	if (VERBOSE) log(`[v] ${msg}`);
};

// ----------------------------------------------------------------------------
// Mutex. cliMutex は browser-driver 操作の直列化。setup フェーズはこの
// 範囲で原子化される; poll は各 iter で短時間取るだけ。
// ----------------------------------------------------------------------------

function makeMutex() {
	let chain: Promise<unknown> = Promise.resolve();
	return async function run<T>(fn: () => Promise<T>): Promise<T> {
		const next = chain.then(fn, fn);
		chain = next.catch(() => {});
		return next;
	};
}
const cliMutex = makeMutex();

// ----------------------------------------------------------------------------
// camofox-browser HTTP driver
// ----------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (CAMOFOX_API_KEY) h["Authorization"] = `Bearer ${CAMOFOX_API_KEY}`;
	return h;
}

async function http(
	method: "GET" | "POST" | "DELETE",
	pathname: string,
	body?: unknown,
	timeoutMs = EVAL_TIMEOUT_MS,
): Promise<any> {
	const url = `${CAMOFOX_URL}${pathname}`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method,
			headers: authHeaders(),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: ac.signal,
		});
		const text = await res.text();
		let parsed: any = text;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {}
		}
		if (!res.ok) {
			const errMsg =
				(parsed && typeof parsed === "object" && (parsed.error || parsed.message)) ||
				text ||
				`HTTP ${res.status}`;
			throw new Error(`camofox ${method} ${pathname} -> ${res.status}: ${errMsg}`);
		}
		return parsed;
	} finally {
		clearTimeout(timer);
	}
}

type CamoTab = { tabId: string; url: string; createdAt?: string };

// camofox-browser's GET /tabs returns { running, tabs: [...] }
async function listTabsLocked(): Promise<CamoTab[]> {
	const res = await http(
		"GET",
		`/tabs?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
	);
	const tabs = (res?.tabs || []) as Array<{ tabId: string; url: string; createdAt?: string }>;
	return tabs.map((t) => ({ tabId: t.tabId, url: t.url, createdAt: t.createdAt }));
}

async function createTab(url: string): Promise<string> {
	const res = await http("POST", "/tabs", {
		userId: CAMOFOX_USER_ID,
		sessionKey: CAMOFOX_SESSION_KEY,
		url,
	});
	if (!res?.tabId) throw new Error(`create_tab returned no tabId: ${JSON.stringify(res)}`);
	return String(res.tabId);
}

async function closeTab(tabId: string): Promise<void> {
	await http(
		"DELETE",
		`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
	);
}

async function refreshTab(tabId: string): Promise<void> {
	await http("POST", `/tabs/${encodeURIComponent(tabId)}/refresh`, {
		userId: CAMOFOX_USER_ID,
	});
}

// Click via JS-dispatched pointer events. ChatGPT uses Radix-style menus
// that listen for pointerdown/pointerup, not just plain `click`. Playwright's
// locator.click() works on most pages but here its actionability check
// ("waiting for element to be visible, enabled and stable") times out on
// the composer chrome which is continuously re-rendering, and camofox-
// browser's built-in mouse-sequence fallback never triggers because it
// matches the error message against lowercase "timeout" while Playwright
// emits uppercase "Timeout 5000ms exceeded". This dispatch avoids both.
async function clickViaHttp(tabId: string, selector: string): Promise<void> {
	const code = `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('clickViaHttp: selector not found: ' + ${JSON.stringify(selector)});
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true,
    button: 0, buttons: 1, pointerType: 'mouse',
    clientX: r.x + r.width / 2,
    clientY: r.y + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  return true;
})()`;
	await evalInTab<boolean>(tabId, code);
}

// Evaluate JS inside the page. Camofox's /evaluate-extended runs the
// expression via Playwright's page.evaluate(string), which treats the
// argument as a *bare expression*, not as a function to invoke. So
// `() => 1` evaluates to a function value (returned as undefined). We
// auto-wrap anything that looks like a function definition with `(...)()`
// so existing `() => ...` and `async () => ...` callsites keep working.
function wrapForEvaluate(expr: string): string {
	const trimmed = expr.trim();
	if (
		trimmed.startsWith("() =>") ||
		trimmed.startsWith("async () =>") ||
		trimmed.startsWith("function") ||
		trimmed.startsWith("async function")
	) {
		return `(${trimmed})()`;
	}
	return trimmed;
}

// Evaluate JS in the page (frameUrl unset) or in a specific frame whose
// URL contains `frameUrl` (string substring or /pattern/flags regex).
// Frame routing requires camofox-browser's patch-camofox-frame-evaluate
// patch — without it, frameUrl is ignored.
async function evalInTab<T>(
	tabId: string,
	expression: string,
	frameUrl?: string,
): Promise<T> {
	const body: Record<string, unknown> = {
		userId: CAMOFOX_USER_ID,
		expression: wrapForEvaluate(expression),
	};
	if (frameUrl) body.frameUrl = frameUrl;
	const res = await http(
		"POST",
		`/tabs/${encodeURIComponent(tabId)}/evaluate-extended`,
		body,
	);
	if (res && res.ok === false) {
		throw new Error(`evaluate failed: ${res.error || JSON.stringify(res)}`);
	}
	return res?.result as T;
}

async function evalVoid(tabId: string, expression: string): Promise<void> {
	await evalInTab(tabId, expression);
}

// ----------------------------------------------------------------------------
// Tab tracking by URL. Some helpers need to find "the tab whose location is
// the conversation URL" since the chatgpt-pro flow keys each request by
// /c/<id>. The Camoufox HTTP listing only reports the URL the tab was
// *created* at, not the current location, so for safety we look up by
// querying the live `location.href` of each tab via evaluate.
// ----------------------------------------------------------------------------

async function findTabIdByLocation(targetUrl: string): Promise<string | null> {
	const tabs = await listTabsLocked();
	for (const t of tabs) {
		try {
			const live = await evalInTab<string>(t.tabId, `() => location.href`);
			if (live === targetUrl) return t.tabId;
		} catch (e) {
			vlog(`findTabIdByLocation(${t.tabId}) skipped: ${(e as Error).message}`);
		}
	}
	return null;
}

// ----------------------------------------------------------------------------
// Driver health check (camofox-browser must be reachable; the underlying
// browser may start on demand when the first tab is created).
// ----------------------------------------------------------------------------

async function ensureDriverReady(): Promise<void> {
	const res = await http("GET", "/health", undefined, 5_000);
	if (!res || res.ok === false || res.running === false) {
		throw new Error(`camofox-browser at ${CAMOFOX_URL} not ready: ${JSON.stringify(res)}`);
	}
}

// ----------------------------------------------------------------------------
// Utility
// ----------------------------------------------------------------------------

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForLocked(
	cond: () => Promise<boolean>,
	timeoutMs: number,
	label: string,
	intervalMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await cond()) return;
		} catch (e) {
			vlog(`waitFor(${label}) cond error: ${(e as Error).message}`);
		}
		await sleep(intervalMs);
	}
	throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

// ----------------------------------------------------------------------------
// Model & composer-chip toggles
//
// Current ChatGPT composer UI (Pro user, observed 2026-05):
//   - Model selector is a "pill" button inside the composer form:
//       <button class="__composer-pill"> with text "Thinking" by default.
//     Clicking it opens a Radix menu of [role=menuitemradio] including:
//       "Instant" / "Thinking• Standard" / "Pro• Standard" / etc.
//     After picking Pro the pill text becomes "Pro" (no aria-label).
//   - The + button (`data-testid="composer-plus-btn"`) opens a menu whose
//     [role=menuitemradio] items are "Web search" / "Deep research" / etc.
//     After enabling one, a new __composer-pill appears with
//     aria-label "<Name>, click to remove".
//
// IMPORTANT: opening these Radix menus requires a real pointer event (the
// upstream README warned about this — calling HTMLElement.click() from a
// page-context expression does NOT open them under React/Radix). So the
// opener click goes through camofox-browser's /click endpoint (Playwright
// click); the row click can still be done from inside an evaluate since at
// that point the menu items are mounted in the DOM.
// ----------------------------------------------------------------------------

async function isProChipPresent(tabId: string): Promise<boolean> {
	return (
		(await evalInTab<boolean>(
			tabId,
			`() => [...document.querySelectorAll('form[data-type="unified-composer"] button.__composer-pill')].some(b => /^Pro\\b/.test((b.textContent || '').trim()))`,
		)) === true
	);
}

async function isWebSearchChipPresent(tabId: string): Promise<boolean> {
	return (
		(await evalInTab<boolean>(
			tabId,
			`() => !!document.querySelector('form[data-type="unified-composer"] button.__composer-pill[aria-label^="Search"], form[data-type="unified-composer"] button.__composer-pill[aria-label^="検索"]')`,
		)) === true
	);
}

async function isDeepResearchChipPresent(tabId: string): Promise<boolean> {
	return (
		(await evalInTab<boolean>(
			tabId,
			`() => !!document.querySelector('form[data-type="unified-composer"] button.__composer-pill[aria-label^="Deep research" i], form[data-type="unified-composer"] button.__composer-pill[aria-label^="ディープリサーチ" i]')`,
		)) === true
	);
}

async function pressEscape(tabId: string): Promise<void> {
	try {
		await http("POST", `/tabs/${encodeURIComponent(tabId)}/press`, {
			userId: CAMOFOX_USER_ID,
			key: "Escape",
		});
	} catch {}
}

// Click an already-mounted menu item by its visible text or aria-label.
// The menu must already be open (use clickViaHttp for the opener first).
async function clickMenuItemByText(
	tabId: string,
	patterns: string[],
): Promise<boolean> {
	const code = `(() => {
  const patterns = ${JSON.stringify(patterns)};
  const items = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
  for (const el of items) {
    const name = ((el.getAttribute('aria-label') || el.textContent) || '').trim();
    for (const p of patterns) {
      if (name.includes(p) || new RegExp(p, 'i').test(name)) {
        el.click();
        return true;
      }
    }
  }
  return false;
})()`;
	return (await evalInTab<boolean>(tabId, code)) === true;
}

async function enableComposerTool(
	tabId: string,
	openerSelector: string,
	itemPatterns: string[],
	verify: () => Promise<boolean>,
	label: string,
): Promise<void> {
	if (await verify()) {
		log(`${label} chip already present — skip enable`);
		return;
	}
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await clickViaHttp(tabId, openerSelector);
			await sleep(500);
			const clicked = await clickMenuItemByText(tabId, itemPatterns);
			if (!clicked) log(`${label} item ${JSON.stringify(itemPatterns)} not in menu (attempt ${attempt})`);
			await sleep(500);
			if (await verify()) {
				log(`enable ${label} verified (attempt=${attempt})`);
				return;
			}
			log(`⚠️ ${label} chip not present after attempt ${attempt}`);
			await pressEscape(tabId);
			await sleep(300);
		} catch (e) {
			log(`enable ${label} attempt ${attempt} failed: ${(e as Error).message}`);
			await pressEscape(tabId);
			await sleep(300);
		}
	}
	throw new Error(`Could not enable ${label} chip after 3 attempts`);
}

async function selectProModel(tabId: string): Promise<void> {
	if (await isProChipPresent(tabId)) {
		log(`Pro chip already present — skip model select`);
		return;
	}
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			// Open the model-pill menu via real Playwright click.
			await clickViaHttp(tabId, `form[data-type="unified-composer"] button.__composer-pill`);
			await sleep(500);
			const clicked = await clickMenuItemByText(tabId, ["^Pro"]);
			if (!clicked) log(`Pro row not found (attempt ${attempt})`);
			await sleep(500);
			if (await isProChipPresent(tabId)) {
				log(`selectProModel verified (attempt=${attempt})`);
				return;
			}
			log(`⚠️ Pro chip not present after attempt ${attempt}`);
			await pressEscape(tabId);
			await sleep(300);
		} catch (e) {
			log(`selectProModel attempt ${attempt} failed: ${(e as Error).message}`);
			await pressEscape(tabId);
			await sleep(300);
		}
	}
	throw new Error(`Could not select Pro model after 3 attempts`);
}

async function enableWebSearchChip(tabId: string): Promise<void> {
	await enableComposerTool(
		tabId,
		`[data-testid="composer-plus-btn"]`,
		["Web search", "ウェブ検索"],
		() => isWebSearchChipPresent(tabId),
		"web-search",
	);
}

async function enableDeepResearchChip(tabId: string): Promise<void> {
	await enableComposerTool(
		tabId,
		`[data-testid="composer-plus-btn"]`,
		["Deep research", "ディープリサーチ"],
		() => isDeepResearchChipPresent(tabId),
		"deep-research",
	);
}

// ----------------------------------------------------------------------------
// Setup: open tab → send prompt → acquire conversation URL
// ----------------------------------------------------------------------------

type ChipMode = "web-search" | "deep-research";

async function setupNewChatAndSend(
	prompt: string,
	mode: ChipMode,
): Promise<{ convUrl: string; tabId: string }> {
	return cliMutex(async () => {
		const tabId = await createTab("https://chatgpt.com/");

		await waitForLocked(
			async () =>
				(await evalInTab<boolean>(
					tabId,
					`() => !!document.querySelector('#prompt-textarea')`,
				)) === true,
			COMPOSER_WAIT_MS,
			"composer ready",
		);

		// Dismiss any blocking dialog (Pro upgrade prompts, etc.).
		await evalVoid(
			tabId,
			`() => {
  const selectors = ['[role="dialog"] button[aria-label="閉じる"]', '[role="dialog"] button[aria-label="Close"]'];
  for (const s of selectors) document.querySelectorAll(s).forEach(b => b.click());
}`,
		);
		await sleep(200);

		await selectProModel(tabId);
		if (mode === "web-search") {
			await enableWebSearchChip(tabId);
		} else {
			await enableDeepResearchChip(tabId);
		}

		// Insert prompt into the contenteditable composer.
		const jsonPrompt = JSON.stringify(prompt);
		await evalVoid(
			tabId,
			`() => {
  const e = document.querySelector('#prompt-textarea');
  if (!e) throw new Error('composer not found');
  e.focus();
  document.execCommand('insertText', false, ${jsonPrompt});
}`,
		);
		await sleep(300);

		await waitForLocked(
			async () =>
				(await evalInTab<boolean>(
					tabId,
					`() => !!document.querySelector('button[data-testid="send-button"]')`,
				)) === true,
			5_000,
			"send button available",
		);
		// Use pointer-event dispatch like the menu openers — React onMouseDown
		// handlers on the send button do not always fire from a bare .click().
		await clickViaHttp(tabId, `button[data-testid="send-button"]`);

		// Wait for the URL to settle on /c/<id>.
		let url = "";
		await waitForLocked(
			async () => {
				url = await evalInTab<string>(tabId, `() => location.href`);
				return /\/c\/[0-9a-f-]+/i.test(url);
			},
			URL_WAIT_MS,
			"conversation URL",
		);
		return { convUrl: url, tabId };
	});
}

// ----------------------------------------------------------------------------
// Poll: identify the conversation tab by current URL, then evaluate state.
// ----------------------------------------------------------------------------

type Figure =
	| { kind: "svg"; content: string; alt?: string }
	| { kind: "img"; src: string; alt?: string }
	| { kind: "canvas"; dataURL: string; alt?: string };

type CompletionProbe = {
	done: boolean;
	stopping: boolean;
	thinking: boolean;
	streaming: boolean;
	deepResearching: boolean;
	text: string;
	figures: Figure[];
};

function cleanDeepResearchText(raw: string): string {
	// Strip the digit-counter animation noise (0\n1\n...9\n repeated).
	let cleaned = raw.replace(/(?:\d\s*\n){5,}/g, "");
	// Strip the header line(s) before the report body. Locale-dependent:
	// "件の検索" (ja-JP) or " searches\n" (en-US). Prefer the last occurrence,
	// which sits right before the report title.
	for (const marker of ["件の検索", " searches\n", " searches"]) {
		const idx = cleaned.lastIndexOf(marker);
		if (idx >= 0) {
			cleaned = cleaned.slice(idx + marker.length);
			break;
		}
	}
	return cleaned.trim();
}

// Extract the /c/<id> identifier from a ChatGPT conversation URL, so we
// can compare two URLs as "same conversation" even when ChatGPT appends
// a model query string or fragment after the navigation we observed.
function conversationId(url: string): string | null {
	const m = url.match(/\/c\/([0-9a-f-]+)/i);
	return m ? m[1] : null;
}

// Tab existence/URL check that does NOT use evaluate (so it survives a
// page that's busy rendering Deep Research and rejects evaluate calls).
// Returns the *current* URL of the tab, or null if the tab is gone.
async function tabUrl(tabId: string): Promise<string | null> {
	try {
		const res = await http(
			"GET",
			`/tabs?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
			undefined,
			5_000,
		);
		const tabs = (res?.tabs || []) as Array<{ tabId: string; url: string }>;
		const hit = tabs.find((t) => t.tabId === tabId);
		return hit ? hit.url : null;
	} catch {
		return null;
	}
}

async function probeConversation(
	tabId: string,
	convUrl: string,
): Promise<CompletionProbe | null> {
	return cliMutex(async () => {
		// Existence check first via GET /tabs (does not run a page.evaluate, so
		// it survives a Deep Research page that's CPU-bound and refusing eval
		// calls — that previously tripped "tab disappeared" after a few
		// consecutive eval timeouts even though the tab was genuinely alive).
		const liveUrl = await tabUrl(tabId);
		if (!liveUrl) {
			vlog(`tab ${tabId} is gone (not in /tabs listing)`);
			return null;
		}
		const expected = conversationId(convUrl);
		const actual = conversationId(liveUrl);
		if (!actual || actual !== expected) {
			vlog(`tab ${tabId} url drifted: ${liveUrl} != ${convUrl}`);
			return null;
		}

		const top = await evalInTab<{
			stop: boolean;
			good: boolean;
			thinking: boolean;
			streaming: boolean;
			drIframe: boolean;
			text: string;
			figures: Figure[];
		}>(
			tabId,
			`() => {
  const stop = !!document.querySelector('button[data-testid="stop-button"]');
  const good = !!document.querySelector('button[data-testid="good-response-turn-action-button"]');
  const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const a = assistants.at(-1);
  const md = a?.querySelector('div[class*="markdown"]');
  const cls = md?.className || '';
  const thinking = cls.includes('result-thinking');
  const streaming = cls.includes('result-streaming');
  const drIframe = !!document.querySelector('iframe[title="internal://deep-research"]');
  const text = a ? (a.innerText || a.textContent || '') : '';
  const figures = [];
  if (a) {
    a.querySelectorAll('svg').forEach(svg => {
      const r = svg.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) figures.push({ kind: 'svg', content: svg.outerHTML });
    });
    a.querySelectorAll('img').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.width > 50 && r.height > 50 && img.src) figures.push({ kind: 'img', src: img.src, alt: img.alt || '' });
    });
    a.querySelectorAll('canvas').forEach(c => {
      const r = c.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) {
        try { figures.push({ kind: 'canvas', dataURL: c.toDataURL('image/png') }); } catch (e) {}
      }
    });
  }
  return { stop, good, thinking, streaming, drIframe, text, figures };
}`,
		);

		// Deep Research body lives in a two-level iframe stack:
		//   outer:  <iframe title="internal://deep-research"
		//                   src="https://...oaiusercontent.com/?app=chatgpt">  (cross-origin)
		//     └── inner: <iframe id="root" src="about:blank">                 (same-origin
		//                                                                      with the outer)
		// Page-context JS can't read the outer iframe (different origin). We
		// route through Playwright's frame API via camofox-browser's
		// frame-evaluate patch: ask camofox to evaluate inside the outer
		// frame, and from THERE walk into root#contentDocument (same-origin
		// from the outer's perspective).
		let drText = "";
		let drDone = false;
		let drFigures: Figure[] = [];
		if (top.drIframe) {
			try {
				const info = await evalInTab<{
					text: string;
					done: boolean;
					figures: Figure[];
					reason?: string;
				}>(
					tabId,
					`() => {
  const root = document.getElementById('root');
  if (!root) return { text: '', done: false, figures: [], reason: 'no-root-iframe' };
  let doc;
  try { doc = root.contentDocument; } catch (e) { return { text: '', done: false, figures: [], reason: 'cross-origin: ' + e.message }; }
  if (!doc) return { text: '', done: false, figures: [], reason: 'no-contentDocument' };
  const body = doc.body;
  const text = body ? (body.innerText || '') : '';
  // ChatGPT signals completion with one of these markers depending on locale.
  // "Research completed in" appears in en-US, "リサーチが完了" in ja-JP, and
  // "件の検索" comes from the search-counter region right above the report.
  const done = /Research completed in/i.test(text)
            || /リサーチが完了/.test(text)
            || /research\\s*complete/i.test(text);
  const figures = [];
  if (body) {
    body.querySelectorAll('svg').forEach(svg => {
      const r = svg.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) figures.push({ kind: 'svg', content: svg.outerHTML });
    });
    body.querySelectorAll('img').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.width > 50 && r.height > 50 && img.src) figures.push({ kind: 'img', src: img.src, alt: img.alt || '' });
    });
    body.querySelectorAll('canvas').forEach(c => {
      const r = c.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) {
        try { figures.push({ kind: 'canvas', dataURL: c.toDataURL('image/png') }); } catch (e) {}
      }
    });
  }
  return { text, done, figures };
}`,
					"oaiusercontent.com",
				);
				drText = info.text || "";
				drDone = info.done || false;
				drFigures = info.figures || [];
			} catch (e) {
				vlog(`DR iframe probe error: ${(e as Error).message}`);
			}
		}

		const done = top.drIframe
			? drDone
			: top.good && !top.stop && !top.thinking && !top.streaming;
		const text = top.drIframe ? cleanDeepResearchText(drText) : top.text;
		const figures: Figure[] = top.drIframe ? drFigures : top.figures;
		const deepResearching = top.drIframe && !drDone;

		return {
			done,
			stopping: top.stop,
			thinking: top.thinking,
			streaming: top.streaming,
			deepResearching,
			text,
			figures,
		};
	});
}

async function closeConversationTab(tabId: string): Promise<void> {
	return cliMutex(async () => {
		try {
			await closeTab(tabId);
		} catch (e) {
			vlog(`closeTab(${tabId}) failed: ${(e as Error).message}`);
		}
	});
}

async function reloadConversationTab(tabId: string): Promise<void> {
	return cliMutex(async () => {
		await refreshTab(tabId);
	});
}

// ----------------------------------------------------------------------------
// Conversation log: save input/output/figures to chatgpt_log/<tool>/<ts>/
// ----------------------------------------------------------------------------

const LOG_DIR_BASE = process.env.CHATGPT_MCP_CONV_LOG_DIR || "chatgpt_log";

function resolveLogRoot(): string {
	if (path.isAbsolute(LOG_DIR_BASE)) return LOG_DIR_BASE;
	const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	return path.resolve(base, LOG_DIR_BASE);
}

function formatLogTimestamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

function inferImageExt(src: string, contentType: string | null): string {
	const m = src.match(/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i);
	if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
	if (contentType) {
		const m2 = contentType.match(/image\/([a-z0-9+.-]+)/i);
		if (m2) {
			const t = m2[1].toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
			return t;
		}
	}
	return "png";
}

function decodeDataUrl(url: string): { buffer: Buffer; ext: string } | null {
	const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
	if (!m) return null;
	const mime = m[1] || "application/octet-stream";
	const base64 = !!m[2];
	const payload = m[3];
	const buffer = base64
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "utf8");
	const ext = inferImageExt("", mime);
	return { buffer, ext };
}

async function fetchRemoteImage(src: string): Promise<{ buffer: Buffer; ext: string } | null> {
	try {
		const res = await fetch(src);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const ab = await res.arrayBuffer();
		return {
			buffer: Buffer.from(ab),
			ext: inferImageExt(src, res.headers.get("content-type")),
		};
	} catch (e) {
		log(`fetchRemoteImage(${src.slice(0, 80)}...) failed: ${(e as Error).message}`);
		return null;
	}
}

async function saveConversationLog(
	tool: string,
	prompt: string,
	text: string,
	figures: Figure[],
): Promise<string | null> {
	try {
		const baseDir = path.join(resolveLogRoot(), tool);
		mkdirSync(baseDir, { recursive: true });
		const ts = formatLogTimestamp();
		let dir = path.join(baseDir, ts);
		let n = 1;
		while (existsSync(dir)) {
			dir = path.join(baseDir, `${ts}_${n}`);
			n++;
		}
		mkdirSync(dir, { recursive: true });

		writeFileSync(path.join(dir, "input.md"), prompt + "\n", "utf8");

		let outputMd = text;
		if (figures.length > 0) {
			const figDir = path.join(dir, "figures");
			mkdirSync(figDir, { recursive: true });
			const links: string[] = [];
			let savedCount = 0;
			for (let i = 0; i < figures.length; i++) {
				const fig = figures[i];
				const n = i + 1;
				const alt = fig.alt || `Figure ${n}`;
				try {
					if (fig.kind === "svg") {
						const fname = `fig${n}.svg`;
						writeFileSync(path.join(figDir, fname), fig.content, "utf8");
						links.push(`![${alt}](figures/${fname})`);
						savedCount++;
					} else if (fig.kind === "canvas") {
						const decoded = decodeDataUrl(fig.dataURL);
						if (!decoded) throw new Error("cannot decode canvas dataURL");
						const fname = `fig${n}.${decoded.ext}`;
						writeFileSync(path.join(figDir, fname), decoded.buffer);
						links.push(`![${alt}](figures/${fname})`);
						savedCount++;
					} else if (fig.kind === "img") {
						let saved: { buffer: Buffer; ext: string } | null = null;
						if (fig.src.startsWith("data:")) {
							saved = decodeDataUrl(fig.src);
						} else {
							saved = await fetchRemoteImage(fig.src);
						}
						if (saved) {
							const fname = `fig${n}.${saved.ext}`;
							writeFileSync(path.join(figDir, fname), saved.buffer);
							links.push(`![${alt}](figures/${fname})`);
							savedCount++;
						} else {
							links.push(`![${alt}](${fig.src})`);
						}
					}
				} catch (e) {
					log(`figure ${n} save failed: ${(e as Error).message}`);
				}
			}
			outputMd =
				outputMd.trimEnd() +
				"\n\n---\n\n## Figures\n\n" +
				links.join("\n\n") +
				"\n";
			log(`saved ${savedCount}/${figures.length} figures locally`);
		}
		writeFileSync(path.join(dir, "output.md"), outputMd + "\n", "utf8");
		log(`saved conversation log to ${dir} (figures=${figures.length})`);
		return dir;
	} catch (e) {
		log(`saveConversationLog failed: ${(e as Error).message}`);
		return null;
	}
}

// ----------------------------------------------------------------------------
// Per-request flow
// ----------------------------------------------------------------------------

const STALE_RELOAD_AFTER_ITERS = 30;

let nextReqId = 1;

async function handleAsk(
	prompt: string,
	mode: ChipMode,
	maxWaitMs: number,
	toolName: string,
): Promise<string> {
	const id = nextReqId++;
	const head = prompt.slice(0, 40).replace(/\n/g, " ");
	log(`#${id} [${mode}] ask START "${head}..."`);

	await ensureDriverReady();

	const { convUrl, tabId } = await setupNewChatAndSend(prompt, mode);
	log(`#${id} [${mode}] conversation url=${convUrl} tabId=${tabId}`);

	const deadline = Date.now() + maxWaitMs;
	let iter = 0;
	let lastTextLen = -1;
	let noChangeIters = 0;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		iter++;
		let probe: CompletionProbe | null;
		try {
			probe = await probeConversation(tabId, convUrl);
		} catch (e) {
			vlog(`#${id} probe error: ${(e as Error).message}`);
			continue;
		}
		if (probe == null) {
			log(`#${id} tab disappeared for ${convUrl}`);
			throw new Error(`tab for ${convUrl} was closed externally`);
		}

		if (probe.text.length !== lastTextLen) {
			lastTextLen = probe.text.length;
			noChangeIters = 0;
		} else {
			noChangeIters++;
		}
		if (iter % 5 === 0) {
			log(
				`#${id} poll iter=${iter} done=${probe.done} stop=${probe.stopping} think=${probe.thinking} stream=${probe.streaming} dr=${probe.deepResearching} len=${probe.text.length}`,
			);
		}
		if (probe.done) {
			log(`#${id} DONE (${probe.text.length} chars, ${probe.figures.length} figures)`);
			const finalText = probe.text.trim();
			await saveConversationLog(toolName, prompt, finalText, probe.figures);
			try {
				await closeConversationTab(tabId);
			} catch (e) {
				log(`#${id} close tab failed: ${(e as Error).message}`);
			}
			return finalText;
		}
		if (
			!probe.stopping &&
			!probe.thinking &&
			!probe.streaming &&
			!probe.deepResearching &&
			noChangeIters >= STALE_RELOAD_AFTER_ITERS
		) {
			log(
				`#${id} DOM appears stale (iter=${iter} no change for ${noChangeIters} iters) — reloading`,
			);
			try {
				await reloadConversationTab(tabId);
			} catch (e) {
				log(`#${id} reload failed: ${(e as Error).message}`);
			}
			noChangeIters = 0;
		}
	}

	try {
		await closeConversationTab(tabId);
	} catch {}
	throw new Error(
		`Timed out after ${Math.round(maxWaitMs / 60000)} minutes for ${convUrl}`,
	);
}

// ----------------------------------------------------------------------------
// MCP tool
// ----------------------------------------------------------------------------

const DEEP_THINKER_TOOL: Tool = {
	name: "deep_thinker",
	description:
		"Ask a high-intelligence reasoning AI (ChatGPT Pro model with web search) to think deeply about a problem. The model does multi-step reasoning while consulting up-to-date web sources, and returns a considered answer. Best for: complex analysis, nuanced reasoning, code review, design tradeoffs, factual questions that need current data. Typical latency: 1–10 minutes. Each call opens an isolated chat tab, so multiple calls run concurrently without interfering.",
	inputSchema: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description:
					"The question or task to send. Be as specific as possible about what kind of answer you want.",
			},
		},
		required: ["prompt"],
	},
};

const DEEP_RESEARCHER_TOOL: Tool = {
	name: "deep_researcher",
	description:
		"Ask a deep-research AI (ChatGPT Pro model with Deep Research mode) to conduct a thorough multi-source investigation and return a report. Spends significantly more time browsing, cross-checking, and synthesizing than `deep_thinker`. Best for: literature reviews, comparative surveys, market/tech landscape reports, investigations that need many sources. Typical latency: 10–30+ minutes. Use only when the extra depth is worth the wait — prefer `deep_thinker` for normal questions.",
	inputSchema: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description:
					"A well-scoped research question. State the topic, what you want investigated, and what format the report should take.",
			},
		},
		required: ["prompt"],
	},
};

const server = new Server(
	{ name: "ChatGPT MCP Tool (web)", version: "5.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [DEEP_THINKER_TOOL, DEEP_RESEARCHER_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const { name, arguments: args } = request.params;
		if (!args) throw new Error("No arguments provided");
		const { prompt } = args as { prompt?: string };
		if (typeof prompt !== "string" || prompt.trim() === "")
			throw new Error("'prompt' is required and must be a non-empty string");

		let response: string;
		if (name === "deep_thinker") {
			response = await handleAsk(prompt, "web-search", MAX_WAIT_THINKER_MS, "deep_thinker");
		} else if (name === "deep_researcher") {
			response = await handleAsk(
				prompt,
				"deep-research",
				MAX_WAIT_RESEARCHER_MS,
				"deep_researcher",
			);
		} else {
			return {
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: response || "No response received from ChatGPT.",
				},
			],
			isError: false,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		log(`request error: ${msg}`);
		return {
			content: [{ type: "text", text: `Error: ${msg}` }],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(
	`server started pid=${process.pid} backend=${CAMOFOX_URL} userId=${CAMOFOX_USER_ID} cwd=${process.cwd()} conv_log_root=${resolveLogRoot()}`,
);
console.error("ChatGPT MCP Server (Camoufox backend) running on stdio");
