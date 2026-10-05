import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, FOLD_MESSAGE_TYPE } from "../src/constants.ts";
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

it("a decision turn killed by a provider error is retried: a fresh check is sent and counted", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=retry test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1
	expect(nudgeMessages(rt)).toHaveLength(1);

	await failDecisionTurn(rt);

	expect(nudgeMessages(rt)).toHaveLength(2); // retried right away, no new countdown
	expect(continuationMessages(rt)).toHaveLength(0); // a failed check never continues

	// The retry is a check like any other: it draws its own nudge from the max= budget.
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("nudged 2/3"))).toBe(true);

	// The retried check answers normally → continue message, so work resumes.
	await rt.emitMessageEnd({ role: "assistant", content: [{ type: "text", text: "still going" }] });
	await rt.settleAfterRun();
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

	// max=1 is already spent, so the retry cannot be sent: monitoring stops like any other cap hit.
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
	await rt.emitMessageEnd({ role: "assistant", content: [{ type: "text", text: "answered after retry" }] });
	await rt.emit("agent_end", {
		messages: [{ role: "assistant", content: [{ type: "text", text: "answered after retry" }], stopReason: "stop" }],
	});
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(nudgeMessages(rt)).toHaveLength(1); // no watchdog retry needed
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(cards(rt)[0]).toMatchObject({ outcome: "continue", reply: "answered after retry" });

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("the phantom abort error from stop_watchdog is never mistaken for a failed check", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	await rt.emit("agent_end", {
		messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }],
	});
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(nudgeMessages(rt)).toHaveLength(1); // stopped on purpose, no retry
	expect(cards(rt)[0]).toMatchObject({ outcome: "stop" });
});
