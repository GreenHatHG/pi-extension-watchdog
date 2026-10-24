import { parseConfig } from "./config.ts";
import { DEFAULT_TIMEOUT_SECONDS } from "./constants.ts";
import { teardown } from "./countdown.ts";
import { startWatchdog } from "./start.ts";
import { getPi, isRunning, isSuspended, setActiveCtx, state } from "./state.ts";
import { currentPhase, phaseText, publishStopped } from "./status.ts";

/** Register the /watchdog command: start, stop, or show status. */
export function registerWatchdogCommand() {
	getPi().registerCommand("watchdog", {
		description:
			"Auto-continue watch: [timeout=sec] [max=count] [message=text] [mode=once|keep] to start | stop to end | status to check",
		handler: async (args, ctx) => {
			setActiveCtx(ctx);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [first] = tokens;

			switch (first) {
				case "stop": {
					if (isSuspended() && !isRunning()) {
						state.mode = "once";
						teardown(ctx);
						publishStopped("manual");
						ctx.ui.notify("watchdog: keep-mode monitoring fully off", "info");
						break;
					}
					if (!isRunning()) {
						ctx.ui.notify("watchdog: not running", "info");
						break;
					}
					// stop always fully stops; pausing is only done by the AI stopping in keep mode.
					state.mode = "once";
					teardown(ctx);
					publishStopped("manual");
					ctx.ui.notify("watchdog: monitoring stopped", "info");
					break;
				}

				case "status": {
					if (isSuspended() && !isRunning()) {
						ctx.ui.notify(
							`watchdog: keep-mode monitoring paused (⏱⏸ next message resumes it, nudged ${state.nudgeCount}/${state.maxNudges})`,
							"info",
						);
						break;
					}
					if (!isRunning()) {
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
