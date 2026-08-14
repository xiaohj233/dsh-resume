/*!
 * dsh-resume — client bundle.
 *
 * 1. Provides `window.__dshResume`, the bridge the patched composer calls when
 *    the user presses send / Enter with an EMPTY input on a session whose last
 *    turn ended without completion (stopped / interrupted / errored). The bridge
 *    prompts the session with an EMPTY-text message: the host-side agent-loop
 *    patch reads it as a "resume the interrupted generation" marker — nothing is
 *    appended to the session and no context injection enters the request, so the
 *    model history ends with the folded partial assistant message and the model
 *    simply continues writing from where it stopped (no visible "继续" message).
 *
 * 2. Renders the producing model of every request as a quiet row in the
 *    conversation flow: one row appears at the TOP of each answer the moment
 *    the request starts (anchored at its `request/header` event — a model
 *    switched mid-turn shows a new row right at the switch point), plus the
 *    per-turn model row just above the official TURN TAIL (an independent
 *    chat node anchored at `turn/end` seq - 0.5 — deliberately NOT a
 *    `conversation.chat.turnTail` chain seat, because that chain renders
 *    only its first matching seat, so the official artifact/resume seats
 *    would swallow the badge on turns that produced files). Both rows show
 *    the reasoning effort when known. Everything rides the official
 *    `conversationEvents` / `conversation.chat.node` machinery — no official
 *    package is patched, and the typography follows the official Think row
 *    (14px/24px).
 *
 * 3. Reasoning effort in the turn-tail row comes from the agent-loop patch,
 *    which copies `reasoningEffort` from the request config into each
 *    `assistant/message` source (the client stream carries no effort there
 *    otherwise).
 *
 * Bundle contract: classic script registering via `window.__ModuleLoader__`
 * with the factory-form CJS shape used by the framework's own client bundles.
 * Debugging: `window.__dshResume` exposes `label`, `resume(sessionId)` and
 * `canResume(sessionId)`.
 */
window.__ModuleLoader__.load({
	id: "dsh-resume",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react_jsx_runtime = require("react/jsx-runtime");
		var react = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// ------------------------------------------------------------------ tuning
		/** Continuation prompt: an EMPTY text message — the host-side agent-loop
		patch treats it as "resume the interrupted generation" (seamless). */
		var CONTINUE_TEXT = "";
		/** Send-button tooltip while an empty input is resumable. */
		var LABEL = "续接";

		// ------------------------------------------------------------------ bridge
		function isResumableSnapshot(snapshot) {
			if (snapshot === void 0 || snapshot.running || snapshot.subagent !== null) return false;
			var timeline = snapshot.chat !== void 0 ? snapshot.chat.timeline : void 0;
			var order = timeline !== void 0 ? timeline.turnOrder : void 0;
			if (order === void 0 || order.length === 0) return false;
			var last = order[order.length - 1];
			var turn = timeline.turns.get(last);
			var end = turn !== void 0 ? turn.end : void 0;
			if (end === void 0) return false;
			var kind = end.data !== void 0 && end.data.reason !== void 0 ? end.data.reason.kind : void 0;
			return kind !== void 0 && kind !== "completed";
		}

		function makeResumeBridge(ctx) {
			return {
				label: LABEL,
				/** Whether the given session can be continued with an empty-input send. */
				canResume(sessionId) {
					var sessions = ctx.get("sessions");
					if (sessions === void 0) return false;
					var binding = sessions.binding(sessionId);
					var session = binding !== void 0 ? binding.session : void 0;
					return session !== void 0 && isResumableSnapshot(session.getSnapshot());
				},
				/** Continue the session's interrupted turn via a normal user prompt. */
				async resume(sessionId) {
					var sessions = ctx.get("sessions");
					if (sessions === void 0) {
						console.error("[dsh-resume] sessions service unavailable");
						return { ok: false, error: { code: "sessions-unavailable", message: "sessions service unavailable" } };
					}
					var binding = sessions.binding(sessionId);
					var session = binding !== void 0 ? binding.session : void 0;
					if (session === void 0) {
						console.error("[dsh-resume] session not found:", sessionId);
						return { ok: false, error: { code: "session-not-found", message: "session not found" } };
					}
					var result = await session.prompt([{ type: "text", text: CONTINUE_TEXT }], "queue");
					if (!result.ok) console.error("[dsh-resume] continue failed:", result.error);
					return result;
				}
			};
		}

		// ------------------------------------------------------ per-request model rows
		/** Location-data key carrying one turn's producing provider/model. */
		var MODEL_KEY = "dsh-resume-model";
		/** Dictionary namespace owned by this plugin. */
		var NS = "dsh-resume";

		/**
		 * Model-row styles aligned with the official Think row (ReasoningRow /
		 * DisclosureRow): 14px/24px text, 24px row height, 14px leading icon
		 * with 6px trailing gap, label-secondary caption, label-tertiary model
		 * name, no chip background.
		 */
		var MODEL_CSS = ".dshResumeModelRow{display:flex;align-items:center;min-width:0;font-size:14px;line-height:24px;color:var(--dsw-alias-label-caption)}.dshResumeModelIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary);margin-right:6px}.dshResumeModelLabel{flex:none;color:var(--dsw-alias-label-secondary);font-weight:400}.dshResumeModelName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-weight:400}.dshResumeModelEffort{flex:none;color:var(--dsw-alias-label-tertiary);font-weight:400}";
		var MODEL_CSS_ID = "dsh-resume/ModelBadge.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(MODEL_CSS_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-resume";
			tag.dataset.pluginCss = MODEL_CSS_ID;
			tag.textContent = MODEL_CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Two cooperating contexts, one responsibility each:
		 *
		 * - `modelTurnDefinition` — one context per turn (id = turn number),
		 *   refreshed by every `assistant/message` and closed by `turn/end`.
		 *   Builds a view node for the turn-tail model row anchored just
		 *   before the official turn-tail (turn/end seq - 0.5). It is an
		 *   ordinary chat node, NOT a `conversation.chat.turnTail` chain seat,
		 *   because the chain renders only the FIRST seat whose select returns
		 *   non-null — the official artifact/resume seats swallow the badge on
		 *   turns that produced files.
		 *
		 * - `modelRequestDefinition` — one context per `request/header` (the
		 *   client stream carries the header at the moment the request starts,
		 *   before the first token). The header's own `location` yields the
		 *   turn (its data carries no turn number) and the start seq anchors
		 *   the model row between the user messages and the assistant reply.
		 *   Builds a view node only — never location data, so it can never
		 *   collide with the turn context's key (the runtime rejects a
		 *   turn-scoped key owned by a second context).
		 */
		var MODEL_HEAD_KEY = "dsh-resume-model-request";

		var modelTurnDefinition = {
			kind: MODEL_KEY,
			target: "chat",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "assistant/message" || event.type === "turn/end") return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => ({
				turn: match.event.data.turn,
				model: null,
				lastTextSeq: void 0,
				lastMsgSeq: void 0,
				endSeq: void 0
			}),
			update: (context, match) => {
				if (match.event.type === "turn/end") return {
					...context.state,
					endSeq: match.event.seq
				};
				var message = match.event.data.message;
				var source = message !== void 0 ? message.source : void 0;
				var sp = source !== void 0 ? source.provider : void 0;
				var sm = source !== void 0 ? source.model : void 0;
				if (typeof sp !== "string" || typeof sm !== "string") return context.state;
				var blocks = message !== void 0 && Array.isArray(message.content) ? message.content : [];
				var hasText = blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
				return {
					...context.state,
					model: {
						provider: sp,
						model: sm,
						...(typeof source.reasoningEffort === "string" ? { reasoningEffort: source.reasoningEffort } : {})
					},
					lastMsgSeq: match.event.seq,
					...(hasText ? { lastTextSeq: match.event.seq } : {})
				};
			},
			buildViewNode: (context) => {
				var state = context.state;
				if (state === void 0 || state.model === null || state.endSeq === void 0) return null;
				/* Anchor just before the official turn-tail node: the official
				   closing anchor is the LAST has-text message + 0.1 (or the
				   interrupted step end + 0.05, or turn/end itself), so +0.05
				   after our last has-text message keeps us strictly in front
				   and the official tail stays the turn's last node. */
				var anchorSeq = state.lastTextSeq !== void 0 ? state.lastTextSeq + 0.05 : state.lastMsgSeq !== void 0 ? state.lastMsgSeq + 0.05 : state.endSeq - 0.5;
				return {
					key: context.key,
					kind: MODEL_KEY,
					id: context.id,
					target: "chat",
					anchorSeq,
					location: context.start?.location ?? context.matches[0]?.location,
					visibility: "visible",
					data: {
						turn: state.turn,
						model: state.model
					}
				};
			}
		};

		var modelRequestDefinition = {
			kind: MODEL_HEAD_KEY,
			target: "chat",
			match: (event) => event.type === "request/header" ? {
				id: String(event.seq),
				role: "start"
			} : null,
			start: (_context, match) => {
				var config = match.event.data.header?.config;
				var location = match.location;
				var turn = location !== void 0 && location.turn !== void 0 ? location.turn.turn : void 0;
				var provider = config !== void 0 ? config.provider : void 0;
				var model = config !== void 0 ? config.model : void 0;
				return {
					seq: match.event.seq,
					turn: typeof turn === "number" ? turn : void 0,
					model: typeof provider === "string" && typeof model === "string" ? {
						provider,
						model,
						...(typeof config.reasoningEffort === "string" ? { reasoningEffort: config.reasoningEffort } : {})
					} : null
				};
			},
			update: (context) => context.state,
			buildLocationData: () => null,
			buildViewNode: (context) => {
				var state = context.state;
				if (state === void 0 || state.turn === void 0 || state.model === null) return null;
				return {
					key: context.key,
					kind: MODEL_HEAD_KEY,
					id: context.id,
					target: "chat",
					anchorSeq: state.seq + 0.5,
					location: context.start?.location ?? context.matches[0]?.location,
					visibility: "visible",
					data: {
						turn: state.turn,
						model: state.model
					}
				};
			}
		};

		/** The row content shared by the request-head seat and the turn-tail badge. */
		function modelRow(model, t) {
			var name = model.model;
			var effort = typeof model.reasoningEffort === "string" ? model.reasoningEffort : void 0;
			return react_jsx_runtime.jsxs("div", {
				className: "dshResumeModelRow",
				"data-model": model.model,
				children: [
					react_jsx_runtime.jsx("span", { className: "dshResumeModelIcon", children: react_jsx_runtime.jsx(primitives.IconSparkle16, { size: 14 }) }),
					react_jsx_runtime.jsx("span", { className: "dshResumeModelLabel", children: t("model.label") }),
					react_jsx_runtime.jsx("span", { className: "dshResumeModelName", title: name, children: name }),
					effort === void 0 ? null : react_jsx_runtime.jsx("span", { className: "dshResumeModelEffort", children: " · " + effort })
				]
			});
		}

		/** Request-head seat: the model of one request, shown from the moment it starts. */
		function ModelHeadRow({ node, t }) {
			var model = node.data.model;
			if (model === void 0) return null;
			return modelRow(model, t);
		}

		/** Turn-tail node: the model that produced the turn, just above the official tail. */
		function ModelBadge({ node, t }) {
			var model = node.data.model;
			if (model === void 0) return null;
			return modelRow(model, t);
		}

		/** Simplified Chinese dictionary (key-set source of truth). */
		var zh = {
			"model.label": "模型"
		};
		/** English dictionary. */
		var en = {
			"model.label": "Model"
		};

		function apply(ctx) {
			window.__dshResume = makeResumeBridge(ctx);
			var locale = ctx.get("locale");
			var conversationEvents = ctx.get("conversationEvents");
			var slots = ctx.get("slots");
			if (locale !== void 0) {
				ctx.effect(() => locale.register(NS, { zh, en }), "dsh-resume: dictionaries");
			}
			if (conversationEvents !== void 0) {
				try {
					ctx.effect(() => conversationEvents.register(modelTurnDefinition), "dsh-resume: turn model location data");
					ctx.effect(() => conversationEvents.register(modelRequestDefinition), "dsh-resume: per-request model rows");
				} catch (error) {
					console.error("[dsh-resume] conversationEvents.register failed:", error);
				}
			}
			if (slots !== void 0) {
				try {
					ctx.effect(() => slots.inject("conversation.chat.node", () => slots.register({
						name: "conversation.chat.node",
						key: MODEL_HEAD_KEY,
						locale: NS
					}, ModelHeadRow)), "dsh-resume: request-head model row");
				} catch (error) {
					console.error("[dsh-resume] model-head seat register failed:", error);
				}
				try {
					ctx.effect(() => slots.inject("conversation.chat.node", () => slots.register({
						name: "conversation.chat.node",
						key: MODEL_KEY,
						locale: NS
					}, ModelBadge)), "dsh-resume: turn-tail model node");
				} catch (error) {
					console.error("[dsh-resume] turn-tail model node register failed:", error);
				}
			}
		}

		exports.name = "dsh-resume";
		exports.apply = apply;
		return module.exports;
	}
});
