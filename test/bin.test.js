// Tests for bin/restore.mjs (package bin command `dsh-resume-restore`): it
// must resolve the active profile/install, accept optional extra anchors,
// print a summary, and exit nonzero on any failure — never swallowing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { patchInstalled } from "../lib/patch.js";
import { TARGETS, TEST_DSH_HOME, makeInstall, officialSource } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/restore.mjs", import.meta.url));

function runBin(install, ...args) {
	/* A disposable DSH_HOME keeps the default anchor away from the real profile. */
	return spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: TEST_DSH_HOME }
	});
}

test("bin/restore.mjs exists and is a node executable", () => {
	const source = readFileSync(BIN, "utf8");
	assert.match(source, /^#!.*\bnode\b/, "shebang must invoke node");
});

test("dsh-resume-restore reverts the patches on the active install and prints a summary", () => {
	const install = makeInstall();
	try {
		patchInstalled([], { anchors: [install.anchor] });
		const run = runBin(install, install.anchor);
		assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr: ${run.stderr}`);
		assert.match(run.stdout, /unpatched/, "stdout must summarize the reverts");
		for (const target of TARGETS) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
	} finally {
		install.cleanup();
	}
});

test("dsh-resume-restore exits nonzero and never swallows a refusal", () => {
	const install = makeInstall({
		overrideVersions: { "@deepseek-ai/dsh-session": "0.1.0-rc.5" }
	});
	try {
		const run = runBin(install, install.anchor);
		assert.notEqual(run.status, 0, "a version refusal must exit nonzero");
		assert.match(run.stderr, /refusing to patch/);
		for (const target of TARGETS) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
	} finally {
		install.cleanup();
	}
});

test("dsh-resume-restore succeeds with no extra anchors when nothing is patched", () => {
	const install = makeInstall();
	try {
		const run = runBin(install);
		assert.equal(run.status, 0, `expected exit 0, got ${run.status}; stderr: ${run.stderr}`);
	} finally {
		install.cleanup();
	}
});

test("dsh-resume-restore exits nonzero when a manifest is unreadable", () => {
	const install = makeInstall();
	try {
		writeFileSync(install.manifestPath(TARGETS[0]), "{ not json\n");
		const run = runBin(install, install.anchor);
		assert.notEqual(run.status, 0, "an unreadable manifest must exit nonzero");
		assert.ok(run.stderr.length > 0, "the failure must be reported on stderr");
	} finally {
		install.cleanup();
	}
});
