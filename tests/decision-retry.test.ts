import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, EMPTY_REPLY_NOTE, FOLD_MESSAGE_TYPE } from "../src/constants.ts";
import type { DecisionCardData } from "../src/decision-card.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

const cards = (rt: { entries: { customType: string; data: any }[] }) =>
	rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as DecisionCardData);

/**
 * Simulate a decision turn that died on a provider error: the assistant message is saved with
 * stopReason "error", then the run ends and settles.
 */
async function failDecisionTurn(rt: Awaited<ReturnType<typeof setup>>, errorMessage = "request timed out") {
	await rt.emitMessageEnd({ role: "assistant", content: [], stopReason: "error", errorMessage });
	await rt.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage }] });
	rt.state.idle = true; // pi marks the run inactive before agent_settled
	await rt.emit("agent_settled");
}

it("a decision turn killed by a provider error is retried by the next countdown, not on the spot", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=retry test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1
	expect(nudgeMessages(rt)).toHaveLength(1);

	await failDecisionTurn(rt);

	// No immediate retry: the check failed, so the countdown starts again and the status bar counts.
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(0); // a failed check never continues
	expect(rt.statusBars.get("watchdog")).toContain("1s");

	await vi.advanceTimersByTimeAsync(1100); // check 2, spending the next nudge from the max= budget
	expect(nudgeMessages(rt)).toHaveLength(2);
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("nudged 2/3"))).toBe(true);

	// The retried check answers normally → continue message, so work resumes.
	await rt.settleAfterRun({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "wc2",
				name: "watchdog_decide",
				arguments: { decision: "continue", note: "still going" },
			},
		],
		stopReason: "toolUse",
	});
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(cards(rt).map((c) => c.outcome)).toEqual(["failed", "continue"]);

	// Both the failed exchange and the retried one fold away: only the continue message stays.
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.filter((m: any) => m.role === "custom").map((m: any) => m.customType)).toEqual([
		"pi-watchdog:continuation",
	]);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a failed check drops a history card carrying the provider error, and folds the whole exchange", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=1 message=fail test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	await failDecisionTurn(rt, "boom: connection reset");

	// The budget is already spent, so the next countdown cannot send anything: it auto-stops instead.
	expect(nudgeMessages(rt)).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(rt.notifications.some((n) => n.msg.includes("auto-stopped"))).toBe(true);

	const failed = cards(rt);
	expect(failed).toHaveLength(1);
	expect(failed[0]).toMatchObject({ outcome: "failed", reply: "boom: connection reset" });

	// The failed exchange still got its end marker, so it never lingers in the request view.
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded).toHaveLength(0);
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE && m.details.outcome === "failed")).toBe(
		true,
	);
});

it("an empty reply is treated like a failed check: card, fold marker, countdown, no work turn", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=silent model", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// The provider finished the stream with no text and no tool call at all.
	await rt.settleAfterRun({ role: "assistant", content: [], stopReason: "stop" });

	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(0); // silence is not "work remains"
	expect(cards(rt)[0]).toMatchObject({ outcome: "empty", reply: EMPTY_REPLY_NOTE });
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE && m.details.outcome === "empty")).toBe(true);
	// The check still folds away, and the status bar went back to counting the same nudge budget.
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded).toHaveLength(0);
	expect(rt.statusBars.get("watchdog")).toContain("1s");
	expect(rt.statusBars.get("watchdog")).toContain("1/3");

	await vi.advanceTimersByTimeAsync(1100); // check 2
	expect(nudgeMessages(rt)).toHaveLength(2);

	// Two empty replies in a row still never start a work turn; they just drain the budget.
	await rt.settleAfterRun({ role: "assistant", content: [], stopReason: "stop" });
	expect(continuationMessages(rt)).toHaveLength(0);
	expect(cards(rt).map((c) => c.outcome)).toEqual(["empty", "empty"]);

	await vi.advanceTimersByTimeAsync(1100); // check 3, the third and last allowed nudge
	await rt.settleAfterRun({ role: "assistant", content: [], stopReason: "stop" });
	await vi.advanceTimersByTimeAsync(1100); // cap hit: no check 4
	expect(rt.notifications.some((n) => n.msg.includes("auto-stopped"))).toBe(true);
	expect(continuationMessages(rt)).toHaveLength(0);
});

it("a check turn that tries to work instead of answering counts as no answer", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=tool only", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// The model reached for its tools instead of answering. The call is blocked, and a blocked call is not
	// an answer: nothing sets the check's decision, so this is silence and the countdown starts over.
	await rt.settleAfterRun({
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
		stopReason: "toolUse",
	});

	expect(cards(rt)[0]).toMatchObject({ outcome: "empty" });
	expect(continuationMessages(rt)).toHaveLength(0);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a failed check the user took over is superseded, not retried", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=user took over", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	rt.state.pendingMessages = 1; // the user queued a message while the check was running
	await failDecisionTurn(rt);

	expect(nudgeMessages(rt)).toHaveLength(1); // no retry: the user is in charge now
	expect(cards(rt)[0]).toMatchObject({ outcome: "superseded" });

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a decision turn that errored and then recovered inside pi still continues normally", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=recovered", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// pi retries internally: the first attempt fails, the second one answers. Only the last one counts.
	await rt.emit("agent_end", {
		messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "x" }],
	});
	const answered = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "wc3",
				name: "watchdog_decide",
				arguments: { decision: "continue", note: "answered after retry" },
			},
		],
		stopReason: "toolUse",
	};
	await rt.emitMessageEnd(answered);
	await rt.tools
		.get("watchdog_decide")
		.execute("wc3", { decision: "continue", note: "answered after retry" }, undefined, undefined, rt.ctx);
	await rt.emit("agent_end", { messages: [answered] });
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(nudgeMessages(rt)).toHaveLength(1); // no watchdog retry needed
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(cards(rt)[0]).toMatchObject({ outcome: "continue", reply: "answered after retry" });

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a stop answer is not mistaken for a failed check, even if an unrelated error row lands", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// The stop answer is already in hand; nothing else in the run may talk the watchdog into a retry. The
	// answer outranks a failure on purpose: the worst case has to be a retried check, never a lost answer.
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	await rt.emit("agent_end", {
		messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }],
	});
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(nudgeMessages(rt)).toHaveLength(1); // stopped on purpose, no retry
	expect(cards(rt)[0]).toMatchObject({ outcome: "stop" });
});
