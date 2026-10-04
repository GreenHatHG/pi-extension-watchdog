export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_NUDGES = 50;
/** Nudge trigger line; message= only adds to it, never replaces it. */
export const DEFAULT_MESSAGE =
	"[Automated, not user input] If work remains, continue working (no reply needed). " +
	"If waiting on a user decision, don't change code — state what you need, then call stop_watchdog as your final action. " +
	"If no work remains and no decision is pending, call stop_watchdog to end the turn.";

/** Build the continue message: fixed trigger line plus any extra order. */
export function continuationText(hint?: string): string {
	return hint ? `${DEFAULT_MESSAGE}\n\nTask instruction: ${hint}` : DEFAULT_MESSAGE;
}

/**
 * Decision-turn prompt and fold start; the turn only allows text or stop_watchdog, so it folds as one clean block.
 */
export const DECISION_MESSAGE =
	"[Automated, not user input] Watchdog check — do not use tools in this turn. " +
	"Reply with a brief acknowledgement if work remains. If no work remains, or you are waiting on a " +
	"user decision, call stop_watchdog as your final action.";

/** How long after the last key press we still treat the user as busy, so we hold the countdown. */
export const ACTIVITY_GRACE_MS = 2000;

export const TOOL_NAME = "stop_watchdog";

/**
 * Decision message: shown as the collapsed check hint in the TUI (click to expand the prompt),
 * carries exchangeId for folding; do not change its string value, saved sessions depend on it.
 */
export const DECISION_MESSAGE_TYPE = "pi-watchdog:nudge";
/** Continue message: sent on "continue", starts the real work turn and ends the fold range. */
export const CONTINUATION_MESSAGE_TYPE = "pi-watchdog:continuation";
/** Stop marker: written on "stop" so folding can drop the whole decision exchange. */
export const FOLD_MESSAGE_TYPE = "pi-watchdog:fold";
/** Decision result: session-history record only (no TUI renderer, no context). */
export const DECISION_ENTRY_TYPE = "pi-watchdog:decision";
/** Max reply chars kept in the history record, to keep session files small but still readable. */
export const DECISION_REPLY_MAX_CHARS = 300;

export const STATUS_KEY = "watchdog";
