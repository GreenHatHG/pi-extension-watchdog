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

it("the user starts typing during the countdown → pause; after clearing it, resume and nudge", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=typing test", rt.ctx);
	await rt.settleAfterRun();

	rt.state.editorText = "typing a bit";
	await vi.advanceTimersByTimeAsync(1400);
	expect(nudgeMessages(rt)).toHaveLength(0);

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100); // ticker polls the resume first (≤1s) + the full 1s timeout
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("typing test"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("editor already has text at agent_settled → pause, no nudge; after clearing, resume", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=input test2", rt.ctx);
	rt.state.editorText = "still clearing text";
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(nudgeMessages(rt)).toHaveLength(0);

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100);
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("input test2"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a key press during the countdown → pause right away; after keys stop (2s grace), resume and nudge", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=key test", rt.ctx);
	await rt.settleAfterRun();

	rt.pressKey();
	await vi.advanceTimersByTimeAsync(1400);
	expect(nudgeMessages(rt)).toHaveLength(0);

	await vi.advanceTimersByTimeAsync(3000); // the 2s grace passes → ticker restarts the countdown → timeout nudge
	expect(nudgeMessages(rt)).toHaveLength(1);
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("key test"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a key press just before agent_settled → pause, no countdown", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=key test2", rt.ctx);
	rt.pressKey();
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(nudgeMessages(rt)).toHaveLength(0);
});
