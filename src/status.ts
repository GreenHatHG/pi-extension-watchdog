import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_GRACE_MS, STATUS_KEY, WATCHDOG_STOPPED_EVENT } from "./constants.ts";
import { getPi, isRunning, isSuspended, state } from "./state.ts";

/** Tell other extensions our state; agent_settled can't say we'll nudge again, so consumers should trust `running`. */
export function publishState() {
	getPi().events.emit("watchdog:state", {
		running: isRunning(),
		suspended: isSuspended(),
		keepAlive: state.mode === "keep",
		countdownArmed: state.countdownDeadline != null,
		paused: state.pausedByInput || state.pausedByActivity,
		interrupted: state.interrupted,
		nudgeCount: state.nudgeCount,
		maxNudges: state.maxNudges,
		timeoutMs: state.timeoutMs,
	});
}

/**
 * Tell other extensions the watchdog is done for good: the nudge cap was hit, /watchdog stop ran, or a
 * once-mode AI stop landed. Only full stops fire this, never a keep-mode nap — consumers should treat it
 * as "the watchdog gave up or was asked to leave", e.g. a driver loop that must not wait on us forever.
 */
export function publishStopped(reason: "max-reached" | "manual" | "ai-stop", suspended = false) {
	getPi().events.emit(WATCHDOG_STOPPED_EVENT, {
		reason,
		suspended,
		nudgeCount: state.nudgeCount,
		maxNudges: state.maxNudges,
	});
}

/** Unsent text in the editor means the user is typing by hand. */
export function editorHasText(ctx: ExtensionContext): boolean {
	try {
		const text = (ctx.ui as any).getEditorText?.();
		return typeof text === "string" && text.trim().length > 0;
	} catch {
		return false;
	}
}

/** Did the user press a key very recently, like picking a command or scrolling history? */
export function userActive(): boolean {
	return Date.now() - state.lastInputAt < ACTIVITY_GRACE_MS;
}

/** Color text with the theme; fall back to plain text when there is no theme (tests). */
export function fg(ctx: ExtensionContext, color: "accent" | "dim" | "muted", text: string): string {
	const theme = (ctx.ui as any).theme;
	return theme?.fg ? theme.fg(color, text) : text;
}

/** What the watchdog is doing right now; one value for both the status bar and /watchdog status. */
export type WatchdogPhase =
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
export function currentPhase(): WatchdogPhase {
	if (isSuspended()) return { kind: "suspended" };
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
export function phaseText(phase: WatchdogPhase): string {
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
export function renderStatus(ctx: ExtensionContext) {
	// A nap has running=false but still owns the status line, so don't bail out on it.
	if (!isRunning() && !isSuspended()) return;
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
