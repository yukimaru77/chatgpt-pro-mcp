#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	isInitializeRequest,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const execFileP = promisify(execFile);

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

type ChatModel = "pro" | "thinking";
type ChipMode = "web-search" | "deep-research";
type SlotKind = ChatModel | "deep_research";

type AppConfig = {
	defaults?: {
		model?: string;
		project?: string;
	};
	projects?: Record<string, string | { label?: string; name?: string }>;
	parallelLimits?: {
		thinking?: number;
		pro?: number;
		deep_research?: number;
		deepResearch?: number;
	};
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_CANDIDATES = [
	path.resolve(process.cwd(), "chatgpt-mcp.yaml"),
	path.resolve(MODULE_DIR, "chatgpt-mcp.yaml"),
	path.resolve(MODULE_DIR, "..", "chatgpt-mcp.yaml"),
];

function loadConfig(): { path: string | null; data: AppConfig } {
	for (const candidate of CONFIG_CANDIDATES) {
		if (!existsSync(candidate)) continue;
		const raw = readFileSync(candidate, "utf8");
		const parsed = parseYaml(raw);
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Config ${candidate} must contain a YAML object`);
		}
		return { path: candidate, data: parsed as AppConfig };
	}
	return { path: null, data: {} };
}

const CONFIG = loadConfig();

function normalizeModel(value: unknown, fallback: ChatModel): ChatModel {
	if (value == null || value === "") return fallback;
	if (typeof value !== "string") {
		throw new Error("'model' must be a string: pro or thinking");
	}
	const normalized = value.trim().toLowerCase().replace(/[_\s-]+/g, "");
	if (normalized === "pro") return "pro";
	if (normalized === "thinking" || normalized === "think") return "thinking";
	throw new Error(`Unknown model: ${value}. Expected "pro" or "thinking".`);
}

function positiveInt(value: unknown, fallback: number): number {
	if (value == null) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) return fallback;
	return n;
}

const DEFAULT_MODEL = normalizeModel(CONFIG.data.defaults?.model, "pro");
const PROJECTS = CONFIG.data.projects || {};
const DEFAULT_PROJECT_KEY =
	(process.env.CHATGPT_MCP_PROJECT || CONFIG.data.defaults?.project || "").trim() ||
	null;
const SLOT_LIMITS: Record<SlotKind, number> = {
	thinking: positiveInt(CONFIG.data.parallelLimits?.thinking, 5),
	pro: positiveInt(CONFIG.data.parallelLimits?.pro, 3),
	deep_research: positiveInt(
		CONFIG.data.parallelLimits?.deep_research ??
			CONFIG.data.parallelLimits?.deepResearch,
		3,
	),
};

type ResolvedProject = {
	key: string;
	label: string;
};

type AskResult = {
	text: string;
	conversationUrl: string;
	chatId: string | null;
	logDir: string | null;
};

function projectLabelFor(keyOrLabel: string): string {
	const entry = PROJECTS[keyOrLabel];
	if (typeof entry === "string") return entry.trim() || keyOrLabel;
	if (entry && typeof entry === "object") {
		return (entry.label || entry.name || keyOrLabel).trim() || keyOrLabel;
	}
	return keyOrLabel;
}

function resolveProject(value: unknown): ResolvedProject | null {
	const raw =
		value == null || value === ""
			? DEFAULT_PROJECT_KEY
			: typeof value === "string"
				? value.trim()
				: (() => {
						throw new Error("'project' must be a string project key or label");
					})();
	if (!raw) return null;
	if (/^(none|null|off|false|no-project)$/i.test(raw)) return null;
	return { key: raw, label: projectLabelFor(raw) };
}

function extractChatId(value: string | null | undefined): string | null {
	const raw = (value || "").trim();
	if (!raw) return null;
	const fromUrl = raw.match(/\/c\/([0-9a-f-]+)/i);
	if (fromUrl) return fromUrl[1];
	const bareId = raw.match(/^([0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,})$/i);
	return bareId ? bareId[1] : null;
}

function resolveConversationUrl(value: unknown): string | null {
	if (value == null || value === "") return null;
	if (typeof value !== "string") {
		throw new Error(
			"'chatId' or 'conversationUrl' must be a ChatGPT chat id or URL string",
		);
	}
	const raw = value.trim();
	if (!raw) return null;
	if (/^https:\/\/chatgpt\.com\//i.test(raw) || /^https:\/\/chat\.openai\.com\//i.test(raw)) {
		const id = extractChatId(raw);
		if (!id) throw new Error("'conversationUrl' must include /c/<chat-id>");
		return raw;
	}
	const id = extractChatId(raw);
	if (!id) {
		throw new Error(
			"'chatId' must look like a ChatGPT conversation id, or pass a full conversationUrl",
		);
	}
	return `https://chatgpt.com/c/${id}`;
}

const CAMOFOX_BASE_URL =
	process.env.CHATGPT_MCP_CAMOFOX_URL ||
	process.env.CAMOFOX_BASE_URL ||
	"http://127.0.0.1:9377";
const CAMOFOX_USER_ID =
	process.env.CHATGPT_MCP_CAMOFOX_USER_ID ||
	process.env.CAMOFOX_USER_ID ||
	"default";
const CAMOFOX_SESSION_KEY =
	process.env.CHATGPT_MCP_CAMOFOX_SESSION_KEY ||
	process.env.CAMOFOX_SESSION_KEY ||
	"default";
const CAMOFOX_API_KEY =
	process.env.CHATGPT_MCP_CAMOFOX_API_KEY ||
	process.env.CAMOFOX_API_KEY ||
	(() => {
		const envPath =
			process.env.CHATGPT_MCP_CAMOFOX_ENV ||
			"/home/yukimaru/camofox-mcp/.env";
		try {
			const raw = readFileSync(envPath, "utf8");
			return raw.match(/^CAMOFOX_API_KEY=(.*)$/m)?.[1]?.trim() || "";
		} catch {
			return "";
		}
	})();
const LOG_FILE = process.env.CHATGPT_MCP_LOG || "/tmp/chatgpt-mcp.log";
const VERBOSE = process.env.CHATGPT_MCP_VERBOSE === "1";
const MAX_WAIT_THINKER_MS =
	(Number(process.env.CHATGPT_MCP_THINKER_MAX_MIN) || 120) * 60 * 1000;
const MAX_WAIT_RESEARCHER_MS =
	(Number(process.env.CHATGPT_MCP_RESEARCHER_MAX_MIN) || 120) * 60 * 1000;
const COMPOSER_WAIT_MS = 30_000;
const URL_WAIT_MS = 30_000;
const RATE_LIMIT_DETECT_DELAY_MS = 3_000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const CAMOFOX_TIMEOUT_MS = 45_000;
const ENABLE_TEST_TOOLS =
	process.argv.includes("--enable-test-tools") ||
	process.env.CHATGPT_MCP_ENABLE_TEST_TOOLS === "1";
const HTTP_MODE =
	process.argv.includes("--http") || process.env.CHATGPT_MCP_HTTP === "1";
const HTTP_HOST = process.env.CHATGPT_MCP_HTTP_HOST || "127.0.0.1";
const HTTP_PORT = (() => {
	const idx = process.argv.indexOf("--port");
	const raw =
		idx >= 0 ? process.argv[idx + 1] : process.env.CHATGPT_MCP_HTTP_PORT;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : 3333;
})();

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

class SlotQueue {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(
		private readonly name: SlotKind,
		private readonly limit: number,
	) {}

	async acquire(reqId: number): Promise<() => void> {
		const queuedBefore = this.waiters.length;
		log(
			`#${reqId} slot ${this.name} waiting active=${this.active}/${this.limit} queued=${queuedBefore}`,
		);
		if (this.active < this.limit && this.waiters.length === 0) {
			this.active++;
		} else {
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
			});
		}
		log(
			`#${reqId} slot ${this.name} acquired active=${this.active}/${this.limit} queued=${this.waiters.length}`,
		);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) {
				next();
			} else {
				this.active--;
			}
			log(
				`#${reqId} slot ${this.name} released active=${this.active}/${this.limit} queued=${this.waiters.length}`,
			);
		};
	}

	stats() {
		return {
			limit: this.limit,
			active: this.active,
			queued: this.waiters.length,
		};
	}
}

// すべてのブラウザ操作を1本の Promise chain で直列化する。
// setup は大きなブロックを cliMutex で独占、poll の各iter も同じ cliMutex を
// 短時間取る。これで setup 中に poll の tab-select が割り込むのを防ぐ。
const cliMutex = makeMutex();

const slotQueues: Record<SlotKind, SlotQueue> = {
	thinking: new SlotQueue("thinking", SLOT_LIMITS.thinking),
	pro: new SlotQueue("pro", SLOT_LIMITS.pro),
	deep_research: new SlotQueue("deep_research", SLOT_LIMITS.deep_research),
};

// ----------------------------------------------------------------------------
// Request status tracking
// ----------------------------------------------------------------------------

type RequestPhase =
	| "waiting"
	| "setup"
	| "rate_limited"
	| "polling"
	| "done"
	| "error";

type RequestRecord = {
	id: number;
	tool: string;
	mode: ChipMode;
	model: ChatModel;
	project?: string;
	projectLabel?: string;
	slot: SlotKind;
	phase: RequestPhase;
	promptPreview: string;
	startedAt: string;
	updatedAt: string;
	slotAcquiredAt?: string;
	conversationUrl?: string;
	chatId?: string | null;
	pollIter?: number;
	textLength?: number;
	finalTextLength?: number;
	responseSource?: "copy" | "dom";
	copyLength?: number;
	figures?: number;
	completedAt?: string;
	error?: string;
};

const SERVER_STARTED_AT = new Date();
const REQUEST_HISTORY_LIMIT = 100;
const requestRecords = new Map<number, RequestRecord>();
let setupPausedUntil = 0;
let setupPauseReason = "";

function nowIso(): string {
	return new Date().toISOString();
}

function updateRequestRecord(id: number, patch: Partial<RequestRecord>) {
	const existing = requestRecords.get(id);
	if (!existing) return;
	requestRecords.set(id, {
		...existing,
		...patch,
		updatedAt: nowIso(),
	});
	pruneRequestRecords();
}

function pruneRequestRecords() {
	const completed = [...requestRecords.values()]
		.filter((r) => r.phase === "done" || r.phase === "error")
		.sort((a, b) => a.id - b.id);
	const excess = completed.length - REQUEST_HISTORY_LIMIT;
	for (let i = 0; i < excess; i++) {
		requestRecords.delete(completed[i].id);
	}
}

function summarizeRequest(r: RequestRecord) {
	return {
		id: r.id,
		tool: r.tool,
		mode: r.mode,
		model: r.model,
		project: r.project,
		projectLabel: r.projectLabel,
		slot: r.slot,
		phase: r.phase,
		promptPreview: r.promptPreview,
		startedAt: r.startedAt,
		updatedAt: r.updatedAt,
		slotAcquiredAt: r.slotAcquiredAt,
		conversationUrl: r.conversationUrl,
		chatId: r.chatId,
		pollIter: r.pollIter,
		textLength: r.textLength,
		finalTextLength: r.finalTextLength,
		responseSource: r.responseSource,
		copyLength: r.copyLength,
		figures: r.figures,
		completedAt: r.completedAt,
		error: r.error,
	};
}

function getServerStatus(completedLimit = 20) {
	const records = [...requestRecords.values()].sort((a, b) => a.id - b.id);
	const live = records.filter((r) => r.phase !== "done" && r.phase !== "error");
	const completed = records
		.filter((r) => r.phase === "done" || r.phase === "error")
		.sort((a, b) => b.id - a.id)
		.slice(0, completedLimit);

	return {
		server: {
			pid: process.pid,
			startedAt: SERVER_STARTED_AT.toISOString(),
			uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT.getTime()) / 1000),
			cwd: process.cwd(),
			configPath: CONFIG.path,
			defaultModel: DEFAULT_MODEL,
			defaultProject: DEFAULT_PROJECT_KEY,
			availableProjects: Object.keys(PROJECTS),
		},
		slots: {
			thinking: slotQueues.thinking.stats(),
			pro: slotQueues.pro.stats(),
			deep_research: slotQueues.deep_research.stats(),
		},
		counts: {
			waiting: records.filter((r) => r.phase === "waiting").length,
			setup: records.filter((r) => r.phase === "setup").length,
			rateLimited: records.filter((r) => r.phase === "rate_limited").length,
			polling: records.filter((r) => r.phase === "polling").length,
			done: records.filter((r) => r.phase === "done").length,
			error: records.filter((r) => r.phase === "error").length,
		},
		setupPause: {
			active: Date.now() < setupPausedUntil,
			until: setupPausedUntil > 0 ? new Date(setupPausedUntil).toISOString() : null,
			remainingSeconds: Math.max(0, Math.ceil((setupPausedUntil - Date.now()) / 1000)),
			reason: setupPauseReason,
		},
		live: live.map(summarizeRequest),
		recentCompleted: completed.map(summarizeRequest),
	};
}

// ----------------------------------------------------------------------------
// Camoufox browser API primitives
// ----------------------------------------------------------------------------

type CamofoxTab = {
	tabId: string;
	targetId?: string;
	title?: string;
	url?: string;
};

let currentTabId: string | null = null;

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs = CAMOFOX_TIMEOUT_MS,
	label = "camoufox request",
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function camofoxRequest<T>(
	method: string,
	pathname: string,
	body?: unknown,
	timeoutMs = CAMOFOX_TIMEOUT_MS,
): Promise<T> {
	const url = new URL(pathname, CAMOFOX_BASE_URL);
	const headers: Record<string, string> = {};
	if (CAMOFOX_API_KEY) headers.authorization = `Bearer ${CAMOFOX_API_KEY}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await withTimeout(
		fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		timeoutMs,
		`${method} ${url.pathname}`,
	);
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`Camoufox ${method} ${url.pathname} failed HTTP ${res.status}: ${text.slice(0, 400)}`,
		);
	}
	if (!text.trim()) return undefined as T;
	return JSON.parse(text) as T;
}

async function camofoxHealth(): Promise<void> {
	const health = await camofoxRequest<{ ok?: boolean; running?: boolean }>(
		"GET",
		"/health",
	);
	if (health.ok === false || health.running === false) {
		throw new Error(`Camoufox server is not ready: ${JSON.stringify(health)}`);
	}
}

async function camofoxTabs(): Promise<CamofoxTab[]> {
	const data = await camofoxRequest<{ tabs?: CamofoxTab[] }>(
		"GET",
		`/tabs?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
	);
	return data.tabs || [];
}

async function camofoxCreateTab(url: string): Promise<CamofoxTab> {
	const tab = await camofoxRequest<CamofoxTab>("POST", "/tabs", {
		url,
		userId: CAMOFOX_USER_ID,
		sessionKey: CAMOFOX_SESSION_KEY,
	});
	currentTabId = tab.tabId || tab.targetId || null;
	if (!currentTabId) throw new Error("Camoufox did not return a tabId");
	return { ...tab, tabId: currentTabId };
}

async function camofoxCloseTab(tabId: string): Promise<void> {
	await camofoxRequest("DELETE", `/tabs/${encodeURIComponent(tabId)}`, {
		userId: CAMOFOX_USER_ID,
	});
	if (currentTabId === tabId) currentTabId = null;
}

async function getCurrentTabId(): Promise<string> {
	if (currentTabId) return currentTabId;
	const tabs = await camofoxTabs();
	if (tabs.length === 0) return (await camofoxCreateTab("https://chatgpt.com/")).tabId;
	currentTabId = tabs.at(-1)?.tabId || null;
	if (!currentTabId) throw new Error("No Camoufox tab available");
	return currentTabId;
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
	const tabId = await getCurrentTabId();
	const expression = normalizeEvaluateExpression(expr);
	const data = await camofoxRequest<{ result?: unknown } | unknown>(
		"POST",
		`/tabs/${encodeURIComponent(tabId)}/evaluate`,
		{ expression, userId: CAMOFOX_USER_ID },
	);
	const value =
		data && typeof data === "object" && "result" in data
			? (data as { result?: unknown }).result
			: data;
	return parsePwOutput(typeof value === "string" ? value : JSON.stringify(value));
}

function normalizeEvaluateExpression(expr: string): string {
	const trimmed = expr.trim();
	if (
		trimmed.startsWith("() =>") ||
		trimmed.startsWith("async () =>") ||
		trimmed.startsWith("function")
	) {
		return `(${trimmed})()`;
	}
	return trimmed;
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

async function pwEvalFrame<T>(
	frame: { frameName?: string; frameUrlIncludes?: string; frameIndex?: number },
	expr: string,
	timeout = CAMOFOX_TIMEOUT_MS,
): Promise<T> {
	const tabId = await getCurrentTabId();
	const expression = normalizeEvaluateExpression(expr);
	const data = await camofoxRequest<
		{ ok?: boolean; result?: unknown; error?: string } | unknown
	>(
		"POST",
		`/tabs/${encodeURIComponent(tabId)}/evaluate-frame`,
		{
			userId: CAMOFOX_USER_ID,
			expression,
			timeout,
			...frame,
		},
		timeout + 10_000,
	);
	if (data && typeof data === "object" && "ok" in data && data.ok === false) {
		throw new Error((data as { error?: string }).error || "frame evaluation failed");
	}
	const value =
		data && typeof data === "object" && "result" in data
			? (data as { result?: unknown }).result
			: data;
	return value as T;
}

async function execCliRaw(args: string[]): Promise<string> {
	const normalized = args[0] === "--raw" ? args.slice(1) : args;
	const [cmd, ...rest] = normalized;
	if (cmd === "tab-new") {
		await camofoxCreateTab(rest[0] || "about:blank");
		return "";
	}
	if (cmd === "tab-list") {
		const tabs = await tabListLocked();
		return tabs
			.map(
				(t) =>
					`- ${t.index}: ${t.current ? "(current) " : ""}[${t.title}](${t.url})`,
			)
			.join("\n");
	}
	if (cmd === "tab-select") {
		const tabs = await tabListLocked();
		const tab = tabs[Number(rest[0])];
		if (!tab) throw new Error(`No Camoufox tab at index ${rest[0]}`);
		currentTabId = tab.tabId;
		return "";
	}
	if (cmd === "tab-close") {
		const tabs = await tabListLocked();
		const tab = tabs[Number(rest[0])];
		if (tab) await camofoxCloseTab(tab.tabId);
		return "";
	}
	if (cmd === "reload") {
		const tabId = await getCurrentTabId();
		await camofoxRequest("POST", `/tabs/${encodeURIComponent(tabId)}/reload`, {
			userId: CAMOFOX_USER_ID,
		});
		return "";
	}
	if (cmd === "click") {
		const tabId = await getCurrentTabId();
		await camofoxRequest("POST", `/tabs/${encodeURIComponent(tabId)}/click`, {
			selector: legacySelectorToCss(rest.join(" ")),
			userId: CAMOFOX_USER_ID,
		});
		return "";
	}
	if (cmd === "press") {
		const tabId = await getCurrentTabId();
		await camofoxRequest("POST", `/tabs/${encodeURIComponent(tabId)}/press`, {
			key: rest[0],
			userId: CAMOFOX_USER_ID,
		});
		return "";
	}
	if (cmd === "eval") return pwEvalRaw(rest.join(" "));
	throw new Error(`Unsupported browser command after Camoufox migration: ${args.join(" ")}`);
}

function legacySelectorToCss(selector: string): string {
	if (selector === "getByTestId('composer-plus-btn')") {
		return '[data-testid="composer-plus-btn"]';
	}
	if (selector.includes("menuitemradio")) {
		const m = selector.match(/name:\s*(?:\/(.+)\/i|(["'])(.*?)\2)/);
		const needle = m?.[1] || m?.[3] || "";
		if (/web|ウェブ/i.test(needle)) return '[role="menuitemradio"]:has-text("Web search"), [role="menuitemradio"]:has-text("ウェブ検索")';
		if (/deep/i.test(needle)) return '[role="menuitemradio"]:has-text("Deep research"), [role="menuitemradio"]:has-text("Deep Research"), [role="menuitemradio"]:has-text("ディープリサーチ")';
		if (/pro/i.test(needle)) return '[role="menuitemradio"]:has-text("Pro")';
		if (/thinking|heavy|思考|推論/i.test(needle)) return '[role="menuitemradio"]:has-text("Thinking"), [role="menuitemradio"]:has-text("Heavy"), [role="menuitemradio"]:has-text("思考"), [role="menuitemradio"]:has-text("推論")';
	}
	if (selector.includes("form:has(#prompt-textarea)") && selector.includes("aria-haspopup")) {
		return 'form:has(#prompt-textarea) button[aria-haspopup="menu"]:not(#composer-plus-btn)';
	}
	return selector
		.replace(/^locator\((['"])(.*)\1\)\.last\(\)$/, "$2")
		.replace(/^locator\((['"])(.*)\1\)$/, "$2");
}

// ----------------------------------------------------------------------------
// Camoufox lifecycle
// ----------------------------------------------------------------------------

let attached = false;
async function ensureAttached(): Promise<void> {
	if (attached) return;
	await camofoxHealth();
	attached = true;
	log(`connected to Camoufox browser API at ${CAMOFOX_BASE_URL}`);
}

// ----------------------------------------------------------------------------
// Tab listing
// ----------------------------------------------------------------------------

type TabInfo = { index: number; current: boolean; title: string; url: string; tabId: string };

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
				tabId: "",
			});
	}
	return tabs;
}

async function tabListLocked(): Promise<TabInfo[]> {
	const tabs = await camofoxTabs();
	return tabs.map((tab, index) => ({
		index,
		current: tab.tabId === currentTabId,
		title: tab.title || "",
		url: tab.url || "",
		tabId: tab.tabId,
	}));
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
// メニュー操作はフォーカス + Enter を使う。Camoufoxの通常clickは、
// ChatGPTの一部コンポーザーボタンで安定待ちが長引く場合があるため。
// ----------------------------------------------------------------------------

async function isProChipPresent(): Promise<boolean> {
	return (await pwEval<boolean>(
		`() => {
  const form = document.querySelector('form:has(#prompt-textarea)') || document.querySelector('#prompt-textarea')?.closest('form');
  const btns = form ? form.querySelectorAll('button[aria-haspopup="menu"]') : [];
  return Array.from(btns).some(b => {
    const text = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim();
    return /^(Pro(?:\\s*[•·-].*)?|GPT-.*Pro)$/i.test(text);
  });
}`,
	)) === true;
}

async function isThinkingChipPresent(): Promise<boolean> {
	return (await pwEval<boolean>(
		`() => {
  const form = document.querySelector('form:has(#prompt-textarea)') || document.querySelector('#prompt-textarea')?.closest('form');
  const btns = form ? form.querySelectorAll('button[aria-haspopup="menu"]') : [];
  return Array.from(btns).some(b => /Thinking|Heavy|思考|推論|深い|じっくり/i.test(b.innerText || b.textContent || ''));
}`,
	)) === true;
}

async function isWebSearchChipPresent(): Promise<boolean> {
	return (await pwEval<boolean>(
		`() => {
  const form = document.querySelector('form:has(#prompt-textarea)') || document.querySelector('#prompt-textarea')?.closest('form');
  if (!form) return false;
  return Array.from(form.querySelectorAll('button')).some(b => {
    const text = (b.innerText || b.textContent || '').trim();
    const aria = b.getAttribute('aria-label') || '';
    return /^検索/.test(text) || /^検索/.test(aria) || /^Search/i.test(text) || /^Search/i.test(aria) || /^ウェブ検索/i.test(text) || /^Web search/i.test(text);
  });
}`,
	)) === true;
}

async function isDeepResearchChipPresent(): Promise<boolean> {
	// aria-label は "Deep Research：クリックして削除" (大文字R)。念のため大小両対応。
	return (await pwEval<boolean>(
		`() => {
  const form = document.querySelector('form:has(#prompt-textarea)') || document.querySelector('#prompt-textarea')?.closest('form');
  if (!form) return false;
  return Array.from(form.querySelectorAll('button')).some(b => {
    const text = (b.innerText || b.textContent || '').trim();
    const aria = b.getAttribute('aria-label') || '';
    return /^Deep research/i.test(text) || /^Deep Research/i.test(aria) || /^ディープリサーチ/i.test(text) || /^ディープリサーチ/i.test(aria);
  });
}`,
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
			const jsonItemName = JSON.stringify(itemName);
			await pwEvalVoid(`() => {
  const expected = ${jsonItemName};
  const candidates = [...document.querySelectorAll('[role="menuitemradio"]')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const item = candidates.find(el => {
    const role = el.getAttribute('role') || '';
    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (/web|ウェブ/i.test(expected)) return role === 'menuitemradio' && /^(web search|ウェブ検索)$/i.test(text);
    if (/deep/i.test(expected)) return role === 'menuitemradio' && /^(deep research|ディープリサーチ)$/i.test(text);
    return text === expected;
  });
  if (!item) {
    const visible = candidates.map(el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
    throw new Error('composer tool item not found: ' + expected + ' visible=' + JSON.stringify(visible.slice(0, 12)));
  }
  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));
  item.setAttribute('data-chatgpt-mcp-click-target', 'composer-tool');
}`);
			await execCliRaw(["click", "[data-chatgpt-mcp-click-target='composer-tool']"]);
			await pwEvalVoid(`() => document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'))`);
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

// ウェブ検索/DeepResearchと同じく毎回明示的にドロップダウン→モデル選択を踏む。
// 「既に選択済みっぽい」早期リターンはしない。
async function selectChatModel(model: ChatModel): Promise<void> {
	const verify = model === "pro" ? isProChipPresent : isThinkingChipPresent;
	let attempt = 0;
	while (attempt < 3) {
		attempt++;
		try {
			await pwEvalVoid(`() => {
  const form = document.querySelector('form:has(#prompt-textarea)') || document.querySelector('#prompt-textarea')?.closest('form');
  if (!form) throw new Error('composer form not found');
  const candidates = [...form.querySelectorAll('button[aria-haspopup="menu"]')]
    .filter(el => el.id !== 'composer-plus-btn')
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const trigger = candidates.at(-1);
  if (!trigger) throw new Error('model menu trigger not found');
  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));
  trigger.setAttribute('data-chatgpt-mcp-click-target', 'model-trigger');
	}`);
				await execCliRaw(["click", "[data-chatgpt-mcp-click-target='model-trigger']"]);
				await sleep(400);
				const jsonModel = JSON.stringify(model);
				const selection = await pwEval<{
					selected: boolean;
					fallbackAccepted: boolean;
					visible: string[];
				}>(`() => {
	  const model = ${jsonModel};
	  const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
	  const candidates = [...document.querySelectorAll('[role="menuitemradio"]')]
	    .filter(el => {
	      const r = el.getBoundingClientRect();
	      return r.width > 0 && r.height > 0;
	    });
	  const item = candidates.find(el => {
	     const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
	    if (model === 'pro') return /^(Pro(?:\\s*[•·-].*)?|GPT-.*Pro)$/i.test(text);
	    return /^(Thinking\\s*•?\\s*Heavy|Thinking|Heavy)$/i.test(text) || /思考|推論/.test(text);
	  });
	  const visible = candidates.map(el => normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '')).filter(Boolean);
	  if (!item) {
	    if (model === 'pro') {
	      return { selected: false, fallbackAccepted: true, visible: visible.slice(0, 12) };
	    }
	    throw new Error('model menu item not found: ' + model + ' visible=' + JSON.stringify(visible.slice(0, 12)));
	  }
	  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));
	  item.setAttribute('data-chatgpt-mcp-click-target', 'model-item');
	  item.click();
	  return { selected: true, fallbackAccepted: false, visible: visible.slice(0, 12) };
	}`);
				if (selection.fallbackAccepted) {
					log(
						`selectChatModel ${model}: exact Pro item not visible; accepting current ChatGPT model visible=${JSON.stringify(selection.visible)}`,
					);
					try {
						await execCliRaw(["press", "Escape"]);
					} catch {}
					return;
				}
				await pwEvalVoid(`() => document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'))`);
				await sleep(400);
				const ok = await verify();
				if (ok) {
					log(`selectChatModel ${model} verified (attempt=${attempt})`);
					return;
				}
				if (model === "pro" && selection.selected) {
					log(`selectChatModel ${model} selected but chip text was not detectable; continuing`);
					return;
				}
			log(`⚠️ ${model} chip not present after attempt ${attempt}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		} catch (e) {
			log(`selectChatModel ${model} attempt ${attempt} failed: ${(e as Error).message}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(300);
		}
	}
	throw new Error(`Could not select ${model} model after 3 attempts`);
}

async function ensureSidebarOpenForProjects(): Promise<void> {
	const visibleProjectCount = await pwEval<number>(`() => {
  const isClickable = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return top === el || el.contains(top);
  };
  return [...document.querySelectorAll('a[href*="/project"]')]
    .filter(isClickable).length;
}`);
	if (visibleProjectCount > 0) return;

	await pwEvalVoid(`() => {
  const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
  const button = [...document.querySelectorAll('button')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .find(el => {
      const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      return /^(Open sidebar|サイドバーを開く)$/.test(text) || /Open sidebar|サイドバーを開く/.test(text);
    });
  if (!button) throw new Error('open sidebar button not found');
  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));
  button.setAttribute('data-chatgpt-mcp-click-target', 'open-sidebar');
}`);
	const clicked = await desktopClickSelector(
		"[data-chatgpt-mcp-click-target='open-sidebar']",
	);
	if (!clicked) {
		await execCliRaw(["click", "[data-chatgpt-mcp-click-target='open-sidebar']"]);
	}
	await waitForLocked(
		async () =>
			(await pwEval<number>(`() => {
  const isClickable = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return top === el || el.contains(top);
  };
  return [...document.querySelectorAll('a[href*="/project"]')]
    .filter(isClickable).length;
}`)) > 0,
		5_000,
		"sidebar projects visible",
	);
}

async function selectChatProject(project: ResolvedProject | null): Promise<void> {
	if (!project) return;
	const label = project.label;
	let attempt = 0;
	while (attempt < 3) {
		attempt++;
		try {
			await ensureSidebarOpenForProjects();
			const visible = await pwEval<string[]>(`() => {
  const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
  const isClickable = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return top === el || el.contains(top);
  };
  return [...document.querySelectorAll('a[href*="/project"]')]
    .filter(isClickable)
    .map(el => normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || ''))
    .filter(Boolean);
}`);
			log(`selectChatProject visible projects=${JSON.stringify(visible.slice(0, 20))}`);
			await pwEvalVoid(`() => {
  const targetLabel = ${JSON.stringify(label)};
  const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
  const isClickable = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return top === el || el.contains(top);
  };
  const anchors = [...document.querySelectorAll('a[href*="/project"]')]
    .filter(el => {
      const href = el.getAttribute('href') || '';
      return href.includes('/project') && isClickable(el);
    });
  const exact = anchors.find(el => normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '') === targetLabel);
  const item = exact || anchors.find(el => normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '').includes(targetLabel));
  if (!item) {
    const visible = anchors.map(el => normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '')).filter(Boolean);
    throw new Error('project not found: ' + targetLabel + ' visible=' + JSON.stringify(visible.slice(0, 20)));
  }
  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));
  item.scrollIntoView({ block: 'center', inline: 'nearest' });
  item.setAttribute('data-chatgpt-mcp-click-target', 'project-item');
}`);
			await sleep(200);
			const clicked = await desktopClickSelector(
				"[data-chatgpt-mcp-click-target='project-item']",
			);
			if (!clicked) {
				await execCliRaw(["click", "[data-chatgpt-mcp-click-target='project-item']"]);
			}
			await sleep(1_200);
			await waitForLocked(
				async () =>
					(await pwEval<boolean>(`() => {
  const label = ${JSON.stringify(label)};
  const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const heading = [...main.querySelectorAll('h1,h2,[role="heading"]')]
    .map(el => normalize(el.innerText || el.textContent || ''))
    .find(Boolean) || '';
  const composer = document.querySelector('#prompt-textarea');
  const composerText = normalize(composer?.innerText || composer?.textContent || composer?.getAttribute('aria-label') || '');
  const placeholder = normalize(composer?.getAttribute('data-placeholder') || composer?.getAttribute('placeholder') || '');
  return location.href.includes('/project') &&
    !!composer &&
    (heading === label || heading.includes(label) || composerText.includes(label) || placeholder.includes(label));
}`)) === true,
				URL_WAIT_MS,
				`project ${label} ready`,
			);
			await pwEvalVoid(`() => document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'))`);
			log(`selectChatProject ${project.key} label=${label} verified (attempt=${attempt})`);
			return;
		} catch (e) {
			log(`selectChatProject ${project.key} attempt ${attempt} failed: ${(e as Error).message}`);
			try {
				await execCliRaw(["press", "Escape"]);
			} catch {}
			await sleep(500);
		}
	}
	throw new Error(`Could not select project ${project.key} (${label}) after 3 attempts`);
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

type RateLimitState = {
	rateLimited: boolean;
	snippet: string;
};

async function detectRateLimitLocked(): Promise<RateLimitState> {
	return pwEval<RateLimitState>(`() => {
  const roots = [
    document.querySelector('main'),
    ...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [data-testid*="toast" i], [class*="toast" i]')
  ].filter(Boolean);
  let text = roots.map(el => el.innerText || el.textContent || '').join('\\n');
  if (!text.trim()) {
    const clone = document.body?.cloneNode(true);
    clone?.querySelectorAll('nav, aside, [data-testid*="history" i], [class*="sidebar" i]').forEach(el => el.remove());
    text = clone?.innerText || clone?.textContent || '';
  }
  const patterns = [
    /too many requests/i,
    /rate limit/i,
    /try again later/i,
    /unusual activity/i,
    /リクエスト.*多すぎ/i,
    /リクエスト.*多い/i,
    /リクエストの頻度が高すぎ/i,
    /会話へのアクセスを一時的に制限/i,
    /数分待ってから/i,
    /時間をおいて/i,
    /しばらくして/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m.index != null) {
      return {
        rateLimited: true,
        snippet: text.slice(Math.max(0, m.index - 160), Math.min(text.length, m.index + 320)).trim()
      };
    }
  }
  return { rateLimited: false, snippet: '' };
}`);
}

async function markCurrentTabLocked(marker: string): Promise<void> {
	await pwEvalVoid(`() => { window.name = ${JSON.stringify(marker)}; }`);
}

async function selectMarkedTabLocked(marker: string): Promise<void> {
	const tabs = await tabListLocked();
	let found: TabInfo | null = null;
	for (const tab of tabs) {
		try {
			const name = await camofoxRequest<{ result?: string }>(
				"POST",
				`/tabs/${encodeURIComponent(tab.tabId)}/evaluate`,
				{ expression: "(() => window.name || '')()", userId: CAMOFOX_USER_ID },
			);
			if (name.result === marker) {
				found = tab;
				break;
			}
		} catch {}
	}
	if (!found) throw new Error(`setup tab disappeared before rate-limit retry`);
	currentTabId = found.tabId;
}

async function closeMarkedTab(marker: string): Promise<void> {
	return cliMutex(async () => {
		const tabs = await tabListLocked();
		for (const tab of tabs) {
			try {
				const name = await camofoxRequest<{ result?: string }>(
					"POST",
					`/tabs/${encodeURIComponent(tab.tabId)}/evaluate`,
					{ expression: "(() => window.name || '')()", userId: CAMOFOX_USER_ID },
				);
				if (name.result === marker) {
					await camofoxCloseTab(tab.tabId);
					return;
				}
			} catch {}
		}
	});
}

// ----------------------------------------------------------------------------
// Setup: open tab → send prompt → acquire conversation URL
// sessionMutex で一括 = この間は他リクエストの tab-new/select と干渉しない。
// ----------------------------------------------------------------------------

type SetupAttempt =
	| { kind: "sent"; convUrl: string }
	| { kind: "rate_limited"; snippet: string };

type TestSetupAttempt =
	| { kind: "typed"; marker: string; url: string }
	| { kind: "rate_limited"; snippet: string };

function pauseSetupForRateLimit(reqId: number, snippet: string) {
	const until = Date.now() + RATE_LIMIT_BACKOFF_MS;
	if (until > setupPausedUntil) {
		setupPausedUntil = until;
		setupPauseReason = snippet;
	}
	log(
		`#${reqId} setup globally paused until ${new Date(setupPausedUntil).toISOString()} due to ChatGPT rate limit`,
	);
}

async function waitForSetupPause(reqId: number): Promise<void> {
	while (Date.now() < setupPausedUntil) {
		const remainingMs = setupPausedUntil - Date.now();
		updateRequestRecord(reqId, {
			phase: "rate_limited",
			error: `Global setup pause due to ChatGPT rate limit; retry after ${new Date(setupPausedUntil).toISOString()}: ${setupPauseReason}`,
		});
		log(
			`#${reqId} setup paused for ${Math.ceil(remainingMs / 1000)}s; polling only until retry`,
		);
		await sleep(Math.min(remainingMs, 60_000));
	}
	updateRequestRecord(reqId, {
		phase: "setup",
		error: undefined,
	});
}

async function setupNewChatAndSend(
	prompt: string,
	mode: ChipMode,
	model: ChatModel,
	project: ResolvedProject | null,
	existingConversationUrl: string | null,
	reqId: number,
): Promise<string> {
	const marker = `chatgpt-mcp-setup-${process.pid}-${reqId}-${Date.now()}`;
	let opened = false;
	let attempt = 0;

	while (true) {
		attempt++;
		await waitForSetupPause(reqId);
		const result = await cliMutex<SetupAttempt>(async () => {
			if (!opened) {
				// 1) 新規タブ(新しいタブが current になる)
				await execCliRaw(["tab-new", existingConversationUrl || "https://chatgpt.com/"]);
				await markCurrentTabLocked(marker);
				opened = true;
			} else {
				await selectMarkedTabLocked(marker);
				await execCliRaw(["reload"]);
			}

			await sleep(RATE_LIMIT_DETECT_DELAY_MS);
			const rateLimit = await detectRateLimitLocked();
			if (rateLimit.rateLimited) {
				pauseSetupForRateLimit(reqId, rateLimit.snippet);
				return { kind: "rate_limited", snippet: rateLimit.snippet };
			}

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

		// 3.5) モデルとツールチップを明示的に選択
		if (!existingConversationUrl) {
			await selectChatProject(project);
		}
		await selectChatModel(model);
		if (mode === "web-search") {
			await enableWebSearchChip();
		} else {
			await enableDeepResearchChip();
		}

		// 4) プロンプト入力
		await pwEvalVoid(`() => {
  const e = document.querySelector('#prompt-textarea');
  if (!e) throw new Error('composer not found');
  e.focus();
  e.textContent = '';
  e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
}`);
		await execCliRaw(["click", "#prompt-textarea"]);
		await camofoxRequest("POST", `/tabs/${encodeURIComponent(await getCurrentTabId())}/type`, {
			selector: "#prompt-textarea",
			text: prompt,
			userId: CAMOFOX_USER_ID,
		});
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
		log(`#${reqId} trying desktop coordinate click for send`);
		await desktopClickSelector("button[data-testid='send-button'], button#composer-submit-button");
		await sleep(2_000);
		const afterClickUrl = await pwEval<string>(`() => location.href`);
		const composerStillHasText = await pwEval<boolean>(`() => {
  const e = document.querySelector('#prompt-textarea');
  return !!e && (e.textContent || '').trim().length > 0;
}`);
		if (!/\/c\/[0-9a-f-]+/i.test(afterClickUrl) || composerStillHasText) {
			log(`#${reqId} send desktop click did not appear to submit; pressing Enter fallback`);
			await pwEvalVoid(`() => document.querySelector('#prompt-textarea')?.focus()`);
			await execCliRaw(["press", "Enter"]);
		}

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
			return { kind: "sent", convUrl: url };
		});

		if (result.kind === "sent") return result.convUrl;

		log(
			`#${reqId} ChatGPT rate-limited during setup attempt=${attempt}; waiting ${Math.round(RATE_LIMIT_BACKOFF_MS / 60000)} min before reload retry: ${result.snippet.slice(0, 240)}`,
		);
		updateRequestRecord(reqId, {
			phase: "rate_limited",
			error: result.snippet,
		});
		await sleep(RATE_LIMIT_BACKOFF_MS);
		updateRequestRecord(reqId, {
			phase: "setup",
			error: undefined,
		});
	}
}

async function setupNewChatAndTypePrompt(
	prompt: string,
	mode: ChipMode,
	model: ChatModel,
	project: ResolvedProject | null,
	reqId: number,
): Promise<{ marker: string; url: string }> {
	const marker = `chatgpt-mcp-test-${process.pid}-${reqId}-${Date.now()}`;
	let opened = false;
	let attempt = 0;

	while (true) {
		attempt++;
		await waitForSetupPause(reqId);
		const result = await cliMutex<TestSetupAttempt>(async () => {
			if (!opened) {
				await execCliRaw(["tab-new", "https://chatgpt.com/"]);
				await markCurrentTabLocked(marker);
				opened = true;
			} else {
				await selectMarkedTabLocked(marker);
				await execCliRaw(["reload"]);
			}

			await sleep(RATE_LIMIT_DETECT_DELAY_MS);
			const rateLimit = await detectRateLimitLocked();
			if (rateLimit.rateLimited) {
				pauseSetupForRateLimit(reqId, rateLimit.snippet);
				return { kind: "rate_limited", snippet: rateLimit.snippet };
			}

			await waitForLocked(
				async () =>
					(await pwEval<boolean>(
						`() => !!document.querySelector('#prompt-textarea')`,
					)) === true,
				COMPOSER_WAIT_MS,
				"composer ready",
			);

			await pwEvalVoid(`() => {
  const selectors = ['[role="dialog"] button[aria-label="閉じる"]', '[role="dialog"] button[aria-label="Close"]'];
  for (const s of selectors) document.querySelectorAll(s).forEach(b => b.click());
}`);
			await sleep(200);

			await selectChatProject(project);
			await selectChatModel(model);
			if (mode === "web-search") {
				await enableWebSearchChip();
			} else {
				await enableDeepResearchChip();
			}

			await pwEvalVoid(`() => {
  const e = document.querySelector('#prompt-textarea');
  if (!e) throw new Error('composer not found');
  e.focus();
  e.textContent = '';
  e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
}`);
			await execCliRaw(["click", "#prompt-textarea"]);
			await camofoxRequest("POST", `/tabs/${encodeURIComponent(await getCurrentTabId())}/type`, {
				selector: "#prompt-textarea",
				text: prompt,
				userId: CAMOFOX_USER_ID,
			});
			await sleep(300);

			await waitForLocked(
				async () =>
					(await pwEval<boolean>(
						`() => !!document.querySelector('button[data-testid="send-button"]')`,
					)) === true,
				5_000,
				"send button available",
			);
			const url = await pwEval<string>(`() => location.href`);
			return { kind: "typed", marker, url };
		});

		if (result.kind === "typed") return { marker: result.marker, url: result.url };

		log(
			`#${reqId} ChatGPT rate-limited during test setup attempt=${attempt}; waiting ${Math.round(RATE_LIMIT_BACKOFF_MS / 60000)} min before reload retry: ${result.snippet.slice(0, 240)}`,
		);
		updateRequestRecord(reqId, {
			phase: "rate_limited",
			error: result.snippet,
		});
		await sleep(RATE_LIMIT_BACKOFF_MS);
		updateRequestRecord(reqId, {
			phase: "setup",
			error: undefined,
		});
	}
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

function chooseFinalResponseText(
	probeText: string,
	copiedMarkdown: string | null,
): { text: string; source: "copy" | "dom"; reason: string } {
	const dom = probeText.trim();
	const copied = copiedMarkdown?.trim() || "";
	if (!copied) return { text: dom, source: "dom", reason: "copy unavailable" };
	if (dom.length >= 2_000 && copied.length < Math.min(1_000, dom.length * 0.25)) {
		return {
			text: dom,
			source: "dom",
			reason: `copy too short (${copied.length} < dom ${dom.length})`,
		};
	}
	return { text: copied, source: "copy", reason: "copy accepted" };
}

async function probeConversation(convUrl: string): Promise<CompletionProbe | null> {
	return cliMutex(async () => {
		const tabs = await tabListLocked();
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
  const turns = [...document.querySelectorAll('section[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]')];
  const turn = turns.at(-1);
  const good = !!turn?.querySelector('button[data-testid="good-response-turn-action-button"], button[aria-label="Good response"]');
  const a = turn?.querySelector('[data-message-author-role="assistant"]') || turn;
  const md = a?.querySelector('div[class*="markdown"], .markdown') || a;
  const cls = md?.className || '';
  const thinking = cls.includes('result-thinking');
  const streaming = cls.includes('result-streaming');
  const drIframe = !!turn?.querySelector('iframe[title="internal://deep-research"]');
  const text = md ? (md.innerText || md.textContent || '') : '';
  const figures = [];
  if (md) {
    md.querySelectorAll('svg').forEach(svg => {
      const r = svg.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) figures.push({ kind: 'svg', content: svg.outerHTML });
    });
    md.querySelectorAll('img').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.width > 50 && r.height > 50 && img.src) figures.push({ kind: 'img', src: img.src, alt: img.alt || '' });
    });
    md.querySelectorAll('canvas').forEach(c => {
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
					const parsed = await pwEvalFrame<{
						text: string;
						done: boolean;
						figures: Figure[];
					reason?: string;
				}>(
					{ frameName: "root" },
					`() => {
      const body = document.body;
      const text = body ? (body.innerText || '') : '';
      const done = /リサーチが完了しました/.test(text) || /research\\s*complete/i.test(text) || /Research completed/i.test(text);
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
					30_000,
					);
					drText = parsed.text || "";
					drDone = parsed.done || false;
					drFigures = Array.isArray(parsed.figures) ? parsed.figures : [];
				} catch (e) {
					vlog(`DR iframe probe error: ${(e as Error).message}`);
				}
			}

			const topLevelDone = top.good && !top.stop && !top.thinking && !top.streaming;
			const done = top.drIframe ? drDone || topLevelDone : topLevelDone;
			const topText = typeof top.text === "string" ? top.text : "";
			const topFigures = Array.isArray(top.figures) ? top.figures : [];
			const text = top.drIframe && drText ? cleanDeepResearchText(drText) : topText;
			const figures: Figure[] =
				top.drIframe && drFigures.length > 0 ? drFigures : topFigures;
		const deepResearching = top.drIframe && !done;

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
		const tabs = await tabListLocked();
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return;
		await camofoxCloseTab(found.tabId);
	});
}

async function reloadConversationTab(convUrl: string): Promise<void> {
	return cliMutex(async () => {
		const tabs = await tabListLocked();
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return;
		if (!found.current) currentTabId = found.tabId;
		await execCliRaw(["reload"]);
	});
}

async function runX11Command(command: string, args: string[]): Promise<string> {
	const { stdout } = await execFileP(command, args, {
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			DISPLAY: process.env.DISPLAY || "unix/:1",
			XAUTHORITY:
				process.env.XAUTHORITY ||
				`/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/gdm/Xauthority`,
		},
	});
	return stdout;
}

function parseWindowOrigin(xwininfo: string): { x: number; y: number } {
	const x = xwininfo.match(/Absolute upper-left X:\s+(-?\d+)/)?.[1];
	const y = xwininfo.match(/Absolute upper-left Y:\s+(-?\d+)/)?.[1];
	if (x == null || y == null) throw new Error("Could not parse Camoufox window origin");
	return { x: Number(x), y: Number(y) };
}

function parseWindowClientOrigin(xwininfo: string): { x: number; y: number } {
	const abs = parseWindowOrigin(xwininfo);
	const relX = xwininfo.match(/Relative upper-left X:\s+(-?\d+)/)?.[1];
	const relY = xwininfo.match(/Relative upper-left Y:\s+(-?\d+)/)?.[1];
	return {
		x: abs.x + Number(relX || 0),
		y: abs.y + Number(relY || 0),
	};
}

async function visibleCamoufoxWindowId(): Promise<string> {
	const out = await runX11Command("wmctrl", ["-lx"]);
	const candidates = out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => /Navigator\.camoufox-default/.test(line));
	const line = candidates.at(-1);
	if (!line) throw new Error("No visible Camoufox content window found");
	return line.split(/\s+/)[0];
}

async function desktopClickSelector(selector: string): Promise<boolean> {
	try {
		const rect = await pwEval<{
			x: number;
			y: number;
			width: number;
			height: number;
			chromeTop: number;
			chromeLeft: number;
		} | null>(`() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    chromeTop: Math.max(0, window.outerHeight - window.innerHeight),
    chromeLeft: Math.max(0, window.outerWidth - window.innerWidth)
  };
}`);
		if (!rect || rect.width <= 0 || rect.height <= 0) return false;
		const windowId = await visibleCamoufoxWindowId();
		const origin = parseWindowClientOrigin(
			await runX11Command("xwininfo", ["-id", windowId]),
		);
		const x = Math.round(origin.x + rect.x + rect.width / 2);
		const y = Math.round(origin.y + rect.y + rect.height / 2);
		await execFileP("/home/yukimaru/camofox-mcp/scripts/camofox-input-shield.sh", ["off"], {
			timeout: 5_000,
		}).catch(() => {});
		await sleep(300);
		await runX11Command("xdotool", ["windowactivate", windowId]).catch(() => "");
		await runX11Command("xdotool", ["windowraise", windowId]).catch(() => "");
		await runX11Command("xdotool", ["mousemove", String(x), String(y)]);
		await runX11Command("xdotool", ["mousedown", "1"]);
		await sleep(60);
		await runX11Command("xdotool", ["mouseup", "1"]);
		await sleep(300);
		await execFileP("/home/yukimaru/camofox-mcp/scripts/camofox-input-shield.sh", ["on"], {
			timeout: 5_000,
		}).catch(() => {});
		log(`desktop click selector=${selector} at ${x},${y}`);
		return true;
	} catch (e) {
		await execFileP("/home/yukimaru/camofox-mcp/scripts/camofox-input-shield.sh", ["on"], {
			timeout: 5_000,
		}).catch(() => {});
		log(`desktop click failed selector=${selector}: ${(e as Error).message}`);
		return false;
	}
}

async function readXClipboard(): Promise<string | null> {
	try {
		const { stdout } = await execFileP("xclip", ["-selection", "clipboard", "-o"], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 20 * 1024 * 1024,
			env: {
				...process.env,
				DISPLAY: process.env.DISPLAY || "unix/:1",
				XAUTHORITY:
					process.env.XAUTHORITY ||
					`/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/gdm/Xauthority`,
			},
		});
		return stdout.trim() || null;
	} catch (e) {
		vlog(`readXClipboard failed: ${(e as Error).message}`);
		return null;
	}
}

async function copyLatestResponseMarkdown(convUrl: string): Promise<string | null> {
	return cliMutex(async () => {
		const tabs = await tabListLocked();
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return null;
		currentTabId = found.tabId;

		await pwEvalVoid(`() => {
  const root = document.scrollingElement || document.documentElement || document.body;
  root.scrollTop = root.scrollHeight;
  window.scrollTo(0, document.body?.scrollHeight || root.scrollHeight);
  const scrollers = [...document.querySelectorAll('main, [class*="overflow"], [data-radix-scroll-area-viewport]')];
  for (const el of scrollers) {
    try { el.scrollTop = el.scrollHeight; } catch {}
  }
}`);
		const prepared = await waitForCopyResponseTarget();
		if (!prepared) return null;
		await sleep(300);
		const before = await readXClipboard();
		await execCliRaw(["click", "[data-chatgpt-mcp-click-target='copy-response']"]);
		let after: string | null = null;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			await sleep(250);
			after = await readXClipboard();
			if (after && after !== before) break;
		}
		await pwEvalVoid(`() => document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'))`);
		if (!after || after === before) return null;
		return after;
	});
}

async function waitForCopyResponseTarget(timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const prepared = await pwEval<boolean>(`() => {
  const turns = [...document.querySelectorAll('section[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]')];
  const turn = turns.at(-1);
  if (!turn) return false;
  turn.scrollIntoView({ block: 'end' });
  document.querySelectorAll('[data-chatgpt-mcp-click-target]').forEach(el => el.removeAttribute('data-chatgpt-mcp-click-target'));

  const groups = [...turn.querySelectorAll('[role="group"][aria-label="Response actions"]')];
  const responseActions = groups.at(-1);
  const scopedButtons = responseActions
    ? [...responseActions.querySelectorAll('button')]
    : [...turn.querySelectorAll('button')];

  const copy = scopedButtons
    .find(b => /^(Copy response|コピー|応答をコピー)$/i.test((b.getAttribute('aria-label') || '').trim()))
    || scopedButtons.find(b =>
      b.getAttribute('data-testid') === 'copy-turn-action-button' &&
      /copy/i.test((b.getAttribute('aria-label') || '').trim()) &&
      !/message|prompt/i.test((b.getAttribute('aria-label') || '').trim())
    );
  if (!copy) return false;

  const r = copy.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  copy.scrollIntoView({ block: 'center', inline: 'center' });
  copy.setAttribute('data-chatgpt-mcp-click-target', 'copy-response');
  return true;
}`);
		if (prepared) return true;
		await sleep(500);
	}
	return false;
}

type DeepResearchSource = {
	index: number;
	title: string;
	url: string;
	snippet?: string;
};

async function collectDeepResearchSources(): Promise<DeepResearchSource[]> {
	const target = await pwEvalFrame<{
		index: string;
		rect: { x: number; y: number; width: number; height: number };
	} | null>(
		{ frameName: "root" },
		`() => {
  const sup = [...document.querySelectorAll('sup[data-citation-index]')]
    .find(el => /^\\d+$/.test(el.getAttribute('data-citation-index') || ''));
  if (!sup) return null;
  sup.scrollIntoView({ block: 'center', inline: 'center' });
  const r = sup.getBoundingClientRect();
  return {
    index: sup.getAttribute('data-citation-index') || '',
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}`,
		10_000,
	);
	if (!target) return [];

	const iframe = await pwEval<{
		x: number;
		y: number;
		width: number;
		height: number;
	} | null>(`() => {
  const iframe = document.querySelector('iframe[title="internal://deep-research"]');
  if (!iframe) return null;
  const r = iframe.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`);
	if (!iframe) return [];

	const windowId = await visibleCamoufoxWindowId();
	const origin = parseWindowClientOrigin(await runX11Command("xwininfo", ["-id", windowId]));
	const x = Math.round(origin.x + iframe.x + target.rect.x + target.rect.width / 2);
	const y = Math.round(origin.y + iframe.y + target.rect.y + target.rect.height / 2);

	try {
		await execFileP("/home/yukimaru/camofox-mcp/scripts/camofox-input-shield.sh", ["off"], {
			timeout: 5_000,
		}).catch(() => {});
		await sleep(200);
		await runX11Command("xdotool", ["windowactivate", windowId]).catch(() => "");
		await runX11Command("xdotool", ["windowraise", windowId]).catch(() => "");
		await runX11Command("xdotool", ["mousemove", String(x), String(y)]);
		await runX11Command("xdotool", ["mousedown", "1"]);
		await sleep(60);
		await runX11Command("xdotool", ["mouseup", "1"]);
		await sleep(800);
	} finally {
		await execFileP("/home/yukimaru/camofox-mcp/scripts/camofox-input-shield.sh", ["on"], {
			timeout: 5_000,
		}).catch(() => {});
	}

	const sources = await pwEvalFrame<DeepResearchSource[]>(
		{ frameName: "root" },
		`() => {
  function clean(s) {
    return (s || '').replace(/\\s+/g, ' ').trim();
  }
  const sections = [...document.querySelectorAll('section, div')]
    .filter(el => /Citations\\s*·|Sources/.test(el.innerText || ''))
    .sort((a, b) => (a.querySelectorAll('a[href]').length - b.querySelectorAll('a[href]').length));
  const panel = sections.find(el => el.querySelectorAll('button a[href]').length > 0)
    || sections.find(el => el.querySelectorAll('a[href]').length > 0);
  if (!panel) return [];

  const rows = [...panel.querySelectorAll('button')]
    .map(button => {
      const links = [...button.querySelectorAll('a[href]')]
        .map(a => ({ text: clean(a.innerText || a.textContent), href: a.href }))
        .filter(a => /^https?:\\/\\//.test(a.href));
      if (links.length === 0) return null;
      const lines = (button.innerText || button.textContent || '')
        .split('\\n')
        .map(clean)
        .filter(Boolean);
      const num = Number(lines.find(line => /^\\d+$/.test(line)) || 0);
      if (!num) return null;
      const url = links[0].href;
      const title = lines.find(line => !/^\\d+$/.test(line) && line !== url && !/^https?:\\/\\//.test(line))
        || links.find(link => link.text && link.text !== url)?.text
        || url;
      const snippet = lines.find(line =>
        line !== title &&
        line !== url &&
        !/^\\d+$/.test(line) &&
        !/^https?:\\/\\//.test(line) &&
        line.length > 20
      );
      return { index: num, title, url, snippet };
    })
    .filter(Boolean);

  const seen = new Set();
  return rows.filter(row => {
    const key = row.index + ' ' + row.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.index - b.index || a.url.localeCompare(b.url));
}`,
		10_000,
	);
	return sources || [];
}

function appendDeepResearchSources(markdown: string, sources: DeepResearchSource[]): string {
	if (sources.length === 0) return markdown;
	const lines = ["", "## Sources", ""];
	for (const source of sources) {
		const title = source.title.replace(/\]/g, "\\]");
		lines.push(`[${source.index}] [${title}](${source.url})`);
		if (source.snippet) lines.push(`    ${source.snippet}`);
	}
	return `${markdown.trimEnd()}\n${lines.join("\n")}`.trim();
}

function linkDeepResearchInlineCitations(
	markdown: string,
	sources: DeepResearchSource[],
): string {
	if (sources.length === 0) return markdown;
	const urlsByIndex = new Map<number, string>();
	for (const source of sources) {
		if (!urlsByIndex.has(source.index)) urlsByIndex.set(source.index, source.url);
	}

	const sourceHeading = markdown.match(/\n## Sources\s*(?:\n|$)/);
	const body = sourceHeading ? markdown.slice(0, sourceHeading.index) : markdown;
	const rest = sourceHeading ? markdown.slice(sourceHeading.index) : "";

	return (
		body
			.split(/(```[\s\S]*?```)/g)
			.map((part) => {
				if (part.startsWith("```")) return part;
				return part.replace(/(?<!\[)\[(\d+)\](?![\]\(])/g, (match, raw) => {
					const url = urlsByIndex.get(Number(raw));
					return url ? `[[${raw}]](${url})` : match;
				});
			})
			.join("") + rest
	);
}

async function extractDeepResearchMarkdown(convUrl: string): Promise<string | null> {
	return cliMutex(async () => {
		const tabs = await tabListLocked();
		const found = tabs.find((t) => t.url === convUrl);
		if (!found) return null;
		currentTabId = found.tabId;
		const sources = await collectDeepResearchSources().catch((e) => {
			log(`deep research source collection failed: ${(e as Error).message}`);
			return [] as DeepResearchSource[];
		});

		const result = await pwEvalFrame<{ markdown?: string; title?: string }>(
			{ frameName: "root" },
			`async () => {
  const citationRefs = new Map();

  function cleanText(text) {
    return (text || '').replace(/\\s+/g, ' ').trim();
  }

	  function escapeMd(text) {
	    const tick = String.fromCharCode(96);
	    return (text || '').replace(/\\\\/g, '\\\\\\\\').replace(new RegExp(tick, 'g'), '\\\\' + tick);
	  }

  function escapeTableCell(text) {
    return cleanText(text).replace(/\\|/g, '\\\\|');
  }

  function getDoc() {
    const nested = [...document.querySelectorAll('iframe')]
      .find((f) => {
        try { return (f.contentDocument?.body?.innerText || '').trim().length > 100; }
        catch { return false; }
      });
    return nested?.contentDocument || document;
  }

  function findContainer(doc) {
    const preferred = [...doc.querySelectorAll('div')]
      .filter((el) => {
        const text = el.innerText || el.textContent || '';
        return el.querySelector('h1') && text.length > 500 && !/^root$/i.test(el.id || '');
      })
      .sort((a, b) => {
        const al = (a.innerText || a.textContent || '').length;
        const bl = (b.innerText || b.textContent || '').length;
        const aMeta = /Research completed|searches|citations/.test((a.innerText || '').slice(0, 120)) ? 1 : 0;
        const bMeta = /Research completed|searches|citations/.test((b.innerText || '').slice(0, 120)) ? 1 : 0;
        if (aMeta !== bMeta) return aMeta - bMeta;
        return al - bl;
      });
    return preferred[0] || doc.querySelector('article') || doc.querySelector('main') || doc.body;
  }

  async function revealMermaidCode(doc) {
    const buttons = [...doc.querySelectorAll('button')]
      .filter((button) => cleanText(button.innerText || button.textContent) === 'Show code');
    for (const button of buttons) button.click();
    if (buttons.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function citationForSup(node) {
    const raw = node.getAttribute('data-citation-index') || cleanText(node.textContent);
    if (!/^\\d+$/.test(raw)) return '';
    return '[' + raw + ']';
  }

  function processChildren(node) {
    let out = '';
    for (const child of node.childNodes) out += processNode(child);
    return out;
  }

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path') return '';
    if (tag === 'sup' && el.matches('[data-citation-index], [role="button"]')) {
      return citationForSup(el);
    }

    if (tag === 'a' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      const text = cleanText(processChildren(el)) || href;
      return '[' + text.replace(/\\]/g, '\\\\]') + '](' + href + ')';
    }

    if (tag === 'pre') return processPre(el);
    if (tag === 'table') return processTable(el);

    const children = processChildren(el);
    switch (tag) {
      case 'h1': return '# ' + cleanText(children) + '\\n\\n';
      case 'h2': return '## ' + cleanText(children) + '\\n\\n';
      case 'h3': return '### ' + cleanText(children) + '\\n\\n';
      case 'h4': return '#### ' + cleanText(children) + '\\n\\n';
      case 'h5': return '##### ' + cleanText(children) + '\\n\\n';
      case 'h6': return '###### ' + cleanText(children) + '\\n\\n';
      case 'p': return cleanText(children) + '\\n\\n';
      case 'strong':
      case 'b': return '**' + children.trim() + '**';
      case 'em':
      case 'i': return '*' + children.trim() + '*';
	      case 'code':
	        if (el.parentElement?.tagName?.toLowerCase() === 'pre') return el.textContent || '';
	        return String.fromCharCode(96) + escapeMd(el.textContent || children) + String.fromCharCode(96);
      case 'br': return '\\n';
      case 'blockquote':
        return children.trim().split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n';
      case 'ul':
      case 'ol':
        return children + '\\n';
      case 'li': {
        const parent = el.parentElement;
        if (parent?.tagName?.toLowerCase() === 'ol') {
          const items = [...parent.children].filter((c) => c.tagName.toLowerCase() === 'li');
          return (items.indexOf(el) + 1) + '. ' + children.trim() + '\\n';
        }
        return '- ' + children.trim() + '\\n';
      }
      case 'tr':
      case 'thead':
      case 'tbody':
      case 'th':
      case 'td':
        return children;
      default:
        return children;
    }
  }

  function processPre(pre) {
    const code = pre.querySelector('code');
    const classList = [...(code || pre).classList];
    let lang = '';
    const langClass = classList.find((c) => /^language-|^lang-/.test(c));
    if (langClass) lang = langClass.replace(/^(language-|lang-)/, '');
	    if (!lang && /mermaid/i.test(pre.className + ' ' + (code?.className || '') + ' ' + cleanText(pre.querySelector('span')?.textContent || ''))) lang = 'mermaid';
	    const text = code ? code.textContent || '' : pre.textContent || '';
	    if (!lang && /^\\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\\b/i.test(text)) lang = 'mermaid';
	    const fence = String.fromCharCode(96, 96, 96);
	    return '\\n' + fence + lang + '\\n' + text.replace(/\\n+$/, '') + '\\n' + fence + '\\n\\n';
  }

  function processTable(table) {
    const rowEls = [...table.querySelectorAll('tr')];
    const rows = rowEls.map((row) => [...row.querySelectorAll('th,td')].map((cell) => escapeTableCell(processChildren(cell))));
    const useful = rows.filter((row) => row.length > 0);
    if (!useful.length) return '';
    const header = useful[0];
    const lines = [
      '| ' + header.join(' | ') + ' |',
      '| ' + header.map(() => '---').join(' | ') + ' |',
      ...useful.slice(1).map((row) => '| ' + row.join(' | ') + ' |'),
    ];
    return '\\n' + lines.join('\\n') + '\\n\\n';
  }

  const doc = getDoc();
  await revealMermaidCode(doc);
  const container = findContainer(doc);
  if (!container) return { markdown: '' };
  let markdown = processNode(container);
  markdown = markdown
    .replace(/(?:^|\\n)(?:Research completed[^\\n]*|\\d+\\s+searches|\\d+\\s+citations)(?=\\n)/gi, '\\n')
    .replace(/(?:\\n\\s*[0-9]\\s*){5,}/g, '\\n')
    .replace(/[ \\t]+$/gm, '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

	  const title = cleanText(doc.querySelector('h1')?.textContent || '');
	  if (title) {
	    const escaped = title.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');
    markdown = markdown.replace(new RegExp('^(#\\\\s*)?' + escaped + '\\\\s*\\\\n+(#\\\\s*)?' + escaped + '\\\\s*\\\\n+', 'i'), '# ' + title + '\\n\\n');
    if (!markdown.startsWith('# ')) markdown = '# ' + title + '\\n\\n' + markdown.replace(new RegExp('^' + escaped + '\\\\s*\\\\n+', 'i'), '');
  }
  return { markdown, title };
}`,
			30_000,
		);
		const linkedMarkdown = linkDeepResearchInlineCitations(
			result.markdown?.trim() || "",
			sources,
		);
		const markdown = appendDeepResearchSources(linkedMarkdown, sources);
		if (!markdown || markdown.length < 200) return null;
		return markdown;
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
	model: ChatModel,
	project: ResolvedProject | null,
	existingConversationUrl: string | null,
	maxWaitMs: number,
	toolName: string,
): Promise<AskResult> {
	const id = nextReqId++;
	const slotName: SlotKind = mode === "deep-research" ? "deep_research" : model;
	const head = prompt.slice(0, 40).replace(/\n/g, " ");
	const projectLog = project ? `/project=${project.key}` : "";
	log(`#${id} [${mode}/${model}${projectLog}] ask START "${head}..."`);
	const startedAt = nowIso();
	requestRecords.set(id, {
		id,
		tool: toolName,
		mode,
		model,
		project: project?.key,
		projectLabel: project?.label,
		chatId: extractChatId(existingConversationUrl),
		slot: slotName,
		phase: "waiting",
		promptPreview: head,
		startedAt,
		updatedAt: startedAt,
	});

	const releaseSlot = await slotQueues[slotName].acquire(id);
	updateRequestRecord(id, {
		phase: "setup",
		slotAcquiredAt: nowIso(),
	});
	let convUrl: string | null = null;
	let finished = false;

	try {
		await ensureAttached();

		// setup(他リクエストと直列化される)
		convUrl = await setupNewChatAndSend(
			prompt,
			mode,
			model,
			project,
			existingConversationUrl,
			id,
		);
		updateRequestRecord(id, {
			phase: "polling",
			conversationUrl: convUrl,
			chatId: extractChatId(convUrl),
		});
		log(`#${id} [${mode}/${model}${projectLog}] conversation url: ${convUrl}`);

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
				const probeText = typeof probe.text === "string" ? probe.text : "";
				const probeFigures = Array.isArray(probe.figures) ? probe.figures : [];

				if (probeText.length !== lastTextLen) {
					lastTextLen = probeText.length;
					noChangeIters = 0;
				} else {
					noChangeIters++;
				}
				updateRequestRecord(id, {
					pollIter: iter,
					textLength: probeText.length,
					figures: probeFigures.length,
				});
				if (iter % 5 === 0) {
					log(
						`#${id} poll iter=${iter} done=${probe.done} stop=${probe.stopping} think=${probe.thinking} stream=${probe.streaming} dr=${probe.deepResearching} len=${probeText.length}`,
					);
				}
				if (probe.done) {
					log(
						`#${id} DONE (${probeText.length} chars, ${probeFigures.length} figures)`,
					);
				const copiedMarkdown = await copyLatestResponseMarkdown(convUrl).catch((e) => {
					log(`#${id} copy markdown failed: ${(e as Error).message}`);
					return null;
				});
				if (copiedMarkdown) {
					log(`#${id} copied markdown from ChatGPT copy button (${copiedMarkdown.length} chars)`);
				}
					let markdownCandidate = copiedMarkdown;
					const copiedLooksTooShort =
						!!copiedMarkdown &&
						probeText.length >= 2_000 &&
						copiedMarkdown.trim().length < Math.min(1_000, probeText.length * 0.25);
				if ((!markdownCandidate || copiedLooksTooShort) && mode === "deep-research") {
					if (copiedLooksTooShort) {
							log(
								`#${id} copied deep research markdown looks too short (${copiedMarkdown?.trim().length} < dom ${probeText.length}); trying iframe extraction`,
							);
					}
					const extractedMarkdown = await extractDeepResearchMarkdown(convUrl).catch((e) => {
						log(`#${id} deep research markdown fallback failed: ${(e as Error).message}`);
						return null;
					});
					if (extractedMarkdown) {
						markdownCandidate = extractedMarkdown;
						log(`#${id} extracted deep research markdown from iframe (${extractedMarkdown.length} chars)`);
					}
					}
					const final = chooseFinalResponseText(probeText, markdownCandidate);
				if (final.source === "dom") {
					log(`#${id} using DOM response text: ${final.reason}`);
				}
				const finalText = final.text;
				const logDir = await saveConversationLog(
						toolName,
						prompt,
						finalText,
						probeFigures,
					);
				updateRequestRecord(id, {
					phase: "done",
					textLength: finalText.length,
					finalTextLength: finalText.length,
					responseSource: final.source,
					copyLength: markdownCandidate?.length,
						figures: probeFigures.length,
					completedAt: nowIso(),
				});
				try {
					await closeConversationTab(convUrl);
				} catch (e) {
					log(`#${id} close tab failed: ${(e as Error).message}`);
				}
				finished = true;
				return {
					text: finalText,
					conversationUrl: convUrl,
					chatId: extractChatId(convUrl),
					logDir,
				};
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

		throw new Error(
			`Timed out after ${Math.round(maxWaitMs / 60000)} minutes for ${convUrl}`,
		);
	} catch (e) {
		updateRequestRecord(id, {
			phase: "error",
			error: e instanceof Error ? e.message : String(e),
			completedAt: nowIso(),
		});
		throw e;
	} finally {
		if (!finished && convUrl) {
			try {
				await closeConversationTab(convUrl);
			} catch {}
		}
		releaseSlot();
	}
}

async function handleTestDelayedResponse(
	prompt: string,
	mode: ChipMode,
	model: ChatModel,
	project: ResolvedProject | null,
	delaySeconds: number,
	responseText: string,
): Promise<string> {
	const id = nextReqId++;
	const slotName: SlotKind = mode === "deep-research" ? "deep_research" : model;
	const head = prompt.slice(0, 40).replace(/\n/g, " ");
	const projectLog = project ? `/project=${project.key}` : "";
	log(
		`#${id} [test/${mode}/${model}${projectLog}] START delay=${delaySeconds}s "${head}..."`,
	);
	const startedAt = nowIso();
	requestRecords.set(id, {
		id,
		tool: "test_delayed_response",
		mode,
		model,
		project: project?.key,
		projectLabel: project?.label,
		slot: slotName,
		phase: "waiting",
		promptPreview: head,
		startedAt,
		updatedAt: startedAt,
	});

	const releaseSlot = await slotQueues[slotName].acquire(id);
	updateRequestRecord(id, {
		phase: "setup",
		slotAcquiredAt: nowIso(),
	});

	let marker: string | null = null;
	let finished = false;
	try {
		await ensureAttached();
		const setup = await setupNewChatAndTypePrompt(prompt, mode, model, project, id);
		marker = setup.marker;
		updateRequestRecord(id, {
			phase: "polling",
			conversationUrl: setup.url,
			textLength: 0,
			figures: 0,
		});

		const startedPolling = Date.now();
		let iter = 0;
		while (Date.now() - startedPolling < delaySeconds * 1000) {
			await sleep(Math.min(POLL_INTERVAL_MS, delaySeconds * 1000));
			iter++;
			updateRequestRecord(id, {
				pollIter: iter,
				textLength: responseText.length,
				figures: 0,
			});
		}

		await saveConversationLog(
			"test_delayed_response",
			prompt,
			responseText,
			[],
		);
		updateRequestRecord(id, {
			phase: "done",
			textLength: responseText.length,
			figures: 0,
			completedAt: nowIso(),
		});
		finished = true;
		return responseText;
	} catch (e) {
		updateRequestRecord(id, {
			phase: "error",
			error: e instanceof Error ? e.message : String(e),
			completedAt: nowIso(),
		});
		throw e;
	} finally {
		if (marker) {
			try {
				await closeMarkedTab(marker);
			} catch (e) {
				log(`#${id} close test tab failed: ${(e as Error).message}`);
			}
		}
		if (!finished) {
			log(`#${id} [test/${mode}/${model}] finished with error or cancellation`);
		}
		releaseSlot();
	}
}

// ----------------------------------------------------------------------------
// MCP tool
// ----------------------------------------------------------------------------

const DEEP_THINKER_TOOL: Tool = {
	name: "deep_thinker",
	description:
		"Ask a very high-capability reasoning AI (ChatGPT Pro model with web search) to think deeply about a problem. The model does multi-step reasoning while consulting up-to-date web sources, and returns a considered answer. Best for: complex analysis, nuanced reasoning, code review, design tradeoffs, factual questions that need current data. Typical time to result is about 10-25 minutes. Each call opens an isolated chat tab, so multiple calls run concurrently without interfering.",
	inputSchema: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description: "The question or task to send. Be as specific as possible about what kind of answer you want.",
			},
			model: {
				type: "string",
				enum: ["pro", "thinking"],
				description:
					"Optional ChatGPT model to select before sending. Defaults to the YAML defaults.model value, which defaults to pro.",
			},
			project: {
				type: "string",
				description:
					"Optional ChatGPT project key or exact project label. Keys are resolved through chatgpt-mcp.yaml projects; if omitted, CHATGPT_MCP_PROJECT or YAML defaults.project is used. Use 'none' to skip project selection.",
			},
			chatId: {
				type: "string",
				description:
					"Optional existing ChatGPT conversation id to continue. If set, project selection is skipped and the prompt is sent in that chat.",
			},
			conversationUrl: {
				type: "string",
				description:
					"Optional full ChatGPT conversation URL to continue. Prefer this over chatId for project chats because it preserves the project-specific URL.",
			},
		},
		required: ["prompt"],
	},
};

const DEEP_RESEARCHER_TOOL: Tool = {
	name: "deep_researcher",
	description:
		"Ask an extremely high-capability deep-research AI (ChatGPT Pro model with Deep Research mode) to conduct a thorough multi-source investigation and return a report. Spends significantly more time browsing, cross-checking, and synthesizing than `deep_thinker`. Best for: literature reviews, comparative surveys, market/tech landscape reports, investigations that need many sources. This tool can produce exceptionally strong research. Typical time to result is about 1-2.5 hours. Use only when the extra depth is worth the wait; prefer `deep_thinker` for normal questions.",
	inputSchema: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description: "A well-scoped research question. State the topic, what you want investigated, and what format the report should take.",
			},
			model: {
				type: "string",
				enum: ["pro", "thinking"],
				description:
					"Optional ChatGPT model to select before enabling Deep Research. Defaults to the YAML defaults.model value, which defaults to pro. Deep Research calls use the deep_research parallel slot regardless of model.",
			},
			project: {
				type: "string",
				description:
					"Optional ChatGPT project key or exact project label. Keys are resolved through chatgpt-mcp.yaml projects; if omitted, CHATGPT_MCP_PROJECT or YAML defaults.project is used. Use 'none' to skip project selection.",
			},
			chatId: {
				type: "string",
				description:
					"Optional existing ChatGPT conversation id to continue. If set, project selection is skipped and the prompt is sent in that chat.",
			},
			conversationUrl: {
				type: "string",
				description:
					"Optional full ChatGPT conversation URL to continue. Prefer this over chatId for project chats because it preserves the project-specific URL.",
			},
		},
		required: ["prompt"],
	},
};

const SERVER_STATUS_TOOL: Tool = {
	name: "server_status",
	description:
		"Return this MCP server process status, including per-model slot usage, queued/running requests, and recent done/error requests. This reports in-memory state for the current server process.",
	inputSchema: {
		type: "object",
		properties: {
			completedLimit: {
				type: "number",
				description:
					"Optional number of recent done/error requests to include. Defaults to 20 and is capped at 100.",
			},
		},
	},
};

const TEST_DELAYED_RESPONSE_TOOL: Tool = {
	name: "test_delayed_response",
	description:
		"Test queue/status behavior without sending a ChatGPT request. Opens ChatGPT, selects the requested model/tool, types the prompt, does not click send, stays in polling for delaySeconds, then returns responseText and closes the tab.",
	inputSchema: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description: "Prompt to type into the ChatGPT composer. It is not submitted.",
			},
			model: {
				type: "string",
				enum: ["pro", "thinking"],
				description:
					"Optional model to select before typing. Defaults to the YAML defaults.model value.",
			},
			project: {
				type: "string",
				description:
					"Optional ChatGPT project key or exact project label to select before typing. Keys are resolved through chatgpt-mcp.yaml projects; use 'none' to skip project selection.",
			},
			mode: {
				type: "string",
				enum: ["web-search", "deep-research"],
				description:
					"Composer tool mode to enable. Defaults to web-search. deep-research uses the deep_research slot.",
			},
			delaySeconds: {
				type: "number",
				description:
					"How long to stay in simulated polling before returning. Defaults to 30 seconds and is capped at 3600.",
			},
			responseText: {
				type: "string",
				description:
					"Text to return after the delay. Defaults to a short test response.",
			},
		},
		required: ["prompt"],
	},
};

function createMcpServer(): Server {
	const server = new Server(
		{ name: "ChatGPT MCP Tool (web)", version: "5.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			DEEP_THINKER_TOOL,
			DEEP_RESEARCHER_TOOL,
			SERVER_STATUS_TOOL,
			...(ENABLE_TEST_TOOLS ? [TEST_DELAYED_RESPONSE_TOOL] : []),
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			const { name, arguments: args } = request.params;
			if (name === "server_status") {
				const completedLimit = Math.min(
					positiveInt((args as { completedLimit?: unknown } | undefined)?.completedLimit, 20),
					100,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(getServerStatus(completedLimit), null, 2),
						},
					],
					isError: false,
				};
			}

			if (!args) throw new Error("No arguments provided");
			if (name === "test_delayed_response") {
				if (!ENABLE_TEST_TOOLS) {
					return {
						content: [
							{
								type: "text",
								text: "Error: test_delayed_response is disabled. Start the server with --enable-test-tools or CHATGPT_MCP_ENABLE_TEST_TOOLS=1.",
							},
						],
						isError: true,
					};
				}
				const {
					prompt,
					model: modelArg,
					project: projectArg,
					mode: modeArg,
					delaySeconds: delayArg,
					responseText,
				} = args as {
					prompt?: string;
					model?: unknown;
					project?: unknown;
					mode?: unknown;
					delaySeconds?: unknown;
					responseText?: unknown;
				};
				if (typeof prompt !== "string" || prompt.trim() === "")
					throw new Error("'prompt' is required and must be a non-empty string");
				const model = normalizeModel(modelArg, DEFAULT_MODEL);
				const project = resolveProject(projectArg);
				const mode =
					modeArg == null || modeArg === ""
						? "web-search"
						: modeArg === "web-search" || modeArg === "deep-research"
							? modeArg
							: (() => {
									throw new Error("'mode' must be web-search or deep-research");
								})();
				const delaySeconds = Math.min(positiveInt(delayArg, 30), 3600);
				const response =
					typeof responseText === "string" && responseText.length > 0
						? responseText
						: `test_delayed_response completed after ${delaySeconds}s without sending to ChatGPT.`;
				const text = await handleTestDelayedResponse(
					prompt,
					mode,
					model,
					project,
					delaySeconds,
					response,
				);
				return {
					content: [{ type: "text", text }],
					isError: false,
				};
			}

			const {
				prompt,
				model: modelArg,
				project: projectArg,
				chatId,
				conversationUrl,
				chatUrl,
			} = args as {
				prompt?: string;
				model?: unknown;
				project?: unknown;
				chatId?: unknown;
				conversationUrl?: unknown;
				chatUrl?: unknown;
			};
			if (typeof prompt !== "string" || prompt.trim() === "")
				throw new Error("'prompt' is required and must be a non-empty string");
			const model = normalizeModel(modelArg, DEFAULT_MODEL);
			const project = resolveProject(projectArg);
			const existingConversationUrl = resolveConversationUrl(
				conversationUrl ?? chatUrl ?? chatId,
			);

			let response: AskResult;
			if (name === "deep_thinker") {
				response = await handleAsk(
					prompt,
					"web-search",
					model,
					project,
					existingConversationUrl,
					MAX_WAIT_THINKER_MS,
					"deep_thinker",
				);
			} else if (name === "deep_researcher") {
				response = await handleAsk(
					prompt,
					"deep-research",
					model,
					project,
					existingConversationUrl,
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
						text: response.text || "No response received from ChatGPT.",
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								chatId: response.chatId,
								conversationUrl: response.conversationUrl,
								logDir: response.logDir,
							},
							null,
							2,
						),
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

	return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return undefined;
	return JSON.parse(raw);
}

function sendJsonRpcError(
	res: ServerResponse,
	status: number,
	code: number,
	message: string,
) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
}

function sendText(res: ServerResponse, status: number, text: string) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(text);
}

function methodNotAllowed(res: ServerResponse, allowed: string) {
	res.writeHead(405, {
		"content-type": "application/json",
		allow: allowed,
	});
	res.end(JSON.stringify({ error: "Method not allowed" }));
}

async function handleRestApiRequest(
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/")) return false;

	if (url.pathname === "/api/status" || url.pathname === "/api/server_status") {
		if (req.method !== "GET") {
			methodNotAllowed(res, "GET");
			return true;
		}
		const completedLimit = Math.min(
			positiveInt(url.searchParams.get("completedLimit"), 20),
			100,
		);
		sendJson(res, 200, getServerStatus(completedLimit));
		return true;
	}

	if (
		url.pathname !== "/api/deep_thinker" &&
		url.pathname !== "/api/deep_researcher"
	) {
		sendJson(res, 404, { error: "Not found" });
		return true;
	}

	if (req.method !== "POST") {
		methodNotAllowed(res, "POST");
		return true;
	}

	try {
		const body = await readJsonBody(req);
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			sendJson(res, 400, { error: "JSON object body is required" });
			return true;
		}

		const {
			prompt,
			model: modelArg,
			project: projectArg,
			format,
			chatId,
			conversationUrl,
			chatUrl,
		} = body as {
			prompt?: unknown;
			model?: unknown;
			project?: unknown;
			format?: unknown;
			chatId?: unknown;
			conversationUrl?: unknown;
			chatUrl?: unknown;
		};
		const responseFormat = String(
			url.searchParams.get("format") ?? format ?? "text",
		).toLowerCase();
		const wantsJson = responseFormat === "json";
		if (responseFormat !== "text" && responseFormat !== "json") {
			sendJson(res, 400, { error: "'format' must be text or json" });
			return true;
		}
		if (typeof prompt !== "string" || prompt.trim() === "") {
			const message = "'prompt' is required and must be a non-empty string";
			if (wantsJson) {
				sendJson(res, 400, { error: message });
			} else {
				sendText(res, 400, message);
			}
			return true;
		}
		const model = normalizeModel(modelArg, DEFAULT_MODEL);
		const project = resolveProject(projectArg);
		const existingConversationUrl = resolveConversationUrl(
			conversationUrl ?? chatUrl ?? chatId,
		);
		const isDeepResearch = url.pathname === "/api/deep_researcher";
		const result = await handleAsk(
			prompt,
			isDeepResearch ? "deep-research" : "web-search",
			model,
			project,
			existingConversationUrl,
			isDeepResearch ? MAX_WAIT_RESEARCHER_MS : MAX_WAIT_THINKER_MS,
			isDeepResearch ? "deep_researcher" : "deep_thinker",
		);
		if (wantsJson) {
			sendJson(res, 200, result);
		} else {
			sendText(res, 200, result.text);
		}
		return true;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log(`rest api error: ${message}`);
		if (url.searchParams.get("format") === "json") {
			sendJson(res, 500, { error: message });
		} else {
			sendText(res, 500, message);
		}
		return true;
	}
}

async function startHttpServer() {
	const transports = new Map<string, StreamableHTTPServerTransport>();

	const httpServer = createHttpServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
			if (url.pathname === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, pid: process.pid }));
				return;
			}
			if (await handleRestApiRequest(url, req, res)) {
				return;
			}
			if (url.pathname !== "/mcp") {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Not found");
				return;
			}

			if (req.method === "POST") {
				const body = await readJsonBody(req);
				const sessionId = req.headers["mcp-session-id"];
				let transport: StreamableHTTPServerTransport | undefined;
				if (typeof sessionId === "string") {
					transport = transports.get(sessionId);
				}

				if (!transport) {
					if (typeof sessionId === "string" || !isInitializeRequest(body)) {
						sendJsonRpcError(
							res,
							typeof sessionId === "string" ? 404 : 400,
							typeof sessionId === "string" ? -32001 : -32000,
							typeof sessionId === "string"
								? "Session not found"
								: "Bad Request: No valid session ID provided",
						);
						return;
					}

					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (newSessionId) => {
							transports.set(newSessionId, transport!);
							log(`http session initialized id=${newSessionId}`);
						},
					});
					transport.onclose = () => {
						const sid = transport?.sessionId;
						if (sid) transports.delete(sid);
						if (sid) log(`http session closed id=${sid}`);
					};
					await createMcpServer().connect(transport);
				}

				await transport.handleRequest(req, res, body);
				return;
			}

			if (req.method === "GET" || req.method === "DELETE") {
				const sessionId = req.headers["mcp-session-id"];
				const transport =
					typeof sessionId === "string" ? transports.get(sessionId) : undefined;
				if (!transport) {
					sendJsonRpcError(
						res,
						404,
						-32001,
						"Session not found or missing session ID",
					);
					return;
				}
				await transport.handleRequest(req, res);
				return;
			}

			sendJsonRpcError(res, 405, -32600, "Method not allowed");
		} catch (e) {
			log(`http request error: ${(e as Error).message}`);
			if (!res.headersSent) {
				sendJsonRpcError(res, 500, -32603, "Internal server error");
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	log(
		`server started pid=${process.pid} transport=http url=http://${HTTP_HOST}:${HTTP_PORT}/mcp camoufox=${CAMOFOX_BASE_URL} user=${CAMOFOX_USER_ID} log=${LOG_FILE} cwd=${process.cwd()} config=${CONFIG.path ?? "(defaults)"} default_model=${DEFAULT_MODEL} default_project=${DEFAULT_PROJECT_KEY ?? "(none)"} projects=${JSON.stringify(Object.keys(PROJECTS))} slots=${JSON.stringify(SLOT_LIMITS)} test_tools=${ENABLE_TEST_TOOLS} conv_log_root=${resolveLogRoot()}`,
	);
	console.error(`ChatGPT MCP Server (web) running on http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
}

async function startStdioServer() {
	const transport = new StdioServerTransport();
	await createMcpServer().connect(transport);
	log(
		`server started pid=${process.pid} transport=stdio camoufox=${CAMOFOX_BASE_URL} user=${CAMOFOX_USER_ID} log=${LOG_FILE} cwd=${process.cwd()} config=${CONFIG.path ?? "(defaults)"} default_model=${DEFAULT_MODEL} default_project=${DEFAULT_PROJECT_KEY ?? "(none)"} projects=${JSON.stringify(Object.keys(PROJECTS))} slots=${JSON.stringify(SLOT_LIMITS)} test_tools=${ENABLE_TEST_TOOLS} conv_log_root=${resolveLogRoot()}`,
	);
	console.error("ChatGPT MCP Server (web) running on stdio");
}

if (HTTP_MODE) {
	await startHttpServer();
} else {
	await startStdioServer();
}
