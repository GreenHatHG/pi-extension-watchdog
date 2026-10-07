import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	DECISION_ENTRY_TYPE,
	DECISION_MESSAGE,
	EMPTY_REPLY_NOTE,
	FOLD_MESSAGE_TYPE,
	TOOL_NAME,
} from "../src/constants.ts";
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

const decideCall = (decision: string, note?: string, id = "wc") => ({
	role: "assistant",
	content: [
		{ type: "toolCall", id, name: TOOL_NAME, arguments: note === undefined ? { decision } : { decision, note } },
	],
	stopReason: "toolUse",
});

it("a 'continue' answer ends its turn with terminate, so nothing looks like a user ESC", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));

	await rt.commands.get("watchdog").handler("timeout=1 message=self continue", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check turn opens

	// The answer ends the turn by returning terminate, not by aborting: pi writes no synthesized
	// "request ended" row, so nothing in the run can be read as a user ESC in the first place.
	await rt.settleAfterRun(decideCall("continue"));

	expect(rt.state.abortedTurns).toBe(0); // no abort anywhere in the plugin's own path
	expect(states.at(-1)?.interrupted).toBeFalsy(); // so the idle spell keeps counting
	expect(continuationMessages(rt)).toHaveLength(1); // and the answer still earns its work turn
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE)).toBe(false); // not a stop

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a check answered with text only is silence: no work turn, budget spent, countdown restarts", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=text only", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1
	expect(nudgeMessages(rt)).toHaveLength(1);

	// The model wrote a careful answer — the design deliberately ignores it.
	await rt.settleAfterRun({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		stopReason: "stop",
	});

	expect(continuationMessages(rt)).toHaveLength(0);
	expect(cards(rt)[0]).toMatchObject({ outcome: "empty", reply: EMPTY_REPLY_NOTE });
	expect(rt.statusBars.get("watchdog")).toContain("1/3"); // the nudge was spent

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("an invalid decision leaves the check unanswered: the tool throws so pi marks it failed", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=bad enum", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// pi's schema would normally reject this before execute; go around it to pin the in-tool guard. Throwing is
	// the only way pi marks the result as an error, so the model can see the failure and answer again.
	await expect(
		rt.tools.get(TOOL_NAME).execute("t1", { decision: "stop" }, undefined, undefined, rt.ctx),
	).rejects.toThrow(/"continue" \| "done" \| "wait_user"/);
	await expect(
		rt.tools.get(TOOL_NAME).execute("t2", { decision: "stop" }, undefined, undefined, rt.ctx),
	).rejects.toThrow("not answered yet");

	await rt.settleAfterRun({ role: "assistant", content: [], stopReason: "stop" });

	// Not answered: the check folds as empty, no work turn, no continuation.
	expect(cards(rt)[0]).toMatchObject({ outcome: "empty" });
	expect(continuationMessages(rt)).toHaveLength(0);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("calling watchdog_decide with 'continue' outside a check turn says there is nothing to answer", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	rt.state.idle = false; // mid work turn, no check open

	await expect(
		rt.tools.get(TOOL_NAME).execute("t1", { decision: "continue" }, undefined, undefined, rt.ctx),
	).rejects.toThrow("No watchdog check is open");
	expect(rt.state.abortedTurns).toBe(0); // nothing was stopped or aborted
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("running"))).toBe(true);
});

it("the tool description and system-prompt hooks carry the same answers as the check prompt", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);
	const tool = rt.tools.get(TOOL_NAME);

	// The check prompt, the tool description and the system-prompt hooks must agree on the enum, or the
	// model learns one set of answers and is asked for another.
	for (const text of [tool.description, tool.promptSnippet, tool.promptGuidelines[0], DECISION_MESSAGE]) {
		expect(text).toContain('"continue"');
		expect(text).toContain('"done"');
		expect(text).toContain('"wait_user"');
	}
	expect(tool.promptGuidelines.join(" ")).toContain(TOOL_NAME);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a 'continue' answer starts the work turn without any abort machinery", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=clean answer", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// The whole answer is one terminating result: no abort, no synthesized "request ended" row, and the
	// continuation still fires in agent_settled.
	const answer = decideCall("continue", "still going", "wc-clean");
	await rt.emitMessageEnd(answer);
	expect(await rt.runToolBatch(answer)).toBe(true);
	await rt.emit("agent_end", { messages: [answer] });
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(cards(rt).at(-1)).toMatchObject({ outcome: "continue", reply: "still going" });
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(rt.state.abortedTurns).toBe(0); // nothing was aborted along the way

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a provider error is a failed check, not a swallowed one", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=real error", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// No watchdog_decide call was made, so nothing was answered: the failure has to reach the card.
	await rt.settleAfterRun({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});

	expect(cards(rt).at(-1)).toMatchObject({ outcome: "failed", reply: "This operation was aborted" });
	expect(continuationMessages(rt)).toHaveLength(0); // a dead request never starts a work turn

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a blocked tool in the same batch does not cost an extra model call", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=mixed batch", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// The model reached for bash and answered in the same message. pi only ends the run when EVERY result in
	// the batch is terminating, so the block hook carries terminate too. The answer still counts, and the
	// batch ends the check turn instead of buying the model a second turn inside it.
	const mixed = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", id: "wc-mixed", name: TOOL_NAME, arguments: { decision: "continue", note: "mixed" } },
		],
		stopReason: "toolUse",
	};
	await rt.emitMessageEnd(mixed);
	expect(await rt.runToolBatch(mixed)).toBe(true);
	await rt.emit("agent_end", { messages: [mixed] });
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(cards(rt).at(-1)).toMatchObject({ outcome: "continue", reply: "mixed" });
	expect(continuationMessages(rt)).toHaveLength(1);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a check where the model only reaches for blocked tools ends as empty", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=blocked only", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// A blocked call is not an answer, and it terminates on its own: the check closes as empty and the next
	// countdown retries it, exactly like a check that came back silent. It does not spin inside the turn.
	const blockedOnly = {
		role: "assistant",
		content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }],
		stopReason: "toolUse",
	};
	await rt.emitMessageEnd(blockedOnly);
	expect(await rt.runToolBatch(blockedOnly)).toBe(true);
	await rt.emit("agent_end", { messages: [blockedOnly] });
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(cards(rt).at(-1)).toMatchObject({ outcome: "empty" });
	expect(continuationMessages(rt)).toHaveLength(0);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a real user message inside the check voids it instead of getting a continuation on top", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=user interjection", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// pi delivers a nudge as steer, which does not end the run, so the user's message is a plain "user" row
	// inside the check turn. By the time the turn settles their message has been consumed and
	// hasPendingMessages() reads false, so the saved row is the only evidence that they took over.
	const answer = decideCall("continue", "stale answer", "wc-interject");
	await rt.emitMessageEnd({ role: "user", content: "hold on, do something else" });
	await rt.emitMessageEnd(answer);
	await rt.runToolBatch(answer);
	await rt.emit("agent_end", { messages: [answer] });
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(cards(rt).at(-1)).toMatchObject({ outcome: "superseded" });
	expect(continuationMessages(rt)).toHaveLength(0); // no continuation on top of the user's own message

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a provider failure that kills a check is a failed check, and no work turn starts", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=3 message=real failure", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // check 1

	// Nothing in this plugin aborts any more, so every error row is the provider's own. It reaches the card
	// untouched (the TUI keeps its red row) and never counts as an answer.
	const bad = {
		role: "assistant",
		content: [{ type: "text", text: "I was saying something when" }],
		stopReason: "error",
		errorMessage: "stream ended early",
	};
	await rt.emitMessageEnd(bad);
	expect(bad.stopReason).toBe("error"); // untouched, so the failure still reaches the TUI

	await rt.settleAfterRun(bad);
	expect(cards(rt).at(-1)).toMatchObject({ outcome: "failed", reply: "stream ended early" });
	expect(continuationMessages(rt)).toHaveLength(0); // a dead request never starts a work turn

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
