import { spawn } from "node:child_process";
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
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseConfig, parseEnvConfig } from "./config.ts";
import {
	ACTIVITY_GRACE_MS,
	CONTINUATION_MESSAGE_TYPE,
	continuationText,
	DECISION_ENTRY_TYPE,
	DECISION_MESSAGE,
	DECISION_MESSAGE_TYPE,
	DECISION_REPLY_MAX_CHARS,
	DEFAULT_MAX_NUDGES,
	DEFAULT_TIMEOUT_SECONDS,
	FOLD_MESSAGE_TYPE,
	STATUS_KEY,
	TOOL_NAME,
} from "./constants.ts";
import { type DecisionCardData, registerDecisionHintRenderer } from "./decision-card.ts";
import { registerWatchdogContextFolding } from "./fold.ts";
import { MODE_POLICY, modeFromKeepAlive, type WatchdogMode } from "./mode.ts";
import { isRecord, isRestoredReason, textFromContent } from "./utils.ts";

/** One decision exchange: from the nudge we send until that turn settles. */
interface DecisionWindow {
	exchangeId: string;
	stopCalled: boolean;
	replyText?: string;
	/** User hit ESC during the decision turn: close it as superseded, don't continue. */
	aborted?: boolean;
}

interface WatchdogState {
	running: boolean;
	/** Mode: once shuts down on stop_watchdog; keep only pauses, and the next user message wakes us. */
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
	timer: null,
	ticker: null,
};

/** Last ctx we saw; the ticker needs it to repaint the status bar. */
let activeCtx: ExtensionContext | null = null;
/** The decision turn we are inside, if any. */
let decisionWindow: DecisionWindow | null = null;
/** Cancel handle for the raw-key listener; only interactive mode gives us one. */
let unsubTerminalInput: (() => void) | null = null;
/** Register stop_watchdog once and never remove it, to keep the prompt cache prefix stable. */
let toolRegistered = false;
let exchangeCounter = 0;
/** stop_watchdog is aborting the running turn; the provider may land a phantom "error" message we must clear. */
let stopAbortPending = false;

export default function (extensionApi: ExtensionAPI) {
	pi = extensionApi;
	// pi re-runs this factory for every new session but keeps the module cached, so clear the flag here.
	// Left alone it would carry the previous session's registration into this one, whose tool table is empty,
	// and startWatchdog would skip registerStopTool, leaving the AI without stop_watchdog.
	toolRegistered = false;

	// Must run now, not at start: resuming a session replays saved nudge messages, and a missing renderer would show their raw text.
	registerDecisionHintRenderer(pi);

	// ---- Every hook we listen to, in lifecycle order. ----

	// Before each model call: fold old decision exchanges out of the request view only.
	registerWatchdogContextFolding(pi);
	// Session opens: start from PI_WATCHDOG when it is set.
	pi.on("session_start", onSessionStart);
	// User sends a real message: wake a paused run and clear the ESC stop.
	pi.on("input", onInput);
	pi.on("agent_start", onAgentStart);
	// During a decision turn: block every tool except stop_watchdog.
	pi.on("tool_call", onToolCall);
	// A message is saved: strip the decision turn's reply text.
	pi.on("message_end", onMessageEnd);
	// A run ends: remember if the user pressed ESC.
	pi.on("agent_end", onAgentEnd);
	// Run fully settled: close the decision turn, or start the countdown again.
	pi.on("agent_settled", onAgentSettled);
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

/** Block all tools except stop_watchdog during a decision turn, so the exchange stays one clean foldable block. */
function onToolCall(event: ToolCallEvent): ToolCallEventResult | undefined {
	if (decisionWindow === null) return;
	if (event.toolName === TOOL_NAME) return;
	return {
		block: true,
		reason:
			"Watchdog decision turn: every tool except stop_watchdog is blocked. Reply with a brief acknowledgement if work remains; " +
			"otherwise call stop_watchdog.",
	};
}

/** A run ended: flag a user stop (ESC or another extension's abort) from the "aborted" stopReason; stop_watchdog sets running=false first, so we skip it. */
function onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext) {
	if (!state.running || !runWasAborted(event.messages)) return;
	state.interrupted = true;
	if (decisionWindow !== null) {
		// ESC during a decision turn means the user took over: mark it superseded so agent_settled won't continue.
		decisionWindow.aborted = true;
		// If the user had already queued a real user message, the model may have eaten it without a retry, so tell them to resend.
		if (
			Array.isArray(event.messages) &&
			event.messages.some((m) => (m as { role?: unknown } | undefined)?.role === "user")
		) {
			ctx.ui.notify(
				"watchdog: decision turn aborted; a message you sent may have been dropped, please resend",
				"warning",
			);
		}
	}
	renderStatus(ctx); // Show ⏱⏹ now, not after agent_settled.
	publishState();
}

/** A message is saved: strip the decision reply (it says nothing useful and is folded anyway); copy it to the card first so the TUI can still show it. */
function onMessageEnd(event: MessageEndEvent) {
	if (event.message.role !== "assistant") return;
	const message = event.message as { content?: unknown; stopReason?: unknown; errorMessage?: unknown };
	// stop_watchdog's abort can land as an empty "error" assistant message that the TUI paints red; clear it, since our abort is expected.
	// Only "error", not "aborted": user ESC is "aborted" and rewriting it would break runWasAborted.
	// The pending flag scopes this to the abort we just triggered, so real provider errors still show.
	if (stopAbortPending && message.stopReason === "error") {
		stopAbortPending = false;
		return {
			message: {
				...event.message,
				content: [],
				stopReason: "stop",
				errorMessage: undefined,
			} as typeof event.message,
		};
	}
	if (decisionWindow === null) return;
	const content = message.content;
	const hasToolCall =
		Array.isArray(content) &&
		content.some((block) => isRecord(block) && (block.type === "toolCall" || block.type === "tool_use"));
	const text = textFromContent(content);
	if (text) decisionWindow.replyText = text.slice(0, DECISION_REPLY_MAX_CHARS);
	return {
		message: {
			...event.message,
			content: hasToolCall ? (content as unknown[]).filter((block) => !(isRecord(block) && block.type === "text")) : [],
		} as typeof event.message,
	};
}

/** Close the decision turn, then re-arm; close before the running check, since stop_watchdog already set running=false but still owes a fold marker. */
async function onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext) {
	const window = decisionWindow;
	decisionWindow = null;
	stopAbortPending = false; // the aborted run has settled; a later real error must not be swallowed.
	if (window !== null) {
		// A decision turn is void (superseded) when the user jumped in, the turn isn't idle, or ESC hit.
		// We must still drop a terminal marker, or the "keep until a marker" rule makes the decision prompt stick forever.
		const superseded = !ctx.isIdle() || ctx.hasPendingMessages() || window.aborted === true;
		const outcome: DecisionCardData["outcome"] = window.stopCalled ? "stop" : superseded ? "superseded" : "continue";
		if (window.stopCalled || superseded) {
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
			// No stop_watchdog call means work remains: send the continue message to start the real work turn.
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
		// History record only: the result card has no TUI renderer, since the nudge hint already marks the check.
		pi.appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
			exchangeId: window.exchangeId,
			outcome,
			reply: window.replyText,
			suspended: outcome === "stop" && state.suspended,
			nudgeCount: state.nudgeCount,
			maxNudges: state.maxNudges,
			ts: Date.now(),
		});
	}
	if (!state.running) return;
	activeCtx = ctx;
	armCountdown(ctx); // Retries and queued turns are done, so count down again.
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
	if (!ctx.isIdle()) return; // AI started running again; agent_settled will re-arm.
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

	state.nudgeCount++;
	if (state.nudgeCount > state.maxNudges) {
		state.mode = "once"; // Hit the cap, so the run is stuck; stop even in keep mode.
		teardown(ctx);
		ctx.ui.notify(`watchdog: nudged ${state.maxNudges} times with no progress, auto-stopped`, "warning");
		return;
	}

	try {
		const exchangeId = createExchangeId();
		decisionWindow = { exchangeId, stopCalled: false };
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
		// Race: the AI started the moment we sent it, so don't count this nudge and wait for agent_settled.
		decisionWindow = null;
		state.nudgeCount--;
		return;
	}
	renderStatus(ctx);
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
		registerStopTool();
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

/** True when the run was stopped: its last assistant message has stopReason "aborted" (ESC or another extension's abort). */
function runWasAborted(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	return messages.some((m) => {
		const msg = m as { role?: unknown; stopReason?: unknown } | undefined;
		return msg?.role === "assistant" && msg?.stopReason === "aborted";
	});
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

/** Register stop_watchdog; startWatchdog calls this on the first start. pi lets us register after startup. */
function registerStopTool() {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Stop auto-continue",
		description:
			"Ends the turn immediately. Call it yourself once no work remains — no need to wait for a watchdog nudge; " +
			"in keep mode this suspends monitoring until the user's next message.",
		parameters: Type.Object({}),
		// The card already shows the content, so render nothing; a zero-line Text with renderShell "self" keeps the call/result lines blank.
		renderShell: "self",
		renderCall: () => new Text("", 0, 0),
		renderResult: () => new Text("", 0, 0),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
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
			// PI_WATCHDOG_ON_STOP hook: run an external command when stop_watchdog fires, e.g. touch an exit file or `tmux wait-for -S done` for a parent (subagent) to wait on.
			const onStop = process.env.PI_WATCHDOG_ON_STOP?.trim();
			if (onStop) {
				spawn("sh", ["-c", onStop], { stdio: "ignore", detached: true }).unref();
			}
			// Soft stop: in keep mode this only pauses us until the user talks again.
			teardown(ctx, false);
			// A call inside the decision window means the result is stop; the fold marker and card drop in agent_settled.
			if (decisionWindow !== null) decisionWindow.stopCalled = true;
			// Same as a user ESC (app.interrupt): after stop_watchdog the AI usually has only closing text or extra moves, so abort now to cut it off.
			if (!ctx.isIdle()) {
				stopAbortPending = true;
				ctx.abort();
			}
			return {
				content: [
					{
						type: "text",
						text: "OK.",
					},
				],
				details: {},
			};
		},
	});
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
					// stop always fully stops; pausing is only done by the AI calling stop_watchdog in keep mode.
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
