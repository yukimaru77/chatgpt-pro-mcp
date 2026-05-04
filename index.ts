#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const execFileP = promisify(execFile);

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const CLI = process.env.CHATGPT_MCP_PW_CLI || "playwright-cli";
const LOG_FILE = process.env.CHATGPT_MCP_LOG || "/tmp/chatgpt-mcp.log";
const VERBOSE = process.env.CHATGPT_MCP_VERBOSE === "1";
const MAX_WAIT_THINKER_MS =
	(Number(process.env.CHATGPT_MCP_THINKER_MAX_MIN) || 120) * 60 * 1000;
const MAX_WAIT_RESEARCHER_MS =
	(Number(process.env.CHATGPT_MCP_RESEARCHER_MAX_MIN) || 120) * 60 * 1000;
const COMPOSER_WAIT_MS = 30_000;
const URL_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const CLI_TIMEOUT_MS = 45_000;
const CLI_MAX_BUFFER = 20 * 1024 * 1024;

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
// Mutex. cliMutex は CLI サブプロセス同士の直列化、sessionMutex は
// 「タブ特定→操作」を原子的に束ねるための大粒度ロック。
// setup フェーズは sessionMutex で単一化。poll フェーズは各iterで cliMutex だけ取る。
// ----------------------------------------------------------------------------

function makeMutex() {
	let chain: Promise<unknown> = Promise.resolve();
	return async function run<T>(fn: () => Promise<T>): Promise<T> {
		const next = chain.then(fn, fn);
		chain = next.catch(() => {});
		return next;
	};
}
// すべての playwright-cli 操作を1本の Promise chain で直列化する。
// setup は大きなブロックを cliMutex で独占、poll の各iter も同じ cliMutex を
// 短時間取る。これで setup 中に poll の tab-select が割り込むのを防ぐ。
const cliMutex = makeMutex();

// ----------------------------------------------------------------------------
// playwright-cli subprocess primitives
// ----------------------------------------------------------------------------

async function execCliRaw(args: string[], timeout = CLI_TIMEOUT_MS): Promise<string> {
	try {
		const { stdout } = await execFileP(CLI, args, {
			timeout,
			maxBuffer: CLI_MAX_BUFFER,
			encoding: "utf8",
		});
		return stdout;
	} catch (e) {
		const err = e as NodeJS.ErrnoException & {
			stderr?: string;
			stdout?: string;
		};
		throw new Error(
			`pw(${args.join(" ")}) failed: ${err.message}${err.stderr ? " :: " + err.stderr.slice(0, 400) : ""}`,
		);
	}
}

// ロック付き実行(他リクエストとの衝突を防ぐ)。
async function pw(args: string[], timeout = CLI_TIMEOUT_MS): Promise<string> {
	return cliMutex(() => execCliRaw(args, timeout));
}

// eval 結果(JSON)をパース。--raw をつけても余計な出力が混じることがあるので
// 最後の有効な JSON-like ブロックを取り出す。
function parsePwOutput(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const candidates = [trimmed];
	const firstBlockEnd = trimmed.indexOf("\n### ");
	if (firstBlockEnd > 0) candidates.push(trimmed.slice(0, firstBlockEnd).trim());
	const firstLine = trimmed.split("\n")[0];
	if (firstLine) candidates.push(firstLine);
	return candidates[0];
}

async function pwEvalRaw(expr: string): Promise<string> {
	const out = await execCliRaw(["--raw", "eval", expr]);
	return parsePwOutput(out);
}

async function pwEval<T>(expr: string): Promise<T> {
	const raw = await pwEvalRaw(expr);
	try {
		return JSON.parse(raw) as T;
	} catch {
		return raw as unknown as T;
	}
}

async function pwEvalVoid(expr: string): Promise<void> {
	await pwEvalRaw(expr);
}

// ----------------------------------------------------------------------------
// Chrome attach lifecycle
// ----------------------------------------------------------------------------

let attached = false;
async function ensureAttached(): Promise<void> {
	if (attached) return;
	try {
		const list = await pw(["list"]);
		if (list.includes("default")) {
			attached = true;
			log(`already attached to Chrome`);
			return;
		}
	} catch {}
	log(`attaching to Chrome via CDP`);
	const cdpTarget = process.env.CHATGPT_MCP_CDP || "chrome";
	await pw(["attach", `--cdp=${cdpTarget}`], 60_000);
	attached = true;
}

// ----------------------------------------------------------------------------
// Tab listing
// ----------------------------------------------------------------------------

type TabInfo = { index: number; current: boolean; title: string; url: string };

function parseTabList(raw: string): TabInfo[] {
	const tabs: TabInfo[] = [];
	for (const line of raw.split("\n")) {
		const m = line.match(/^- (\d+):\s*(\(current\))?\s*\[(.*?)\]\((.*?)\)\s*$/);
		if (m)
			tabs.push({
				index: Number(m[1]),
				current: !!m[2],
				title: m[3],
				url: m[4],
			});
	}
	return tabs;
}

async function tabListLocked(): Promise<TabInfo[]> {
	return parseTabList(await execCliRaw(["--raw", "tab-list"]));
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
// - モデル: dropdown → Pro を選ぶ
// - Web検索: + ボタン → ウェブ検索 を押す(タブごとにトグル必要)
// どちらも playwright-cli の click (getByRole/getByTestId) を使う。JS .click()
// では React の pointer event ハンドラが拾わない場合があるため。
// ----------------------------------------------------------------------------

async function isProChipPresent(): Promise<boolean> {
	return (await pwEval<boolean>(
		`() => { const btns = document.querySelectorAll('form[data-type="unified-composer"] button[aria-haspopup="menu"]'); return Array.from(btns).some(b => /Pro/.test(b.innerText || '')); }`,
	)) === true;
}

async function isWebSearchChipPresent(): Promise<boolean> {
	return (await pwEval<boolean>(
		`() => !!document.querySelector('form[data-type="unified-composer"] button[aria-label^="検索"]')`,
	)) === true;
}

async function isDeepResearchChipPresent(): Promise<boolean> {
	// aria-label は "Deep Research：クリックして削除" (大文字R)。念のため大小両対応。
	return (await pwEval<boolean>(
		`() => !!document.querySelector('form[data-type="unified-composer"] button[aria-label^="Deep Research" i], form[data-type="unified-composer"] button[aria-label^="ディープリサーチ" i]')`,
	)) === true;
}

// 汎用: +メニューから menuitemradio を 1 つ選択する。
async function enableComposerTool(
	itemName: string,
	verify: () => Promise<boolean>,
	label: string,
): Promise<void> {
	if (await verify()) {
		log(`${label} chip already present — skip enable`);
		return;
	}
	let attempt = 0;
	while (attempt < 3) {
		attempt++;
		try {
			await execCliRaw(["click", "getByTestId('composer-plus-btn')"]);
			await sleep(500);
			await execCliRaw([
				"click",
				`getByRole('menuitemradio', { name: ${JSON.stringify(itemName)} })`,
			]);
			await sleep(400);
			if (await verify()) {
				log(`enable ${label} verified (attempt=${attempt})`);
				return;
			}
			log(`⚠️ ${label} chip not present after attempt ${attempt}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		} catch (e) {
			log(`enable ${label} attempt ${attempt} failed: ${(e as Error).message}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		}
	}
	throw new Error(`Could not enable ${label} chip after 3 attempts`);
}

// ウェブ検索/DeepResearchと同じく毎回明示的にドロップダウン→Pro を踏む。
// 「既に Pro っぽい」早期リターンはしない。
async function selectProModel(): Promise<void> {
	let attempt = 0;
	while (attempt < 3) {
		attempt++;
		try {
			await execCliRaw([
				"click",
				`locator('form[data-type="unified-composer"] button[aria-haspopup="menu"]:not([data-testid])').last()`,
			]);
			await sleep(400);
			await execCliRaw([
				"click",
				"getByRole('menuitemradio', { name: /^Pro/ })",
			]);
			await sleep(400);
			const ok = await isProChipPresent();
			if (ok) {
				log(`selectProModel verified (attempt=${attempt})`);
				return;
			}
			log(`⚠️ Pro chip not present after attempt ${attempt}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		} catch (e) {
			log(`selectProModel attempt ${attempt} failed: ${(e as Error).message}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		}
	}
	throw new Error(`Could not select Pro model after 3 attempts`);
}

async function enableWebSearchChip(): Promise<void> {
	await enableComposerTool("ウェブ検索", isWebSearchChipPresent, "web-search");
}

async function enableDeepResearchChip(): Promise<void> {
	await enableComposerTool(
		"Deep research",
		isDeepResearchChipPresent,
		"deep-research",
	);
}

// ----------------------------------------------------------------------------
// Setup: open tab → send prompt → acquire conversation URL
// sessionMutex で一括 = この間は他リクエストの tab-new/select と干渉しない。
// ----------------------------------------------------------------------------

type ChipMode = "web-search" | "deep-research";

async function setupNewChatAndSend(
	prompt: string,
	mode: ChipMode,
): Promise<string> {
	return cliMutex(async () => {
		// 1) 新規タブ(新しいタブが current になる)
		await execCliRaw(["tab-new", "https://chatgpt.com/"]);

		// 2) composer 出現を待つ
		await waitForLocked(
			async () =>
				(await pwEval<boolean>(
					`() => !!document.querySelector('#prompt-textarea')`,
				)) === true,
			COMPOSER_WAIT_MS,
			"composer ready",
		);

		// 3) 邪魔なダイアログがあれば閉じる
		await pwEvalVoid(`() => {
  const selectors = ['[role="dialog"] button[aria-label="閉じる"]', '[role="dialog"] button[aria-label="Close"]'];
  for (const s of selectors) document.querySelectorAll(s).forEach(b => b.click());
}`);
		await sleep(200);

		// 3.5) モデルを Pro に、ツールチップをモードに応じて有効化
		await selectProModel();
		if (mode === "web-search") {
			await enableWebSearchChip();
		} else {
			await enableDeepResearchChip();
		}

		// 4) プロンプト入力
		const jsonPrompt = JSON.stringify(prompt);
		await pwEvalVoid(`() => {
  const e = document.querySelector('#prompt-textarea');
  if (!e) throw new Error('composer not found');
  e.focus();
  document.execCommand('insertText', false, ${jsonPrompt});
}`);
		await sleep(300);

		// 5) 送信ボタン出現を少し待つ
		await waitForLocked(
			async () =>
				(await pwEval<boolean>(
					`() => !!document.querySelector('button[data-testid="send-button"]')`,
				)) === true,
			5_000,
			"send button available",
		);
		await pwEvalVoid(`() => {
  const b = document.querySelector('button[data-testid="send-button"]');
  if (!b) throw new Error('send button missing');
  b.click();
}`);

		// 6) URL が /c/<id> に切り替わるのを待つ(このタブの識別子)
		let url = "";
		await waitForLocked(
			async () => {
				url = await pwEval<string>(`() => location.href`);
				return /\/c\/[0-9a-f-]+/i.test(url);
			},
			URL_WAIT_MS,
			"conversation URL",
		);
		return url;
	});
}

// ----------------------------------------------------------------------------
// Poll: URL ベースでタブを特定して原子的に select+eval を行う
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
	deepResearching: boolean; // Deep Research iframe が居てまだ完了してない
	text: string;
	figures: Figure[]; // コンテンツ画像(SVG/IMG/Canvas)
};

// Deep Research の本文は nested iframe (about:blank, name="root") の中。
// 完了時はその body に "リサーチが完了しました" ヘッダが載る。
// 頭にカウンタアニメーションのゴミ文字列 (0\n1\n..9\n) が並ぶので除去する。
function cleanDeepResearchText(raw: string): string {
	let cleaned = raw.replace(/(?:\d\s*\n){5,}/g, "");
	const marker = "件の検索";
	const idx = cleaned.lastIndexOf(marker);
	if (idx >= 0) cleaned = cleaned.slice(idx + marker.length);
	return cleaned.trim();
}

async function execCliRunCode(code: string): Promise<string> {
	const out = await execCliRaw(["--raw", "run-code", code]);
	return parsePwOutput(out);
}

async function probeConversation(convUrl: string): Promise<CompletionProbe | null> {
	return cliMutex(async () => {
		const tabs = parseTabList(await execCliRaw(["--raw", "tab-list"]));
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return null;
		if (!found.current) {
			await execCliRaw(["tab-select", String(found.index)]);
		}

		// top-level DOM の状態を取る
		const top = await pwEval<{
			stop: boolean;
			good: boolean;
			thinking: boolean;
			streaming: boolean;
			drIframe: boolean;
			text: string;
			figures: Figure[];
		}>(`() => {
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
}`);

		// Deep Research モードなら nested iframe を読みに行く
		let drText = "";
		let drDone = false;
		let drFigures: Figure[] = [];
		if (top.drIframe) {
			try {
				const raw = await execCliRunCode(`async (page) => {
  const frames = page.frames();
  const rootFrame = frames.find(f => f.name() === 'root' || f.url() === 'about:blank');
  if (!rootFrame) return { text: '', done: false, figures: [], reason: 'no-root-frame' };
  try {
    const info = await rootFrame.evaluate(() => {
      const body = document.body;
      const text = body ? (body.innerText || '') : '';
      const done = /リサーチが完了しました/.test(text) || /research\\s*complete/i.test(text);
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
    });
    return info;
  } catch (e) { return { text: '', done: false, figures: [], reason: String(e) }; }
}`);
				const parsed = JSON.parse(raw) as {
					text: string;
					done: boolean;
					figures: Figure[];
					reason?: string;
				};
				drText = parsed.text || "";
				drDone = parsed.done || false;
				drFigures = parsed.figures || [];
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

async function closeConversationTab(convUrl: string): Promise<void> {
	return cliMutex(async () => {
		const tabs = parseTabList(await execCliRaw(["--raw", "tab-list"]));
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return;
		await execCliRaw(["tab-close", String(found.index)]);
	});
}

async function reloadConversationTab(convUrl: string): Promise<void> {
	return cliMutex(async () => {
		const tabs = parseTabList(await execCliRaw(["--raw", "tab-list"]));
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return;
		if (!found.current) {
			await execCliRaw(["tab-select", String(found.index)]);
		}
		await execCliRaw(["reload"]);
	});
}

// ----------------------------------------------------------------------------
// Conversation log: save input/output/figures to chatgpt_log/<tool>/<ts>/
// ----------------------------------------------------------------------------

const LOG_DIR_BASE = process.env.CHATGPT_MCP_CONV_LOG_DIR || "chatgpt_log";

// 解決基準: CHATGPT_MCP_CONV_LOG_DIR が絶対パスならそれを使う。
// 相対パスなら、Claude Code が流してくる $CLAUDE_PROJECT_DIR を優先し、
// 無ければ process.cwd() にフォールバック。
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

function inferImageExt(
	src: string,
	contentType: string | null,
): string {
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

function decodeDataUrl(
	url: string,
): { buffer: Buffer; ext: string } | null {
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

async function fetchRemoteImage(
	src: string,
): Promise<{ buffer: Buffer; ext: string } | null> {
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
						let saved:
							| { buffer: Buffer; ext: string }
							| null = null;
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
							// フェッチ失敗時は remote URL をそのまま貼る
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

const STALE_RELOAD_AFTER_ITERS = 30; // stallしてるっぽい時にreloadしてみる閾値

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

	await ensureAttached();

	// setup(他リクエストと直列化される)
	const convUrl = await setupNewChatAndSend(prompt, mode);
	log(`#${id} [${mode}] conversation url: ${convUrl}`);

	// poll(他リクエストとは並列に進む、各 iter だけ cliMutex を取る)
	const deadline = Date.now() + maxWaitMs;
	let iter = 0;
	let lastTextLen = -1;
	let noChangeIters = 0;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		iter++;
		let probe: CompletionProbe | null;
		try {
			probe = await probeConversation(convUrl);
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
			log(
				`#${id} DONE (${probe.text.length} chars, ${probe.figures.length} figures)`,
			);
			const finalText = probe.text.trim();
			await saveConversationLog(toolName, prompt, finalText, probe.figures);
			try {
				await closeConversationTab(convUrl);
			} catch (e) {
				log(`#${id} close tab failed: ${(e as Error).message}`);
			}
			return finalText;
		}
		// DOM が反映されてないっぽい場合はリロードで救済
		// ただし Deep Research iframe が居る間は触らない(リロードで研究が飛ぶ)
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
				await reloadConversationTab(convUrl);
			} catch (e) {
				log(`#${id} reload failed: ${(e as Error).message}`);
			}
			noChangeIters = 0;
		}
	}

	try {
		await closeConversationTab(convUrl);
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
				description: "The question or task to send. Be as specific as possible about what kind of answer you want.",
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
				description: "A well-scoped research question. State the topic, what you want investigated, and what format the report should take.",
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
			response = await handleAsk(
				prompt,
				"web-search",
				MAX_WAIT_THINKER_MS,
				"deep_thinker",
			);
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
	`server started pid=${process.pid} cli=${CLI} log=${LOG_FILE} cwd=${process.cwd()} conv_log_root=${resolveLogRoot()}`,
);
console.error("ChatGPT MCP Server (web) running on stdio");
