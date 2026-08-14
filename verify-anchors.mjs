// One-shot anchor verification for dsh-resume patches (no writes).
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { AGENT_LOOP_HUNKS, SESSION_HUNKS, CONVERSATION_HUNKS } from "./lib/patch.js";

const anchors = [
  import.meta.url,
  join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "web", "package.json"),
];
const packages = [
  ["@deepseek-ai/dsh-agent-loop", "lib/index.js", AGENT_LOOP_HUNKS],
  ["@deepseek-ai/dsh-session", "lib/index.js", SESSION_HUNKS],
  ["@deepseek-ai/dsh-client-ui-conversation", "lib/client.js", CONVERSATION_HUNKS],
];
const found = new Set();
const seen = new Set();
let failures = 0;
for (const anchor of anchors) {
  const anchoredRequire = createRequire(anchor);
  for (const [packageName, file, hunks] of packages) {
    let path;
    try {
      path = realpathSync(join(dirname(anchoredRequire.resolve(`${packageName}/package.json`)), file));
    } catch {
      continue;
    }
    found.add(packageName);
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const hunk of hunks) {
      const count = source.split(hunk.from).length - 1;
      const markerCount = source.split(hunk.marker).length - 1;
      const marker = markerCount === 1;
      if (markerCount > 1 || (markerCount === 0 && count !== 1)) {
        failures += 1;
        console.log(`FAIL ${packageName}/${file} - ${hunk.what}: occurrences=${count} markerPresent=${marker}`);
      } else {
        console.log(`ok   ${packageName}/${file} - ${hunk.what} (${marker ? "patched" : "pristine"})`);
      }
    }
  }
}
for (const [packageName] of packages) {
  if (found.has(packageName)) continue;
  failures += 1;
  console.log(`FAIL ${packageName}: package was not reachable from any resolution anchor`);
}
console.log(failures === 0 ? "ALL ANCHORS OK" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
