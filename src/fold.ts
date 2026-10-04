import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE, DECISION_MESSAGE_TYPE, FOLD_MESSAGE_TYPE } from "./constants.ts";
import { isRecord } from "./utils.ts";

/** Only a decision message with a valid exchangeId starts a fold; other custom messages are left alone. */
function messageExchangeId(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "custom") return undefined;
	if (message.customType !== DECISION_MESSAGE_TYPE) return undefined;
	const details = message.details;
	if (!isRecord(details)) return undefined;
	const exchangeId = details.exchangeId;
	return typeof exchangeId === "string" && exchangeId.length > 0 ? exchangeId : undefined;
}

function sameExchange(message: unknown, customType: string, exchangeId: string): boolean {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== customType) return false;
	const details = message.details;
	if (!isRecord(details)) return false;
	return details.exchangeId === exchangeId;
}

/**
 * Non-destructively hide finished watchdog decision exchanges from the request view.
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
 * Anything else hit first (a real user message, a summary, another plugin's custom
 * message, or the end of the list) is a boundary. Without a terminal marker the
 * exchange may still be live, so nothing is folded — fail closed rather than risk
 * deleting a decision prompt the model still needs to answer.
 *
 * Pure over the saved messages (linking uses only each message's own `customType`
 * + `details.exchangeId`), so the result is stable across resume/reload. Folding
 * only changes the request view; the saved session is never rewritten.
 */
export function foldWatchdogContext<T extends object>(messages: T[]): T[] {
	const drop = new Array<boolean>(messages.length).fill(false);
	for (let i = 0; i < messages.length; i += 1) {
		const exchangeId = messageExchangeId(messages[i]);
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
	return drop.some(Boolean) ? messages.filter((_, index) => !drop[index]) : messages;
}

/** Register folding before each provider request; it only changes the request view, not the saved session. */
export function registerWatchdogContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({ messages: foldWatchdogContext(event.messages) }));
}
