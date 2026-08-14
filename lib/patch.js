/**
 * @deepseek-ai/dsh-resume/patch — the installed-package patches this plugin
 * owns, applied at boot (see ./index.js).
 *
 * What is patched and why:
 *
 * 1. `@deepseek-ai/dsh-agent-loop/lib/index.js` — when a streaming turn is
 *    aborted (user stop / teardown), fold the already-streamed text/reasoning
 *    deltas into an `assistant/message` before the turn closes. Without this,
 *    the interrupted thinking exists only as `assistant/chunk` events, which
 *    are NOT part of the model-request history (`deriveMessages` folds surface
 *    events only) — a later "继续" would make the model start thinking from
 *    scratch instead of continuing. The fold is skipped when the step already
 *    produced a complete message (e.g. abort during a second request after a
 *    tool round).
 *
 * 2. `@deepseek-ai/dsh-session/lib/index.js` — same fold for the crash-repair
 *    path: `interruptedTurnClosers` now also folds the open step's partial
 *    chunks into an `assistant/message` so a session restored after a crash
 *    keeps its interrupted thinking in the model history.
 *
 * 3. `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` — the composer
 *    send button and Enter key: with an empty draft on a session whose last
 *    turn ended without completion, pressing send/Enter continues the turn via
 *    the `window.__dshResume` bridge (see ./client.js) instead of being a
 *    no-op. Also keeps the "stopped" badge on a folded partial message.
 *
 * All hunks are idempotent (per-hunk marker check) and anchor-based: when an
 * upstream update restores or rewrites a file, a hunk either still matches
 * (re-patched) or fails loudly naming the file and hunk.
 *
 * Safety contract (enforced and tested):
 * - The three target packages are resolved through their package.json
 *   manifests, and any installed version other than the exact supported one
 *   (0.1.0-rc.6) refuses the whole run BEFORE anything is written.
 * - A hunk whose marker is absent requires its `from` anchor to occur exactly
 *   once in the file; zero or multiple occurrences refuse without writing.
 * - Restore removes the exact `to` text only when the marker is present, in
 *   reverse hunk order, idempotently; a marker present without a unique `to`
 *   refuses without writing.
 * - All files are computed before any write: one refusal anywhere means no
 *   file is touched.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The exact published versions this plugin's patches are written against. */
const TARGET_VERSIONS = {
	"@deepseek-ai/dsh-agent-loop": "0.1.0-rc.6",
	"@deepseek-ai/dsh-session": "0.1.0-rc.6",
	"@deepseek-ai/dsh-client-ui-conversation": "0.1.0-rc.6"
};

/** (package name, target file) pairs patched by this plugin. */
const TARGET_FILES = [
	["@deepseek-ai/dsh-agent-loop", "lib/index.js"],
	["@deepseek-ai/dsh-session", "lib/index.js"],
	["@deepseek-ai/dsh-client-ui-conversation", "lib/client.js"]
];

/** Package root of one installed @deepseek-ai package (via its package.json). */
function packageRoot(packageName, anchor = import.meta.url) {
	const manifest = createRequire(anchor).resolve(`${packageName}/package.json`);
	return dirname(manifest);
}

/** Count (overlapping) occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
	if (needle === "") return 0;
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
	return count;
}

/**
 * Replace `from` with `to`, requiring the anchor to occur EXACTLY once. Zero
 * occurrences mean the installed package changed (fail loudly naming the
 * file/hunk); multiple occurrences mean the anchor is structurally ambiguous
 * and must never be silently patched — either way nothing is written.
 */
function replaceExactlyOnce(source, from, to, what) {
	const count = countOccurrences(source, from);
	if (count === 0) {
		throw new Error(`dsh-resume: patch anchor not found (${what}); the installed package changed — check whether upstream shipped a fix and update this plugin`);
	}
	if (count > 1) {
		throw new Error(`dsh-resume: patch anchor is ambiguous (${what}): the anchor text occurs ${count} times; refusing to patch — the installed package changed, update this plugin`);
	}
	const at = source.indexOf(from);
	return source.slice(0, at) + to + source.slice(at + from.length);
}

/**
 * Compute the content of one file after applying a hunk list (no writes).
 * A hunk whose marker is already present in the ORIGINAL source is a no-op; a
 * hunk whose anchor is missing or ambiguous fails loudly. Throwing here means
 * the caller writes nothing at all.
 */
function applyHunksToSource(source, hunks, file) {
	const results = [];
	let next = source;
	for (const hunk of hunks) {
		if (source.includes(hunk.marker)) {
			results.push({ status: "skip", file, what: hunk.what });
			continue;
		}
		next = replaceExactlyOnce(next, hunk.from, hunk.to, `${file}: ${hunk.what}`);
		results.push({ status: "patched", file, what: hunk.what });
	}
	return { content: next, results };
}

/** Apply a hunk list to one file; every missing/ambiguous anchor throws and nothing is written. */
function applyHunks(path, hunks) {
	const source = readFileSync(path, "utf8");
	const { content, results } = applyHunksToSource(source, hunks, path);
	if (content !== source) writeFileSync(path, content);
	return results;
}

/** Apply one hunk to one file (see {@link applyHunks}). */
function applyHunk(path, hunk) {
	return applyHunks(path, [hunk])[0];
}

/**
 * Compute the content of one file after reverting a hunk list (no writes).
 * A hunk whose marker is absent is already unpatched and is skipped; a hunk
 * whose marker is present must find its exact `to` text exactly once. Hunks
 * unwind in reverse declaration order so nested hunks restore
 * outermost-first. Throwing here means the caller writes nothing at all.
 */
function unpatchHunksToSource(source, hunks, file) {
	const results = [];
	let next = source;
	for (const hunk of [...hunks].reverse()) {
		if (!next.includes(hunk.marker)) {
			results.push({ status: "skip", file, what: hunk.what });
			continue;
		}
		next = replaceExactlyOnce(next, hunk.to, hunk.from, `${file}: ${hunk.what}`);
		results.push({ status: "unpatched", file, what: hunk.what });
	}
	return { content: next, results };
}

/**
 * Revert a hunk list on one file, restoring the pre-patch source. Idempotent:
 * a hunk whose marker is absent (upstream reinstall restored the original) is
 * skipped; a marker present without a unique `to` fails loudly rather than
 * corrupting the file, and nothing is written. Hunks unwind in reverse
 * declaration order so nested hunks restore outermost-first.
 * @param path - the file to unpatched.
 * @param hunks - hunk list, each with `what`, `from`, `to`, `marker`.
 * @returns the outcome per hunk: "unpatched" or "skip".
 */
function unpatchHunks(path, hunks) {
	const source = readFileSync(path, "utf8");
	const { content, results } = unpatchHunksToSource(source, hunks, path);
	if (content !== source) writeFileSync(path, content);
	return results;
}

// #region agent-loop patch (@deepseek-ai/dsh-agent-loop/lib/index.js)
const AGENT_LOOP_HUNKS = [
	{
		what: "agent-loop continue resume (empty-text = resume generation)",
		marker: "dsh-resume continue v1",
		from: `\t\tconst claimed = this.inbox.claim(target, position.turn);
\t\tconst assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`,
		to: `\t\tconst claimed = this.inbox.claim(target, position.turn);
\t\t/* dsh-resume continue v1: an empty-text user message means "resume the
\t\tinterrupted generation" — no message and no context injection enter the
\t\trequest, so the model history ends with the folded partial assistant
\t\tmessage and the model continues from where it stopped. */
\t\tconst continued = Array.isArray(claimed) && claimed.length > 0 && claimed.every((message) => message?.content?.length === 1 && message.content[0]?.type === "text" && message.content[0].text === "");
\t\tconst assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));`
	},
	{
		what: "agent-loop continue pre-step",
		marker: "dsh-resume continue-prestep v1",
		from: `\t\tconst context = this.runtimeContext.project(joinContextSections(sections), sections);
\t\tconst decision = await this.dispatch.waterfall("agent/pre-step", {
\t\t\tmessages: claimed,
\t\t\t...position,
\t\t\tsignal
\t\t}, () => Promise.resolve({
\t\t\tkind: "enter",
\t\t\tmessages: context === void 0 ? claimed : [...claimed, context]
\t\t}));`,
		to: `\t\tconst context = this.runtimeContext.project(joinContextSections(sections), sections);
\t\tconst decision = await this.dispatch.waterfall("agent/pre-step", {
\t\t\tmessages: claimed,
\t\t\t...position,
\t\t\tsignal
\t\t}, () => Promise.resolve({
\t\t\tkind: "enter",
\t\t\t/* dsh-resume continue-prestep v1 */
\t\t\tmessages: continued ? [] : (context === void 0 ? claimed : [...claimed, context]),
\t\t\t...(continued ? { continued: true } : {})
\t\t}));`
	},
	{
		what: "agent-loop continue turn empty-message bypass",
		marker: "dsh-resume continue-turn v1",
		from: `\t\t\t\tif (turnEnds && decision.messages.length === 0) break;
\t\t\t\tif (phase.step === 0 && decision.messages.length === 0) {
\t\t\t\t\tturnEnds = { kind: "completed" };
\t\t\t\t\treturn false;
\t\t\t\t}`,
		to: `\t\t\t\tif (turnEnds && decision.messages.length === 0) break;
\t\t\t\t/* dsh-resume continue-turn v1 */
\t\t\t\tif (phase.step === 0 && decision.messages.length === 0 && decision.continued !== true) {
\t\t\t\t\tturnEnds = { kind: "completed" };
\t\t\t\t\treturn false;
\t\t\t\t}`
	},
	{
		what: "agent-loop stream abort partial fold",
		marker: "dsh-resume partial fold v1",
		from: `\t\t\tsignal.throwIfAborted();
\t\t\tfor await (const chunk of stream) {
\t\t\t\tsignal.throwIfAborted();
\t\t\t\tchunkSeqs.push(this.session.append("assistant/chunk", {
\t\t\t\t\tturn,
\t\t\t\t\tstep,
\t\t\t\t\tchunk
\t\t\t\t}).seq);
\t\t\t\tassembler.push(chunk);
\t\t\t}
\t\t\tsignal.throwIfAborted();`,
		to: `\t\t\tsignal.throwIfAborted();
\t\t\ttry {
\t\t\t\tfor await (const chunk of stream) {
\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\tchunkSeqs.push(this.session.append("assistant/chunk", {
\t\t\t\t\t\tturn,
\t\t\t\t\t\tstep,
\t\t\t\t\t\tchunk
\t\t\t\t\t}).seq);
\t\t\t\t\tassembler.push(chunk);
\t\t\t\t}
\t\t\t\tsignal.throwIfAborted();
\t\t\t} catch (error) {
\t\t\t\t/* dsh-resume partial fold v1: fold partial text/reasoning into an assistant message so
\t\t\t\tthe interrupted thinking stays in the model history and a "继续" resumes it. */
\t\t\t\tif (signal.aborted) {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst alreadyComplete = this.session.events.findLast((event) => event.type === "assistant/message" && event.data.turn === turn && event.data.step === step) !== void 0;
\t\t\t\t\t\tif (!alreadyComplete) {
\t\t\t\t\t\t\tconst partialBlocks = assembler.blocks().filter((block) => block.type === "text" || block.type === "reasoning");
\t\t\t\t\t\t\tif (partialBlocks.length > 0 && chunkSeqs.length > 0) {
\t\t\t\t\t\t\t\tthis.session.append("assistant/message", {
\t\t\t\t\t\t\t\t\tturn,
\t\t\t\t\t\t\t\t\tstep,
\t\t\t\t\t\t\t\t\tmessage: createAssistantMessage({
\t\t\t\t\t\t\t\t\t\tcontent: partialBlocks,
\t\t\t\t\t\t\t\t\t\tsource: {
\t\t\t\t\t\t\t\t\t\t\tprovider: request.provider,
\t\t\t\t\t\t\t\t\t\t\tmodel: request.model,
\t\t\t\t\t\t\t\t\t\t\t...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}
\t\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t\t...assembler.usage === void 0 ? {} : { usage: assembler.usage }
\t\t\t\t\t\t\t\t}, {
\t\t\t\t\t\t\t\t\tsurfaceOp: "append",
\t\t\t\t\t\t\t\t\tsourceEventSeqs: chunkSeqs
\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t} catch (foldError) {
\t\t\t\t\t\t/* best-effort: the interrupted turn must still abort cleanly */
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tthrow error;
\t\t\t}`,
		},
	{
		what: "agent-loop assistant source reasoning effort",
		marker: "dsh-resume source effort v1",
		from: `\t\t\tconst message = createAssistantMessage({
\t\t\t\tcontent: assembler.blocks(),
\t\t\t\tsource: {
\t\t\t\t\tprovider: request.provider,
\t\t\t\t\tmodel: request.model,
\t\t\t\t\t...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}
\t\t\t\t}
\t\t\t});`,
		to: `\t\t\tconst message = createAssistantMessage({
\t\t\t\tcontent: assembler.blocks(),
\t\t\t\tsource: {
\t\t\t\t\tprovider: request.provider,
\t\t\t\t\tmodel: request.model,
\t\t\t\t\t/* dsh-resume source effort v1: keep the request's reasoning effort on the message source so the client can show it in the turn-tail model row. */
\t\t\t\t\t...request.reasoningEffort !== void 0 ? { reasoningEffort: request.reasoningEffort } : {},
\t\t\t\t\t...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}
\t\t\t\t}
\t\t\t});`
	},
	{
		what: "agent-loop fold source reasoning effort",
		marker: "dsh-resume source effort v2",
		from: `\t\t\t\t\t\t\t\t\t\tsource: {
\t\t\t\t\t\t\t\t\t\t\tprovider: request.provider,
\t\t\t\t\t\t\t\t\t\t\tmodel: request.model,
\t\t\t\t\t\t\t\t\t\t\t...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}
\t\t\t\t\t\t\t\t\t\t}`,
		to: `\t\t\t\t\t\t\t\t\t\tsource: {
\t\t\t\t\t\t\t\t\t\t\tprovider: request.provider,
\t\t\t\t\t\t\t\t\t\t\tmodel: request.model,
\t\t\t\t\t\t\t\t\t\t\t/* dsh-resume source effort v2: same effort on the interrupted-turn fold. */
\t\t\t\t\t\t\t\t\t\t\t...request.reasoningEffort !== void 0 ? { reasoningEffort: request.reasoningEffort } : {},
\t\t\t\t\t\t\t\t\t\t\t...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}
\t\t\t\t\t\t\t\t\t\t}`
	}
];
// #endregion

// #region session patch (@deepseek-ai/dsh-session/lib/index.js)
const SESSION_HUNKS = [
	{
		what: "interruptedTurnClosers state",
		marker: "dsh-resume crash-fold v1",
		from: `\tlet openTurn = null;
\tlet openStep = null;
\tconst pendingCalls = /* @__PURE__ */ new Map();`,
		to: `\tlet openTurn = null;
\tlet openStep = null;
\tconst pendingCalls = /* @__PURE__ */ new Map();
\t/* dsh-resume crash-fold v1: collect this open step's raw chunks and track steps that already folded a message. */
\tconst stepMessages = /* @__PURE__ */ new Set();
\tlet openChunks = [];`
	},
	{
		what: "interruptedTurnClosers scan cases",
		marker: "dsh-resume crash-scan v1",
		from: `\t\tcase "turn/start":
\t\t\topenTurn = event.data.turn;
\t\t\topenStep = null;
\t\t\tpendingCalls.clear();
\t\t\tbreak;
\t\tcase "turn/end":
\t\t\topenTurn = null;
\t\t\topenStep = null;
\t\t\tpendingCalls.clear();
\t\t\tbreak;
\t\tcase "step/start":
\t\t\topenStep = event.data.step;
\t\t\tbreak;
\t\tcase "step/end":
\t\t\tpendingCalls.clear();
\t\t\topenStep = null;
\t\t\tbreak;
\t\tcase "assistant/message":
\t\t\tfor (const block of event.data.message.content) if (block.type === "tool-call") pendingCalls.set(block.id, { step: event.data.step });
\t\t\tbreak;`,
		to: `\t\t/* dsh-resume crash-scan v1 */
		\t\tcase "turn/start":
\t\t\topenTurn = event.data.turn;
\t\t\topenStep = null;
\t\t\tpendingCalls.clear();
\t\t\tstepMessages.clear();
\t\t\topenChunks = [];
\t\t\tbreak;
\t\tcase "turn/end":
\t\t\topenTurn = null;
\t\t\topenStep = null;
\t\t\tpendingCalls.clear();
\t\t\topenChunks = [];
\t\t\tbreak;
\t\tcase "step/start":
\t\t\topenStep = event.data.step;
\t\t\topenChunks = [];
\t\t\tbreak;
\t\tcase "step/end":
\t\t\tpendingCalls.clear();
\t\t\topenStep = null;
\t\t\topenChunks = [];
\t\t\tbreak;
\t\tcase "assistant/chunk":
\t\t\tif (openTurn !== null && openStep !== null && event.data.step === openStep) openChunks.push({ seq: event.seq, chunk: event.data.chunk });
\t\t\tbreak;
\t\tcase "assistant/message":
\t\t\tstepMessages.add(event.data.step);
\t\t\tfor (const block of event.data.message.content) if (block.type === "tool-call") pendingCalls.set(block.id, { step: event.data.step });
\t\t\tbreak;`
	},
	{
		what: "interruptedTurnClosers partial fold",
		marker: "dsh-resume crash-fold-close v1",
		from: `\tconst last = events.at(-1);
\tif (openTurn === null || last === void 0) return [];
\tlet seq = last.seq + 1;
\tconst time = last.time;
\tconst closers = [];`,
		to: `\tconst last = events.at(-1);
\tif (openTurn === null || last === void 0) return [];
\tlet seq = last.seq + 1;
\tconst time = last.time;
\tconst closers = [];
\t/* dsh-resume crash-fold-close v1: fold an open step's partial text/reasoning into an assistant
\tmessage so a resumed session keeps the interrupted thinking in its model history. */
\tif (openStep !== null && !stepMessages.has(openStep) && openChunks.length > 0) {
\t\tconst partials = /* @__PURE__ */ new Map();
\t\tconst order = [];
\t\tconst chunkSeqs = [];
\t\tfor (const { seq: chunkSeq, chunk } of openChunks) {
\t\t\tchunkSeqs.push(chunkSeq);
\t\t\tswitch (chunk.type) {
\t\t\t\tcase "block-start":
\t\t\t\t\tif (!partials.has(chunk.index)) {
\t\t\t\t\t\tpartials.set(chunk.index, { blockType: chunk.blockType, text: "" });
\t\t\t\t\t\torder.push(chunk.index);
\t\t\t\t\t}
\t\t\t\t\tbreak;
\t\t\t\tcase "text-delta":
\t\t\t\tcase "reasoning-delta": {
\t\t\t\t\tconst blockType = chunk.type === "text-delta" ? "text" : "reasoning";
\t\t\t\t\tconst entry = partials.get(chunk.index);
\t\t\t\t\tif (entry === void 0) {
\t\t\t\t\t\tpartials.set(chunk.index, { blockType, text: chunk.text });
\t\t\t\t\t\torder.push(chunk.index);
\t\t\t\t\t} else if (entry.blockType === blockType) entry.text += chunk.text;
\t\t\t\t\tbreak;
\t\t\t\t}
\t\t\t\tdefault: break;
\t\t\t}
\t\t}
\t\tconst blocks = [];
\t\tfor (const index of order) {
\t\t\tconst entry = partials.get(index);
\t\t\tif (entry.blockType === "text" || entry.blockType === "reasoning") blocks.push({ type: entry.blockType, text: entry.text });
\t\t}
\t\tif (blocks.length > 0) {
\t\t\tlet header;
\t\t\tfor (const event of events) if (event.type === "request/header") header = event.data.header;
\t\t\tclosers.push({
\t\t\t\ttype: "assistant/message",
\t\t\t\tseq: seq++,
\t\t\t\ttime,
\t\t\t\tdata: {
\t\t\t\t\tturn: openTurn,
\t\t\t\t\tstep: openStep,
\t\t\t\t\tmessage: freezeMessage({
\t\t\t\t\t\tid: MessageId(\`interrupted-partial-\${seq}\`),
\t\t\t\t\t\trole: "assistant",
\t\t\t\t\t\tcontent: blocks,
\t\t\t\t\t\tsource: {
\t\t\t\t\t\t\tkind: "model",
\t\t\t\t\t\t\t...header === void 0 ? {} : { provider: header.config.provider, model: header.config.model }
\t\t\t\t\t\t}
\t\t\t\t\t})
\t\t\t\t},
\t\t\t\tsurfaceOp: "append",
\t\t\t\tsourceEventSeqs: chunkSeqs
\t\t\t});
\t\t}
\t}`
	}
];
// #endregion

// #region conversation client patch (@deepseek-ai/dsh-client-ui-conversation/lib/client.js)
const CONVERSATION_HUNKS = [
	{
		what: "InputBar resumable state",
		marker: "dsh-resume resumable v1",
		from: `\t\t\tconst empty = draft.trim() === "" && attachments.length === 0;`,
		to: `\t\t\tconst empty = draft.trim() === "" && attachments.length === 0;
\t\t\t/* dsh-resume resumable v1: the last turn ended without completion — empty-input send continues it. */
\t\t\tconst resumable = useSession((snapshot) => {
\t\t\t\tif (snapshot.running || snapshot.subagent !== null) return false;
\t\t\t\tconst timeline = snapshot.chat?.timeline;
\t\t\t\tconst order = timeline?.turnOrder;
\t\t\t\tconst last = order === void 0 || order.length === 0 ? void 0 : order[order.length - 1];
\t\t\t\tconst turn = last === void 0 ? void 0 : timeline.turns.get(last);
\t\t\t\tconst end = turn?.end;
\t\t\t\tif (end === void 0) return false;
\t\t\t\tconst kind = end.data?.reason?.kind;
\t\t\t\treturn kind !== void 0 && kind !== "completed";
\t\t\t}) ?? false;`
	},
	{
		what: "InputBar Enter resume",
		marker: "dsh-resume enter v1",
		from: `\t\t\t\te.preventDefault();
\t\t\t\tif (e.repeat) return;
\t\t\t\tif (locked || machineBusy) return;
\t\t\t\tconst accelerated = e.ctrlKey || e.metaKey;`,
		to: `\t\t\t\te.preventDefault();
\t\t\t\tif (e.repeat) return;
\t\t\t\tif (locked || machineBusy) return;
\t\t\t\t/* dsh-resume enter v1: Enter with an empty draft continues an interrupted session. */
\t\t\t\tif (empty && resumable && window.__dshResume !== void 0) {
\t\t\t\t\twindow.__dshResume.resume(sessionId);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tconst accelerated = e.ctrlKey || e.metaKey;`
	},
	{
		what: "InputBar primary label/action",
		marker: "dsh-resume resume-action v1",
		from: `\t\t\tconst primaryLabel = primaryStops ? t("input.stop") : t("input.send");
\t\t\tconst onPrimary = () => {
\t\t\t\tif (primaryStops) {
\t\t\t\t\tstop?.();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (inputActions === void 0) return;
\t\t\t\t/* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
\t\t\t\tif (!empty && !disabled && !machineBusy) inputActions.submit();
\t\t\t};`,
		to: `\t\t\tconst primaryLabel = primaryStops ? t("input.stop") : (resumable && empty ? (window.__dshResume?.label ?? "续接") : t("input.send"));
\t\t\tconst onPrimary = () => {
\t\t\t\tif (primaryStops) {
\t\t\t\t\tstop?.();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (inputActions === void 0) return;
\t\t\t\t/* dsh-resume resume-action v1: empty input on an interrupted session continues it. */
\t\t\t\tif (empty && resumable && window.__dshResume !== void 0) {
\t\t\t\t\twindow.__dshResume.resume(sessionId);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\t/* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
\t\t\t\tif (!empty && !disabled && !machineBusy) inputActions.submit();
\t\t\t};`
	},
	{
		what: "InputBar send button disabled",
		marker: "dsh-resume disabled v1",
		from: `\t\t\t\t\t\t\t\t\t\t\t\tdisabled: primaryStops ? stop === void 0 : empty || disabled || machineBusy,`,
		to: `\t\t\t\t\t\t\t\t\t\t\t\tdisabled: /* dsh-resume disabled v1 */ primaryStops ? stop === void 0 : (empty && !resumable) || disabled || machineBusy,`
	},
	{
		what: "assistant node interrupted badge",
		marker: "dsh-resume badge v1",
		from: `\t\t\tif (final?.event.type === "assistant/message") {
\t\t\t\tconst event = final.event;
\t\t\t\treturn {
\t\t\t\t\tkind: "assistant",
\t\t\t\t\tseq: event.seq,
\t\t\t\t\tmessageId: event.data.message.id,
\t\t\t\t\ttime: event.time,
\t\t\t\t\tturn: state.turn,
\t\t\t\t\tstep: state.step,
\t\t\t\t\tblocks: (0, _deepseek_ai_dsh_client_runtime_client.toAssistantBlocks)(event.data.message.content),
\t\t\t\t\tusage: event.data.usage,
\t\t\t\t\ttiming: {
\t\t\t\t\t\tstepStartTime: context.start?.event.time ?? null,
\t\t\t\t\t\tfirstTokenTime: state.firstTokenTime ?? null,
\t\t\t\t\t\tcompletedTime: event.time
\t\t\t\t\t}
\t\t\t\t};
\t\t\t}`,
		to: `\t\t\tif (final?.event.type === "assistant/message") {
\t\t\t\tconst event = final.event;
\t\t\t\t/* dsh-resume badge v1: a message whose turn ended aborted/interrupted is a partial fold — keep the stopped badge. */
\t\t\t\tconst location = context.start?.location ?? context.matches.at(-1)?.location;
\t\t\t\tconst turnEnd = location === void 0 ? void 0 : location.turn?.end;
\t\t\t\tconst interrupted = turnEnd !== void 0 && (turnEnd.data.reason.kind === "aborted" || turnEnd.data.reason.kind === "interrupted");
\t\t\t\treturn {
\t\t\t\t\tkind: "assistant",
\t\t\t\t\tseq: event.seq,
\t\t\t\t\tmessageId: event.data.message.id,
\t\t\t\t\ttime: event.time,
\t\t\t\t\tturn: state.turn,
\t\t\t\t\tstep: state.step,
\t\t\t\t\tblocks: (0, _deepseek_ai_dsh_client_runtime_client.toAssistantBlocks)(event.data.message.content),
\t\t\t\t\tusage: event.data.usage,
\t\t\t\t\ttiming: {
\t\t\t\t\t\tstepStartTime: context.start?.event.time ?? null,
\t\t\t\t\t\tfirstTokenTime: state.firstTokenTime ?? null,
\t\t\t\t\t\tcompletedTime: event.time
\t\t\t\t\t},
\t\t\t\t\t...(interrupted ? { interrupted: true } : {})
\t\t\t\t};
\t\t\t}`
	}
];
// #endregion

/**
 * The DSH home directory: $DSH_HOME, or the conventional ~/.dsh. The web
 * profile lives under it, and resolving the patched packages from the
 * profile's manifest follows the same node_modules walk (and the boot-maintained
 * fallback junctions) the Loader uses — so this anchor names the copies the
 * RUNNING server actually loads, even when that server boots from a different
 * dsh installation (e.g. a global npm install) whose nested node_modules holds
 * its own unpatched closure.
 * @returns the DSH home directory.
 */
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Resolve one (packageName, file) target from one anchor. Returns null when
 * the package (or its target file) is not installed at this anchor. An
 * installed package whose manifest cannot be read resolves to a descriptor
 * with `manifestError` set; an installed package at any version resolves to a
 * descriptor carrying its `version` — the decision whether that version may
 * be patched belongs to the caller (patchInstalled), never here, so a single
 * unsupported copy can never brick module loading.
 */
function resolveTarget(anchor, packageName, file) {
	const manifestPath = findManifest(anchorPath(anchor), packageName);
	if (manifestPath === null) return null;
	const root = dirname(manifestPath);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { packageName, root, version: null, manifestError: error instanceof Error ? error.message : String(error) };
	}
	try {
		return { packageName, root, version: manifest.version, file: realpathSync(join(root, file)) };
	} catch {
		return null;
	}
}

/** Normalize an anchor (possibly a `file://` URL, as with import.meta.url) to a plain path. */
function anchorPath(anchor) {
	return typeof anchor === "string" && anchor.startsWith("file://") ? fileURLToPath(anchor) : anchor;
}

/**
 * Find `<anchor dir>/node_modules/<packageName>/package.json`, replicating
 * node's upward node_modules walk (the same walk the Loader uses for the
 * boot-maintained fallback junctions; junctions and symlinks are followed
 * transparently by the filesystem). Returns the manifest path, or null when
 * the package is not installed at this anchor.
 */
function findManifest(anchorPathValue, packageName) {
	let dir = dirname(anchorPathValue);
	for (;;) {
		const candidate = join(dir, "node_modules", packageName, "package.json");
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* keep walking up */
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** All reachable target descriptors across anchors, deduplicated by real path. */
function resolveTargets(anchors) {
	const seen = new Set();
	const targets = [];
	for (const anchor of anchors) {
		for (const [packageName, file] of TARGET_FILES) {
			const resolved = resolveTarget(anchor, packageName, file);
			if (resolved === null) continue;
			/* Unreadable-manifest descriptors have no file; dedupe them by
			package + root so the caller still sees (and refuses) them. */
			const key = resolved.file ?? `${resolved.packageName}@${resolved.root}`;
			if (seen.has(key)) continue;
			seen.add(key);
			targets.push(resolved);
		}
	}
	return targets;
}

/** `@deepseek-ai/dsh-agent-loop` style label for a target file path. */
function packageLabel(file) {
	const match = /@deepseek-ai[\\/][^\\/]+/.exec(file);
	return match ? match[0] : basename(dirname(file));
}

/** The hunk list that patches one target package (matched by package name). */
function hunksForPackage(packageName) {
	return packageName.includes("dsh-agent-loop") ? AGENT_LOOP_HUNKS : packageName.includes("dsh-session") ? SESSION_HUNKS : CONVERSATION_HUNKS;
}

/**
 * Non-throwing hunk application: applies every hunk in declaration order to
 * `source`, classifying each outcome instead of failing the whole run.
 * A hunk whose marker is already present in the ORIGINAL source is `already`;
 * a hunk whose `from` anchor is missing or ambiguous in the EVOLVING content
 * is a blocker with a reason; every other hunk is replaced and marked
 * `patched`. Returns `{ content, results, blockers }` — callers write
 * nothing when blockers are non-empty.
 */
function classifyApply(source, hunks, file) {
	const results = [];
	const blockers = [];
	let next = source;
	for (const hunk of hunks) {
		if (source.includes(hunk.marker)) {
			results.push({ status: "already", file, what: hunk.what });
			continue;
		}
		const count = countOccurrences(next, hunk.from);
		if (count === 0) {
			blockers.push({ file, what: hunk.what, reason: "missing-anchor" });
			continue;
		}
		if (count > 1) {
			blockers.push({ file, what: hunk.what, reason: "ambiguous-anchor" });
			continue;
		}
		const at = next.indexOf(hunk.from);
		next = next.slice(0, at) + hunk.to + next.slice(at + hunk.from.length);
		results.push({ status: "patched", file, what: hunk.what });
	}
	return { content: next, results, blockers };
}

/**
 * Non-throwing hunk reversion (strict): unwinds hunks in reverse declaration
 * order so nested hunks restore outermost-first. A hunk whose marker is
 * absent is `already` (idempotent); a marker present without exactly one `to`
 * occurrence is a blocker — restoring never guesses on unknown layouts.
 */
function classifyUnpatch(source, hunks, file) {
	const results = [];
	const blockers = [];
	let next = source;
	for (const hunk of [...hunks].reverse()) {
		if (!next.includes(hunk.marker)) {
			results.push({ status: "already", file, what: hunk.what });
			continue;
		}
		const count = countOccurrences(next, hunk.to);
		if (count === 0) {
			blockers.push({ file, what: hunk.what, reason: "marker-without-to" });
			continue;
		}
		if (count > 1) {
			blockers.push({ file, what: hunk.what, reason: "ambiguous-to" });
			continue;
		}
		const at = next.indexOf(hunk.to);
		next = next.slice(0, at) + hunk.from + next.slice(at + hunk.to.length);
		results.push({ status: "unpatched", file, what: hunk.what });
	}
	return { content: next, results, blockers };
}

/**
 * Write a file through a temporary sibling and rename it into place, so a
 * mid-write failure or crash cannot leave a partially patched official file.
 */
function atomicWrite(file, content) {
	const temp = `${file}.dsh-resume-${process.pid}.tmp`;
	try {
		writeFileSync(temp, content);
		renameSync(temp, file);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* the temp file may not exist yet */
		}
		throw error;
	}
}

/**
 * Apply every hunk to every reachable installed copy of the three packages.
 * Resolution anchors, in order: this plugin's own location (the install the
 * plugin was resolved from), the DSH home's web profile manifest (the copies
 * the running server loads, via the boot-maintained fallback junctions), and
 * any extra anchors the caller supplies. Real paths are deduplicated, so a
 * junctioned fallback adds no second patch pass.
 *
 * Version policy (v2 — adaptive by default, strict optional, NEVER blocks):
 * - `strict: false` (default, adaptive): an exact-version target is patched
 *   when every hunk's anchor is unique; a different version is patched only
 *   when every hunk's anchor still matches uniquely (recorded as
 *   `adaptive: true`), otherwise that copy is skipped with a reason.
 * - `strict: true`: only exact-version targets are patched; every other copy
 *   is skipped with a reason.
 * - A target whose manifest is unreadable is skipped with a reason.
 * - Missing or ambiguous anchors skip ONLY that copy; other copies still
 *   patch. This function never throws for installation-state reasons, so a
 *   DSH upgrade can never brick module loading or the agent loop.
 *
 * Each copy is computed before any write; only successfully classified
 * copies are written, atomically (temp file + rename).
 * @param extraAnchors - additional package.json-anchored paths to resolve from.
 * @param options - `{ anchors }`: an exact anchor list, replacing the default
 * resolution; `{ strict }`: strict version policy (see above).
 * @returns a report `{ ok, summary, applied, skipped, results }`; `ok` is
 * false when any copy was skipped for a failure reason (version in strict
 * mode, unreadable manifest, missing/ambiguous anchors).
 */
export function patchInstalled(extraAnchors = [], options = {}) {
	/* Development-time guard: every hunk's replacement text must carry its own
	marker, or the second boot would fail to find the (already rewritten)
	anchor. This check makes that class of bug fail loudly at patch time. */
	for (const hunks of [AGENT_LOOP_HUNKS, SESSION_HUNKS, CONVERSATION_HUNKS]) {
		for (const hunk of hunks) {
			if (!hunk.to.includes(hunk.marker)) {
				throw new Error(`dsh-resume: patch hunk "${hunk.what}" does not embed its marker "${hunk.marker}" in the replacement text — idempotency would break on the next boot`);
			}
		}
	}
	const strict = options.strict === true;
	const anchors = options.anchors ?? [
		import.meta.url,
		join(dshHome(), "profiles", "web", "package.json"),
		...extraAnchors
	];
	const targets = resolveTargets(anchors);
	const applied = [];
	const skipped = [];
	const results = [];
	const writes = [];
	for (const target of targets) {
		const expected = TARGET_VERSIONS[target.packageName];
		const versionOk = target.manifestError === undefined && target.version === expected;
		const hunks = hunksForPackage(target.packageName);
		if (target.manifestError !== undefined) {
			skipped.push({ file: target.root, reason: "unreadable-manifest", detail: target.manifestError });
			continue;
		}
		let source;
		try {
			source = readFileSync(target.file, "utf8");
		} catch (error) {
			skipped.push({ file: target.file, reason: "unreadable-file", detail: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (!versionOk && strict) {
			skipped.push({ file: target.file, reason: "version", detail: `installed "${target.version}", supported "${expected}" (strict mode)` });
			continue;
		}
		const classified = classifyApply(source, hunks, target.file);
		results.push(...classified.results);
		if (classified.blockers.length > 0) {
			skipped.push({
				file: target.file,
				reason: versionOk ? "anchor" : "version-anchor",
				detail: `${classified.blockers.map((blocker) => `${blocker.what}: ${blocker.reason}`).join("; ")}` +
					(versionOk ? "" : ` (installed "${target.version}", supported "${expected}")`)
			});
			continue;
		}
		if (classified.content === source) {
			skipped.push({ file: target.file, reason: "already-patched" });
			continue;
		}
		applied.push({ file: target.file, adaptive: !versionOk });
		writes.push({ file: target.file, content: classified.content });
	}
	for (const { file, content } of writes) atomicWrite(file, content);
	const failureSkipped = skipped.filter((entry) => entry.reason !== "already-patched");
	const summary = applied.length === 0 && failureSkipped.length === 0
		? `all ${targets.length} reachable copy/copies already carry the patch`
		: [
			applied.length > 0 ? `patched ${applied.map((entry) => packageLabel(entry.file) + (entry.adaptive ? " (adaptive version match)" : "")).join(", ")}` : "",
			failureSkipped.length > 0 ? `skipped ${failureSkipped.map((entry) => `${packageLabel(entry.file)} (${entry.reason})`).join(", ")}` : "",
			skipped.filter((entry) => entry.reason === "already-patched").length > 0 ? `already patched: ${skipped.filter((entry) => entry.reason === "already-patched").length} copy/copies` : ""
		].filter(Boolean).join("; ");
	return { ok: failureSkipped.length === 0, summary, applied, skipped, results };
}

/**
 * Revert every hunk on every reachable installed copy of the three packages,
 * restoring the official sources. Anchors mirror {@link patchInstalled}.
 * Restore is ALWAYS strict — version mismatch, unreadable manifest, a marker
 * without its exact `to` text, or an ambiguous `to` skip that copy with a
 * reason and never write it. Idempotent: a hunk whose marker is already gone
 * is `already`. Never throws for installation-state reasons; callers treat a
 * non-empty failure skip set as an error exit.
 * @param extraAnchors - additional package.json-anchored paths to resolve from.
 * @param options - `{ anchors }`: an exact anchor list (see {@link patchInstalled}).
 * @returns a report `{ ok, summary, reverted, skipped, results }`.
 */
export function unpatchInstalled(extraAnchors = [], options = {}) {
	const anchors = options.anchors ?? [
		import.meta.url,
		join(dshHome(), "profiles", "web", "package.json"),
		...extraAnchors
	];
	const targets = resolveTargets(anchors);
	const reverted = [];
	const skipped = [];
	const results = [];
	const writes = [];
	for (const target of targets) {
		const expected = TARGET_VERSIONS[target.packageName];
		const hunks = hunksForPackage(target.packageName);
		if (target.manifestError !== undefined) {
			skipped.push({ file: target.root, reason: "unreadable-manifest", detail: target.manifestError });
			continue;
		}
		if (target.version !== expected) {
			skipped.push({ file: target.file, reason: "version", detail: `installed "${target.version}", supported "${expected}" — restoring an untested version is refused` });
			continue;
		}
		let source;
		try {
			source = readFileSync(target.file, "utf8");
		} catch (error) {
			skipped.push({ file: target.file, reason: "unreadable-file", detail: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const classified = classifyUnpatch(source, hunks, target.file);
		results.push(...classified.results);
		if (classified.blockers.length > 0) {
			skipped.push({
				file: target.file,
				reason: "restore-blocked",
				detail: classified.blockers.map((blocker) => `${blocker.what}: ${blocker.reason}`).join("; ")
			});
			continue;
		}
		if (classified.content === source) {
			skipped.push({ file: target.file, reason: "already-restored" });
			continue;
		}
		reverted.push({ file: target.file });
		writes.push({ file: target.file, content: classified.content });
	}
	for (const { file, content } of writes) atomicWrite(file, content);
	const failureSkipped = skipped.filter((entry) => entry.reason !== "already-restored");
	const summary = reverted.length === 0 && failureSkipped.length === 0
		? `all ${targets.length} reachable copy/copies already carry the original sources`
		: [
			reverted.length > 0 ? `restored ${reverted.map((entry) => packageLabel(entry.file)).join(", ")}` : "",
			failureSkipped.length > 0 ? `refused ${failureSkipped.map((entry) => `${packageLabel(entry.file)} (${entry.reason})`).join(", ")}` : "",
			skipped.filter((entry) => entry.reason === "already-restored").length > 0 ? `already original: ${skipped.filter((entry) => entry.reason === "already-restored").length} copy/copies` : ""
		].filter(Boolean).join("; ");
	return { ok: failureSkipped.length === 0, summary, reverted, skipped, results };
}

export { AGENT_LOOP_HUNKS, CONVERSATION_HUNKS, SESSION_HUNKS, applyHunk, applyHunks, unpatchHunks, packageRoot };
