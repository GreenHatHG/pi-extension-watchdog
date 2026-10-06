export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_NUDGES = 50;
/** Nudge trigger line; message= only adds to it, never replaces it. */
export const DEFAULT_MESSAGE =
	"[Automated, not user input] If work remains, continue working (no reply needed). " +
	// "Don't restate" is here on purpose: without it, "state what you need" reads as an invitation to
	// repeat a finished report, and that repeat lands after the fold range, so it stays in context forever.
	"If waiting on a user decision, don't change code — state what you need in one line, don't restate an answer you already delivered, then call stop_watchdog as your final action. " +
	"If no work remains and no decision is pending, call stop_watchdog to end the turn.";

/** Build the continue message: fixed trigger line plus any extra order. */
export function continuationText(hint?: string): string {
	return hint ? `${DEFAULT_MESSAGE}\n\nTask instruction: ${hint}` : DEFAULT_MESSAGE;
}

/**
 * Decision-turn prompt and fold start; the turn only allows text or stop_watchdog, so it folds as one clean block.
 * The mapping is spelled out because it is not guessable: text means "still working", whatever the text says.
 * A model that answers the check with "all done" therefore buys itself another work turn and repeats itself.
 */
export const DECISION_MESSAGE =
	"[Automated, not user input] Watchdog check — every tool except stop_watchdog is blocked in this turn. " +
	'Any text reply is read as "work remains" and starts another work turn, so only reply briefly if work is left, ' +
	"and never restate or summarize an answer you already gave. " +
	"If no work remains, or you are waiting on a user decision, call stop_watchdog as your final action.";

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
/**
 * Proactive stop marker: the AI called stop_watchdog outside any decision turn. Written once the run is
 * over, it closes the fold range of that turn — the closing text and the tool round-trip would otherwise
 * ride along in every later request. Do not change its string value, saved sessions depend on it.
 */
export const STOP_MESSAGE_TYPE = "pi-watchdog:stopped";
/** Decision result: session-history record only (no TUI renderer, no context). */
export const DECISION_ENTRY_TYPE = "pi-watchdog:decision";
/** Max reply chars kept in the history record, to keep session files small but still readable. */
export const DECISION_REPLY_MAX_CHARS = 300;

/**
 * Card detail for a check that came back with nothing at all: no text, no tool call.
 * Says what happened instead of pretending the model answered something.
 */
export const EMPTY_REPLY_NOTE = "the model sent no text and no tool call — no work turn started, countdown restarted";

export const STATUS_KEY = "watchdog";
