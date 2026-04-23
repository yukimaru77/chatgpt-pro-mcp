#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 重めのプロンプトを2本即時、3本目はバッチ巡回中に到着させて動作確認する。
const PROMPTS_FIRST = [
	"TypeScript と Go の言語仕様を比較して、型システム・並行処理・エラー処理・パッケージ管理の4観点で各300字で論じ、最後に用途別の使い分け指針を200字でまとめてください。",
	"日本の少子化の主因を、経済・文化・制度の3側面に分けて各300字で整理し、それぞれに対する具体的政策案を1つずつ提案してください。",
];
const PROMPT_LATE =
	"江戸幕府260年の政治的転換点を3つ選び、それぞれの時代背景・転換の中身・その後の影響を各300字で説明してください。";
const LATE_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 125 * 60 * 1000;

const transport = new StdioClientTransport({
	command: "node",
	args: ["dist/index.js"],
	cwd: process.cwd(),
	env: { ...process.env },
	stderr: "inherit",
});

const client = new Client({ name: "mcp-test-stagger", version: "0.1.0" });

function extractText(result) {
	if (!result?.content || !Array.isArray(result.content)) return "(no text)";
	return result.content
		.map((item) => ("text" in item ? item.text : JSON.stringify(item)))
		.join("\n")
		.trim();
}

async function callAsk(prompt, label) {
	const startedAt = Date.now();
	try {
		const result = await client.callTool(
			{ name: process.env.MCP_TOOL || "deep_thinker", arguments: { prompt } },
			undefined,
			{ timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
		);
		return {
			label,
			prompt,
			ok: true,
			elapsed_ms: Date.now() - startedAt,
			text: extractText(result),
		};
	} catch (e) {
		return {
			label,
			prompt,
			ok: false,
			elapsed_ms: Date.now() - startedAt,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function main() {
	await client.connect(transport);
	const tools = await client.listTools();
	console.log("tools:", tools.tools.map((t) => t.name).join(", "));

	const t0 = Date.now();
	const earlyCalls = PROMPTS_FIRST.map((p, i) =>
		callAsk(p, `early#${i + 1}`),
	);

	const latePromise = (async () => {
		console.log(`[plan] late prompt will be submitted after ${LATE_DELAY_MS / 1000}s`);
		await new Promise((r) => setTimeout(r, LATE_DELAY_MS));
		console.log(`[dispatch] submitting late prompt at t=${Date.now() - t0}ms`);
		return callAsk(PROMPT_LATE, "late");
	})();

	const results = await Promise.all([...earlyCalls, latePromise]);
	console.log(`\ntotal_elapsed_ms: ${Date.now() - t0}`);
	for (const r of results) {
		console.log(`\n[${r.label}] elapsed=${r.elapsed_ms}ms ok=${r.ok}`);
		console.log(`  prompt: ${r.prompt.slice(0, 60)}...`);
		if (r.ok) {
			console.log(`  ---`);
			console.log(r.text);
		} else {
			console.log(`  ERROR: ${r.error}`);
		}
	}
}

main()
	.catch((e) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	})
	.finally(async () => {
		await transport.close().catch(() => {});
	});
