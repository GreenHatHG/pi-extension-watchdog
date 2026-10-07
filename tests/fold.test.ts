import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CONTINUATION_MESSAGE_TYPE,
	DECISION_MESSAGE,
	DECISION_MESSAGE_TYPE,
	FOLD_MESSAGE_TYPE,
	continuationText as nudge,
	STOP_MESSAGE_TYPE,
} from "../src/constants.ts";
import { foldWatchdogContext } from "../src/fold.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

const EXCHANGE = "exchange-1";

const nudgeMsg = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: DECISION_MESSAGE_TYPE,
	content: DECISION_MESSAGE,
	display: false,
	details: { exchangeId },
});
const continuationMsg = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: CONTINUATION_MESSAGE_TYPE,
	content: nudge(),
	display: true,
	details: { exchangeId },
});
const stopMarker = (exchangeId = EXCHANGE, toolCallId = "cs") => ({
	role: "custom",
	customType: STOP_MESSAGE_TYPE,
	content: "",
	display: false,
	details: { exchangeId, toolCallId },
});
const foldMarker = (exchangeId = EXCHANGE, outcome = "stop") => ({
	role: "custom",
	customType: FOLD_MESSAGE_TYPE,
	content: "",
	display: false,
	details: { exchangeId, outcome },
});
const assistant = (content: unknown[]) => ({ role: "assistant", content });
const toolResult = (toolCallId: string, toolName: string) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [],
});
const user = (text: string) => ({ role: "user", content: text });

it("a continue exchange folds down to just the continue message", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([{ type: "text", text: "ok" }]),
		continuationMsg(),
		user("later"),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task"), continuationMsg(), user("later")]);
});

it("a display:true nudge still folds (its visibility is TUI-only)", () => {
	const messages = [
		user("task"),
		{ ...nudgeMsg(), display: true },
		assistant([{ type: "text", text: "ok" }]),
		continuationMsg(),
		user("later"),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task"), continuationMsg(), user("later")]);
});

it("a stop exchange is dropped together with the blocked tool pair", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([
			{ type: "toolCall", id: "c1", name: "edit", arguments: {} }, // blocked
			{ type: "toolCall", id: "cs", name: "watchdog_decide", arguments: {} },
			{ type: "text", text: "done" },
		]),
		toolResult("c1", "edit"),
		toolResult("cs", "watchdog_decide"),
		foldMarker(),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task")]);
});

it("decision turn still running (no end marker) → keep all, the model must see the prompt", () => {
	const messages = [user("task"), nudgeMsg(), assistant([{ type: "text", text: "..." }])];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("a real user message inside the range → fail closed, keep all", () => {
	const messages = [nudgeMsg(), user("wait"), continuationMsg()];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("a custom message from another plugin inside the range → fail closed, keep all", () => {
	const messages = [
		nudgeMsg(),
		{ role: "custom", customType: "other:x", content: "x", display: false },
		continuationMsg(),
	];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("multiple exchanges fold independently", () => {
	const messages = [
		nudgeMsg("e1"),
		assistant([]),
		continuationMsg("e1"),
		nudgeMsg("e2"),
		assistant([]),
		foldMarker("e2"),
		user("after"),
	];
	expect(foldWatchdogContext(messages)).toEqual([continuationMsg("e1"), user("after")]);
});

it("a non-message role such as a compaction summary inside the range → fail closed, keep all", () => {
	const messages = [nudgeMsg(), { role: "compactionSummary", summary: "..." }, continuationMsg()];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("an orphan continuation with no decision message is kept", () => {
	const messages = [user("a"), continuationMsg(), user("b")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("no end state and a new user message after it → keep all", () => {
	const messages = [nudgeMsg(), assistant([{ type: "text", text: "..." }]), user("interrupt")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("old saved messages with an unknown details field (like an old version) still fold", () => {
	const legacyNudge = {
		role: "custom",
		customType: DECISION_MESSAGE_TYPE,
		content: DECISION_MESSAGE,
		display: false,
		details: { version: 1, exchangeId: EXCHANGE },
	};
	const messages = [user("task"), legacyNudge, assistant([]), continuationMsg(), user("later")];
	expect(foldWatchdogContext(messages)).toEqual([user("task"), continuationMsg(), user("later")]);
});

it("a superseded fold marker also ends the range", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([]),
		{
			role: "custom",
			customType: FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: { exchangeId: EXCHANGE, outcome: "superseded" },
		},
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task")]);
});

it("plain messages with no link are untouched", () => {
	const messages = [user("a"), assistant([{ type: "text", text: "b" }]), user("c")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("a proactive stop folds the run that ended at its marker, and keeps what came before and after", () => {
	const messages = [
		user("task"),
		assistant([
			{ type: "toolCall", id: "c1", name: "edit", arguments: {} },
			{ type: "toolCall", id: "cs", name: "watchdog_decide", arguments: {} },
		]),
		toolResult("c1", "edit"),
		toolResult("cs", "watchdog_decide"),
		stopMarker("w1", "cs"),
		user("next thing"),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task"), user("next thing")]);
});

it("a proactive stop keeps the wrap-up text the AI wrote after the tool call out of the view", () => {
	const messages = [
		user("task"),
		assistant([
			{ type: "text", text: "starting" },
			{ type: "toolCall", id: "cs", name: "watchdog_decide", arguments: {} },
		]),
		toolResult("cs", "watchdog_decide"),
		{ role: "assistant", content: [{ type: "text", text: "all done, here is the summary" }], stopReason: "aborted" },
		stopMarker("w1", "cs"),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task")]);
});

it("a proactive stop whose tool call is gone (compacted) fails closed and keeps its rows", () => {
	const messages = [user("task"), toolResult("cs", "watchdog_decide"), stopMarker("w1", "cs")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("a stop marker without a tool call id is ignored, not guessed at", () => {
	const messages = [
		user("task"),
		assistant([{ type: "toolCall", id: "cs", name: "watchdog_decide", arguments: {} }]),
		toolResult("cs", "watchdog_decide"),
		{ role: "custom", customType: STOP_MESSAGE_TYPE, content: "", display: false, details: { exchangeId: "w1" } },
	];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("context hook: after the decision turn the request view has no decision exchange", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=fold test", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.settleAfterRun(); // decision turn ends (model did not call stop) → continue message

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.some((m) => m.customType === DECISION_MESSAGE_TYPE)).toBe(false);
	expect(folded.filter((m) => m.role === "custom").map((m) => m.customType)).toEqual([CONTINUATION_MESSAGE_TYPE]);
});

it("context hook: after the AI calls watchdog_decide the whole decision exchange is removed", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=stop fold", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	await rt.settleAfterRun(); // decision turn ends → stop fold marker

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.filter((m) => m.role === "custom")).toHaveLength(0);
});

it("context hook: a proactive stop takes its own wrap-up out of the request view", async () => {
	const rt = await setup();
	rt.pushMessage({ role: "user", content: "do the thing" } as any);
	await rt.commands.get("watchdog").handler("timeout=60 message=proactive fold", rt.ctx);
	rt.state.idle = false; // mid-run: no check turn

	// The AI says it is done and calls the tool in the same message, then the turn settles.
	// (No message_end rewrite here: outside a check turn the hook leaves the message alone.)
	rt.pushMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "all done" },
			{ type: "toolCall", id: "cs", name: "watchdog_decide", arguments: {} },
		],
	} as any);
	await rt.tools.get("watchdog_decide").execute("cs", { decision: "done" }, undefined, undefined, rt.ctx);
	rt.pushMessage({ role: "toolResult", toolCallId: "cs", content: [{ type: "text", text: "OK." }] });
	await rt.settleAfterRun();

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.filter((m) => m.role === "assistant" || m.role === "toolResult")).toHaveLength(0);
	expect(folded.some((m) => m.customType === STOP_MESSAGE_TYPE)).toBe(false);
	expect(folded.some((m) => m.role === "user")).toBe(true); // the real conversation is untouched
});

it("inside the decision window every tool but watchdog_decide is blocked; after settling they pass again", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn opens

	const blocked = await rt.emitToolCall({ toolName: "bash", toolCallId: "c1", input: {} });
	expect(blocked?.block).toBe(true);
	// terminate rides along so a batch of [blocked tool, watchdog_decide] still ends the turn: a blocked call
	// is not an answer, but it must not cost an extra model call either.
	expect(blocked?.terminate).toBe(true);
	expect(blocked?.reason).toContain("every tool except watchdog_decide is blocked");

	const allowed = await rt.emitToolCall({ toolName: "watchdog_decide", toolCallId: "cs", input: {} });
	expect(allowed).toBeUndefined();

	await rt.settleAfterRun(); // settle the decision window
	const after = await rt.emitToolCall({ toolName: "bash", toolCallId: "c2", input: {} });
	expect(after).toBeUndefined();
});

it("the continue message is sent only after the decision turn settles, and still uses the fixed trigger line", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=delayed send", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(0); // not settled yet, so no continue message

	await rt.settleAfterRun();
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)[0].content).toBe(nudge("delayed send"));
});

it("the check turn's text is left in the session, since the watchdog reads only the tool call", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn opens

	// No stripping any more: text is not a signal, so the turn can say what it likes. It folds away with
	// the rest of the exchange, and it is the only record of why the model decided what it decided.
	const withText = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hmm", signature: "sig" },
			{ type: "text", text: "all done" },
		],
	};
	expect(await rt.emitMessageEnd(withText)).toBeUndefined();

	await rt.settleAfterRun({ role: "assistant", content: [], stopReason: "stop" }); // decision window closes
	const normal = { role: "assistant", content: [{ type: "text", text: "hi" }] };
	expect(await rt.emitMessageEnd(normal)).toBeUndefined(); // normal turns were never touched either
});

it("a user message saved mid-check voids the check even when no queue is left to hint at it", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	// A nudge is delivered as steer, so a message the user types is answered INSIDE the same run: by the time
	// the turn settles their queue is empty and hasPendingMessages() reads false. The saved user row is what
	// tells us they took over, so a stale "continue" answer must not put a continuation on top of their turn.
	await rt.emitMessageEnd({ role: "user", content: "actually, do this instead" });
	await rt.settleAfterRun({
		role: "assistant",
		content: [{ type: "toolCall", id: "wc5", name: "watchdog_decide", arguments: { decision: "continue" } }],
		stopReason: "toolUse",
	});

	expect(continuationMessages(rt)).toHaveLength(0); // the user is in charge, so the answer is void
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE)).toBe(true);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("a user interjection during the decision turn → the check is void, no continue message, the exchange still folds", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	rt.state.pendingMessages = 1; // the user queued one message
	await rt.settleAfterRun({
		role: "assistant",
		content: [{ type: "toolCall", id: "wc4", name: "watchdog_decide", arguments: { decision: "continue" } }],
		stopReason: "toolUse",
	});

	expect(continuationMessages(rt)).toHaveLength(0); // the user is in charge, so the answer is void
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE)).toBe(true);
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.some((m) => m.customType === DECISION_MESSAGE_TYPE)).toBe(false);

	// the watchdog is still running, and counts down again after the user's turn
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("running"))).toBe(true);
});
