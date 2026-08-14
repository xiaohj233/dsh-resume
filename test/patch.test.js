// Behavior tests for lib/patch.js against byte-exact official rc.6 fixtures.
// Every test builds its own temporary install tree (see helpers.mjs); nothing
// touches the real profile, the real DSH_HOME, or the repo's node_modules.
//
// v2 patch semantics under test:
// - adaptive by default: an untested version is patched when every hunk
//   anchor still matches uniquely; otherwise that copy is skipped.
// - strict option: only the exact tested version is patched.
// - one drifted copy never blocks the others; module loading never throws.
// - restore is ALWAYS strict (untested versions and unknown layouts refuse).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("adaptive mode patches an untested version when every anchor matches", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0-rc.7" } });
	try {
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, true);
		assert.ok(report.applied.some((entry) => entry.file === install.path(session)));
		const adaptive = report.applied.find((entry) => entry.file === install.path(session));
		assert.equal(adaptive.adaptive, true);
		const source = readFileSync(install.path(session), "utf8");
		for (const hunk of hunksFor(session, HUNKS)) {
			assert.ok(source.includes(hunk.marker), `marker "${hunk.marker}" missing after adaptive patch`);
		}
	} finally {
		install.cleanup();
	}
});

test("adaptive mode skips an untested version whose anchors drifted, writing nothing", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.2.0" } });
	try {
		writeFileSync(install.path(session), "// a rewritten upstream file\n");
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(session));
		assert.equal(skipped.reason, "version-anchor");
		assert.equal(readFileSync(install.path(session), "utf8"), "// a rewritten upstream file\n");
		/* Other copies still patched. */
		for (const target of [agentLoop, conversation]) {
			const source = readFileSync(install.path(target), "utf8");
			assert.ok(source.includes(hunksFor(target, HUNKS)[0].marker));
		}
	} finally {
		install.cleanup();
	}
});

test("strict mode refuses every untested version even when anchors match", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0-rc.7" } });
	try {
		const report = patchInstalled([], { anchors: [install.anchor], strict: true });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(session));
		assert.equal(skipped.reason, "version");
		assert.equal(readFileSync(install.path(session), "utf8"), officialSource(session));
		/* Exact-version copies still patch in strict mode. */
		for (const target of [agentLoop, conversation]) {
			const source = readFileSync(install.path(target), "utf8");
			assert.ok(source.includes(hunksFor(target, HUNKS)[0].marker));
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
		assert.equal(report.applied.length, TARGETS.length);
		assert.ok(report.applied.every((entry) => entry.adaptive !== true));
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

test("a drifted copy is skipped on its own; the other copies still patch", () => {
	const install = makeInstall();
	try {
		writeFileSync(install.path(agentLoop), "// not the real agent-loop\n");
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(agentLoop));
		assert.equal(skipped.reason, "anchor");
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), "// not the real agent-loop\n");
		for (const target of [session, conversation]) {
			const source = readFileSync(install.path(target), "utf8");
			assert.ok(source.includes(hunksFor(target, HUNKS)[0].marker), `${target.name} should still be patched`);
		}
	} finally {
		install.cleanup();
	}
});

test("a hunk whose anchor occurs more than once skips that copy only", () => {
	const install = makeInstall();
	try {
		const hunk = AGENT_LOOP_HUNKS[0];
		const doubled = `${hunk.from}\n\n${hunk.from}\n`;
		writeFileSync(install.path(agentLoop), doubled);
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(agentLoop));
		assert.equal(skipped.reason, "anchor");
		assert.ok(skipped.detail.includes("ambiguous-anchor"));
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), doubled);
		for (const target of [session, conversation]) {
			assert.ok(readFileSync(install.path(target), "utf8").includes(hunksFor(target, HUNKS)[0].marker));
		}
	} finally {
		install.cleanup();
	}
});

test("an unreadable manifest skips that package without throwing", () => {
	const install = makeInstall();
	try {
		writeFileSync(install.manifestPath(session), "{ not json");
		const report = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		assert.ok(report.skipped.some((entry) => entry.reason === "unreadable-manifest"));
		for (const target of [agentLoop, conversation]) {
			assert.ok(readFileSync(install.path(target), "utf8").includes(hunksFor(target, HUNKS)[0].marker));
		}
	} finally {
		install.cleanup();
	}
});

test("zero reachable targets reports ok with an explanatory summary and never throws", () => {
	const install = makeInstall();
	try {
		const emptyDir = mkdtempSync(join(tmpdir(), "dsh-resume-empty-"));
		const emptyAnchor = join(emptyDir, "anchor.json");
		writeFileSync(emptyAnchor, "{}\n");
		const report = patchInstalled([], { anchors: [emptyAnchor] });
		assert.equal(report.ok, true);
		assert.equal(report.applied.length, 0);
		assert.match(report.summary, /0/);
	} finally {
		install.cleanup();
	}
});

test("apply is idempotent: the second run skips every copy and leaves the bytes untouched", () => {
	const install = makeInstall();
	try {
		const first = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(first.ok, true);
		const afterFirst = TARGETS.map((target) => readFileSync(install.path(target), "utf8"));
		const second = patchInstalled([], { anchors: [install.anchor] });
		assert.equal(second.ok, true);
		assert.equal(second.applied.length, 0);
		assert.ok(second.skipped.every((entry) => entry.reason === "already-patched"));
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
		assert.equal(undo.ok, true);
		assert.equal(undo.reverted.length, TARGETS.length);
		for (const target of TARGETS) {
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
		assert.equal(again.ok, true);
		assert.equal(again.reverted.length, 0);
		assert.ok(again.skipped.every((entry) => entry.reason === "already-restored"));
		TARGETS.forEach((target, index) => {
			assert.equal(readFileSync(install.path(target), "utf8"), pristine[index]);
		});
	} finally {
		install.cleanup();
	}
});

test("restore is strict: an untested version is refused and left untouched", () => {
	const install = makeInstall({ overrideVersions: { [session.name]: "0.1.0-rc.7" } });
	try {
		patchInstalled([], { anchors: [install.anchor] });
		const before = readFileSync(install.path(session), "utf8");
		const report = unpatchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(session));
		assert.equal(skipped.reason, "version");
		assert.equal(readFileSync(install.path(session), "utf8"), before);
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
		const report = unpatchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(session));
		assert.equal(skipped.reason, "restore-blocked");
		assert.ok(skipped.detail.includes("ambiguous-to"));
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
		const report = unpatchInstalled([], { anchors: [install.anchor] });
		assert.equal(report.ok, false);
		const skipped = report.skipped.find((entry) => entry.file === install.path(session));
		assert.equal(skipped.reason, "restore-blocked");
		assert.ok(skipped.detail.includes("marker-without-to"));
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
		assert.equal(report.ok, true);
		assert.equal(report.applied.length, 0);
		assert.ok(report.skipped.every((entry) => entry.reason === "already-patched"));
		assert.equal(readFileSync(install.path(agentLoop), "utf8"), content);
	} finally {
		install.cleanup();
	}
});

test("the same real file reachable from two anchors is patched exactly once", () => {
	const install = makeInstall();
	try {
		const report = patchInstalled([], { anchors: [install.anchor, install.secondAnchor] });
		assert.equal(report.ok, true);
		assert.equal(report.applied.length, TARGETS.length);
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
