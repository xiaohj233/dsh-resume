import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { AGENT_LOOP_HUNKS, SESSION_HUNKS, CONVERSATION_HUNKS } from "./lib/patch.js";
const require = createRequire(import.meta.url);
const targets = [
	["@deepseek-ai/dsh-agent-loop", "lib/index.js", AGENT_LOOP_HUNKS],
	["@deepseek-ai/dsh-session", "lib/index.js", SESSION_HUNKS],
	["@deepseek-ai/dsh-client-ui-conversation", "lib/client.js", CONVERSATION_HUNKS]
];
for (const [pkg, file, hunks] of targets) {
	const dir = dirname(require.resolve(`${pkg}/package.json`));
	const path = join(dir, file);
	let source = readFileSync(path, "utf8");
	for (const h of hunks) {
		if (source.includes(h.marker)) continue;
		const at = source.indexOf(h.from);
		if (at === -1) throw new Error(`anchor missing: ${h.what}`);
		source = source.slice(0, at) + h.to + source.slice(at + h.from.length);
	}
	const tmp = join(mkdtempSync(join(tmpdir(), "dshresume-")), file.replace(/[/\\]/g, "_") + ".mjs");
	writeFileSync(tmp, source);
	execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
	console.log(`patched-content OK: ${pkg}/${file} (${hunks.length} hunks)`);
}
