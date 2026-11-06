import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askExternalCheck, sendExternalContinuation } from "./check.ts";
import { DECISION_MESSAGE, DECISION_MESSAGE_TYPE, STATUS_KEY } from "./constants.ts";
import { MODE_POLICY } from "./mode.ts";
import { hasMessages } from "./run-scan.ts";
import {
	clearCountdown,
	createExchangeId,
	getActiveCtx,
	getLastMistake,
	getPi,
	getUnsubTerminalInput,
	isRunning,
	isSuspended,
	setActiveCtx,
	setDecisionWindow,
	setLastMistake,
	setOnStopFired,
	setUnsubTerminalInput,
	state,
	stopWithoutCtx,
} from "./state.ts";
import { ctxAlive, editorHasText, publishState, publishStopped, renderStatus, userActive } from "./status.ts";

/** Countdown, pause/resume, teardown, ticker, and sending the decision check. */

/**
 * A replaced session leaves us a dead ctx: pi exits on an uncaught timer throw, so hanging up beats painting.
 * Touches no UI and no event bus, because both die with the session that the ctx points at.
 */
function dropStaleCtx(ctx: ExtensionContext): boolean {
	if (ctxAlive(ctx)) return false;
	setActiveCtx(null);
	stopWithoutCtx();
	return true;
}

// Module-graph-proof reads: always fetch through the process-global carrier.
const activeCtx = () => getActiveCtx();
const unsubTerminalInput = () => getUnsubTerminalInput();
const lastMistake = () => getLastMistake();

/**
 * Stop or pause: clear timers and status; keep mode only pauses, and the tool stays registered to keep the prompt cache stable.
 * `force` means really stop, even in keep mode; `force = false` lets keep mode just take a nap.
 */
export function teardown(ctx?: ExtensionContext, force = true, publish = true) {
	// Keep mode + soft stop = nap, not death; the next real user message wakes us up.
	const suspend = !force && isRunning() && MODE_POLICY[state.mode].sleepsOnAiStop;
	state.status = suspend ? "suspended" : "stopped";
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
		try {
			(ctx ?? activeCtx())?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Stale ctx: its session took the status line away, so there is nothing left to wipe.
		}
		const unsub = unsubTerminalInput();
		if (unsub) {
			unsub();
			setUnsubTerminalInput(null);
		}
	} else {
		// Napping: keep the status line, so the user still sees ⏱⏸.
		const target = ctx ?? activeCtx();
		if (target) renderStatus(target);
	}
	if (publish) publishState();
}

/** Wake a paused keep-mode watchdog: keep the old settings, reset the nudge count. */
export function resumeWatchdog(ctx: ExtensionContext) {
	if (!isSuspended()) return;
	if (dropStaleCtx(ctx)) return;
	state.status = "running";
	state.nudgeCount = 0;
	state.interrupted = false;
	setOnStopFired(false); // A resumed run is a fresh run: its later stop may fire the hook once again.
	setActiveCtx(ctx);
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
export function ensureTerminalInputListener(ctx: ExtensionContext) {
	if (unsubTerminalInput()) return;
	const ui = ctx.ui as any;
	if (typeof ui.onTerminalInput !== "function") return;
	setUnsubTerminalInput(
		ui.onTerminalInput(() => {
			state.lastInputAt = Date.now();
			if (!isRunning() || state.countdownDeadline == null) return;
			// A key just landed, so pause now instead of waiting for the ticker.
			clearCountdown();
			state.pausedByActivity = true;
			renderStatus(activeCtx() ?? ctx);
		}),
	);
}

/** AI went idle: start the countdown, or pause first if the user is typing or pressing keys. */
export function armCountdown(ctx: ExtensionContext) {
	if (!isRunning()) return;
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
	if (!isRunning()) return;
	if (dropStaleCtx(ctx)) return;
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
export function sendDecision(ctx: ExtensionContext): boolean {
	state.nudgeCount++;
	if (state.nudgeCount > state.maxNudges) {
		state.mode = "once"; // Hit the cap, so the run is stuck; stop even in keep mode.
		teardown(ctx);
		publishStopped("max-reached");
		ctx.ui.notify(`watchdog: nudged ${state.maxNudges} times with no progress, auto-stopped`, "warning");
		return false;
	}
	// Ask other extensions first: a listener (e.g. a driver loop with its own completion checks) answers
	// in the synchronous emit, and its answer replaces the model check entirely. The answer is one shot
	// per emit — the next countdown asks again, so a stale answer can never pin the watchdog down.
	const answer = askExternalCheck();
	if (answer) {
		if (answer.decision === "done") {
			// An external checker knows the work is over: no model check is needed to confirm what code
			// just verified. Stop hard, like the cap path, so keep mode cannot nap and re-arm later.
			state.mode = "once";
			teardown(ctx);
			publishStopped("ai-stop");
			return false;
		}
		sendExternalContinuation(ctx, answer.message);
		return true;
	}
	try {
		const exchangeId = createExchangeId();
		setDecisionWindow({ exchangeId });
		// The previous check's mistake rides along in the prompt: the model cannot learn from a failure it
		// never sees, and a fresh check with no mention of it is how the same mistake repeated twice.
		const prevMistake = lastMistake();
		const content = prevMistake
			? `${DECISION_MESSAGE}\n\nYour last check went unanswered because of your own mistake: ${prevMistake}. This is a new check — answer it now.`
			: DECISION_MESSAGE;
		setLastMistake(undefined); // one mention per check; a new mistake replaces it
		// display:true shows the collapsed check hint; details.exchangeId lets the context hook and the hint renderer find this exchange.
		getPi().sendMessage(
			{
				customType: DECISION_MESSAGE_TYPE,
				content,
				display: true,
				details: { exchangeId },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch {
		// Only a stale ctx throws here: pi swallows async send failures itself, a replaced session makes
		// every pi and ctx call throw. Staying alive would leave a half-open decision window that blocks
		// every tool in the next turn, so stop for real, touching neither the UI nor the event bus.
		setDecisionWindow(null);
		state.nudgeCount--; // the message never went out, so it does not spend a nudge
		stopWithoutCtx();
		return false;
	}
	renderStatus(ctx);
	return true;
}

/** Once a second: repaint the seconds and watch the editor and keys so pauses come and go. */
export function startTicker() {
	if (state.ticker) clearInterval(state.ticker);
	state.ticker = setInterval(() => {
		const active = activeCtx();
		if (!isRunning() || !active) return;
		if (dropStaleCtx(active)) return;
		if (state.waitingForIdle) {
			// The countdown ran out while the session was busy; start a fresh one the moment it is idle.
			if (active.isIdle()) armCountdown(active);
			return;
		}
		if (state.countdownDeadline != null) {
			if (editorHasText(active) || userActive()) {
				const byText = editorHasText(active);
				clearCountdown();
				state.pausedByInput = byText;
				state.pausedByActivity = !byText;
			}
			renderStatus(active);
		} else if ((state.pausedByInput || state.pausedByActivity) && !editorHasText(active) && !userActive()) {
			state.pausedByInput = false;
			state.pausedByActivity = false;
			if (active.isIdle()) {
				armCountdown(active);
			} else {
				renderStatus(active); // AI is running; agent_settled will re-arm.
			}
		}
	}, 1000);
}
