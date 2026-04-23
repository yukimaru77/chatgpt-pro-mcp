#!/usr/bin/env node
// 今 playwright-cli がアタッチしてるカレントタブから
// deep_researcher の保存ロジックを再現して chatgpt_log/ に書き出すテスト。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

const execFileP = promisify(execFile);
const CLI = "playwright-cli";

async function pw(args) {
	const { stdout } = await execFileP(CLI, args, {
		maxBuffer: 50 * 1024 * 1024,
	});
	return stdout;
}

function parsePwOut(raw) {
	const trimmed = (raw || "").trim();
	const idx = trimmed.indexOf("\n### ");
	return idx > 0 ? trimmed.slice(0, idx).trim() : trimmed;
}

async function runCodeJSON(code) {
	const raw = await pw(["--raw", "run-code", code]);
	const trimmed = raw.trim();
	// --raw は最初に JSON を出す。以降の `### ...` セクションが続くことがある。
	const end = trimmed.indexOf("\n### ");
	const jsonText = end > 0 ? trimmed.slice(0, end).trim() : trimmed;
	return JSON.parse(jsonText);
}

function cleanDeepResearchText(raw) {
	let cleaned = raw.replace(/(?:\d\s*\n){5,}/g, "");
	const marker = "件の検索";
	const idx = cleaned.lastIndexOf(marker);
	if (idx >= 0) cleaned = cleaned.slice(idx + marker.length);
	return cleaned.trim();
}

function formatTs(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

function inferImageExt(src, contentType) {
	const m = src.match(/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i);
	if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
	if (contentType) {
		const m2 = contentType.match(/image\/([a-z0-9+.-]+)/i);
		if (m2) {
			return m2[1]
				.toLowerCase()
				.replace("jpeg", "jpg")
				.replace("svg+xml", "svg");
		}
	}
	return "png";
}

function decodeDataUrl(url) {
	const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
	if (!m) return null;
	const mime = m[1];
	const base64 = !!m[2];
	const payload = m[3];
	const buffer = base64
		? Buffer.from(payload, "base64")
		: Buffer.from(decodeURIComponent(payload), "utf8");
	return { buffer, ext: inferImageExt("", mime) };
}

async function fetchRemote(src) {
	try {
		const res = await fetch(src);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const ab = await res.arrayBuffer();
		return {
			buffer: Buffer.from(ab),
			ext: inferImageExt(src, res.headers.get("content-type")),
		};
	} catch (e) {
		console.error("fetchRemote failed:", e.message);
		return null;
	}
}

async function main() {
	// 1) current URL から prompt (user message) を取る
	const meta = await runCodeJSON(`async (page) => {
  const topInfo = await page.evaluate(() => {
    const u = [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1);
    const drIframe = !!document.querySelector('iframe[title="internal://deep-research"]');
    const good = !!document.querySelector('button[data-testid="good-response-turn-action-button"]');
    return { url: location.href, prompt: (u?.innerText || u?.textContent || ''), drIframe, good };
  });
  return topInfo;
}`);
	console.error("current tab:", meta.url);
	console.error("dr iframe present:", meta.drIframe, "good:", meta.good);
	if (!meta.prompt) throw new Error("no user message found on tab");

	// 2) iframe から本文と figures を取る (DR tab 前提)
	const body = await runCodeJSON(`async (page) => {
  const frames = page.frames();
  const rootFrame = frames.find(f => f.name() === 'root' || f.url() === 'about:blank');
  if (!rootFrame) return { text: '', figures: [] };
  return await rootFrame.evaluate(() => {
    const body = document.body;
    const text = body ? (body.innerText || '') : '';
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
    return { text, figures };
  });
}`);
	const cleaned = cleanDeepResearchText(body.text || "");
	console.error(
		`text len: raw=${(body.text || "").length} cleaned=${cleaned.length} figures=${body.figures.length}`,
	);

	// 3) ログ保存
	const tool = "deep_researcher";
	const baseDir = path.resolve(process.cwd(), "chatgpt_log", tool);
	mkdirSync(baseDir, { recursive: true });
	const ts = formatTs();
	let dir = path.join(baseDir, ts);
	let n = 1;
	while (existsSync(dir)) {
		dir = path.join(baseDir, `${ts}_${n}`);
		n++;
	}
	mkdirSync(dir, { recursive: true });

	writeFileSync(path.join(dir, "input.md"), meta.prompt + "\n", "utf8");

	let outputMd = cleaned;
	const figs = body.figures || [];
	if (figs.length > 0) {
		const figDir = path.join(dir, "figures");
		mkdirSync(figDir, { recursive: true });
		const links = [];
		for (let i = 0; i < figs.length; i++) {
			const fig = figs[i];
			const idx = i + 1;
			const alt = fig.alt || `Figure ${idx}`;
			try {
				if (fig.kind === "svg") {
					const fname = `fig${idx}.svg`;
					writeFileSync(path.join(figDir, fname), fig.content, "utf8");
					links.push(`![${alt}](figures/${fname})`);
				} else if (fig.kind === "canvas") {
					const dec = decodeDataUrl(fig.dataURL);
					if (!dec) throw new Error("canvas decode");
					const fname = `fig${idx}.${dec.ext}`;
					writeFileSync(path.join(figDir, fname), dec.buffer);
					links.push(`![${alt}](figures/${fname})`);
				} else if (fig.kind === "img") {
					const saved = fig.src.startsWith("data:")
						? decodeDataUrl(fig.src)
						: await fetchRemote(fig.src);
					if (saved) {
						const fname = `fig${idx}.${saved.ext}`;
						writeFileSync(path.join(figDir, fname), saved.buffer);
						links.push(`![${alt}](figures/${fname})`);
					} else {
						links.push(`![${alt}](${fig.src})`);
					}
				}
			} catch (e) {
				console.error(`fig ${idx}: ${e.message}`);
			}
		}
		outputMd =
			outputMd.trimEnd() +
			"\n\n---\n\n## Figures\n\n" +
			links.join("\n\n") +
			"\n";
	}
	writeFileSync(path.join(dir, "output.md"), outputMd + "\n", "utf8");
	console.log("SAVED:", dir);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
