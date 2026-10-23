import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTINUATION_MESSAGE_TYPE,
	continuationText,
	type ExternalCheckAnswer,
	type ExternalCheckEvent,
	WATCHDOG_CHECK_EVENT,
} from "./constants.ts";
import { getPi, state, stopWithoutCtx } from "./state.ts";
import { renderStatus } from "./status.ts";
import { isRecord } from "./utils.ts";

/**
 * Fire the external-check event and take the first valid answer. Handlers run synchronously inside the
 * emit, so by the time this returns every listener has had its say. A handler without a valid answer
 * just returns undefined and the built-in model check stays in charge.
 */
export function askExternalCheck(): ExternalCheckAnswer | undefined {
	// The answer travels in the payload: EventEmitter drops handler return values, so a writable
	// `answer` slot on the event is the only channel a synchronous listener can reply through.
	const event: ExternalCheckEvent = { nudgeCount: state.nudgeCount, maxNudges: state.maxNudges };
	getPi().events.emit(WATCHDOG_CHECK_EVENT, event);
	const answer = event.answer;
	if (!isRecord(answer)) return undefined;
	const decision = (answer as { decision?: unknown }).decision;
	if (decision !== "continue" && decision !== "done") return undefined;
	const message = (answer as { message?: unknown }).message;
	return { decision, message: typeof message === "string" && message.trim() ? message : undefined };
}

/**
 * Send an external checker's continue instruction as the real work-turn message. Reuses the plain
 * continuation type — no decision hint preceded it, so folding finds no range and keeps it whole,
 * which is exactly right: it is a real instruction the model must see in later requests too.
 */
export function sendExternalContinuation(ctx: ExtensionContext, message: string | undefined) {
	try {
		const content = message?.trim() || continuationText(state.message || undefined);
		getPi().sendMessage(
			{
				customType: CONTINUATION_MESSAGE_TYPE,
				content,
				display: true,
				details: {},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	} catch {
		// Same stale-ctx story as the normal check path: the send failed, so stop for real instead of
		// leaving a watchdog that fires on a dead session.
		stopWithoutCtx();
		return;
	}
	renderStatus(ctx);
}
