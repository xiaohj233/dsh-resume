// Guards the "no unpatch-on-dispose" contract: lib/index.js must apply the
// patches at load, but must NOT register anything that reverts them — a normal
// Cordis shutdown (fiber dispose) must leave the patches in place. The revert
// is exclusively the job of the dsh-resume-restore bin (see test/bin.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX_SOURCE = readFileSync(fileURLToPath(new URL("../lib/index.js", import.meta.url)), "utf8");

test("lib/index.js registers no unpatch-on-dispose effect", () => {
	assert.doesNotMatch(INDEX_SOURCE, /unpatch/i, "index.js must not reference unpatch at all");
	assert.doesNotMatch(INDEX_SOURCE, /on dispose/i, "no dispose-time unpatch effect may be registered");
});

test("lib/index.js still applies the installed-package patches at module load", () => {
	assert.match(INDEX_SOURCE, /import\s*\{[^}]*patchInstalled[^}]*\}\s*from\s*["']\.\/patch\.js["']/);
	assert.match(INDEX_SOURCE, /patchInstalled\(\)/);
});

test("normal Cordis shutdown must not restore: only the CLI path may call unpatchInstalled", () => {
	/* lib/patch.js exports unpatchInstalled for bin/restore.mjs; the runtime
	   plugin module itself must never call it. */
	assert.doesNotMatch(INDEX_SOURCE, /unpatchInstalled/);
	assert.match(INDEX_SOURCE, /patchInstalled/);
});

test("graceful teardown matches the rc.6 aborted-disposed event shape", () => {
	assert.match(INDEX_SOURCE, /reason\?\.kind\s*!==\s*["']aborted["']/);
	assert.match(INDEX_SOURCE, /reason\.reason\?\.kind\s*!==\s*["']disposed["']/);
});

test("failed subagent retries remain pending", () => {
	assert.match(INDEX_SOURCE, /failed\.push\(sessionId\)/);
	assert.match(INDEX_SOURCE, /pendingSubagents\.push\(\.\.\.failed\)/);
});

test("restore consumes the state file per session, never all at once", () => {
	/* A kill mid-restore must not lose the remaining sessions: the file is
	   rewritten with the still-pending set after every successful resume,
	   never blanked before the restore pass starts. */
	assert.match(INDEX_SOURCE, /persistRemaining\(\)/);
	assert.doesNotMatch(INDEX_SOURCE, /running:\s*\[\],\s*subagents:\s*\[\]\s*\}/, "no all-at-once blank write of the state file");
	assert.match(INDEX_SOURCE, /remaining\.running\s*=\s*remaining\.running\.filter/);
	assert.match(INDEX_SOURCE, /remaining\.subagents\s*=\s*remaining\.subagents\.filter/);
	assert.match(INDEX_SOURCE, /failed \(kept for next boot\)/);
});

