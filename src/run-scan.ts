import type { AgentSettledEvent } from "@earendil-works/pi-coding-agent";
import { DECISION_CONTINUE, type Decision } from "./constants.ts";
import type { DecisionCardData } from "./decision-card.ts";
import { isRecord } from "./utils.ts";

/**
 * True when the run was stopped: its last assistant message has stopReason "aborted" (ESC, or another
 * extension's abort). The row it reads is the newest assistant message, never any assistant message: a run
 * that ends because its tool batch terminated carries no "aborted" row at all, and a stop answer can leave
 * an older tool-call row behind, so scanning the whole run would read an answered check as a user ESC.
 */
export function runWasAborted(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		return msg.stopReason === "aborted";
	}
	return false;
}

/**
 * What a finished check settled on, most specific first: a turn the user took over, the answer itself, a
 * dead request, or nothing at all. Only the watchdog_decide call counts as an answer; text never does, which
 * is the whole point of the redesign — a model that answers in prose gets no work turn, it gets silence.
 *
 * The answer outranks `failed` on purpose. A check is answered by a watchdog_decide call, so no run failure
 * can produce that call; the ordering only matters for the pathological case where both look true, and the
 * cost of being wrong must be a retried check, never a live answer thrown away.
 */
export function decisionOutcome(
	window: {
		decision?: Decision;
		failed?: boolean;
	},
	superseded: boolean,
): DecisionCardData["outcome"] {
	if (superseded) return "superseded";
	if (window.decision !== undefined) return window.decision === DECISION_CONTINUE ? "continue" : "stop";
	if (window.failed === true) return "failed";
	return "empty";
}

/**
 * Provider error text when the run died on one, or undefined when it ended any other way.
 * Pi emits agent_end once per internal retry attempt, so the newest assistant message decides:
 * a later successful attempt clears the earlier error.
 */
export function runError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return undefined;
		return typeof msg.errorMessage === "string" ? msg.errorMessage : "";
	}
	return undefined;
}

/** The run's messages from a settled event: pi wraps them in `messages`, so scan the wrapper if present. */
export function settledMessages(event: AgentSettledEvent | unknown): unknown {
	if (isRecord(event) && Array.isArray(event.messages)) return event.messages;
	return event;
}

export function lastAssistantText(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: unknown; content?: unknown } | undefined;
		if (msg?.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) return undefined;
		for (const block of msg.content as { type?: unknown; text?: unknown }[]) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				return block.text;
			}
		}
		return undefined;
	}
	return undefined;
}

/**
 * Did the assistant message that carries this tool call also say something? pi saves the assistant
 * message before its tool batch runs, so the branch already holds it at execute time; the mock mirrors
 * that order. Scanning backwards for the matching toolCallId, so a retried run can't fool the scan.
 */
export function turnCarriesText(toolCallId: string, ctx: { sessionManager: { getBranch(): unknown[] } }): boolean {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i -= 1) {
			const entry = branch[i] as { type?: unknown; message?: unknown } | undefined;
			if (entry?.type !== "message") continue;
			const msg = entry.message as { role?: unknown; content?: unknown } | undefined;
			if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
			if (
				!(msg.content as { type?: unknown; id?: unknown }[]).some(
					(b) => isRecord(b) && (b.type === "toolCall" || b.type === "tool_use") && b.id === toolCallId,
				)
			)
				continue;
			return (msg.content as { type?: unknown; text?: unknown }[]).some(
				(b) => isRecord(b) && b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
			);
		}
		return true; // Message not found: fail open, never block a stop on a guess.
	} catch {
		return true;
	}
}

/** Does the session already have messages? Tells a brand-new session apart. */
export function hasMessages(ctx: { sessionManager: { getBranch(): { type?: unknown }[] } }): boolean {
	try {
		return ctx.sessionManager.getBranch().some((e) => e.type === "message");
	} catch {
		return true; // If reading fails, treat it as non-empty to keep the old countdown behavior.
	}
}
