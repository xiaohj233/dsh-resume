/**
 * @deepseek-ai/dsh-resume — 中断续接 + 重启自动恢复（web profile 插件）。
 *
 * Host half:
 *
 * 1. Applies the installed-package patches at module load (see ./patch.js):
 *    - agent-loop: fold a stream-aborted turn's partial text/reasoning into
 *      an `assistant/message` (the interrupted thinking then stays in the
 *      model history, so a "继续" continues it instead of restarting);
 *    - dsh-session: the same fold in the crash-repair path
 *      (`interruptedTurnClosers`);
 *    - dsh-client-ui-conversation: the composer's send button and Enter key
 *      continue an interrupted turn when the input is empty (via the
 *      `window.__dshResume` bridge from ./client.js), and folded partial
 *      messages keep the "stopped" badge.
 *
 * 2. Tracks which sessions are running and persists them to
 *    `$DSH_HOME/resume-state.json` on every transition (debounced) and on
 *    process exit. Teardown cancels (`turn/end` with reason kind "disposed")
 *    never clear the set, so a shutdown while sessions are running leaves the
 *    exact "running at shutdown" set behind. Web sessions (ids prefixed
 *    `session-`) go to `running`; subagent sessions (bare ids) go to
 *    `subagents` — they are NOT auto-restored (the parent drives them), but
 *    are kept for the one-click `resume_interrupted_subagents` tool.
 *
 * 3. On boot, after the loader tree settles (+ restoreDelayMs), resumes each
 *    session in `running` (`ctx.agents.resume` with the session's stored
 *    preset and its own last logged model selection, falling back to the
 *    deployment default) and sends the configured continuation message, so the
 *    interrupted turn — including its thinking — continues. ONLY the sessions
 *    recorded as running at shutdown are touched; the file is consumed
 *    (emptied) before restoring, so nothing is ever restored twice. The
 *    recorded subagent ids are held in memory and exposed to the
 *    `resume_interrupted_subagents` tool: from any main conversation, one call
 *    restarts every subagent that was running when dsh shut down.
 *
 * The restored agent installs NO private model-selection override and this
 * plugin registers NO app-level `agent/request` override either: model routing
 * stays entirely with the api-proxy's per-agent session selection (`picked`
 * in-process switch → the session's own logged request/header → the
 * deployment default), so GUI model switches keep working live AND on a
 * seamless continuation (the assembly re-snapshots the selection every step).
 * What this plugin DOES add is a per-session model memory: every `request/header`
 * is recorded per session, and the boot restore in resumeSession() seeds the
 * resumed agent with the session's OWN remembered model — the deployment
 * default (settings.yaml) is global, so without this memory a restart pulls
 * every resumed session onto whatever the deployment default is ("everything
 * became gpt after restart"). The remembered model is a seed only: once the
 * user touches the session (models/selectModel/prompt via the api-proxy), its
 * selection takes over and the session behaves exactly like a non-restored one.
 *
 * The agent-loop row is rewritten by cordis.patch.yml to inject
 * `resumePatchReady`, guaranteeing this module (and therefore the file patch)
 * runs before the agent loop is imported.
 */
import z from "@deepseek-ai/schemastery";
import { readFileSync, writeFileSync } from "node:fs";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { hasApiRemoteSubagentOwner } from "@deepseek-ai/dsh-api-remotes";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { patchInstalled } from "./patch.js";

const name = "dsh-resume";

const Config = z.object({
	/** Whether automatic restore at boot is enabled (running-state tracking always runs). */
	enabled: z.boolean().default(true),
	/** @deprecated no longer sent — resumes are seamless (empty-text continue marker). Kept for config compatibility. */
	resumeMessage: z.string(),
	/** Wait after the loader tree settles before restoring (lets the web server finish starting). */
	restoreDelayMs: z.number().min(0).default(2000)
});

/** The running-set state file: `$DSH_HOME/resume-state.json`. */
const STATE_FILE = dshHomePath("resume-state.json");

/** Boot log: `$DSH_HOME/resume-state.log` (restore visibility when stdout is not observable). */
const LOG_FILE = dshHomePath("resume-state.log");

function appendLog(message) {
	try {
		writeFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, { flag: "a" });
	} catch {
		/* best-effort */
	}
}

/** Web sessions carry the `session-` prefix; subagent sessions are bare uuids. */
function isSubagentId(sessionId) {
	return typeof sessionId !== "string" || !sessionId.startsWith("session-");
}

/** Apply the installed-package patches before the loader imports the patched modules. */
const patchReport = patchInstalled();
appendLog(`[dsh-resume] patches: ${patchReport.summary}`);

function apply(ctx, config) {
	ctx.provide("resumePatchReady", {});
	ctx.logger?.info("[dsh-resume] installed — empty-input send continues interrupted turns; running sessions are restored after restart");

	// --------------------------------------- model routing: no app-level override
	/* Model routing is left entirely to the api-proxy's per-agent session
	selection, whose `current` precedence is: in-process `picked` (GUI/selectModel
	switch) → the session's own logged request/header → the deployment default.
	Its `system-prompt/assemble` listener re-snapshots `selection.assembled` on
	EVERY step — including a seamless empty-text continuation, because the
	agent-loop patch still runs the assembly — so a model switched while the
	agent is live (selectModel itself revives a cold agent and sets `picked` on
	it) reaches the very next request, continuation or not.

	An app-level `agent/request` override was tried here before and had to be
	removed: registered before the api-proxy installs its per-agent selection,
	it sits OUTSIDE it in the waterfall (first registered = outermost = final
	override) and therefore clobbers `picked` with whatever it pins — first the
	deployment default ("everything became gpt after restart"), then the
	session's remembered model ("switch stops working / resume never switches").

	The per-session model memory below has two narrow, NON-clobbering uses:
	- it seeds the boot restore in resumeSession(), where the restored agent
	  has no api-proxy selection installed yet; and
	- the first-request correction below re-applies it ONLY when a freshly
	  resumed agent's very first request resolves exactly to the deployment
	  default (the boot-window race where the api-proxy selection has not
	  applied the session's own model yet). A request that resolves to a
	  picked or logged model is never touched. */
	const MEMORY_FILE = dshHomePath("session-models.json");
	let memoryCache = null;
	function loadMemory() {
		if (memoryCache !== null) return memoryCache;
		try {
			const parsed = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
			memoryCache = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
		} catch {
			memoryCache = {};
		}
		return memoryCache;
	}
	function saveMemory(sessionId, selection) {
		const memory = loadMemory();
		memory[sessionId] = selection;
		memoryCache = memory;
		try {
			writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
		} catch (error) {
			ctx.logger?.warn(`[dsh-resume] session-model memory write failed: ${String(error)}`);
		}
	}
	/* A `request/header` snapshot records the model a session actually used —
	reason "change" (a live GUI/selectModel switch), "resume" (a mechanical
	continuation after restart), or "initial" (first header). Only the
	USER-INFLUENCED ones ("initial"/"change") define the session's own model
	choice: a "resume" header can carry the deployment default when the
	first-request correction below missed (boot-window race), and recording it
	would silently overwrite the user's per-session choice with the drifted
	default. */
	ctx.on("session/event", (session, event) => {
		if (event.type !== "request/header") return;
		const reason = event.data?.reason;
		if (reason !== "initial" && reason !== "change") return;
		const config = event.data.header?.config;
		if (typeof config?.provider !== "string" || typeof config?.model !== "string") return;
		saveMemory(session.id, {
			provider: config.provider,
			model: config.model,
			...(typeof config.reasoningEffort === "string" ? { reasoningEffort: config.reasoningEffort } : {}),
			time: Date.now()
		});
	});

	// ------------------------------- first-request model correction
	/* Boot-window race (reproduced): right after a restart a cold-resumed
	agent's session log attaches ASYNCHRONOUSLY, so at the first assembly the
	api-proxy selection reads a PARTIAL or EMPTY `requestHeader()` fold. The
	agent's very first request then resolves to a STALE earlier model — or, with
	an empty fold, to the deployment default — instead of the model the session
	actually used last. That is the "the session drifted back to the old model /
	the default after restart" complaint.

	Detect the signature: the first request of a freshly created/resumed agent
	whose resolution equals the selection's fold-or-default fallback
	(`session.requestHeader()` if present, else the deployment default) — i.e.
	the resolution came from the session's own (possibly stale) state, NOT from
	a `picked` switch. Re-apply the session's remembered model in that case.

	Safe by construction:
	- a `picked` switch resolves to the picked model, which differs from the
	  fold-or-default fallback, so live switches are never touched;
	- a working (fully-attached) selection resolves to the session's last
	  header, which equals the remembered model — no-op;
	- created sessions with no remembered model yet are untouched;
	- the boot-restore seed (resumeSession) resolves to the remembered model —
	  no-op. */
	const freshAgentIds = new Set();
	ctx.on("agent/created", (carrier, _name, payload) => {
		/* Scope-filtered emit: args = [scopeCarrier, "agent/created", { agent }]. */
		const agent = (payload ?? carrier)?.agent;
		if (agent?.id) freshAgentIds.add(agent.id);
	});
	ctx.on("agent/request", async (payload, next) => {
		const id = payload?.agent?.id;
		const agent = payload?.agent;
		const resolved = await next();
		if (typeof id !== "string" || !freshAgentIds.delete(id)) return resolved;
		try {
			const fold = agent?.session?.requestHeader?.()?.config;
			const def = ctx.get("agentDefaultModel")?.currentSelection?.();
			if (def === void 0) return resolved;
			const fallback = fold ?? def;
			if (!(resolved?.provider === fallback.provider && resolved?.model === fallback.model)) return resolved;
			const remembered = loadMemory()[id];
			if (remembered === void 0) return resolved;
			if (remembered.provider === resolved.provider && remembered.model === resolved.model) return resolved;
			ctx.logger?.info(`[dsh-resume] first-request model correction: ${id} resolved from the session fallback (${resolved.provider}/${resolved.model}); re-applying the session's remembered model (${remembered.provider}/${remembered.model})`);
			return {
				...resolved,
				provider: remembered.provider,
				model: remembered.model,
				...(typeof remembered.reasoningEffort === "string" ? { reasoningEffort: remembered.reasoningEffort } : {})
			};
		} catch (error) {
			ctx.logger?.warn(`[dsh-resume] first-request model correction failed: ${String(error)}`);
			return resolved;
		}
	});

	// ---------------------------------------------------------------- tracking
	/** sessionId -> { running, tearingDown } — web sessions. */
	const running = new Map();
	/** sessionId -> { running, tearingDown } — subagent sessions (kept for the one-click tool). */
	const subagents = new Map();
	let writeTimer = null;

	function writeState() {
		const payload = {
			version: 1,
			updatedAt: Date.now(),
			running: [...running.entries()].filter(([, entry]) => entry.running).map(([id]) => id),
			subagents: [...subagents.entries()].filter(([, entry]) => entry.running).map(([id]) => id)
		};
		try {
			writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
		} catch (error) {
			ctx.logger?.warn(`[dsh-resume] state write failed: ${String(error)}`);
		}
	}

	function scheduleWrite() {
		if (writeTimer !== null) clearTimeout(writeTimer);
		writeTimer = setTimeout(() => {
			writeTimer = null;
			writeState();
		}, 300);
	}

	function track(sessionId, status) {
		const table = isSubagentId(sessionId) ? subagents : running;
		const entry = table.get(sessionId) ?? { running: false, tearingDown: false };
		if (status === "running") entry.running = true;
		else if (status === "idle" && !entry.tearingDown) entry.running = false;
		table.set(sessionId, entry);
		scheduleWrite();
	}

	ctx.on("agent/status", ({ agent, status }) => {
		track(agent.id, status);
	});

	ctx.on("agent/disposed", ({ agent }) => {
		freshAgentIds.delete(agent.id);
		const table = isSubagentId(agent.id) ? subagents : running;
		const entry = table.get(agent.id);
		if (entry === void 0) return;
		/* An agent that was running when it disappeared stays in the restore set
		(the resume at next boot is the intended recovery). An idle agent is dropped. */
		if (!entry.running) table.delete(agent.id);
		scheduleWrite();
	});

	/* Teardown is recorded as turn/end reason.kind "aborted" with the
	inner reason.kind "disposed". Preserve the running entry before the final
	idle status arrives, because this is shutdown rather than user abort. */
	ctx.on("session/event", (session, event) => {
		const reason = event.data?.reason;
		if (event.type !== "turn/end" || reason?.kind !== "aborted" || reason.reason?.kind !== "disposed") return;
		const table = isSubagentId(session.id) ? subagents : running;
		const entry = table.get(session.id);
		if (entry !== void 0) entry.tearingDown = true;
	});

	/* Final synchronous write on process exit (also covers Ctrl+C, where no
	teardown cascade runs at all). */
	const onExit = () => {
		if (writeTimer !== null) {
			clearTimeout(writeTimer);
			writeTimer = null;
		}
		writeState();
	};
	process.on("exit", onExit);
	ctx.effect(() => {
		process.off("exit", onExit);
	});

	if (!config.enabled) return;

	// ------------------------------------------------------------------ restore
	/**
	 * Resume one recorded session and send it the continuation message.
	 * @param sessionId - the session to resume.
	 * @param options - `{ allowSubagent }`: subagent sessions are skipped by the
	 * automatic boot pass (the parent drives them) but allowed by the tool.
	 */
	async function resumeSession(sessionId, { allowSubagent = false } = {}) {
		const persistence = ctx.get("sessionPersistence");
		if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
		const stored = (await persistence.list()).find((header) => header.id === sessionId);
		if (stored === void 0) throw new Error("no session log found on disk");
		const inspected = await persistence.inspect(sessionId);
		if (!allowSubagent && hasApiRemoteSubagentOwner(ctx, { header: inspected.meta }, void 0)) {
			throw new Error("subagent-owned session — the parent's restore drives it");
		}
		if (ctx.agents.get(sessionId) !== void 0) return;
		const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events });
		/* Restore seed model: the session's OWN remembered model (per-session
		model memory) wins, then the last logged request header, falling back to
		the deployment default. This deliberately does NOT install a private
		installModelSelection override on the restored agent — and this plugin
		registers no app-level agent/request override either: any override would
		sit OUTSIDE the api-proxy's lazily-installed session selection in the
		agent/request waterfall (first registered = outermost = final override)
		and freeze every request on its snapshot, so GUI model switches on a
		restored session would never take effect. The api-proxy selection is
		installed on the first wire touch (models/selectModel/prompt), reads the
		same logged header, and its `picked` slot makes subsequent GUI switches
		win; the seed below only feeds requests issued before that — the
		restored agent's own seamless continuation, which has no api-proxy
		selection yet, so the seeded header flows straight through. */
		const fallback = ctx.get("agentDefaultModel")?.currentSelection() ?? {};
		const remembered = loadMemory()[sessionId];
		let loggedConfig;
		for (const event of inspected.events) if (event.type === "request/header") loggedConfig = event.data.header.config;
		const source = remembered?.provider !== void 0 && remembered?.model !== void 0
			? remembered
			: (typeof loggedConfig?.provider === "string" ? loggedConfig : fallback);
		const effort = source.reasoningEffort ?? fallback.reasoningEffort;
		const seed = {
			provider: source.provider,
			model: source.model,
			...(effort === void 0 ? {} : { reasoningEffort: effort })
		};
		const presets = ctx.get("agentPresets");
		let setup;
		if (presets === void 0) {
			setup = () => Promise.resolve();
		} else {
			const resolvedId = (await presets.resolve(storedPreset)).id;
			setup = async (agentCtx) => {
				await presets.mount(agentCtx, resolvedId);
			};
		}
		const { agent } = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: {
				...seed.provider === void 0 ? {} : { provider: seed.provider },
				...seed.model === void 0 ? {} : { model: seed.model }
			},
			setup
		});
		/* Seamless resume: instead of a visible "继续" user message we send an
		EMPTY-text user message. The agent-loop patch recognizes it as a "resume
		the interrupted generation" marker: nothing is appended to the session
		and no context injection enters the request, so the model history ends
		with the folded partial assistant message and the model simply continues
		writing from where it stopped. */
		agent.followup(createUserMessage({
			content: [{ type: "text", text: "" }],
			source: { kind: "user" }
		}));
		ctx.logger?.info(`[dsh-resume] resumed "${sessionId}" and continued its generation`);
	}

	async function restore() {
		let state;
		try {
			state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		} catch {
			return;
		}
		/* Migration: pre-subagents state files carried subagent ids inside
		`running`; split them out so the subagent restore path drives them. */
		const recordedSubagents = [
			...(Array.isArray(state?.subagents) ? state.subagents : []),
			...(Array.isArray(state?.running) ? state.running.filter((id) => isSubagentId(id)) : [])
		];
		const toRestore = Array.isArray(state?.running) ? state.running.filter((id) => !isSubagentId(id)) : [];
		if (toRestore.length === 0 && recordedSubagents.length === 0) {
			appendLog("[dsh-resume] restore: state file present but nothing recorded to restore");
			return;
		}
		appendLog(`[dsh-resume] restore: running=${JSON.stringify(toRestore)} subagents=${JSON.stringify(recordedSubagents)}`);
		/* Consume the file BEFORE restoring: even a crash mid-restore never restores twice. */
		try {
			writeFileSync(STATE_FILE, JSON.stringify({ version: 1, updatedAt: Date.now(), running: [], subagents: [] }, null, 2));
		} catch (error) {
			ctx.logger?.warn(`[dsh-resume] state reset failed: ${String(error)}`);
		}
		if (toRestore.length > 0) {
			ctx.logger?.info(`[dsh-resume] restoring ${toRestore.length} session(s) that were running at shutdown: ${toRestore.join(", ")}`);
			for (const sessionId of toRestore) {
				try {
					await resumeSession(sessionId);
					appendLog(`[dsh-resume] restore ok: ${sessionId}`);
				} catch (error) {
					appendLog(`[dsh-resume] restore failed: ${sessionId} — ${String(error)}`);
					ctx.logger?.warn(`[dsh-resume] restore of "${sessionId}" failed: ${String(error)}`);
				}
			}
		}
		if (recordedSubagents.length > 0) {
			/* Subagents are auto-restored too: a main session that already finished
			its own work may still be waiting for its subagents at shutdown — when
			those were interrupted, nobody would ever drive them again. Restoring
			them leaves a finished parent untouched ("不打扰主代理"); a parent that
			itself stopped because of the shutdown is handled by the `running`
			pass above and then proceeds with its original wrap-up, which is
			exactly what waiting on the restarted subagents means. Failed restores
			are kept for the resume_interrupted_subagents tool's one-click retry. */
			ctx.logger?.info(`[dsh-resume] restoring ${recordedSubagents.length} subagent(s) that were running at shutdown: ${recordedSubagents.join(", ")}`);
			for (const sessionId of recordedSubagents) {
				try {
					await resumeSession(sessionId, { allowSubagent: true });
					appendLog(`[dsh-resume] restore ok (subagent): ${sessionId}`);
				} catch (error) {
					if (!pendingSubagents.includes(sessionId)) pendingSubagents.push(sessionId);
					appendLog(`[dsh-resume] restore failed (subagent): ${sessionId} — ${String(error)}`);
					ctx.logger?.warn(`[dsh-resume] restore of subagent "${sessionId}" failed (kept for resume_interrupted_subagents): ${String(error)}`);
				}
			}
		}
	}

	/** Subagent sessions recorded at the last shutdown, waiting for the one-click tool. */
	const pendingSubagents = [];

	/* The one-click tool: from any main conversation, restart every subagent
	that was running when dsh shut down. */
	ctx.tools.register(defineTool({
		name: "resume_interrupted_subagents",
		parameters: {},
		description: "Restart every subagent session that was still running when dsh was last shut down or restarted (their work was interrupted mid-turn). Subagents are normally restored automatically at boot; this tool is the one-click manual entry — use it when the user asks to resume/restart the interrupted subagents, or when a subagent's automatic restore failed or was skipped. Restarted subagents receive a continuation message telling them to continue their interrupted thinking and work from the breakpoint. Sessions already live are skipped. No parameters needed — run it and report the results.",
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					restored: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								ok: { type: "boolean", required: true },
								error: { type: "string" }
							}
						}
					},
					remaining: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			}
		},
		async execute() {
			const results = [];
			const failed = [];
			while (pendingSubagents.length > 0) {
				const sessionId = pendingSubagents.shift();
				try {
					await resumeSession(sessionId, { allowSubagent: true });
					results.push({ id: sessionId, ok: true });
					ctx.logger?.info(`[dsh-resume] one-click restore of subagent "${sessionId}" succeeded`);
				} catch (error) {
					failed.push(sessionId);
					results.push({ id: sessionId, ok: false, error: String(error) });
					ctx.logger?.warn(`[dsh-resume] one-click restore of subagent "${sessionId}" failed: ${String(error)}`);
				}
			}
			pendingSubagents.push(...failed);
			return {
				restored: results,
				remaining: [...pendingSubagents]
			};
		}
	}));

	/* Run once the whole entry tree has settled (bounded wait — a hung entry
	must not starve the restore), then after the configured delay. */
	(async () => {
		try {
			await Promise.race([
				ctx.get("loader")?.await() ?? Promise.resolve(),
				new Promise((resolve) => setTimeout(resolve, 20000))
			]);
		} catch {
			/* a missing loader (non-boot context) means nothing to wait for */
		}
		setTimeout(() => {
			restore().catch((error) => {
				const message = `[dsh-resume] restore pass failed: ${String(error)}`;
				ctx.logger?.warn(message);
				appendLog(message);
			});
		}, config.restoreDelayMs);
	})();
}

export { Config, apply, name };


