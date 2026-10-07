import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE, DECISION_MESSAGE_TYPE, FOLD_MESSAGE_TYPE, STOP_MESSAGE_TYPE } from "./constants.ts";
import { isRecord } from "./utils.ts";

function exchangeIdOf(message: Record<string, unknown>): string | undefined {
	const details = message.details;
	if (!isRecord(details)) return undefined;
	const exchangeId = details.exchangeId;
	return typeof exchangeId === "string" && exchangeId.length > 0 ? exchangeId : undefined;
}

/** The check that opened a decision turn; a message without a valid exchangeId is left alone. */
function decisionExchangeId(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "custom") return undefined;
	if (message.customType !== DECISION_MESSAGE_TYPE) return undefined;
	return exchangeIdOf(message);
}

/** A proactive-stop marker: it names the tool call it closes, which is how its range is located. */
function stopMarker(message: unknown): { exchangeId: string; toolCallId: string } | undefined {
	if (!isRecord(message) || message.role !== "custom") return undefined;
	if (message.customType !== STOP_MESSAGE_TYPE) return undefined;
	const exchangeId = exchangeIdOf(message);
	const details = message.details;
	const toolCallId = isRecord(details) ? details.toolCallId : undefined;
	if (exchangeId === undefined || typeof toolCallId !== "string" || toolCallId.length === 0) return undefined;
	return { exchangeId, toolCallId };
}

function sameExchange(message: unknown, customType: string, exchangeId: string): boolean {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== customType) return false;
	const details = message.details;
	if (!isRecord(details)) return false;
	return details.exchangeId === exchangeId;
}

/** Does this assistant message carry the tool call the marker closes? */
function carriesToolCall(message: unknown, toolCallId: string): boolean {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some((block) => {
		if (!isRecord(block)) return false;
		const isToolCall = block.type === "toolCall" || block.type === "tool_use";
		return isToolCall && block.id === toolCallId;
	});
}

/**
 * Non-destructively hide finished watchdog exchanges from the request view.
 *
 * A decision exchange is a contiguous run that starts at a decision message
 * (`pi-watchdog:nudge`) and contains only the turn the model produced inside that
 * decision window: assistant / toolResult messages, including the blocked tool
 * calls. Earlier messages are left untouched.
 *
 * An exchange is folded only when it is provably finished, i.e. a terminal marker
 * with the same `exchangeId` is reached before any unrelated message:
 *   - a continuation message (`:continuation`): drop the whole exchange but keep
 *     this message, so the model still sees the prompt for the real work turn; or
 *   - a fold marker (`:fold`, user took over / aborted turn): drop that too.
 *
 * A proactive stop (`:stopped`, written when the AI called watchdog_decide outside any
 * check) folds the mirror image: the range is the run that *ends* at the marker, not
 * the one that starts at it. It starts at the assistant message carrying the tool
 * call the marker names, and covers everything up to the marker — the closing text,
 * the call, its result, and any row the aborted run appended after it. "All done"
 * wrap-ups are the AI's last words on a finished task, so replaying them in every
 * later request only ever nudges the model to restate them.
 *
 * Anything else hit first (a real user message, a summary, another plugin's custom
 * message, or the end of the list) is a boundary. Without a terminal marker the
 * exchange may still be live, so nothing is folded — fail closed rather than risk
 * deleting a decision prompt the model still needs to answer. A stop whose anchor
 * cannot be found (compacted away, say) keeps its rows for the same reason.
 *
 * Pure over the saved messages (linking uses only each message's own `customType`,
 * `details.exchangeId` and `details.toolCallId`), so the result is stable across
 * resume/reload/branch. Folding only changes the request view; the saved session is
 * never rewritten.
 */
export function foldWatchdogContext<T extends object>(messages: T[]): T[] {
	const drop = new Array<boolean>(messages.length).fill(false);
	for (let i = 0; i < messages.length; i += 1) {
		const exchangeId = decisionExchangeId(messages[i]);
		if (exchangeId === undefined) continue;
		let end = -1; // drop range [i, end)
		let complete = false;
		for (let j = i + 1; j < messages.length; j += 1) {
			const message: unknown = messages[j];
			if (isRecord(message) && message.role === "custom") {
				if (sameExchange(message, CONTINUATION_MESSAGE_TYPE, exchangeId)) {
					end = j; // keep the continuation itself
					complete = true;
				} else if (sameExchange(message, FOLD_MESSAGE_TYPE, exchangeId)) {
					end = j + 1; // drop the fold marker too
					complete = true;
				}
				break; // other custom messages are a boundary; keep them
			}
			if (isRecord(message) && (message.role === "assistant" || message.role === "toolResult")) continue;
			break; // real user messages, summaries: keep them
		}
		if (!complete || end < 0) continue; // no end marker yet: keep all, or the model loses the prompt
		for (let k = i; k < end; k += 1) drop[k] = true;
		i = end - 1;
	}
	// Proactive stops last, so a decision turn's own range is settled before a stop looks back into it.
	for (let i = 0; i < messages.length; i += 1) {
		const marker = stopMarker(messages[i]);
		if (marker === undefined) continue;
		let start = -1;
		for (let j = i - 1; j >= 0; j -= 1) {
			if (carriesToolCall(messages[j], marker.toolCallId)) {
				start = j;
				break;
			}
			// Only the run's own rows sit between the call and the marker (an abort leaves at most an empty
			// assistant row behind); anything else means the call itself is gone, so keep the rows.
			const message: unknown = messages[j];
			if (isRecord(message) && (message.role === "assistant" || message.role === "toolResult")) continue;
			break;
		}
		if (start < 0) continue; // anchor gone (compacted): keep the rows rather than guess
		for (let k = start; k <= i; k += 1) drop[k] = true;
	}
	return drop.some(Boolean) ? messages.filter((_, index) => !drop[index]) : messages;
}

/** Register folding before each provider request; it only changes the request view, not the saved session. */
export function registerWatchdogContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({ messages: foldWatchdogContext(event.messages) }));
}
