import { writeFileSync } from "node:fs";
import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { registerWatchdogCommand } from "./command.ts";
import { parseConfig, parseEnvConfig } from "./config.ts";
import {
	CONTINUATION_MESSAGE_TYPE,
	continuationText,
	DECISION_CONTINUE,
	DECISION_DONE,
	DECISION_ENTRY_TYPE,
	DECISION_WAIT_USER,
	EMPTY_REPLY_NOTE,
	FOLD_MESSAGE_TYPE,
	TOOL_NAME,
} from "./constants.ts";
import { armCountdown, resumeWatchdog, teardown } from "./countdown.ts";
import { markProactiveStop, recordProactiveStop } from "./decide-tool.ts";
import { type DecisionCardData, registerDecisionCardRenderers } from "./decision-card.ts";
import { expandedCardIds, expandedHintIds } from "./expanded.ts";
import { registerWatchdogContextFolding } from "./fold.ts";
import { MODE_POLICY } from "./mode.ts";
import { decisionOutcome, lastAssistantText, runError, runWasAborted, settledMessages } from "./run-scan.ts";
import { startWatchdog } from "./start.ts";
import {
	clearCountdown,
	decisionWindow,
	getPi,
	isRunning,
	isSuspended,
	pendingProactiveStop,
	setActiveCtx,
	setDecisionWindow,
	setLastMistake,
	setPendingProactiveStop,
	setPi,
	setSilentStopWarned,
	setToolRegistered,
	state,
} from "./state.ts";
import { publishState, renderStatus } from "./status.ts";
import { isRestoredReason } from "./utils.ts";

/** Back-to-back empty replies from the model; the card shows the streak, and a warning fires at the threshold. */
let emptyStreak = 0;
/** After this many silent checks in a row, tell the user the model looks broken. */
const EMPTY_STREAK_WARN = 3;

export default function (extensionApi: ExtensionAPI) {
	setPi(extensionApi);
	// pi re-runs this factory for every new session but keeps the module cached, so clear the flag here.
	// Left alone it would carry the previous session's registration into this one, whose tool table is empty,
	// and startWatchdog would skip registerDecideTool, leaving the AI without watchdog_decide.
	setToolRegistered(false);
	emptyStreak = 0;
	setSilentStopWarned(false);
	// Same reason: a stop whose run never settled must not follow us into the new session.
	setPendingProactiveStop(null);

	// Must run now, not at start: resuming a session replays saved nudge messages, and a missing renderer would show their raw text.
	registerDecisionCardRenderers(getPi());
	// Both types of a check keep one open state per exchange by entry id, so they reset on a new run.
	expandedHintIds.clear();
	expandedCardIds.clear();

	// ---- Every hook we listen to, in lifecycle order. ----

	// Before each model call: fold old decision exchanges out of the request view only.
	registerWatchdogContextFolding(getPi());
	// Session opens: start from PI_WATCHDOG when it is set.
	getPi().on("session_start", onSessionStart);

	// User sends a real message: wake a paused run and clear the ESC stop.
	getPi().on("input", onInput);
	getPi().on("agent_start", onAgentStart);
	// During a decision turn: block every tool except watchdog_decide.
	getPi().on("tool_call", onToolCall);
	// A user message saved mid-check: the check is void, the user is in charge now.
	getPi().on("message_end", onMessageEnd);
	// A run ends: remember if the user pressed ESC.
	getPi().on("agent_end", onAgentEnd);
	// Run fully settled: write a proactive stop's card and fold marker, close the decision turn, re-arm.
	getPi().on("agent_settled", onAgentSettled);
	getPi().on("agent_settled", onProactiveStopSettled);
	getPi().on("session_shutdown", onSessionShutdown);
	getPi().events.on("watchdog:state:query", publishState);

	registerWatchdogCommand();
}

// ---------- what each hook does ----------

/** Session opened: auto-start when the env var asks for it. */
function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext) {
	// Authorize THIS process for the sub-agent wrap-up chain: the ON_STOP shell string (inherited by
	// every descendant, e.g. vitest workers running our tests) only fires when its spawning process
	// pid matches the pid written here. Without this, a test calling watchdog_decide("done") would
	// kill-session the sub-agent pane mid-run. Best-effort: diagnostics must never break startup.
	const pidFile = process.env.PI_WATCHDOG_PIDFILE?.trim();
	if (pidFile) {
		try {
			writeFileSync(pidFile, `${process.pid}\n`);
		} catch {}
	}
	// Reload means a manual hot-reload mid-session: the watchdog was already shut down for it, and
	// auto-restarting here would count down on a session that did no work yet. /watchdog starts it again.
	if (event.reason === "reload") {
		if (parseEnvConfig()?.ok) {
			ctx.ui.notify("watchdog: not auto-started after reload; /watchdog to restart", "info");
		}
		return;
	}
	const envConfig = parseEnvConfig();
	if (envConfig?.ok && !isRunning()) {
		// Env start and the manual command share startWatchdog; folding is handled by the context hook either way.
		startWatchdog(
			ctx,
			envConfig.timeoutSeconds,
			envConfig.message ?? "", // Extra instruction only; the trigger line never changes.
			envConfig.maxNudges,
			envConfig.keepAlive,
			isRestoredReason(event.reason), // Resumed sessions wait for the first agent_settled.
		);
	} else {
		// Env var set but bad: say why, don't skip silently.
		const raw = process.env.PI_WATCHDOG?.trim();
		if (raw && raw !== "0" && raw !== "false" && raw !== "1" && raw !== "true") {
			const r = parseConfig(raw);
			if (!r.ok) {
				ctx.ui.notify(
					`watchdog: bad PI_WATCHDOG (${r.error}), not started. Usage: PI_WATCHDOG="timeout=30 max=100 message=continue mode=keep"`,
					"warning",
				);
			}
		}
	}
}

/** A run started: stop counting and forget any pause. */
function onAgentStart(_event: AgentStartEvent, ctx: ExtensionContext) {
	if (!isRunning()) return;
	setActiveCtx(ctx);
	state.pausedByInput = false;
	state.pausedByActivity = false;
	setSilentStopWarned(false); // A new run gets its own one warn.
	// Don't clear `interrupted` here: a run can be started by another extension, so only a real user message clears it.
	clearCountdown();
	renderStatus(ctx);
}

/**
 * Block all tools except watchdog_decide during a decision turn, so the exchange stays one clean foldable block.
 *
 * The block also carries `terminate: true`, which is what lets the answer end the turn without an abort:
 * pi only stops after a tool batch when EVERY finalized result in it is terminating. On its own the block
 * means "the model reached for a tool and got nothing" — that is not an answer, so the check ends as
 * `empty` and the next countdown retries it, exactly like a check that came back silent. In a mixed batch
 * (a blocked tool next to watchdog_decide) it makes the whole batch terminating, so the answer still ends
 * the turn instead of costing one more model call.
 */
function onToolCall(event: ToolCallEvent): ToolCallEventResult | undefined {
	if (decisionWindow === null) return;
	if (event.toolName === TOOL_NAME) return;
	// The model reached for a wrong tool in a check turn: record it, so the card and the next check can say
	// what went wrong instead of a blanket "no answer".
	decisionWindow.mistake = `tried to call "${event.toolName}" in the check turn — every tool except ${TOOL_NAME} is blocked there`;
	return {
		block: true,
		terminate: true,
		reason:
			`This is a watchdog check turn: every tool except ${TOOL_NAME} is blocked, and nothing you do here reaches the user. ` +
			`Call ${TOOL_NAME} to answer — "${DECISION_CONTINUE}" if work remains, "${DECISION_DONE}" if the task is finished, ` +
			`"${DECISION_WAIT_USER}" if you are waiting on the user. Your text is kept as a message, but it is not an answer.`,
	};
}

/**
 * A run ended: flag a user stop from the "aborted" stopReason (ESC, or another extension's abort).
 *
 * Our own paths never land here as a stop any more: the tool ends its turn with `terminate: true`, so no
 * abort is fired and no synthesized "request ended" row is written. A stop answer also clears `running`
 * before the run ends, which the guard below reads.
 */
function onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext) {
	if (isRunning() && decisionWindow !== null) {
		// Pi may retry a run internally, so read the newest decision from every agent_end; the
		// final one before agent_settled decides whether the check really failed.
		const error = runError(event.messages);
		decisionWindow.failed = error !== undefined;
		decisionWindow.failureMessage = error;
	}
	if (!isRunning() || !runWasAborted(event.messages)) return;
	state.interrupted = true;
	if (decisionWindow !== null) {
		// ESC during a decision turn means the user took over: mark it superseded so agent_settled won't continue.
		decisionWindow.aborted = true;
		// If the user had already sent a real message, the model may have been cut off before answering it.
		if (
			Array.isArray(event.messages) &&
			event.messages.some((m) => (m as { role?: unknown } | undefined)?.role === "user")
		) {
			ctx.ui.notify(
				"watchdog: the decision turn was interrupted; if the message you sent got no answer, please resend",
				"warning",
			);
		}
	}
	renderStatus(ctx); // Show ⏱⏹ now, not after agent_settled.
	publishState();
}

/**
 * Write down a real user message that landed inside a check turn.
 *
 * pi hands us the message, not the app message, so this is where we can see it: no customType, no
 * watchdog marker, just a plain user row. Two things follow from it. The run really is still ours —
 * a nudge is queued as `steer`, which pi delivers without ending the run — so `hasPendingMessages`
 * reads false by the time the turn settles and cannot be asked. And the user is now ahead of us: the
 * answer being computed is about a request they have already moved past, so the check must fold as
 * `superseded` instead of sending a continuation on top of their message.
 */
function onMessageEnd(event: MessageEndEvent) {
	if (decisionWindow === null) return;
	if ((event.message as { role?: unknown }).role !== "user") return;
	decisionWindow.userInterjected = true;
}

/**
 * Close the decision turn, then re-arm. A stop answer already set running=false; a continue answer only
 * ended its turn, so the continuation below is what starts the real work.
 *
 * The turn was cut short by pi, not by us: the tool result carries `terminate: true`, so pi skips the
 * follow-up model call and no abort is fired. Nothing here has to clean up after a phantom row.
 */
async function onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext) {
	const window = decisionWindow;
	setDecisionWindow(null);
	if (window !== null) {
		// A decision turn is void (superseded) when the user jumped in, the turn isn't idle, or ESC hit.
		// We must still drop a terminal marker, or the "keep until a marker" rule makes the decision prompt stick forever.
		const superseded =
			!ctx.isIdle() || ctx.hasPendingMessages() || window.userInterjected === true || window.aborted === true;
		const outcome = decisionOutcome(window, superseded);
		// A check answered with text but no tool call is a mistake too: the model wrote its delivery into a
		// channel the watchdog ignores, so the answer never counted. Recorded here from the run's last
		// assistant message (the same scan runError uses), because no tool_call hook fires for prose.
		if (
			outcome === "empty" &&
			window.mistake === undefined &&
			lastAssistantText(settledMessages(_event)) !== undefined
		) {
			window.mistake = `answered with text instead of calling ${TOOL_NAME} — text is not an answer`;
		}
		// A mistake (wrong tool, text-only answer) rides into the next check's prompt, so the model sees what
		// it did wrong; kept only for an empty check, or the note would outlive the exchange it explains —
		// an answered check folds whole, so its evidence is gone and the note would dangle without a referent.
		if (outcome === "empty" && window.mistake !== undefined) setLastMistake(window.mistake);
		// A check that never answered (provider error, or an empty reply) is retried by the next
		// countdown, not on the spot: the timer re-arms and that check spends the next nudge from the
		// same max= budget (sendDecision caps and auto-stops).
		const rearm = isRunning() && (outcome === "failed" || outcome === "empty");
		if (outcome === "stop" || outcome === "superseded" || rearm) {
			getPi().sendMessage(
				{
					customType: FOLD_MESSAGE_TYPE,
					content: "",
					display: false,
					details: {
						exchangeId: window.exchangeId,
						outcome,
						// The mistake rides on the fold marker: folding reads it to keep the assistant row that
						// carries the evidence, so the next check's mistake note has its proof in view.
						...(outcome === "empty" && window.mistake !== undefined ? { mistake: window.mistake } : {}),
					},
				},
				{ triggerTurn: false },
			);
		} else {
			// "continue" means work remains: send the continue message to start the real work turn.
			// It is both the fold's end marker and the only kept message from the whole exchange.
			getPi().sendMessage(
				{
					customType: CONTINUATION_MESSAGE_TYPE,
					content: continuationText(state.message || undefined),
					display: true,
					details: { exchangeId: window.exchangeId },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
		// History record only: it gets a TUI renderer and stays for reading back, but never enters the model context.
		// One entry per exchange. The reply is the note the AI passed to watchdog_decide; a failed check keeps the
		// provider error, and a check where the model made a mistake says what it did instead of a blanket "no answer".
		const reply =
			window.note ?? window.mistake ?? (outcome === "empty" ? EMPTY_REPLY_NOTE : window.failureMessage || undefined);
		// Only true silence counts toward the streak: a mistake means the check's prompt changes next time
		// (the model sees its mistake), and failed means the provider died — neither is "the model went quiet".
		let streak: number | undefined;
		if (outcome === "empty" && window.mistake === undefined) {
			emptyStreak += 1;
			streak = emptyStreak;
			if (emptyStreak === EMPTY_STREAK_WARN) {
				ctx.ui.notify(
					`watchdog: the model replied empty ${EMPTY_STREAK_WARN} checks in a row — it looks broken; /watchdog stop if this is a loop`,
					"warning",
				);
			}
		} else if (outcome !== "failed") {
			emptyStreak = 0;
		}
		getPi().appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
			exchangeId: window.exchangeId,
			outcome,
			reply,
			decision:
				window.decision === DECISION_CONTINUE ? undefined : (window.decision as "done" | "wait_user" | undefined),
			suspended: outcome === "stop" && (window.suspended ?? isSuspended()),
			...(streak !== undefined ? { emptyStreak: streak } : {}),
			nudgeCount: state.nudgeCount,
			maxNudges: state.maxNudges,
			ts: Date.now(),
		});
	}
	if (!isRunning()) return;
	setActiveCtx(ctx);
	armCountdown(ctx); // Queued turns and failed/empty checks are done, so count down again.
}

/**
 * Record an AI stop taken outside a check turn. Held until the run settles because both halves of the
 * record belong after the wrap-up: the history card describes a finished stop, and the fold marker has
 * to be the last row of the turn it closes. Writing them here, not inside the tool, is what keeps the
 * AI's closing text inside the folded range instead of leaving it in every later request.
 */
function onProactiveStopSettled(_event: AgentSettledEvent) {
	const stop = pendingProactiveStop;
	setPendingProactiveStop(null);
	if (stop === null) return;
	recordProactiveStop(stop);
	markProactiveStop(stop);
}

/** A real user message wakes a paused keep-mode run and clears the ESC stop; extension messages are our own nudges, so skip them. */
function onInput(event: InputEvent, ctx: ExtensionContext) {
	if (event.source === "extension") return;
	if (isRunning() && state.interrupted) {
		state.interrupted = false; // User is back, so nudging can resume.
		publishState();
	}
	if (isSuspended() && !isRunning() && MODE_POLICY[state.mode].resumesOnUserMessage) {
		resumeWatchdog(ctx);
	}
}

/** Session closing: clean up. A reload just rebinds extensions, so don't broadcast a fake stop. */
function onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext) {
	setDecisionWindow(null);
	setPendingProactiveStop(null);
	// Session is going away, so stop hard; on reload keep quiet, others just get rebound.
	teardown(ctx, true, event.reason !== "reload");
	// Session replacement (/clear, /resume, /fork) makes this ctx stale before the next session_start.
	// Drop it so no later fallback (e.g. teardown without a ctx) can touch the dead context.
	setActiveCtx(null);
}
