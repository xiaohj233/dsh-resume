#!/usr/bin/env node
/**
 * dsh-resume-restore — revert every dsh-resume patch on the active
 * profile/install, restoring the official package sources.
 *
 * Resolution mirrors patchInstalled: this package's own install, the DSH home
 * web profile manifest ($DSH_HOME/profiles/web/package.json, the copies the
 * running server actually loads), then any extra package.json-anchored paths
 * given as arguments. Version-guarded: an installed package at anything other
 * than the exact supported version refuses the whole run.
 *
 * Failures are never swallowed: the error goes to stderr and the process
 * exits with a nonzero status.
 */
import { unpatchInstalled } from "../lib/patch.js";

try {
	const report = unpatchInstalled(process.argv.slice(2));
	console.log(`dsh-resume-restore: ${report.summary}`);
	for (const result of report.results) {
		if (result.status !== "skip") console.log(`  ${result.status}: ${result.what}`);
	}
} catch (error) {
	console.error(`dsh-resume-restore: failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
