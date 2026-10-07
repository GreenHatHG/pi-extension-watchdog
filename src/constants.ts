export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_NUDGES = 50;
/** Nudge trigger line; message= only adds to it, never replaces it. */
export const DEFAULT_MESSAGE =
	"[Automated, not user input] Your watchdog check is over and this is a normal work turn with every tool available — you are not answering a check now. " +
	"If work remains, continue working (no reply needed). " +
	// "Don't restate" is here on purpose: without it, "state what you need" reads as an invitation to
	// repeat a finished report, and that repeat lands after the fold range, so it stays in context forever.
	// The "check is over" opener is here for the same reason one step earlier: a model that never learned the
	// check closed keeps answering it (a second watchdog_decide, "I'm in a check turn") instead of working.
	"If waiting on a user decision, don't change code — state what you need in one line, don't restate an answer you already delivered, then call watchdog_decide with decision \"wait_user\" as your final action. " +
	'If no work remains and no decision is pending, call watchdog_decide with decision "done" to end the turn.';

/** Build the continue message: fixed trigger line plus any extra order. */
export function continuationText(hint?: string): string {
	return hint ? `${DEFAULT_MESSAGE}\n\nTask instruction: ${hint}` : DEFAULT_MESSAGE;
}

/**
 * Decision-check prompt and fold start.
 *
 * The check turn has exactly one channel: a `watchdog_decide` call. Text is not an answer, and the
 * prompt says so, because the old "any text reply means work remains" mapping made the model write its
 * delivery into a channel the watchdog folds away — the more care it put in the text, the more got
 * deleted, and a model that wanted to keep working had no legitimate call to make but the stop one.
 *
 * The "restating is not work" clause answers a check the model got wrong in practice: a turn that already
 * delivered an answer (or that ended on its own with stopReason "stop") was read as interrupted, so the
 * model answered "continue" to write the very answer it had just sent. A rewrite is not progress, and
 * "wait_user" is only for being blocked — not for parking a finished task.
 */
export const DECISION_MESSAGE =
	"[Automated, not user input] Watchdog check — every tool except watchdog_decide is blocked in this turn. " +
	'Answer by calling watchdog_decide: "continue" if work remains, "done" if the task is finished, ' +
	'or "wait_user" if you are waiting on a user decision. ' +
	"Do not answer with text — a check turn that calls nothing is treated as no answer and the countdown starts over. " +
	'This turn never does work: if you answer "continue", the work happens in the next turn. ' +
	"Your previous turn ending is not an interruption, and an answer you already wrote counts as delivered: " +
	'restating, expanding or re-formatting it is not work, so answer "done" if nothing is left to do. ' +
	"The optional note is one short line for the user, never a report.";

/** How long after the last key press we still treat the user as busy, so we hold the countdown. */
export const ACTIVITY_GRACE_MS = 2000;

/** The single tool an AI uses to answer a check and to stop on its own. */
export const TOOL_NAME = "watchdog_decide";

/** The three answers a check accepts; `decision` is the only signal the watchdog reads. */
export const DECISION_CONTINUE = "continue";
export const DECISION_DONE = "done";
export const DECISION_WAIT_USER = "wait_user";
export type Decision = typeof DECISION_CONTINUE | typeof DECISION_DONE | typeof DECISION_WAIT_USER;
/** The two answers that end the watchdog's interest (a check answer or a proactive stop). */
export type StopDecision = typeof DECISION_DONE | typeof DECISION_WAIT_USER;
export const DECISIONS: readonly Decision[] = [DECISION_CONTINUE, DECISION_DONE, DECISION_WAIT_USER];

/** Quote the enum for error and prompt text: `"continue" | "done" | "wait_user"`. */
export const DECISION_CHOICES = DECISIONS.map((value) => `"${value}"`).join(" | ");

/** Tool description: the model reads this before it ever sees a check. */
export const TOOL_DESCRIPTION =
	`Answer a watchdog check, or end the turn early.\n` +
	`- A watchdog check turn blocks every other tool. Answer it by calling this tool with decision "${DECISION_CONTINUE}" ` +
	`(work remains), "${DECISION_DONE}" (the task is finished), or "${DECISION_WAIT_USER}" (you are waiting on the user). ` +
	`Do not answer a check with text.\n` +
	`- Outside a check turn you may call it with "${DECISION_DONE}" or "${DECISION_WAIT_USER}" to stop the auto-continue ` +
	`watchdog yourself once you are really done; in keep mode that only pauses it until the user's next message.\n` +
	`- The optional note is one short line for the user (under ~100 characters), shown in the watchdog card. ` +
	`Never put a report, a summary, or any deliverable in it.`;

/** One line in the default system prompt's tool list. */
export const TOOL_PROMPT_SNIPPET = `Answer the watchdog's idle check (${DECISION_CHOICES}) or end the turn on purpose`;

/** Guidelines appended to the default system prompt while the tool is active. */
export const TOOL_PROMPT_GUIDELINES = [
	`When the watchdog asks whether work remains, answer with a ${TOOL_NAME} call, never with text: "${DECISION_CONTINUE}" means keep going, ` +
		`"${DECISION_DONE}" means finished, "${DECISION_WAIT_USER}" means you are waiting on the user.`,
	`Call ${TOOL_NAME} with "${DECISION_DONE}" yourself when the task is finished — you do not have to wait for a check.`,
];

/** Returned when the tool is called outside a check turn to say "keep going": there is nothing to answer there. */
export const NOT_IN_CHECK_TURN_NOTE =
	`The watchdog check is already answered and closed — "${DECISION_CONTINUE}" means nothing here. ` +
	`Just keep working. Use "${DECISION_DONE}" or "${DECISION_WAIT_USER}" only when you are truly finished or waiting on the user.`;

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
 * Proactive stop marker: the AI called watchdog_decide outside any decision turn. Written once the run is
 * over, it closes the fold range of that turn — the closing text and the tool round-trip would otherwise
 * ride along in every later request. Do not change its string value, saved sessions depend on it.
 */
export const STOP_MESSAGE_TYPE = "pi-watchdog:stopped";
/** Decision result: session-history record only (no TUI renderer, no context). */
export const DECISION_ENTRY_TYPE = "pi-watchdog:decision";
/**
 * Max note chars kept in the history record. The tool asks for one short line; this is only the
 * backstop, so a model that writes an essay gets truncated instead of blowing up the session file.
 */
export const DECISION_NOTE_MAX_CHARS = 200;

/**
 * Card detail for a check that came back with no `watchdog_decide` call at all.
 * Says what happened instead of pretending the model answered something.
 */
export const EMPTY_REPLY_NOTE = "the model never called watchdog_decide — no work turn started, countdown restarted";

/**
 * Help text for a watchdog_decide call that cannot do anything here. Thrown, not returned: pi only marks a
 * tool result as an error when execute() throws, and the model should see the failure as one it can fix
 * ("call again with a valid decision") rather than as a silent success.
 */
export const BAD_DECISION_NOTE = `${TOOL_NAME} needs a decision of ${DECISION_CHOICES}.`;

export const STATUS_KEY = "watchdog";
