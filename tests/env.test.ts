import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { continuationText as nudge } from "../src/constants.ts";
import { nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("valid PI_WATCHDOG: session_start auto-starts, nudges with the custom text after the timeout", async () => {
	process.env.PI_WATCHDOG = "timeout=1 message=env text";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("monitoring started"))).toBe(true);

	await vi.advanceTimersByTimeAsync(1300); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("env text"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("/resume: monitoring starts but does not count down right away, first agent_settled then nudges", async () => {
	process.env.PI_WATCHDOG = "timeout=1 message=env text";
	const rt = await setup();
	await rt.emit("session_start", { reason: "resume" });
	expect(rt.notifications.some((n) => n.msg.includes("monitoring started"))).toBe(true);
	expect(rt.notifications.some((n) => n.msg.includes("restored session"))).toBe(true);

	// the user does nothing after resuming: no countdown, no nudge
	await vi.advanceTimersByTimeAsync(5000);
	expect(rt.sentMessages).toHaveLength(0);

	// after real work (one finished AI run) the normal countdown starts
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300); // decision turn
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("env text"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("/fork: also does not count down right away", async () => {
	process.env.PI_WATCHDOG = "timeout=1";
	const rt = await setup();
	await rt.emit("session_start", { reason: "fork" });
	expect(rt.notifications.some((n) => n.msg.includes("restored session"))).toBe(true);

	await vi.advanceTimersByTimeAsync(3000);
	expect(rt.sentMessages).toHaveLength(0);

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("PI_WATCHDOG=0 does not auto-start (and does not register the tool, saving tokens)", async () => {
	process.env.PI_WATCHDOG = "0";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications).toHaveLength(0);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false); // lazy: no start, no tool
});

it("bad PI_WATCHDOG format: clear warning, no silent skip, no start", async () => {
	process.env.PI_WATCHDOG = "30:100|oldDSL";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("bad PI_WATCHDOG"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false); // lazy: no start, no tool
});

it("PI_WATCHDOG=1 uses the default settings (60s)", async () => {
	process.env.PI_WATCHDOG = "1";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("monitoring started") && n.msg.includes("after 60s idle"))).toBe(
		true,
	);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
