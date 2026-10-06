import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, DECISION_MESSAGE, DECISION_MESSAGE_TYPE, EMPTY_REPLY_NOTE } from "../src/constants.ts";
import type { DecisionCardData } from "../src/decision-card.ts";
import { nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

/** Decision cards saved so far (the CustomEntry rows from appendEntry). */
const cards = (rt: { entries: { customType: string; data: any }[] }) =>
	rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as DecisionCardData);

/** In tests the theme degrades to the identity function. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const clickLeft = {
	type: "click",
	button: "left",
	x: 0,
	y: 0,
	screenX: 0,
	screenY: 0,
	width: 80,
	height: 3,
	shift: false,
	alt: false,
	ctrl: false,
};

/** Render a nudge row the way the TUI does: one component, rendered through the renderer. */
const hintView = (
	rt: { messageRenderers: Map<string, any> },
	message: { content: string; details: { exchangeId: string } },
	expanded = false,
) => rt.messageRenderers.get(DECISION_MESSAGE_TYPE)!(message, { expanded }, theme);

/** Render a saved decision card. */
const cardView = (rt: { entryRenderers: Map<string, any> }, data: DecisionCardData, entryId = "e1", expanded = false) =>
	rt.entryRenderers.get(DECISION_ENTRY_TYPE)!(
		{ id: entryId, customType: DECISION_ENTRY_TYPE, data } as any,
		{ expanded },
		theme,
	);

it("outcome continue drops one card with the AI reply", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	// The check hint is the visible nudge message; the result entry is a history record.
	expect(nudgeMessages(rt)[0]?.display).toBe(true);

	await rt.settleAfterRun({ role: "assistant", content: [{ type: "text", text: "still working on it" }] }); // settle → continue

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({
		outcome: "continue",
		reply: "still working on it",
		nudgeCount: 1,
		maxNudges: 50,
	});
});

it("when the AI calls stop_watchdog the card says stopped on purpose and keeps the extra text", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	// Nothing is saved yet: the turn may still say a closing line, and history holds one entry per exchange.
	expect(cards(rt)).toHaveLength(0);

	// Extra text in the same message as the tool call lands in that entry, not a second one.
	await rt.settleAfterRun({
		role: "assistant",
		content: [
			{ type: "text", text: "all done" },
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
		],
		stopReason: "toolUse",
	}); // settle → stop

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({ outcome: "stop", reply: "all done" });
});

it("when the user takes over the card says superseded, not stop", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	rt.state.pendingMessages = 1; // the user queued one message
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0].outcome).toBe("superseded");
});

it("a very long AI reply is cut to the cap before saving", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);

	const long = "x".repeat(400);
	await rt.settleAfterRun({ role: "assistant", content: [{ type: "text", text: long }] });

	const found = cards(rt);
	expect(found[0].reply).toHaveLength(300);
	expect(found[0].reply).toBe(long.slice(0, 300));
});

it("the nudge message renders as a collapsed hint and shows the prompt only when expanded", async () => {
	const rt = await setup();
	const renderer = rt.messageRenderers.get(DECISION_MESSAGE_TYPE);
	expect(renderer).toBeTypeOf("function");

	const message = { content: DECISION_MESSAGE, details: { exchangeId: "w1" } };
	const collapsed = renderer!(message, { expanded: false }, theme).render(80).join("\n");
	expect(collapsed).toContain("watchdog:"); // each card names its plugin
	expect(collapsed).toContain("Sending decision message");
	expect(collapsed).not.toContain("Watchdog check");

	const expanded = renderer!(message, { expanded: true }, theme).render(80).join("\n");
	expect(expanded).toContain("watchdog:");
	expect(expanded).toContain("Watchdog check");
});

it("the decision prompt names stop_watchdog as the only allowed tool, so it does not contradict itself", () => {
	expect(DECISION_MESSAGE).toContain("every tool except stop_watchdog is blocked");
});

it("the decision prompt spells out that text means still working, so a 'done' reply is not read as done", () => {
	// The check turn has no other channel: the model has to know that answering with words buys another
	// work turn, or "all done, here is the report again" costs a round and repeats itself.
	expect(DECISION_MESSAGE).toContain('text reply is read as "work remains"');
	expect(DECISION_MESSAGE).toContain("never restate");
});

it("in fullscreen the hint expands on click and collapses on a second click", async () => {
	const rt = await setup();
	const message = { content: DECISION_MESSAGE, details: { exchangeId: "click-1" } };
	const view = hintView(rt, message);

	expect(view.render(80).join("\n")).toContain("Sending decision message");
	expect(view.render(80).join("\n")).not.toContain("Watchdog check");
	view.handleMouse(clickLeft);
	expect(view.render(80).join("\n")).toContain("Watchdog check");
	view.handleMouse(clickLeft);
	expect(view.render(80).join("\n")).not.toContain("Watchdog check");
});

it("the saved card renders its outcome collapsed and the AI reply only when expanded", async () => {
	const rt = await setup();
	const data: DecisionCardData = {
		exchangeId: "w1",
		outcome: "continue",
		reply: "still working on the parser",
		nudgeCount: 2,
		maxNudges: 50,
		ts: 0,
	};

	const collapsed = cardView(rt, data).render(80).join("\n");
	expect(collapsed).toContain("watchdog:"); // every card names its plugin, even result rows
	expect(collapsed).toContain("still working");
	expect(collapsed).toContain("click to expand");
	expect(collapsed).not.toContain("still working on the parser"); // the reply is what the timeline never showed

	const expanded = cardView(rt, data, "e1", true).render(80).join("\n");
	expect(expanded).toContain("still working on the parser");
});

it("the card shows the stop outcome, a paused note in keep mode, and a reply only when there is one", async () => {
	const rt = await setup();
	const base: DecisionCardData = { exchangeId: "w1", outcome: "stop", nudgeCount: 3, maxNudges: 50, ts: 0 };

	const paused = cardView(rt, { ...base, suspended: true })
		.render(80)
		.join("\n");
	expect(paused).toContain("stopped on purpose");
	expect(paused).toContain("monitoring paused");
	// No reply means nothing to expand, so the row carries no toggle.
	expect(paused).not.toContain("click to expand");

	const withReply = cardView(rt, { ...base, reply: "wrapping up" })
		.render(80)
		.join("\n");
	expect(withReply).toContain("click to expand");
});

it("an empty reply renders its own outcome and explains itself when expanded", async () => {
	const rt = await setup();
	const data: DecisionCardData = {
		exchangeId: "w1",
		outcome: "empty",
		reply: EMPTY_REPLY_NOTE,
		nudgeCount: 1,
		maxNudges: 50,
		ts: 0,
	};

	// The row must not claim the model is "still working": it said nothing at all.
	const collapsed = cardView(rt, data).render(80).join("\n");
	expect(collapsed).toContain("empty reply from model");
	expect(collapsed).not.toContain("still working");
	expect(collapsed).toContain("click to expand");
	expect(collapsed).not.toContain(EMPTY_REPLY_NOTE);

	// Width 200 keeps the note on one line, so the assertion is about content, not wrapping.
	const expanded = cardView(rt, data, "e1", true).render(200).join("\n");
	expect(expanded).toContain(EMPTY_REPLY_NOTE);
});

it("a proactive stop card names the missing check instead of making one up", async () => {
	const rt = await setup();
	const data: DecisionCardData = {
		exchangeId: "w1",
		outcome: "stop",
		proactive: true,
		suspended: true,
		nudgeCount: 0,
		maxNudges: 50,
		ts: 0,
	};

	const view = cardView(rt, data).render(80).join("\n");
	expect(view).toContain("stopped on purpose");
	expect(view).toContain("monitoring paused");
	expect(view).toContain("no check"); // this stop came from no check turn, so do not imply one
});

it("clicking a card expands it, and the open state survives a rebuilt component", async () => {
	const rt = await setup();
	const data: DecisionCardData = {
		exchangeId: "w1",
		outcome: "continue",
		reply: "no work remains",
		nudgeCount: 1,
		maxNudges: 50,
		ts: 0,
	};

	const view = cardView(rt, data, "e1");
	expect(view.render(80).join("\n")).not.toContain("no work remains");
	view.handleMouse(clickLeft);
	expect(view.render(80).join("\n")).toContain("no work remains");

	// A theme change builds a new component; the remembered open set has to bring the reply back.
	const rebuilt = cardView(rt, data, "e1");
	expect(rebuilt.render(80).join("\n")).toContain("no work remains");
	rebuilt.handleMouse(clickLeft);
	expect(rebuilt.render(80).join("\n")).not.toContain("no work remains");
});

it("a keep-mode stop still records the paused state in history", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found[0]).toMatchObject({ outcome: "stop", suspended: true });
});

it("a once-mode stop card has no paused state", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	expect(cards(rt)[0]).toMatchObject({ outcome: "stop", suspended: false });
});

it("the stopReason error message left by stop_watchdog's abort is cleared inside the decision window", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision window opens

	// a real error in the decision window must not be swallowed: it stays when stop_watchdog was not called
	const real = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
	});
	expect(real.message.stopReason).toBe("error");
	expect(real.message.errorMessage).toBe("boom");

	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	const phantom = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	expect(phantom.message.stopReason).toBe("stop");
	expect(phantom.message.content).toEqual([]);
	expect(phantom.message.errorMessage).toBeUndefined();
});

it("a user ESC (stopReason aborted) is not rewritten, so runWasAborted still works", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision window opens

	// after a user interjection they press ESC themselves: the stopCalled branch must not touch this
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	const escaped = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Operation aborted",
	});
	expect(escaped.message.stopReason).toBe("aborted");
	expect(escaped.message.errorMessage).toBe("Operation aborted");
});

it("stop_watchdog's tool lines render empty (renderShell:self plus empty renderCall/renderResult)", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx); // lazy tool registration
	const tool = rt.tools.get("stop_watchdog");
	expect(tool.renderShell).toBe("self");
	const ctxArg = { args: {}, toolCallId: "t1", state: {}, expanded: false, isPartial: false };
	expect(tool.renderCall({}, theme, ctxArg).render(80)).toEqual([]);
	expect(
		tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: false }, theme, ctxArg).render(80),
	).toEqual([]);
});
