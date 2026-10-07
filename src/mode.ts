/**
 * Mode policy: what an AI-initiated stop means, and whether a real user message wakes the watchdog.
 *   once  watchdog_decide shuts the watchdog down
 *   keep  watchdog_decide only puts it to sleep; the user's next message resumes it
 */
export type WatchdogMode = "once" | "keep";

export interface ModePolicy {
	/** AI calls watchdog_decide: sleep (keep) or shut down (once). */
	sleepsOnAiStop: boolean;
	/** A real user message wakes a sleeping run. */
	resumesOnUserMessage: boolean;
	/** Fragment in the "monitoring started" notice. */
	startNotice: string;
}

export const MODE_POLICY: Record<WatchdogMode, ModePolicy> = {
	once: { sleepsOnAiStop: false, resumesOnUserMessage: false, startNotice: "" },
	keep: { sleepsOnAiStop: true, resumesOnUserMessage: true, startNotice: "keep mode, " },
};

/** Turn the config/env keepAlive flag into a mode. */
export function modeFromKeepAlive(keepAlive: boolean): WatchdogMode {
	return keepAlive ? "keep" : "once";
}
