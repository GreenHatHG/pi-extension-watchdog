import { spawn } from "node:child_process";
import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseConfig, parseEnvConfig } from "./config.ts";
import {
	ACTIVITY_GRACE_MS,
	BAD_DECISION_NOTE,
	CONTINUATION_MESSAGE_TYPE,
	continuationText,
	DECISION_CONTINUE,
	DECISION_DONE,
	DECISION_ENTRY_TYPE,
	DECISION_MESSAGE,
	DECISION_MESSAGE_TYPE,
	DECISION_NOTE_MAX_CHARS,
	DECISION_WAIT_USER,
	DECISIONS,
	DEFAULT_MAX_NUDGES,
	DEFAULT_TIMEOUT_SECONDS,
	type Decision,
	EMPTY_REPLY_NOTE,
	FOLD_MESSAGE_TYPE,
	NOT_IN_CHECK_TURN_NOTE,
	STATUS_KEY,
	STOP_MESSAGE_TYPE,
	type StopDecision,
	TOOL_DESCRIPTION,
	TOOL_NAME,
	TOOL_PROMPT_GUIDELINES,
	TOOL_PROMPT_SNIPPET,
} from "./constants.ts";
import { type DecisionCardData, registerDecisionCardRenderers } from "./decision-card.ts";
import { expandedCardIds, expandedHintIds } from "./expanded.ts";
import { registerWatchdogContextFolding } from "./fold.ts";
import { MODE_POLICY, modeFromKeepAlive, type WatchdogMode } from "./mode.ts";
import { isRestoredReason } from "./utils.ts";

/** One decision exchange: from the nudge we send until that turn settles. */
interface DecisionWindow {
	exchangeId: string;
	/** The answer the model gave; undefined means it never called the tool (an empty check). */
	decision?: Decision;
	/** Short note the AI passed along, kept for the history card. */
	note?: string;
	/** User hit ESC during the decision turn: close it as superseded, don't continue. */
	aborted?: boolean;
	/** A real user message landed mid-check: the user took over, so the check is void. */
	userInterjected?: boolean;
	/** The provider request that carried this check failed, so the check never got an answer. */
	failed?: boolean;
	/** Provider error text from that failure, kept for the history card. */
	failureMessage?: string;
}

interface WatchdogState {
	running: boolean;
	/** Mode: once shuts the watchdog down on an AI stop; keep only pauses, and the next user message wakes us. */
	mode: WatchdogMode;
	/** Paused in keep mode; a new user message resumes us. */
	suspended: boolean;
	timeoutMs: number;
	message: string;
	maxNudges: number;
	nudgeCount: number;
	/** When the countdown ends (epoch ms); null while the AI runs. */
	countdownDeadline: number | null;
	/** Editor has unsent text, so the countdown is paused; clears when the text is gone. */
	pausedByInput: boolean;
	/** User is pressing keys, so the countdown is paused; clears when they stop. */
	pausedByActivity: boolean;
	/** When the user last pressed a key; tells us if they are still busy. */
	lastInputAt: number;
	/** User hit ESC on the last run: skip this idle spell, clear on their next real message. */
	interrupted: boolean;
	/**
	 * The countdown ran out while the session was busy: another run (agent_settled re-arms us), or pi
	 * compacting, which never fires agent_settled at all. The ticker re-arms the countdown once idle.
	 */
	waitingForIdle: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	ticker: ReturnType<typeof setInterval> | null;
}

// pi loads this extension once, so one module-level state is enough.
let pi: ExtensionAPI;
const state: WatchdogState = {
	running: false,
	mode: "once",
	suspended: false,
	timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
	message: "", // Extra instruction only; continuationText glues on the fixed trigger line.
	maxNudges: DEFAULT_MAX_NUDGES,
	nudgeCount: 0,
	countdownDeadline: null,
	pausedByInput: false,
	pausedByActivity: false,
	lastInputAt: 0,
	interrupted: false,
	waitingForIdle: false,
	timer: null,
	ticker: null,
};

/** Last ctx we saw; the ticker needs it to repaint the status bar. */
let activeCtx: ExtensionContext | null = null;
/** The decision turn we are inside, if any. */
let decisionWindow: DecisionWindow | null = null;
/** Cancel handle for the raw-key listener; only interactive mode gives us one. */
let unsubTerminalInput: (() => void) | null = null;
/** Register watchdog_decide once and never remove it, to keep the prompt cache prefix stable. */
let toolRegistered = false;
let exchangeCounter = 0;

/**
 * The proactive stop waiting to be written down: the tool ran, but the run it belongs to is not over yet.
 * Held until then because a `pi.sendMessage` from inside a running tool only lands at turn_end, which is
 * after the AI's wrap-up text — a marker sent from the tool would end the fold range on the wrong side.
 */
interface PendingProactiveStop {
	/** Fresh each time, so the marker links back to this stop and to nothing else. */
	exchangeId: string;
	/** The watchdog_decide call the range hangs off; the assistant message carrying it starts the range. */
	toolCallId: string;
	/** Keep mode: monitoring is only suspended, and the card says so. */
	suspended: boolean;
	/** Why the AI stopped: "done" or "wait_user". */
	decision: StopDecision;
	nudgeCount: number;
}
let pendingProactiveStop: PendingProactiveStop | null = null;

export default function (extensionApi: ExtensionAPI) {
	pi = extensionApi;
	// pi re-runs this factory for every new session but keeps the module cached, so clear the flag here.
	// Left alone it would carry the previous session's registration into this one, whose tool table is empty,
	// and startWatchdog would skip registerDecideTool, leaving the AI without watchdog_decide.
	toolRegistered = false;
	// Same reason: a stop whose run never settled must not follow us into the new session.
	pendingProactiveStop = null;

	// Must run now, not at start: resuming a session replays saved nudge messages, and a missing renderer would show their raw text.
	registerDecisionCardRenderers(pi);
	// Both types of a check keep one open state per exchange by entry id, so they reset on a new run.
	expandedHintIds.clear();
	expandedCardIds.clear();

	// ---- Every hook we listen to, in lifecycle order. ----

	// Before each model call: fold old decision exchanges out of the request view only.
	registerWatchdogContextFolding(pi);
	// Session opens: start from PI_WATCHDOG when it is set.
	pi.on("session_start", onSessionStart);
	// User sends a real message: wake a paused run and clear the ESC stop.
	pi.on("input", onInput);
	pi.on("agent_start", onAgentStart);
	// During a decision turn: block every tool except watchdog_decide.
	pi.on("tool_call", onToolCall);
	// A user message saved mid-check: the check is void, the user is in charge now.
	pi.on("message_end", onMessageEnd);
	// A run ends: remember if the user pressed ESC.
	pi.on("agent_end", onAgentEnd);
	// Run fully settled: write a proactive stop's card and fold marker, close the decision turn, re-arm.
	pi.on("agent_settled", onAgentSettled);
	pi.on("agent_settled", onProactiveStopSettled);
	pi.on("session_shutdown", onSessionShutdown);
	pi.events.on("watchdog:state:query", publishState);

	registerWatchdogCommand();
}

// ---------- what each hook does ----------

/** Session opened: auto-start when the env var asks for it. */
function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext) {
	const envConfig = parseEnvConfig();
	if (envConfig?.ok && !state.running) {
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
	if (!state.running) return;
	activeCtx = ctx;
	state.pausedByInput = false;
	state.pausedByActivity = false;
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
	if (state.running && decisionWindow !== null) {
		// Pi may retry a run internally, so read the newest decision from every agent_end; the
		// final one before agent_settled decides whether the check really failed.
		const error = runError(event.messages);
		decisionWindow.failed = error !== undefined;
		decisionWindow.failureMessage = error;
	}
	if (!state.running || !runWasAborted(event.messages)) return;
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
	decisionWindow = null;
	if (window !== null) {
		// A decision turn is void (superseded) when the user jumped in, the turn isn't idle, or ESC hit.
		// We must still drop a terminal marker, or the "keep until a marker" rule makes the decision prompt stick forever.
		const superseded =
			!ctx.isIdle() || ctx.hasPendingMessages() || window.userInterjected === true || window.aborted === true;
		const outcome = decisionOutcome(window, superseded);
		// A check that never answered (provider error, or an empty reply) is retried by the next
		// countdown, not on the spot: the timer re-arms and that check spends the next nudge from the
		// same max= budget (sendDecision caps and auto-stops).
		const rearm = state.running && (outcome === "failed" || outcome === "empty");
		if (outcome === "stop" || outcome === "superseded" || rearm) {
			pi.sendMessage(
				{
					customType: FOLD_MESSAGE_TYPE,
					content: "",
					display: false,
					details: {
						exchangeId: window.exchangeId,
						outcome,
					},
				},
				{ triggerTurn: false },
			);
		} else {
			// "continue" means work remains: send the continue message to start the real work turn.
			// It is both the fold's end marker and the only kept message from the whole exchange.
			pi.sendMessage(
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
		// One entry per exchange. The reply is the note the AI passed to watchdog_decide, a failed check keeps the
		// provider error, and a check that called nothing says so instead of pretending the model answered.
		pi.appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
			exchangeId: window.exchangeId,
			outcome,
			reply: window.note ?? (outcome === "empty" ? EMPTY_REPLY_NOTE : window.failureMessage || undefined),
			decision:
				window.decision === DECISION_CONTINUE ? undefined : (window.decision as "done" | "wait_user" | undefined),
			suspended: outcome === "stop" && state.suspended,
			nudgeCount: state.nudgeCount,
			maxNudges: state.maxNudges,
			ts: Date.now(),
		});
	}
	if (!state.running) return;
	activeCtx = ctx;
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
	pendingProactiveStop = null;
	if (stop === null) return;
	recordProactiveStop(stop);
	markProactiveStop(stop);
}

/** A real user message wakes a paused keep-mode run and clears the ESC stop; extension messages are our own nudges, so skip them. */
function onInput(event: InputEvent, ctx: ExtensionContext) {
	if (event.source === "extension") return;
	if (state.running && state.interrupted) {
		state.interrupted = false; // User is back, so nudging can resume.
		publishState();
	}
	if (state.suspended && !state.running && MODE_POLICY[state.mode].resumesOnUserMessage) {
		resumeWatchdog(ctx);
	}
}

/** Session closing: clean up. A reload just rebinds extensions, so don't broadcast a fake stop. */
function onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext) {
	decisionWindow = null;
	pendingProactiveStop = null;
	// Session is going away, so stop hard; on reload keep quiet, others just get rebound.
	teardown(ctx, true, event.reason !== "reload");
	// Session replacement (/clear, /resume, /fork) makes this ctx stale before the next session_start.
	// Drop it so no later fallback (e.g. teardown without a ctx) can touch the dead context.
	activeCtx = null;
}

// ---------- state helpers ----------

/** Tell other extensions our state; agent_settled can't say we'll nudge again, so consumers should trust `running`. */
function publishState() {
	pi.events.emit("watchdog:state", {
		running: state.running,
		suspended: state.suspended,
		keepAlive: state.mode === "keep",
		countdownArmed: state.countdownDeadline != null,
		paused: state.pausedByInput || state.pausedByActivity,
		interrupted: state.interrupted,
		nudgeCount: state.nudgeCount,
		maxNudges: state.maxNudges,
		timeoutMs: state.timeoutMs,
	});
}

function clearCountdown() {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	state.countdownDeadline = null;
	// Any fresh arming replaces the wait; the flag only ever means "the timer already ran out once".
	state.waitingForIdle = false;
}

/** Unsent text in the editor means the user is typing by hand. */
function editorHasText(ctx: ExtensionContext): boolean {
	try {
		const text = (ctx.ui as any).getEditorText?.();
		return typeof text === "string" && text.trim().length > 0;
	} catch {
		return false;
	}
}

/** Did the user press a key very recently, like picking a command or scrolling history? */
function userActive(): boolean {
	return Date.now() - state.lastInputAt < ACTIVITY_GRACE_MS;
}

/** Color text with the theme; fall back to plain text when there is no theme (tests). */
function fg(ctx: ExtensionContext, color: "accent" | "dim" | "muted", text: string): string {
	const theme = (ctx.ui as any).theme;
	return theme?.fg ? theme.fg(color, text) : text;
}

/** What the watchdog is doing right now; one value for both the status bar and /watchdog status. */
type WatchdogPhase =
	| { kind: "suspended" }
	| { kind: "interrupted" }
	| { kind: "counting"; remainingSeconds: number }
	| { kind: "paused-input" }
	| { kind: "paused-activity" }
	| { kind: "idle" };

/**
 * Current phase. Status bar and /watchdog status both render from this, so the branch order lives
 * here only; two copies in two different orders is how they drifted apart before.
 */
function currentPhase(): WatchdogPhase {
	if (state.suspended) return { kind: "suspended" };
	if (state.interrupted) return { kind: "interrupted" };
	if (state.countdownDeadline != null) {
		const remainingSeconds = Math.max(0, Math.ceil((state.countdownDeadline - Date.now()) / 1000));
		return { kind: "counting", remainingSeconds };
	}
	if (state.pausedByInput) return { kind: "paused-input" };
	if (state.pausedByActivity) return { kind: "paused-activity" };
	return { kind: "idle" };
}

/** /watchdog status wording per phase; tests match these strings, so keep them stable. */
function phaseText(phase: WatchdogPhase): string {
	switch (phase.kind) {
		case "counting":
			return `nudge in ${phase.remainingSeconds}s`;
		case "paused-input":
			return "paused: you're typing (resumes when the box is empty)";
		case "paused-activity":
			return "paused: you're pressing keys (resumes when you stop)";
		case "interrupted":
			return "ESC-interrupted (no nudge this idle spell, resumes after your next message)";
		case "suspended":
			// /watchdog status reports a nap with its own wording before reaching here.
			return "keep-mode monitoring paused (next message resumes it)";
		case "idle":
			return "waiting for the AI to go idle";
	}
}

/** Status bar: counting `⏱23s 2/50`, paused `⏱✍ 2/50`, waiting `⏱▶ 2/50`, napping `⏱⏸ 2/50`, stopped `⏱⏹ 2/50`. */
function renderStatus(ctx: ExtensionContext) {
	// A nap has running=false but still owns the status line, so don't bail out on it.
	if (!state.running && !state.suspended) return;
	const count = fg(ctx, "dim", ` ${state.nudgeCount}/${state.maxNudges}`);
	const phase = currentPhase();
	let glyph: string;
	switch (phase.kind) {
		case "suspended":
			glyph = fg(ctx, "muted", "⏱⏸");
			break;
		case "interrupted":
			// ESC stopped the last run: no nudge this idle spell, so show that.
			glyph = fg(ctx, "muted", "⏱⏹");
			break;
		case "counting":
			glyph = fg(ctx, "accent", `⏱${phase.remainingSeconds}s`);
			break;
		case "paused-input":
		case "paused-activity":
			glyph = fg(ctx, "muted", "⏱✍");
			break;
		case "idle":
			glyph = fg(ctx, "muted", "⏱▶");
			break;
	}
	ctx.ui.setStatus(STATUS_KEY, glyph + count);
}

// ---------- lifecycle ----------

/**
 * Stop or pause: clear timers and status; keep mode only pauses, and the tool stays registered to keep the prompt cache stable.
 * `force` means really stop, even in keep mode; `force = false` lets keep mode just take a nap.
 */
function teardown(ctx?: ExtensionContext, force = true, publish = true) {
	// Keep mode + soft stop = nap, not death; the next real user message wakes us up.
	const suspend = !force && state.running && MODE_POLICY[state.mode].sleepsOnAiStop;
	state.running = false;
	state.suspended = suspend;
	state.pausedByInput = false;
	state.pausedByActivity = false;
	state.interrupted = false;
	clearCountdown();
	if (state.ticker) {
		clearInterval(state.ticker);
		state.ticker = null;
	}
	if (!suspend) {
		// All the way off: wipe the status line and stop watching keys.
		(ctx ?? activeCtx)?.ui.setStatus(STATUS_KEY, undefined);
		if (unsubTerminalInput) {
			unsubTerminalInput();
			unsubTerminalInput = null;
		}
	} else {
		// Napping: keep the status line, so the user still sees ⏱⏸.
		const target = ctx ?? activeCtx;
		if (target) renderStatus(target);
	}
	if (publish) publishState();
}

/**
 * Stop for real without touching the ctx. On a stale ctx every ui call throws too, so a shutdown that
 * cleans the status line cannot be used here; clearing the state is all we can honestly do.
 */
function stopWithoutCtx() {
	state.running = false;
	state.suspended = false;
	state.pausedByInput = false;
	state.pausedByActivity = false;
	state.interrupted = false;
	clearCountdown();
	if (state.ticker) {
		clearInterval(state.ticker);
		state.ticker = null;
	}
	if (unsubTerminalInput) {
		unsubTerminalInput();
		unsubTerminalInput = null;
	}
}

/** Wake a paused keep-mode watchdog: keep the old settings, reset the nudge count. */
function resumeWatchdog(ctx: ExtensionContext) {
	if (!state.suspended || state.running) return;
	state.suspended = false;
	state.running = true;
	state.nudgeCount = 0;
	state.interrupted = false;
	activeCtx = ctx;
	startTicker();
	ensureTerminalInputListener(ctx);
	if (ctx.isIdle()) {
		if (hasMessages(ctx)) {
			armCountdown(ctx);
		} else {
			renderStatus(ctx);
			ctx.ui.notify(
				"watchdog: monitoring resumed, session has no messages yet; countdown starts after the AI's first run",
				"info",
			);
		}
	} else {
		renderStatus(ctx);
	}
	ctx.ui.notify(
		`watchdog: keep-mode monitoring resumed (nudge after ${Math.round(state.timeoutMs / 1000)}s idle, up to ${state.maxNudges} times)`,
		"info",
	);
	publishState();
}

/** Watch raw keys: any key means the user is busy, so pause the countdown right away (only interactive mode gives us onTerminalInput). */
function ensureTerminalInputListener(ctx: ExtensionContext) {
	if (unsubTerminalInput) return;
	const ui = ctx.ui as any;
	if (typeof ui.onTerminalInput !== "function") return;
	unsubTerminalInput = ui.onTerminalInput(() => {
		state.lastInputAt = Date.now();
		if (!state.running || state.countdownDeadline == null) return;
		// A key just landed, so pause now instead of waiting for the ticker.
		clearCountdown();
		state.pausedByActivity = true;
		renderStatus(activeCtx ?? ctx);
	});
}

/** AI went idle: start the countdown, or pause first if the user is typing or pressing keys. */
function armCountdown(ctx: ExtensionContext) {
	if (!state.running) return;
	if (state.interrupted) {
		// ESC stopped the last run: skip this idle spell and wait for the user's next real message.
		renderStatus(ctx);
		return;
	}
	clearCountdown();
	if (editorHasText(ctx)) {
		state.pausedByInput = true;
		renderStatus(ctx);
		return;
	}
	if (userActive()) {
		state.pausedByActivity = true;
		renderStatus(ctx);
		return;
	}
	state.pausedByInput = false;
	state.pausedByActivity = false;
	state.countdownDeadline = Date.now() + state.timeoutMs;
	state.timer = setTimeout(() => {
		state.timer = null;
		void fireNudge(ctx);
	}, state.timeoutMs);
	renderStatus(ctx);
}

/** Countdown hit zero: nudge only if the AI is still idle. */
async function fireNudge(ctx: ExtensionContext) {
	state.countdownDeadline = null;
	if (!state.running) return;
	if (!ctx.isIdle()) {
		// Busy right now: another run (its agent_settled re-arms us), or pi compacting, which never fires
		// agent_settled at all. Don't drop the idle spell; the ticker re-arms once the session is idle.
		state.waitingForIdle = true;
		return;
	}
	if (editorHasText(ctx)) {
		// Race guard: user is typing but the ticker hasn't paused us yet.
		state.pausedByInput = true;
		renderStatus(ctx);
		return;
	}
	if (userActive()) {
		// Race guard: user is pressing keys but the key event hasn't reached us yet.
		state.pausedByActivity = true;
		renderStatus(ctx);
		return;
	}

	sendDecision(ctx);
}

/**
 * Spend one nudge on a decision check: bump the count, auto-stop at the cap, then send the decision
 * message. The countdown and the retry after a failed check both go through here, so every check
 * (including a retry) draws from the same `max=` budget.
 */
function sendDecision(ctx: ExtensionContext): boolean {
	state.nudgeCount++;
	if (state.nudgeCount > state.maxNudges) {
		state.mode = "once"; // Hit the cap, so the run is stuck; stop even in keep mode.
		teardown(ctx);
		ctx.ui.notify(`watchdog: nudged ${state.maxNudges} times with no progress, auto-stopped`, "warning");
		return false;
	}
	try {
		const exchangeId = createExchangeId();
		decisionWindow = { exchangeId };
		// display:true shows the collapsed check hint; details.exchangeId lets the context hook and the hint renderer find this exchange.
		pi.sendMessage(
			{
				customType: DECISION_MESSAGE_TYPE,
				content: DECISION_MESSAGE,
				display: true,
				details: { exchangeId },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {
		// Only a stale ctx throws here: pi swallows async send failures itself, a replaced session makes
		// every pi and ctx call throw. Staying alive would leave a half-open decision window that blocks
		// every tool in the next turn, so stop for real, touching neither the UI nor the event bus.
		decisionWindow = null;
		state.nudgeCount--; // the message never went out, so it does not spend a nudge
		stopWithoutCtx();
		return false;
	}
	renderStatus(ctx);
	return true;
}

/** Start watching: register the tool on first use, reset settings, then arm or wait. */
function startWatchdog(
	ctx: ExtensionContext,
	timeoutSeconds: number,
	message: string,
	maxNudges?: number,
	keepAlive = false,
	restored = false,
) {
	// Register the tool on first start only: sessions without monitoring don't send it, saving tokens.
	// Once registered we never remove it, so the tools list stays stable for the prompt cache.
	if (!toolRegistered) {
		toolRegistered = true;
		registerDecideTool();
	}
	// Allow a restart while running: reset settings and counters.
	// Skip the brief running=false on purpose, so integrations don't think we finished and ring a bell.
	// Pass the current ctx: after session replacement activeCtx is the stale previous-session context.
	// Restarting: stop hard, and don't tell others we stopped (the run keeps going).
	teardown(ctx, true, false);
	state.mode = modeFromKeepAlive(keepAlive);
	state.running = true;
	state.timeoutMs = timeoutSeconds * 1000;
	state.message = message;
	if (maxNudges !== undefined) state.maxNudges = maxNudges;
	state.nudgeCount = 0;
	activeCtx = ctx;
	startTicker();
	ensureTerminalInputListener(ctx);

	// Idle now? Maybe count down. Otherwise wait for agent_settled.
	// No messages yet: nothing to nudge, so wait for the first agent_settled.
	// Restored sessions (resume/fork) are the same: old history isn't real work.
	if (ctx.isIdle()) {
		if (hasMessages(ctx) && !restored) {
			armCountdown(ctx);
		} else {
			renderStatus(ctx);
			const why = restored ? "restored session, waiting for real work" : "session has no messages yet";
			ctx.ui.notify(`watchdog: ${why}; countdown starts after the AI's first run`, "info");
		}
	} else {
		renderStatus(ctx);
	}

	ctx.ui.notify(
		`watchdog: monitoring started (${MODE_POLICY[state.mode].startNotice}nudge after ${timeoutSeconds}s idle, up to ${state.maxNudges} times)`,
		"info",
	);
	publishState();
}

// ---------- small helpers ----------

function createExchangeId(): string {
	exchangeCounter += 1;
	return `w${Date.now().toString(36)}-${exchangeCounter}`;
}

/**
 * True when the run was stopped: its last assistant message has stopReason "aborted" (ESC, or another
 * extension's abort). The row it reads is the newest assistant message, never any assistant message: a run
 * that ends because its tool batch terminated carries no "aborted" row at all, and a stop answer can leave
 * an older tool-call row behind, so scanning the whole run would read an answered check as a user ESC.
 */
function runWasAborted(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		return msg.stopReason === "aborted";
	}
	return false;
}

/**
 * What a finished check settled on, most specific first: a turn the user took over, the answer itself, a
 * dead request, or nothing at all. Only the watchdog_decide call counts as an answer; text never does, which
 * is the whole point of the redesign — a model that answers in prose gets no work turn, it gets silence.
 *
 * The answer outranks `failed` on purpose. A check is answered by a watchdog_decide call, so no run failure
 * can produce that call; the ordering only matters for the pathological case where both look true, and the
 * cost of being wrong must be a retried check, never a live answer thrown away.
 */
function decisionOutcome(window: DecisionWindow, superseded: boolean): DecisionCardData["outcome"] {
	if (superseded) return "superseded";
	if (window.decision !== undefined) return window.decision === DECISION_CONTINUE ? "continue" : "stop";
	if (window.failed === true) return "failed";
	return "empty";
}

/**
 * Provider error text when the run died on one, or undefined when it ended any other way.
 * Pi emits agent_end once per internal retry attempt, so the newest assistant message decides:
 * a later successful attempt clears the earlier error.
 */
function runError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return undefined;
		return typeof msg.errorMessage === "string" ? msg.errorMessage : "";
	}
	return undefined;
}

/** Does the session already have messages? Tells a brand-new session apart. */
function hasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getBranch().some((e) => e.type === "message");
	} catch {
		return true; // If reading fails, treat it as non-empty to keep the old countdown behavior.
	}
}

/** Once a second: repaint the seconds and watch the editor and keys so pauses come and go. */
function startTicker() {
	if (state.ticker) clearInterval(state.ticker);
	state.ticker = setInterval(() => {
		if (!state.running || !activeCtx) return;
		if (state.waitingForIdle) {
			// The countdown ran out while the session was busy; start a fresh one the moment it is idle.
			if (activeCtx.isIdle()) armCountdown(activeCtx);
			return;
		}
		if (state.countdownDeadline != null) {
			if (editorHasText(activeCtx) || userActive()) {
				const byText = editorHasText(activeCtx);
				clearCountdown();
				state.pausedByInput = byText;
				state.pausedByActivity = !byText;
			}
			renderStatus(activeCtx);
		} else if ((state.pausedByInput || state.pausedByActivity) && !editorHasText(activeCtx) && !userActive()) {
			state.pausedByInput = false;
			state.pausedByActivity = false;
			if (activeCtx.isIdle()) {
				armCountdown(activeCtx);
			} else {
				renderStatus(activeCtx); // AI is running; agent_settled will re-arm.
			}
		}
	}, 1000);
}

// ---------- the stop tool ----------

/**
 * Write the history card for an AI-initiated stop taken outside a decision turn.
 *
 * A check leaves a trace on the timeline by itself (its hint, its reply, its result card). A proactive
 * stop has no check behind it, so without this row the watchdog goes quiet with nothing on screen but
 * the status bar blinking off — the user cannot tell the AI finished on purpose from the plugin dying.
 * A history record, so it stays readable in `/tree` and never enters the model context.
 */
function recordProactiveStop(stop: PendingProactiveStop) {
	pi.appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
		// The card and the fold marker share one id, so a card can be read next to the range it explains.
		exchangeId: stop.exchangeId,
		outcome: "stop",
		decision: stop.decision,
		proactive: true,
		suspended: stop.suspended,
		nudgeCount: stop.nudgeCount,
		maxNudges: state.maxNudges,
		ts: Date.now(),
	});
}

/**
 * Write the marker that closes a proactive stop's fold range.
 *
 * Sent after the run rather than from the tool: a `pi.sendMessage` from a running tool defers to
 * turn_end, which is too late — the wrap-up text the AI wrote after the tool call sits queued in front
 * of it, and would end up on the wrong side of the range. Written here, the marker lands last, naming
 * the tool call so folding can find the range without depending on the order it was saved in.
 */
function markProactiveStop(stop: PendingProactiveStop) {
	pi.sendMessage(
		{
			customType: STOP_MESSAGE_TYPE,
			content: "",
			display: false,
			details: { exchangeId: stop.exchangeId, toolCallId: stop.toolCallId },
		},
		{ triggerTurn: false },
	);
}

/**
 * The one tool: answer a check, or stop on your own. Called from the check turn for all three answers, and
 * from a normal work turn with "done"/"wait_user" for a proactive stop (a proactive "continue" says nothing).
 * Registered once by startWatchdog; pi lets us register after startup.
 */
function registerDecideTool() {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Watchdog decide",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: TOOL_PROMPT_GUIDELINES,
		parameters: Type.Object({
			decision: Type.Union([
				Type.Literal(DECISION_CONTINUE),
				Type.Literal(DECISION_DONE),
				Type.Literal(DECISION_WAIT_USER),
			]),
			// The description carries the one-line rule: it rides along with every request, so the model sees
			// it without paying an example round trip. The 200-char slice is only a backstop.
			note: Type.Optional(
				Type.String({
					description:
						"One short line for the user (under ~100 characters). It shows in the watchdog card; never a report or a deliverable.",
				}),
			),
		}),
		// The card already shows the content, so render nothing; a zero-line Text with renderShell "self" keeps the call/result lines blank.
		renderShell: "self",
		renderCall: () => new Text("", 0, 0),
		renderResult: () => new Text("", 0, 0),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = params?.decision as Decision | undefined;
			const note = typeof params?.note === "string" ? params.note.slice(0, DECISION_NOTE_MAX_CHARS) : undefined;
			// Nothing to answer or stop when monitoring is off; a second call in one turn lands here too.
			if (!state.running) {
				return {
					content: [
						{
							type: "text",
							text: state.suspended
								? "Already suspended. Nothing to do — end your turn normally."
								: "Watchdog is not running. Nothing to stop — end your turn normally.",
						},
					],
					details: {},
				};
			}
			// The check turn is open: this call is the answer. Guarded rather than trusted: pi validates the
			// schema before execute, but the check turn runs with every other tool blocked, so a payload that
			// slipped through must not be silently read as "no answer".
			if (decisionWindow !== null) {
				const window = decisionWindow; // keep the window we answered, even if a later send clears it
				if (decision === undefined || !DECISIONS.includes(decision)) {
					// Throw, not return isError: pi only marks a result as an error when execute() throws, and the
					// model has to see this as a failure it can fix inside the same check turn.
					throw new Error(
						BAD_DECISION_NOTE +
							(decision === undefined ? "" : ` Got ${JSON.stringify(decision)}.`) +
							" This check is not answered yet — call again with a valid decision.",
					);
				}
				window.decision = decision;
				window.note = note;
				if (decision === DECISION_CONTINUE) {
					// Work remains: end this turn on the tool result, onAgentSettled sends the continuation. Ending
					// the turn with terminate is what keeps the model from starting the work inside the check turn;
					// it is not an abort, so no "request ended" row appears and the answer cannot read as a user ESC.
					return { content: [{ type: "text", text: "Continuing in the next turn." }], details: {}, terminate: true };
				}
				// "done" / "wait_user": the check ends the watchdog's interest; the card and fold marker drop in agent_settled.
				return stopWatchdog(toolCallId, decision, ctx);
			}

			// No check turn: the AI is closing out on its own. "continue" has nothing to answer here.
			if (decision === DECISION_CONTINUE) {
				throw new Error(NOT_IN_CHECK_TURN_NOTE);
			}
			if (decision !== DECISION_DONE && decision !== DECISION_WAIT_USER) {
				throw new Error(
					`${BAD_DECISION_NOTE} Here, outside a check, only "${DECISION_DONE}" and "${DECISION_WAIT_USER}" do anything.`,
				);
			}
			return stopWatchdog(toolCallId, decision, ctx);
		},
	});
}

/**
 * The "stop" half of the tool, shared by a check answer and a proactive stop: soft-stop, remember what it
 * was (proactive stops are recorded once the run settles, so the AI's wrap-up lands inside the folded
 * range), then end the turn with a terminating tool result.
 *
 * `terminate: true` is what `ctx.abort()` used to do here: pi skips the follow-up model call after this
 * batch, so no further moves ride along. Unlike an abort it never throws, so pi writes no synthesized
 * "request ended" row. It does not erase text the model already streamed — a tool call only runs after its
 * assistant message is complete — but that text stays inside the proactive stop's fold range either way, so
 * nothing extra is paid for keeping it.
 */
function stopWatchdog(toolCallId: string, decision: StopDecision, ctx: ExtensionContext): AgentToolResult<unknown> {
	// PI_WATCHDOG_ON_STOP hook: run an external command when the AI stops the watchdog, e.g. touch an exit file or `tmux wait-for -S done` for a parent (subagent) to wait on.
	const onStop = process.env.PI_WATCHDOG_ON_STOP?.trim();
	if (onStop) {
		spawn("sh", ["-c", onStop], { stdio: "ignore", detached: true }).unref();
	}
	// Soft stop: in keep mode this only pauses us until the user talks again.
	teardown(ctx, false);
	if (decisionWindow === null) {
		// No check turn: hold the record until the run settles. The marker has to be the last row of the turn
		// it closes, and the card describes a stop that is over.
		pendingProactiveStop = {
			exchangeId: createExchangeId(),
			toolCallId,
			decision,
			suspended: state.suspended,
			nudgeCount: state.nudgeCount,
		};
	}
	return { content: [{ type: "text", text: "OK." }], details: {}, terminate: true };
}

// ---------- the /watchdog command ----------

/** Register the /watchdog command: start, stop, or show status. */
function registerWatchdogCommand() {
	pi.registerCommand("watchdog", {
		description:
			"Auto-continue watch: [timeout=sec] [max=count] [message=text] [mode=once|keep] to start | stop to end | status to check",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [first] = tokens;

			switch (first) {
				case "stop": {
					if (state.suspended && !state.running) {
						state.mode = "once";
						teardown(ctx);
						ctx.ui.notify("watchdog: keep-mode monitoring fully off", "info");
						break;
					}
					if (!state.running) {
						ctx.ui.notify("watchdog: not running", "info");
						break;
					}
					// stop always fully stops; pausing is only done by the AI stopping in keep mode.
					state.mode = "once";
					teardown(ctx);
					ctx.ui.notify("watchdog: monitoring stopped", "info");
					break;
				}

				case "status": {
					if (state.suspended && !state.running) {
						ctx.ui.notify(
							`watchdog: keep-mode monitoring paused (⏱⏸ next message resumes it, nudged ${state.nudgeCount}/${state.maxNudges})`,
							"info",
						);
						break;
					}
					if (!state.running) {
						ctx.ui.notify(
							"watchdog: not running (/watchdog timeout=30 message=continue to start; mode=keep for keep mode)",
							"info",
						);
						break;
					}
					const phase = currentPhase();
					const msgPreview = state.message.length > 30 ? `${state.message.slice(0, 30)}…` : state.message;
					ctx.ui.notify(
						`watchdog: running · ${phaseText(phase)} · nudged ${state.nudgeCount}/${state.maxNudges} · extra order: "${msgPreview || "-"}"`,
						"info",
					);
					break;
				}

				default: {
					// Same parser as the env var: strict key=value, and bad args show usage instead of silently becoming text.
					const config = parseConfig(args);
					const cfg = config.ok ? config : undefined;
					if (args.trim() && !config.ok) {
						ctx.ui.notify(
							`watchdog: bad args (${config.error}). Usage: /watchdog [timeout=sec] [max=count] [message=text] [mode=once|keep], e.g. /watchdog timeout=30 message=continue mode=keep`,
							"warning",
						);
						break;
					}
					startWatchdog(
						ctx,
						cfg?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
						cfg?.message ?? "", // Extra instruction; empty when unset, so no stale value carries over.
						cfg?.maxNudges,
						cfg?.keepAlive ?? false,
					);
					break;
				}
			}
		},
	});
}
