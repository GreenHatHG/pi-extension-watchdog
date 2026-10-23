import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_NUDGES, DEFAULT_TIMEOUT_SECONDS, type Decision, type StopDecision } from "./constants.ts";
import type { WatchdogMode } from "./mode.ts";

/** One decision exchange: from the nudge we send until that turn settles. */
export interface DecisionWindow {
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
	/**
	 * The mistake the model made in this check: a wrong tool call or a text-only answer. Kept so the card
	 * says what the model actually did, and so a retried check can show the model its own mistake.
	 */
	mistake?: string;
}

export interface WatchdogState {
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

/**
 * The proactive stop waiting to be written down: the tool ran, but the run it belongs to is not over yet.
 * Held until then because a `pi.sendMessage` from inside a running tool only lands at turn_end, which is
 * after the AI's wrap-up text — a marker sent from the tool would end the fold range on the wrong side.
 */
export interface PendingProactiveStop {
	/** Fresh each time, so the marker links back to this stop and to nothing else. */
	exchangeId: string;
	/** The watchdog_decide call the range hangs off; the assistant message carrying it starts the range. */
	toolCallId: string;
	/** Keep mode: monitoring is only suspended, and the card says so. */
	suspended: boolean;
	/** Why the AI stopped: "done" or "wait_user". */
	decision: StopDecision;
	/** The short note the AI passed along, so the card can show it. Undefined when it wrote none. */
	reply?: string;
	nudgeCount: number;
}

// pi loads this extension once, so one module-level state is enough.
export const state: WatchdogState = {
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

// The rest of the shared mutable state. Written from several modules, so each exposes a setter:
// an imported `let` can be read across modules but only reassigned in its own module.

/** Last ctx we saw; the ticker needs it to repaint the status bar. */
export let activeCtx: ExtensionContext | null = null;
export function setActiveCtx(ctx: ExtensionContext | null) {
	activeCtx = ctx;
}

/** The decision turn we are inside, if any. */
export let decisionWindow: DecisionWindow | null = null;
export function setDecisionWindow(window: DecisionWindow | null) {
	decisionWindow = window;
}

export let pendingProactiveStop: PendingProactiveStop | null = null;
export function setPendingProactiveStop(stop: PendingProactiveStop | null) {
	pendingProactiveStop = stop;
}

/** The mistake the last check caught (wrong tool, text-only answer); shown once in the next check's prompt. */
export let lastMistake: string | undefined;
export function setLastMistake(mistake: string | undefined) {
	lastMistake = mistake;
}

/** Set after we threw once at a silent proactive stop in this run; the next one fails open. */
export let silentStopWarned = false;
export function setSilentStopWarned(warned: boolean) {
	silentStopWarned = warned;
}

/** Register watchdog_decide once and never remove it, to keep the prompt cache prefix stable. */
export let toolRegistered = false;
export function setToolRegistered(registered: boolean) {
	toolRegistered = registered;
}

/** Cancel handle for the raw-key listener; only interactive mode gives us one. */
export let unsubTerminalInput: (() => void) | null = null;
export function setUnsubTerminalInput(unsub: (() => void) | null) {
	unsubTerminalInput = unsub;
}

let exchangeCounter = 0;

export function createExchangeId(): string {
	exchangeCounter += 1;
	return `w${Date.now().toString(36)}-${exchangeCounter}`;
}

// One pi handle for every module; set once by the extension factory.
let pi: ExtensionAPI | undefined;

export function setPi(api: ExtensionAPI) {
	pi = api;
}

export function getPi(): ExtensionAPI {
	if (pi === undefined) throw new Error("watchdog: extension not initialized yet");
	return pi;
}

export function clearCountdown() {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
	state.countdownDeadline = null;
	// Any fresh arming replaces the wait; the flag only ever means "the timer already ran out once".
	state.waitingForIdle = false;
}

/**
 * Stop for real without touching the ctx. On a stale ctx every ui call throws too, so a shutdown that
 * cleans the status line cannot be used here; clearing the state is all we can honestly do.
 */
export function stopWithoutCtx() {
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
		setUnsubTerminalInput(null);
	}
}
