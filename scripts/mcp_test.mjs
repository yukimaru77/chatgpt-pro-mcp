#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const prompts =
	process.argv.slice(2).length > 0
		? process.argv.slice(2)
		: [
				"TypeScript と Go を、型安全性・開発速度・保守性の観点で比較し、最後に100字で結論を書いてください。",
				"日本の少子化の主因を3つに整理し、それぞれに対する政策案を1つずつ提案してください。",
				"江戸幕府の転換点を3つ選び、それぞれが政治に与えた影響を簡潔に説明してください。",
			];

const REQUEST_TIMEOUT_MS = 125 * 60 * 1000;

const transport = new StdioClientTransport({
	command: "node",
	args: ["dist/index.js"],
	cwd: process.cwd(),
	env: {
		...process.env,
	},
	stderr: "inherit",
});

const client = new Client({
	name: "mcp-test",
	version: "0.1.0",
});

function extractText(result) {
	if (!result?.content || !Array.isArray(result.content)) return "(no text)";
	return result.content
		.map((item) => ("text" in item ? item.text : JSON.stringify(item)))
		.join("\n")
		.trim();
}

async function main() {
	await client.connect(transport);

	const tools = await client.listTools();
	console.log(
		"tools:",
		tools.tools.map((tool) => tool.name).join(", "),
	);

	const startedAt = Date.now();
	const results = await Promise.allSettled(
		prompts.map(async (prompt) => {
			const toolName = process.env.MCP_TOOL || "deep_thinker";
			const result = await client.callTool({
				name: toolName,
				arguments: { prompt },
			}, undefined, {
				timeout: REQUEST_TIMEOUT_MS,
				maxTotalTimeout: REQUEST_TIMEOUT_MS,
			});
			return { prompt, result };
		}),
	);

	console.log(`elapsed_ms: ${Date.now() - startedAt}`);
	for (const [index, settled] of results.entries()) {
		if (settled.status === "fulfilled") {
			console.log(`\n[${index + 1}] prompt: ${settled.value.prompt}`);
			console.log(extractText(settled.value.result));
		} else {
			console.log(`\n[${index + 1}] prompt: ${prompts[index]}`);
			console.log(
				`ERROR: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
			);
		}
	}
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(async () => {
		await transport.close().catch(() => {});
	});
