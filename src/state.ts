import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_NUDGES, DEFAULT_TIMEOUT_SECONDS, type Decision, type StopDecision } from "./constants.ts";
import type { WatchdogMode } from "./mode.ts";

// Shared accessors for the globals() carrier live at the bottom; the interfaces below only
// describe shapes, so their order relative to globals() does not matter at runtime.

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
	/** Was the watchdog napping when this check answered "stop"? Captured at stop time: a user message
	 * landing between stop and settle resumes us, and the card would lose its "monitoring paused" note. */
	suspended?: boolean;
}

/**
 * The three states the watchdog itself can be in; paused/interrupted/waiting are sub-signs of running.
 * One field instead of two independent booleans (running + suspended) means the impossible combo
 * (running and suspended at once) can no longer even be written, and what we hold is exactly what
 * publishState sends out.
 */
export type WatchdogStatus = "running" | "suspended" | "stopped";

export interface WatchdogState {
	/** The one true state; `isRunning()` / `isSuspended()` below are read-only views of it. */
	status: WatchdogStatus;
	/** Mode: once shuts the watchdog down on an AI stop; keep only pauses, and the next user message wakes us. */
	mode: WatchdogMode;
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

/** True while status is "running"; every old `state.running` read works unchanged. */
export function isRunning(): boolean {
	return globals().state.status === "running";
}
/** True while status is "suspended" (keep mode nap); read-only view of status. */
export function isSuspended(): boolean {
	return globals().state.status === "suspended";
}

/**
 * Process-global carrier for every piece of shared mutable state.
 *
 * pi loads extension modules through jiti with `moduleCache: false` (loader.js), so the same
 * src/*.ts file can be instantiated into several module graphs in one process (extension reload,
 * a second import path, a rebuilt factory). Module-level singletons are NOT shared across those
 * graphs: the tool closure in one graph set `decisionWindow` while `onAgentSettled` in another
 * graph read null — the check was answered but no card, fold marker or continuation was ever
 * written (missing on the timeline since the Oct-23 refactor). Stashing everything on globalThis
 * makes every graph resolve the same instances, whatever pi's loader does.
 */
const STATE_KEY = "__piWatchdogState";

interface WatchdogGlobals {
	state: WatchdogState;
	activeCtx: ExtensionContext | null;
	decisionWindow: DecisionWindow | null;
	pendingProactiveStop: PendingProactiveStop | null;
	lastMistake: string | undefined;
	silentStopWarned: boolean;
	onStopFired: boolean;
	toolRegistered: boolean;
	unsubTerminalInput: (() => void) | null;
	exchangeCounter: number;
	pi: ExtensionAPI | undefined;
	expandedHintIds: Set<string>;
	expandedCardIds: Set<string>;
	emptyStreak: number;
}

/** The one shared carrier, for sibling modules (expanded.ts) that hold shared sets. */
export function getGlobals(): WatchdogGlobals {
	return globals();
}

function globals(): WatchdogGlobals {
	const carrier = globalThis as typeof globalThis & { [STATE_KEY]?: WatchdogGlobals };
	if (!carrier[STATE_KEY]) {
		carrier[STATE_KEY] = {
			state: freshState(),
			activeCtx: null,
			decisionWindow: null,
			pendingProactiveStop: null,
			lastMistake: undefined,
			silentStopWarned: false,
			onStopFired: false,
			toolRegistered: false,
			unsubTerminalInput: null,
			exchangeCounter: 0,
			pi: undefined,
			expandedHintIds: new Set(),
			expandedCardIds: new Set(),
			emptyStreak: 0,
		};
	}
	return carrier[STATE_KEY];
}

/**
 * Reset every field a fresh plugin instance used to start with. The factory runs per session in pi,
 * and the test suite calls it after vi.resetModules() expecting brand-new state; with a process-global
 * carrier this reset IS the fresh start.
 */
export function resetGlobalsForNewSession() {
	const g = globals();
	g.state = freshState();
	g.activeCtx = null;
	g.decisionWindow = null;
	g.pendingProactiveStop = null;
	g.lastMistake = undefined;
	g.silentStopWarned = false;
	g.onStopFired = false;
	g.toolRegistered = false;
	g.unsubTerminalInput = null;
	g.expandedHintIds.clear();
	g.expandedCardIds.clear();
	g.emptyStreak = 0;
}

function freshState(): WatchdogState {
	return {
		status: "stopped",
		mode: "once",
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
}

/** The one shared watchdog state object, wherever this module graph was loaded from. */
export const state: WatchdogState = new Proxy({} as WatchdogState, {
	get(_t, prop) {
		return Reflect.get(globals().state, prop);
	},
	set(_t, prop, value) {
		return Reflect.set(globals().state, prop, value);
	},
});

/** Last ctx we saw; the ticker needs it to repaint the status bar. */
export function getActiveCtx(): ExtensionContext | null {
	return globals().activeCtx;
}
export function setActiveCtx(ctx: ExtensionContext | null) {
	globals().activeCtx = ctx;
}

/** The decision turn we are inside, if any. */
export function getDecisionWindow(): DecisionWindow | null {
	return globals().decisionWindow;
}
export function setDecisionWindow(window: DecisionWindow | null) {
	globals().decisionWindow = window;
}

export function getPendingProactiveStop(): PendingProactiveStop | null {
	return globals().pendingProactiveStop;
}
export function setPendingProactiveStop(stop: PendingProactiveStop | null) {
	globals().pendingProactiveStop = stop;
}

/** The mistake the last check caught (wrong tool, text-only answer); shown once in the next check's prompt. */
export function getLastMistake(): string | undefined {
	return globals().lastMistake;
}
export function setLastMistake(mistake: string | undefined) {
	globals().lastMistake = mistake;
}

/** Set after we threw once at a silent proactive stop in this run; the next one fails open. */
export function isSilentStopWarned(): boolean {
	return globals().silentStopWarned;
}
export function setSilentStopWarned(warned: boolean) {
	globals().silentStopWarned = warned;
}

/** ON_STOP already fired for this watchdog run. One run = one stop = one hook execution; a second
 * stop (or a re-entrant stop from a child process inheriting the env) must not re-run the chain. */
export function hasOnStopFired(): boolean {
	return globals().onStopFired;
}
export function setOnStopFired(fired: boolean) {
	globals().onStopFired = fired;
}

/** Register watchdog_decide once and never remove it, to keep the prompt cache prefix stable. */
export function isToolRegistered(): boolean {
	return globals().toolRegistered;
}
export function setToolRegistered(registered: boolean) {
	globals().toolRegistered = registered;
}

/** Cancel handle for the raw-key listener; only interactive mode gives us one. */
export function getUnsubTerminalInput(): (() => void) | null {
	return globals().unsubTerminalInput;
}
export function setUnsubTerminalInput(unsub: (() => void) | null) {
	globals().unsubTerminalInput = unsub;
}

export function createExchangeId(): string {
	const g = globals();
	g.exchangeCounter += 1;
	return `w${Date.now().toString(36)}-${g.exchangeCounter}`;
}

// One pi handle for every module; set once by the extension factory.
/** Back-to-back empty replies from the model; the card shows the streak, and a warning fires at the threshold. */
export function getEmptyStreak(): number {
	return globals().emptyStreak;
}
export function setEmptyStreak(streak: number) {
	globals().emptyStreak = streak;
}

export function setPi(api: ExtensionAPI) {
	globals().pi = api;
}

export function getPi(): ExtensionAPI {
	const pi = globals().pi;
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
	state.status = "stopped";
	state.pausedByInput = false;
	state.pausedByActivity = false;
	state.interrupted = false;
	clearCountdown();
	if (state.ticker) {
		clearInterval(state.ticker);
		state.ticker = null;
	}
	const unsub = globals().unsubTerminalInput;
	if (unsub) {
		unsub();
		setUnsubTerminalInput(null);
	}
}
