import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE, continuationText as nudge } from "../src/constants.ts";
import { nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("first start with an empty session → no countdown until the first agent_settled, using the default text", async () => {
	const rt = await setup();
	rt.sessionEntries.length = 0; // simulate a brand-new session
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	expect(rt.activeTools.has("watchdog_decide")).toBe(true); // tool is active after start

	await vi.advanceTimersByTimeAsync(1300);
	expect(nudgeMessages(rt)).toHaveLength(0); // no messages, so no nudge
	expect(rt.notifications.some((n) => n.msg.includes("no messages yet"))).toBe(true);

	await rt.settleAfterRun(); // first AI run ends → countdown starts
	await vi.advanceTimersByTimeAsync(1200); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(rt.sentMessages).not.toContain(DEFAULT_MESSAGE); // decision turn not done yet, no continue message

	await rt.settleAfterRun(); // decision turn ends (model replied text) → continue message
	expect(rt.sentMessages.filter((m) => m === DEFAULT_MESSAGE)).toHaveLength(1);
	// The continue message must not invite a repeat of an answer the model already delivered.
	expect(DEFAULT_MESSAGE).toContain("don't restate an answer you already delivered");

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.activeTools.has("watchdog_decide")).toBe(true); // registered for good, kept after stop
});

it("no nudge while the AI runs; after it stops, countdown and nudge again", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=test continue", rt.ctx);
	await rt.settleAfterRun();

	await rt.emit("agent_start");
	await vi.advanceTimersByTimeAsync(1200);
	expect(nudgeMessages(rt)).toHaveLength(0); // no nudge while running

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(600);
	await rt.emit("agent_start"); // AI runs again (countdown is cancelled and rebuilt)
	await vi.advanceTimersByTimeAsync(600);
	expect(nudgeMessages(rt)).toHaveLength(0);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("test continue"));
	expect(rt.state.idle).toBe(false); // the continue message starts a new run, so the AI is running
});

it("max= cap: stops and notifies on reaching it", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=cap test", rt.ctx);
	for (let i = 0; i < 2; i++) {
		await rt.settleAfterRun(); // last run ends → countdown
		await vi.advanceTimersByTimeAsync(1100); // decision turn
		await rt.settleAfterRun(); // decision turn ends → continue message
	}
	expect(nudgeMessages(rt)).toHaveLength(2);
	expect(rt.sentMessages.filter((m) => m === nudge("cap test"))).toHaveLength(2);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // the 3rd should be blocked and auto-stop
	expect(nudgeMessages(rt)).toHaveLength(2);
	expect(rt.notifications.some((n) => n.msg.includes("auto-stopped"))).toBe(true);
});

it("after a manual stop no more nudges; status shows running/not running", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=manual test", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	await vi.advanceTimersByTimeAsync(1200);
	expect(nudgeMessages(rt)).toHaveLength(0);

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);

	await rt.commands.get("watchdog").handler("", rt.ctx); // no args = default settings
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("running"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("status detail: counting down / typing pause / key pause / waiting for idle", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60 message=status test", rt.ctx);

	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("nudge in"))).toBe(true);

	rt.state.editorText = "draft"; // unsent editor text → the ticker pauses after a poll
	await vi.advanceTimersByTimeAsync(1100);
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("you're typing"))).toBe(true);

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100); // past the key grace, ticker restarts the countdown
	rt.pressKey(); // a key during the countdown → key pause right away
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("pressing keys"))).toBe(true);

	await rt.emit("agent_start"); // AI running → waiting for idle
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("waiting for the AI to go idle"))).toBe(true);
});

it("a countdown that runs out while the session is busy re-arms the moment it goes idle", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=busy poll", rt.ctx);
	await rt.settleAfterRun(); // run ends → countdown

	// The timer runs out while the AI is running: nothing is sent, and no timer is left behind.
	rt.state.idle = false;
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(0);

	// The ticker notices the idle session and starts a fresh, full countdown instead of nudging at once.
	rt.state.idle = true;
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a stale ctx while sending the check stops monitoring instead of leaving a half-open window", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3", rt.ctx);
	await rt.settleAfterRun();

	// pi throws synchronously when the session was replaced; every later call on that ctx throws too.
	rt.pi.sendMessage = () => {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	await vi.advanceTimersByTimeAsync(1100);

	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true); // stopped, not limping

	// No half-open decision window: the next turn must not have its tools blocked.
	expect(await rt.emitToolCall({ toolName: "bash", toolCallId: "c1", args: {} })).toBeUndefined();
});

it("re-running /watchdog while running: resets args, text and nudge count, no stale countdown", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=5 message=old text", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.settleAfterRun(); // decision turn ends → old-text continue message
	expect(rt.sentMessages.filter((m) => m === nudge("old text"))).toHaveLength(1);

	await rt.commands.get("watchdog").handler("timeout=1 message=new text", rt.ctx); // restart while running
	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("nudged 0/"))).toBe(true); // count reset
	expect(rt.notifications.some((n) => n.msg.includes("nudged 0/5"))).toBe(true); // max kept when not given

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1200); // decision turn
	await rt.settleAfterRun(); // decision turn ends → new-text continue message
	expect(rt.sentMessages.filter((m) => m === nudge("old text"))).toHaveLength(1); // old args/timer cleared
	expect(rt.sentMessages.filter((m) => m === nudge("new text"))).toHaveLength(1);
});
