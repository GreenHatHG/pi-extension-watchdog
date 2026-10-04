import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("keep mode: timeout nudges → stop_watchdog only pauses → an interactive message resumes", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=keep test", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);

	// the AI calls stop_watchdog during the decision turn: pause, not off
	const r = await rt.tools.get("stop_watchdog").execute("t10", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(r.content)).toContain("OK.");
	expect(rt.activeTools.has("stop_watchdog")).toBe(true);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(nudgeMessages(rt)).toHaveLength(1); // no nudge while paused

	// the user sends a new message: auto-resume
	await rt.emit("input", { text: "new task", source: "interactive" });
	expect(rt.notifications.some((n) => n.msg.includes("resumed"))).toBe(true);
	await vi.advanceTimersByTimeAsync(1200);
	expect(nudgeMessages(rt)).toHaveLength(2);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("keep mode: an input from an extension does not resume", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=keep test2", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t10b", {}, undefined, undefined, rt.ctx); // pause
	await rt.settleAfterRun();

	await rt.emit("input", { text: "nudge message", source: "extension" });
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("paused"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("keep mode: a manual stop while running also fully stops, and a new message does not wake it", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=keep test3", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("monitoring stopped"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // registered for good, no longer removed on start/stop

	await rt.emit("input", { text: "plain message", source: "interactive" });
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("keep mode: a manual stop while paused → fully off", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=keep test4", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t10c", {}, undefined, undefined, rt.ctx); // pause
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("paused"))).toBe(true);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("fully off"))).toBe(true);
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("keep mode: hitting the max cap → fully off, a new message does not resume", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=1 mode=keep message=keep cap", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn 1
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	await rt.settleAfterRun(); // work turn ends → countdown

	await vi.advanceTimersByTimeAsync(1100); // the 2nd is blocked, keep mode also fully off
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(rt.notifications.some((n) => n.msg.includes("auto-stopped"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // registered for good, no longer removed on start/stop

	await rt.emit("input", { text: "new task", source: "interactive" }); // no resume
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("PI_WATCHDOG mode=keep: auto-starts in keep mode, a new message resumes after a pause", async () => {
	process.env.PI_WATCHDOG = "timeout=1 mode=keep message=keep env text";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("keep mode") && n.msg.includes("monitoring started"))).toBe(true);

	await vi.advanceTimersByTimeAsync(1300); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);

	const r = await rt.tools.get("stop_watchdog").execute("t11", {}, undefined, undefined, rt.ctx); // inside the decision window → pause
	expect(JSON.stringify(r.content)).toContain("OK.");

	await rt.emit("input", { text: "continue new task", source: "interactive" });
	expect(rt.notifications.some((n) => n.msg.includes("resumed"))).toBe(true);
	await rt.settleAfterRun(); // settle the decision turn that the pause interrupted
	await vi.advanceTimersByTimeAsync(2300); // ticker restarts the countdown (≤1s) + 1s timeout
	expect(nudgeMessages(rt).length).toBeGreaterThanOrEqual(2);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // registered for good, no longer removed on start/stop
});
