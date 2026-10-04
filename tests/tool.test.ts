import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("the AI calls stop_watchdog (once mode) → fully stop, and the tool stays registered", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=tool test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);

	// the AI calls stop_watchdog during the decision turn: the outcome is stop
	const result = await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("OK.");

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(continuationMessages(rt)).toHaveLength(0); // no continue message after a stop
	expect(nudgeMessages(rt)).toHaveLength(1); // and no new decision turn either
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // registered for good, no longer removed on start/stop
});

it("calling stop_watchdog proactively, before any nudge, stops monitoring and clears the abort phantom error", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // AI is mid-run; no decision window is open

	const result = await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("OK.");
	expect(rt.state.abortedTurns).toBe(1); // the closing moves are cut off, like a user ESC

	// our abort can land as an empty "error" message; even outside a decision window it must not show as red text
	const phantom = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	expect(phantom.message.stopReason).toBe("stop");
	expect(phantom.message.content).toEqual([]);
	expect(phantom.message.errorMessage).toBeUndefined();

	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("a real provider error outside the decision window is left untouched", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // running, but stop_watchdog was never called

	const real = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
	});
	expect(real).toBeUndefined(); // no rewrite, so the error still reaches the TUI
});

it("calling stop_watchdog while not running says there is nothing to stop", async () => {
	const rt = await setup();
	// lazy: start then fully stop, so the tool stays registered while monitoring is off
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	const result = await rt.tools.get("stop_watchdog").execute("t0", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("not running");
});

it("calling stop_watchdog while paused → says already suspended, state unchanged", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=repeat stop", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t2", {}, undefined, undefined, rt.ctx); // pause

	const result = await rt.tools.get("stop_watchdog").execute("t3", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("Already suspended");
	await rt.commands.get("watchdog").handler("status", rt.ctx); // still paused, not broken by the second call
	expect(rt.notifications.some((n) => n.msg.includes("paused"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
