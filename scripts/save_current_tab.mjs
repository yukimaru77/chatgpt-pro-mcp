#!/usr/bin/env node
// Camoufox の最新タブから、現在表示中のChatGPT会話を chatgpt_log/ に保存する補助スクリプト。
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

const CAMOFOX_BASE_URL =
	process.env.CHATGPT_MCP_CAMOFOX_URL ||
	process.env.CAMOFOX_BASE_URL ||
	"http://127.0.0.1:9377";
const CAMOFOX_USER_ID =
	process.env.CHATGPT_MCP_CAMOFOX_USER_ID ||
	process.env.CAMOFOX_USER_ID ||
	"default";
const CAMOFOX_API_KEY =
	process.env.CHATGPT_MCP_CAMOFOX_API_KEY ||
	process.env.CAMOFOX_API_KEY ||
	(() => {
		try {
			const raw = readFileSync("/home/yukimaru/camofox-mcp/.env", "utf8");
			return raw.match(/^CAMOFOX_API_KEY=(.*)$/m)?.[1]?.trim() || "";
		} catch {
			return "";
		}
	})();

async function camofox(method, pathname, body) {
	const url = new URL(pathname, CAMOFOX_BASE_URL);
	const headers = {};
	if (CAMOFOX_API_KEY) headers.authorization = `Bearer ${CAMOFOX_API_KEY}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${url.pathname} failed ${res.status}: ${text}`);
	return text.trim() ? JSON.parse(text) : undefined;
}

async function evalTab(tabId, expression) {
	const data = await camofox("POST", `/tabs/${encodeURIComponent(tabId)}/evaluate`, {
		userId: CAMOFOX_USER_ID,
		expression,
	});
	return data?.result;
}

function formatTs(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

async function main() {
	const list = await camofox(
		"GET",
		`/tabs?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
	);
	const tab = list.tabs?.at(-1);
	if (!tab?.tabId) throw new Error("no Camoufox tab found");

	const meta = await evalTab(tab.tabId, `(() => {
  const u = [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1);
  const a = [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
  return {
    url: location.href,
    prompt: (u?.innerText || u?.textContent || '').trim(),
    text: (a?.innerText || a?.textContent || '').trim()
  };
})()`);
	console.error("current tab:", meta.url);
	if (!meta.prompt) throw new Error("no user message found on tab");
	if (!meta.text) throw new Error("no assistant message found on tab");

	const baseDir = path.resolve(process.cwd(), "chatgpt_log", "current_tab");
	mkdirSync(baseDir, { recursive: true });
	const ts = formatTs();
	let dir = path.join(baseDir, ts);
	let n = 1;
	while (existsSync(dir)) dir = path.join(baseDir, `${ts}_${n++}`);
	mkdirSync(dir, { recursive: true });

	writeFileSync(path.join(dir, "input.md"), meta.prompt + "\n", "utf8");
	writeFileSync(path.join(dir, "output.md"), meta.text + "\n", "utf8");
	console.log("SAVED:", dir);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
