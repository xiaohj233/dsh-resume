#!/usr/bin/env node
/**
 * dsh-resume-restore — revert every dsh-resume patch on the active
 * profile/install, restoring the official package sources.
 *
 * Resolution mirrors patchInstalled: this package's own install, the DSH home
 * web profile manifest ($DSH_HOME/profiles/web/package.json, the copies the
 * running server actually loads), then any extra package.json-anchored paths
 * given as arguments.
 *
 * Restore is ALWAYS strict: a copy at an untested version, an unreadable
 * manifest, a marker without its exact `to` text, or an ambiguous `to`
 * refuses that copy and the process exits nonzero. Failures are never
 * swallowed: the reason goes to stderr and the process exits with a nonzero
 * status.
 */
import { unpatchInstalled } from "../lib/patch.js";

const report = unpatchInstalled(process.argv.slice(2));
console.log(`dsh-resume-restore: ${report.summary}`);
for (const entry of report.reverted) {
	console.log(`  restored: ${entry.file}`);
}
for (const entry of report.skipped) {
	if (entry.reason === "already-restored") {
		console.log(`  already original: ${entry.file}`);
	} else {
		console.error(`  refused: ${entry.file} (${entry.reason}${entry.detail ? `: ${entry.detail}` : ""})`);
	}
}
if (!report.ok) process.exitCode = 1;
