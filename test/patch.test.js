// Behavior tests for lib/patch.js against byte-exact official rc.6 fixtures.
// Every test builds its own temporary install tree (see helpers.mjs); nothing
// touches the real profile, the real DSH_HOME, or the repo's node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	patchInstalled,
	unpatchInstalled,
	applyHunks,
	unpatchHunks,
	AGENT_LOOP_HUNKS,
	SESSION_HUNKS,
	CONVERSATION_HUNKS
} from "../lib/patch.js";
import { TARGETS, TEST_DSH_HOME, makeInstall, officialSource, hunksFor } from "./helpers.mjs";

/* Never let a default-anchor resolution reach the real profile. */
process.env.DSH_HOME = TEST_DSH_HOME;

const HUNKS = { AGENT_LOOP_HUNKS, SESSION_HUNKS, CONVERSATION_HUNKS };
const agentLoop = TARGETS[0];
const session = TARGETS[1];
const conversation = TARGETS[2];

test("patchInstalled refuses a package whose installed version is not the exact rc.6, without writing", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0-rc.5" } });
	try {
		assert.throws(
			() => patchInstalled([], { anchors: [install.anchor] }),
			(error) => {
				assert.match(error.message, new RegExp(`refusing to patch ${session.name.replace("/", "\\/")}`));
				assert.match(error.message, /0\.1\.0-rc\.5/);
				assert.match(error.message, /0\.1\.0-rc\.6/);
				return true;
			}
		);
		/* The refused package's file was never written. */
		assert.equal(readFileSync(install.path(session), "utf8"), officialSource(session));
	} finally {
		install.cleanup();
	}
});

test("patchInstalled refuses a non-rc.6 version before writing ANY file", () => {
	/* agent-loop and conversation are valid rc.6 copies; session is not. */
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0" } });
	try {
		assert.throws(() => patchInstalled([], { anchors: [install.anchor] }), /refusing to patch/);
		/* Not even the valid files were patched — the whole run is atomic. */
		for (const target of TARGETS) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
	} finally {
		install.cleanup();
	}
});

test("unpatchInstalled also refuses a package at a non-rc.6 version", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0-rc.3" } });
	try {
		assert.throws(() => unpatchInstalled([], { anchors: [install.anchor] }), /refusing to patch/);
		for (const target of TARGETS) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
	} finally {
		install.cleanup();
	}
});

test("patchInstalled accepts the exact rc.6 install and reports the patched hunks", () => {
	const install = makeInstall();
	try {
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, true);
		assert.ok(report.results.length > 0);
		assert.ok(report.results.every((result) => result.status === "patched"));
		for (const target of TARGETS) {
			const source = readFileSync(install.path(target), "utf8");
			for (const hunk of hunksFor(target, HUNKS)) {
				assert.ok(source.includes(hunk.marker), `${target.name}: marker "${hunk.marker}" missing after patch`);
			}
		}
	} finally {
		install.cleanup();
	}
});

test("a hunk whose anchor is missing refuses the run without writing", () => {
	const install = makeInstall();
	try {
		/* Replace agent-loop's file with content that lacks the first hunk anchor. */
		writeFileSync(install.path(agentLoop), "// not the real agent-loop\n");
		assert.throws(
			() => patchInstalled([], { anchors: [install.anchor] }),
			(error) => {
				assert.match(error.message, /patch anchor not found/);
				assert.match(error.message, /agent-loop/);
				return true;
			}
		);
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), "// not the real agent-loop\n");
		/* And the other files were not written either. */
		for (const target of [session, conversation]) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
	} finally {
		install.cleanup();
	}
});

test("a hunk whose anchor occurs more than once refuses the run without writing", () => {
	const install = makeInstall();
	try {
		const hunk = AGENT_LOOP_HUNKS[0];
		const doubled = `${hunk.from}\n\n${hunk.from}\n`;
		writeFileSync(install.path(agentLoop), doubled);
		assert.throws(
			() => patchInstalled([], { anchors: [install.anchor] }),
			(error) => {
				assert.match(error.message, /ambiguous/);
				assert.match(error.message, /2/);
				return true;
			}
		);
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), doubled);
	} finally {
		install.cleanup();
	}
});

test("an ambiguity anywhere refuses the whole run: no file is written at all", () => {
	const install = makeInstall();
	try {
		/* agent-loop valid; session file carries a doubled anchor. */
		writeFileSync(install.path(session), `${SESSION_HUNKS[0].from}\n\n${SESSION_HUNKS[0].from}\n`);
		assert.throws(() => patchInstalled([], { anchors: [install.anchor] }), /ambiguous/);
		/* The valid agent-loop and conversation files must be untouched. */
		for (const target of [agentLoop, conversation]) {
			assert.equal(readFileSync(install.path(target), "utf8"), officialSource(target));
		}
		assert.equal(readFileSync(install.path(session), "utf8"), `${SESSION_HUNKS[0].from}\n\n${SESSION_HUNKS[0].from}\n`);
	} finally {
		install.cleanup();
	}
});

test("apply is idempotent: the second run skips every hunk and leaves the bytes untouched", () => {
	const install = makeInstall();
	try {
		const first = patchInstalled([], { anchors: [install.anchor] });
		assert.ok(first.results.length > 0);
		assert.ok(first.results.every((result) => result.status === "patched"));
		const afterFirst = TARGETS.map((target) => readFileSync(install.path(target), "utf8"));
		const second = patchInstalled([], { anchors: [install.anchor] });
		assert.ok(second.results.length > 0);
		assert.ok(second.results.every((result) => result.status === "skip"));
		TARGETS.forEach((target, index) => {
			assert.equal(readFileSync(install.path(target), "utf8"), afterFirst[index]);
		});
	} finally {
		install.cleanup();
	}
});

test("byte-exact roundtrip: restoring reverts all three official packages to the original bytes", () => {
	const install = makeInstall();
	try {
		patchInstalled([], { anchors: [install.anchor] });
		const undo = unpatchInstalled([], { anchors: [install.anchor] });
		assert.ok(undo.results.length > 0);
		assert.ok(undo.results.every((result) => result.status === "unpatched"));		for (const target of TARGETS) {
			assert.equal(
				readFileSync(install.path(target), "utf8"),
				officialSource(target),
				`${target.name} was not restored byte-exactly`
			);
		}
	} finally {
		install.cleanup();
	}
});

test("restore is idempotent: unpatching an already-unpatched install skips everything", () => {
	const install = makeInstall();
	try {
		patchInstalled([], { anchors: [install.anchor] });
		unpatchInstalled([], { anchors: [install.anchor] });
		const pristine = TARGETS.map((target) => readFileSync(install.path(target), "utf8"));
		const again = unpatchInstalled([], { anchors: [install.anchor] });
		assert.ok(again.results.length > 0);
		assert.ok(again.results.every((result) => result.status === "skip"));
		TARGETS.forEach((target, index) => {
			assert.equal(readFileSync(install.path(target), "utf8"), pristine[index]);
		});
	} finally {
		install.cleanup();
	}
});

test("restore removes the to text only when the marker is present, in reverse hunk order", () => {
	const install = makeInstall();
	try {
		/* Synthetic file where hunk B's anchor lives INSIDE hunk A's replacement:
		   only reverse-order restore can recover the original. */
		const hunkA = { what: "outer", marker: "marker-A", from: "AAA", to: "BBB\n/* marker-A */" };
		const hunkB = { what: "inner", marker: "marker-B", from: "BBB", to: "CCC /* marker-B */" };
		const file = join(install.root, "nested.txt");
		writeFileSync(file, "AAA\n");
		/* Not through patchInstalled (hunk lists are fixed per package): drive the
		   hunk machinery directly through applyHunks/unpatchHunks. */
		applyHunks(file, [hunkA, hunkB]);
		assert.equal(readFileSync(file, "utf8"), "CCC /* marker-B */\n/* marker-A */\n");
		const undo = unpatchHunks(file, [hunkA, hunkB]);
		assert.deepEqual(undo.map((result) => result.status), ["unpatched", "unpatched"]);
		assert.equal(readFileSync(file, "utf8"), "AAA\n");
	} finally {
		install.cleanup();
	}
});

test("restore refuses when the marker is present but the to text occurs more than once", () => {
	const install = makeInstall();
	try {
		const hunk = SESSION_HUNKS[0];
		const doubled = `${hunk.to}\n\n${hunk.to}\n`;
		writeFileSync(install.path(session), doubled);
		assert.throws(() => unpatchInstalled([], { anchors: [install.anchor] }), /ambiguous/);
		assert.equal(readFileSync(install.path(session), "utf8"), doubled);
	} finally {
		install.cleanup();
	}
});

test("restore refuses when the marker is present but the to text is gone", () => {
	const install = makeInstall();
	try {
		/* Marker present, replacement text missing — restore must fail loudly
		   instead of corrupting the file. */
		writeFileSync(install.path(session), `// ${SESSION_HUNKS[0].marker} only\n`);
		assert.throws(() => unpatchInstalled([], { anchors: [install.anchor] }), /patch anchor not found/);
		assert.equal(readFileSync(install.path(session), "utf8"), `// ${SESSION_HUNKS[0].marker} only\n`);
	} finally {
		install.cleanup();
	}
});

test("a hunk whose marker is already present is skipped without checking its anchor", () => {
	const install = makeInstall();
	try {
		/* All markers present (concatenated replacements) — every hunk must skip,
		   even though no from anchor exists in this content. */
		let content = "";
		for (const target of TARGETS) {
			for (const hunk of hunksFor(target, HUNKS)) content += `${hunk.to}\n`;
		}
		writeFileSync(install.path(agentLoop), content);
		writeFileSync(install.path(session), content);
		writeFileSync(install.path(conversation), content);
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.ok(report.results.length > 0);
		assert.ok(report.results.every((result) => result.status === "skip"));
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), content);
	} finally {
		install.cleanup();
	}
});

test("the same real file reachable from two anchors is patched exactly once", () => {
	const install = makeInstall();
	try {
		const report = patchInstalled([], { anchors: [install.anchor, install.secondAnchor] });
		const patchedHunks = report.results.filter((result) => result.status === "patched");
		assert.ok(patchedHunks.length > 0);
		/* Each hunk was applied to exactly one file copy. */
		const perWhat = new Map();
		for (const result of patchedHunks) {
			perWhat.set(result.what, (perWhat.get(result.what) ?? 0) + 1);
		}
		for (const count of perWhat.values()) assert.equal(count, 1);
		for (const target of TARGETS) {
			const source = readFileSync(install.path(target), "utf8");
			for (const hunk of hunksFor(target, HUNKS)) {
				assert.equal(source.split(hunk.marker).length - 1, 1, `${target.name}: marker "${hunk.marker}" must appear exactly once`);
			}
		}
	} finally {
		install.cleanup();
	}
});

test("real hunk data is well-formed for the official rc.6 sources", () => {
	/* Guards the exact-once contract against the REAL hunk data on the REAL
	   official files: every hunk's from must occur exactly once at apply time
	   and every marker must be embedded in its own replacement text. */
	for (const target of TARGETS) {
		const source = officialSource(target);
		for (const hunk of hunksFor(target, HUNKS)) {
			assert.ok(hunk.to.includes(hunk.marker), `${target.name}: ${hunk.what} replacement lacks its own marker`);
			const count = source.split(hunk.from).length - 1;
			assert.ok(count === 0 || count === 1, `${target.name}: ${hunk.what} from occurs ${count}x in the official source`);
		}
	}
});
