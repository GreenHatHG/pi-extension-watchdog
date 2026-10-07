import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, continuationText as nudge } from "../src/constants.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

/**
 * Simulate "user pressed ESC to stop the running turn":
 * the AI starts running, then the turn ends with assistant.stopReason === "aborted".
 */
async function abortRunningTurn(rt: Awaited<ReturnType<typeof setup>>) {
	rt.state.idle = false; // the AI is running
	await rt.emit("agent_start");
	await rt.settleAbortedTurn(); // user pressed ESC → the turn was aborted
}

it("ESC mid-run → no nudge this idle spell, status bar shows the stop", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));

	await rt.commands.get("watchdog").handler("timeout=1 message=ESC test", rt.ctx);
	await rt.settleAfterRun(); // one clean run → would normally start the countdown

	await abortRunningTurn(rt);
	expect(states.at(-1)).toMatchObject({ running: true, interrupted: true });

	await vi.advanceTimersByTimeAsync(3000); // far past the timeout, still no nudge
	expect(nudgeMessages(rt)).toHaveLength(0);
	expect(rt.statusBars.get("watchdog")).toContain("⏹"); // status bar no longer lies with "AI running"

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("ESC-interrupted"))).toBe(true);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("after an ESC stop, the next user message and finished run bring back counting and nudges", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=ESC resume", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0); // no nudge while stopped

	await rt.emit("input", { text: "continue", source: "interactive" }); // real user message → clears the stop flag
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // nudges resume: decision turn first
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("ESC resume"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("keep mode: an ESC stop still works, and monitoring can still go on", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=KEEP test", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0);

	await rt.emit("input", { text: "continue", source: "interactive" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // nudges resume: decision turn first
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("KEEP test"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a run from another extension does not count as the user coming back; only a real user message clears the stop", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=extension source", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	// a message from another extension (source=extension) starts a run: not the user coming back
	await rt.emit("input", { text: "extension inject", source: "extension" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0);

	// only a real user message clears the stopped state
	await rt.emit("input", { text: "taking over", source: "interactive" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // nudges resume: decision turn first
	await rt.settleAfterRun(); // decision turn ends → continue message
	expect(rt.sentMessages.at(-1)).toBe(nudge("extension source"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("ESC on the decision turn → no continue message, the card says superseded, and no nudge this idle spell", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));

	await rt.commands.get("watchdog").handler("timeout=1 message=decision abort", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // countdown hit zero → decision message sent, decisionWindow opens
	expect(nudgeMessages(rt)).toHaveLength(1);

	await rt.settleAbortedTurn(); // user pressed ESC to stop the decision turn

	// aborted decision turn sends no continuation, or it would start a new run
	expect(continuationMessages(rt)).toHaveLength(0);
	expect(states.at(-1)).toMatchObject({ running: true, interrupted: true });

	const cards = rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as any);
	expect(cards.at(-1)).toMatchObject({ outcome: "superseded" });

	// interrupted means no countdown or nudge this idle spell
	await vi.advanceTimersByTimeAsync(5000);
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(rt.statusBars.get("watchdog")).toContain("⏹");

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("ESC after a user interjection during the decision turn → offers a resend, and sends no continue message", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=interject abort", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decisionWindow opens

	rt.notifications.length = 0;
	// the aborted run contains a real user message (the decision prompt is role:"custom", so it does not count)
	await rt.emit("agent_end", {
		messages: [
			{ role: "user", content: "interjection" },
			{ role: "assistant", content: [], stopReason: "aborted" },
		],
	});
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(rt.notifications.some((n) => n.msg.includes("got no answer"))).toBe(true);
	expect(continuationMessages(rt)).toHaveLength(0);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("the turn watchdog_decide ends is not read as a user ESC stop", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60 message=self-stop test", rt.ctx);
	await rt.settleAfterRun();

	// The tool ends the turn with terminate and teardown runs first: running=false, no abort, no ESC row.
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(rt.state.abortedTurns).toBe(0);
	await rt.settleAfterRun(); // the run's own agent_end/agent_settled

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("not running"))).toBe(true);
	expect(rt.statusBars.get("watchdog")).toBeUndefined(); // status bar cleared, no leftover "stopped" mark
});
