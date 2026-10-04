import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CONTINUATION_MESSAGE_TYPE,
	DECISION_MESSAGE,
	DECISION_MESSAGE_TYPE,
	FOLD_MESSAGE_TYPE,
	continuationText as nudge,
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
const stopMarker = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: FOLD_MESSAGE_TYPE,
	content: "",
	display: false,
	details: { exchangeId, outcome: "stop" },
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
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
			{ type: "text", text: "done" },
		]),
		toolResult("c1", "edit"),
		toolResult("cs", "stop_watchdog"),
		stopMarker(),
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
		stopMarker("e2"),
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

it("context hook: after the AI calls stop_watchdog the whole decision exchange is removed", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=stop fold", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun(); // decision turn ends → stop fold marker

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.filter((m) => m.role === "custom")).toHaveLength(0);
});

it("inside the decision window every tool but stop_watchdog is blocked; after settling they pass again", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn opens

	const blocked = await rt.emitToolCall({ toolName: "bash", toolCallId: "c1", input: {} });
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("tools are blocked");

	const allowed = await rt.emitToolCall({ toolName: "stop_watchdog", toolCallId: "cs", input: {} });
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

it("the decision turn's model reply is cleared before saving; with a tool call only the tool call block stays", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn opens

	const ack = { role: "assistant", content: [{ type: "text", text: "ok, continuing" }], stopReason: "stop" };
	const replaced = await rt.emitMessageEnd(ack);
	expect(replaced?.message.content).toEqual([]);

	const withTool = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "need to wrap up", signature: "sig" },
			{ type: "text", text: "all done" },
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
		],
	};
	const replacedWithTool = await rt.emitMessageEnd(withTool);
	expect(replacedWithTool?.message.content).toEqual([
		{ type: "thinking", thinking: "need to wrap up", signature: "sig" },
		{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
	]); // only text is stripped; toolCall / thinking stay (pairing and signature)

	await rt.settleAfterRun(); // decision window closes
	const normal = { role: "assistant", content: [{ type: "text", text: "hi" }] };
	expect(await rt.emitMessageEnd(normal)).toBeUndefined(); // normal turns are untouched again
});

it("a user interjection during the decision turn → the check is void, no continue message, the exchange still folds", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	rt.state.pendingMessages = 1; // the user queued one message
	await rt.settleAfterRun();

	expect(continuationMessages(rt)).toHaveLength(0);
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE)).toBe(true);
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.some((m) => m.customType === DECISION_MESSAGE_TYPE)).toBe(false);

	// the watchdog is still running, and counts down again after the user's turn
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("running"))).toBe(true);
});
