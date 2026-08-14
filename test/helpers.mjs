// Portable test helpers: temporary install trees built from the committed
// byte-exact official rc.6 fixtures in ./fixtures. No personal paths, no
// network, no dependency on the repo's node_modules.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** The three packages dsh-resume patches, with the exact supported version. */
export const TARGETS = Object.freeze([
	Object.freeze({ name: "@deepseek-ai/dsh-agent-loop", file: "lib/index.js", version: "0.1.0-rc.6" }),
	Object.freeze({ name: "@deepseek-ai/dsh-session", file: "lib/index.js", version: "0.1.0-rc.6" }),
	Object.freeze({ name: "@deepseek-ai/dsh-client-ui-conversation", file: "lib/client.js", version: "0.1.0-rc.6" })
]);

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Byte-exact official package file content from the committed fixture archive. */
export function officialSource(target) {
	return gunzipSync(readFileSync(join(FIXTURES_DIR, target.name, `${target.file}.gz`))).toString("utf8");
}

/**
 * A disposable DSH_HOME so no test can ever reach the real profile: the
 * default anchor `$DSH_HOME/profiles/web/package.json` resolves to nothing.
 */
export const TEST_DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-resume-home-"));

/**
 * Build a temporary "install": a node_modules tree with the three target
 * packages, each carrying the byte-exact official rc.6 content and a manifest
 * whose version can be overridden (for the version-guard tests).
 * @param {{ overrideVersions?: Record<string, string> }} options
 * @returns {{ root: string, anchor: string, secondAnchor: string,
 *   path(target): string, manifestPath(target): string, cleanup(): void }}
 */
export function makeInstall({ overrideVersions = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsh-resume-test-"));
	const anchor = join(root, "anchor.json");
	writeFileSync(anchor, "{}\n");
	const secondAnchor = join(root, "second-anchor.json");
	writeFileSync(secondAnchor, "{}\n");
	for (const target of TARGETS) {
		const dir = join(root, "node_modules", target.name);
		mkdirSync(join(dir, "lib"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({
			name: target.name,
			version: overrideVersions[target.name] ?? target.version
		}, null, 2) + "\n");
		writeFileSync(join(dir, target.file), officialSource(target));
	}
	return {
		root,
		anchor,
		secondAnchor,
		path(target) {
			return join(root, "node_modules", target.name, target.file);
		},
		manifestPath(target) {
			return join(root, "node_modules", target.name, "package.json");
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		}
	};
}

/** The hunk list exported by lib/patch.js for one target package. */
export function hunksFor(target, { AGENT_LOOP_HUNKS, SESSION_HUNKS, CONVERSATION_HUNKS }) {
	if (target.name.includes("agent-loop")) return AGENT_LOOP_HUNKS;
	if (target.name.includes("session")) return SESSION_HUNKS;
	return CONVERSATION_HUNKS;
}
