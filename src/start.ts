import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { armCountdown, ensureTerminalInputListener, startTicker, teardown } from "./countdown.ts";
import { registerDecideTool } from "./decide-tool.ts";
import { MODE_POLICY, modeFromKeepAlive } from "./mode.ts";
import { hasMessages } from "./run-scan.ts";
import { setActiveCtx, setLastMistake, setToolRegistered, state, toolRegistered } from "./state.ts";
import { publishState, renderStatus } from "./status.ts";

/** Start watching: register the tool on first use, reset settings, then arm or wait. */
export function startWatchdog(
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
		setToolRegistered(true);
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
	setLastMistake(undefined); // a fresh run starts clean; a stale note would misname its first check
	setActiveCtx(ctx);
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
