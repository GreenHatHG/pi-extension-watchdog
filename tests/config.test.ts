import { beforeEach, expect, it, vi } from "vitest";
import { continuationText as nudge } from "../src/constants.ts";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});

it("no tool on load; the first start registers it and marks it active", async () => {
	const rt = await setup();
	expect(rt.tools.has("watchdog_decide")).toBe(false); // lazy: sessions without monitoring save the tool slot
	expect(rt.commands.has("watchdog")).toBe(true);
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	expect(rt.tools.has("watchdog_decide")).toBe(true);
	expect(rt.activeTools.has("watchdog_decide")).toBe(true);
});

it("strict key=value: bare token / unknown key / bad value / bad mode are all rejected with usage", async () => {
	const rt = await setup();
	for (const bad of ["30 go on", "foo=bar", "timeout=abc", "mode=always"]) {
		await rt.commands.get("watchdog").handler(bad, rt.ctx);
	}
	const warns = rt.notifications.filter((n) => n.msg.includes("bad args"));
	expect(warns).toHaveLength(4);
	expect(warns[0].msg).toContain("Usage");

	// rejected, so monitoring stayed off
	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
});

it("a valid timeout/max/message combo takes effect and nudges as set", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=parse test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("parse test"));
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("monitoring stopped"))).toBe(true);
});

it("message= with spaces joins all the tokens into one text", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=continue next step", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("continue next step"));
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("no args = default settings (60s)", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("monitoring started") && n.msg.includes("after 60s idle"))).toBe(
		true,
	);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
