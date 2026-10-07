import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, STOP_MESSAGE_TYPE } from "../src/constants.ts";
import type { DecisionCardData } from "../src/decision-card.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

/** Decision cards saved so far (the CustomEntry rows from appendEntry). */
const cards = (rt: { entries: { customType: string; data: any }[] }) =>
	rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as DecisionCardData);

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("the AI calls watchdog_decide (once mode) → fully stop, and the tool stays registered", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=tool test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);

	// the AI calls watchdog_decide during the decision turn: the outcome is stop
	const result = await rt.tools
		.get("watchdog_decide")
		.execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("OK.");

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(continuationMessages(rt)).toHaveLength(0); // no continue message after a stop
	expect(nudgeMessages(rt)).toHaveLength(1); // and no new decision turn either
	expect(rt.activeTools.has("watchdog_decide")).toBe(true); // registered for good, no longer removed on start/stop
});

it("a proactive stop is recorded once its run settles, card and fold marker both after the wrap-up", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // AI is mid-run; no decision window is open
	expect(cards(rt)).toHaveLength(0);

	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	// Nothing yet: the wrap-up text queued behind the tool call has to land inside the folded range first.
	expect(cards(rt)).toHaveLength(0);
	expect(rt.customMessages.filter((m) => m.customType === STOP_MESSAGE_TYPE)).toHaveLength(0);

	await rt.settleAfterRun();
	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({ outcome: "stop", proactive: true, suspended: false, nudgeCount: 0 });

	const markers = rt.customMessages.filter((m) => m.customType === STOP_MESSAGE_TYPE);
	expect(markers).toHaveLength(1);
	expect(markers[0]?.details).toMatchObject({ exchangeId: found[0]?.exchangeId, toolCallId: "t1" });
});

it("a check whose answer is stop writes the card at settle, not at the tool call, and marks it as part of the check", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision window opens

	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(cards(rt)).toHaveLength(0); // nothing yet: the turn may still say a closing line

	await rt.settleAfterRun();
	const found = cards(rt);
	expect(found).toHaveLength(1); // exactly one card, not one per writer
	expect(found[0]).toMatchObject({ outcome: "stop", suspended: true });
	expect(found[0]?.proactive).toBeUndefined();
});

it("calling watchdog_decide proactively, before any nudge, stops monitoring by ending the turn", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // AI is mid-run; no decision window is open

	const result = await rt.tools
		.get("watchdog_decide")
		.execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("OK.");
	// The turn ends because the result is terminating, not because we abort: no "request ended" row is written,
	// so there is no red error to clean up either.
	expect(result.terminate).toBe(true);
	expect(rt.state.abortedTurns).toBe(0);

	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("a real provider error outside the decision window is left untouched", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // running, but watchdog_decide was never called

	const real = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
	});
	expect(real).toBeUndefined(); // no rewrite, so the error still reaches the TUI
});

it("calling watchdog_decide while not running says there is nothing to stop", async () => {
	const rt = await setup();
	// lazy: start then fully stop, so the tool stays registered while monitoring is off
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	const result = await rt.tools
		.get("watchdog_decide")
		.execute("t0", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("not running");
});

it("calling watchdog_decide while paused → says already suspended, state unchanged", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=repeat stop", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("watchdog_decide").execute("t2", { decision: "done" }, undefined, undefined, rt.ctx); // pause

	const result = await rt.tools
		.get("watchdog_decide")
		.execute("t3", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("Already suspended");
	await rt.commands.get("watchdog").handler("status", rt.ctx); // still paused, not broken by the second call
	expect(rt.notifications.some((n) => n.msg.includes("paused"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
