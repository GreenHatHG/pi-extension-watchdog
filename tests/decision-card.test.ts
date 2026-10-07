import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	DECISION_ENTRY_TYPE,
	DECISION_MESSAGE,
	DECISION_MESSAGE_TYPE,
	DECISION_NOTE_MAX_CHARS,
	EMPTY_REPLY_NOTE,
} from "../src/constants.ts";
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

it("outcome continue drops one card with the note the AI passed to watchdog_decide", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	// The check hint is the visible nudge message; the result entry is a history record.
	expect(nudgeMessages(rt)[0]?.display).toBe(true);

	// A check turn answers only by calling the tool; the optional note is what the card shows.
	await rt.settleAfterRun({
		role: "assistant",
		content: [
			{ type: "text", text: "a paragraph of prose the card must ignore" },
			{
				type: "toolCall",
				id: "wc",
				name: "watchdog_decide",
				arguments: { decision: "continue", note: "still working on it" },
			},
		],
		stopReason: "toolUse",
	}); // settle → continue

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({
		outcome: "continue",
		reply: "still working on it",
		nudgeCount: 1,
		maxNudges: 50,
	});
});

it("when the AI stops the card says so and keeps the note; a wait gets its own label", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision turn

	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	// Nothing is saved yet: the turn may still say a closing line, and history holds one entry per exchange.
	expect(cards(rt)).toHaveLength(0);

	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({ outcome: "stop", decision: "done" });
	expect(cardView(rt, found[0]!).render(80).join("\n")).toContain("stopped on purpose");

	// "wait_user" stops exactly like "done"; only the label differs, and it says what to do next.
	const waiting = cardView(rt, {
		exchangeId: "w2",
		outcome: "stop",
		decision: "wait_user",
		nudgeCount: 1,
		maxNudges: 50,
		ts: 0,
	});
	expect(waiting.render(80).join("\n")).toContain("waiting on you");
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

it("the card truncates a note that ignores the one-line instruction", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);

	const long = "x".repeat(400);
	await rt.settleAfterRun({
		role: "assistant",
		content: [{ type: "toolCall", id: "wc", name: "watchdog_decide", arguments: { decision: "continue", note: long } }],
		stopReason: "toolUse",
	});

	const found = cards(rt);
	expect(found[0].reply).toHaveLength(DECISION_NOTE_MAX_CHARS);
	expect(found[0].reply).toBe(long.slice(0, DECISION_NOTE_MAX_CHARS));
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

it("the decision prompt names watchdog_decide as the only allowed tool, so it does not contradict itself", () => {
	expect(DECISION_MESSAGE).toContain("every tool except watchdog_decide is blocked");
});

it("the decision prompt says text is not an answer and names the three decisions", () => {
	// The check turn reads exactly one signal: the tool call. Saying so out loud is what stops the model
	// from writing its delivery into a channel that folds away, and gives "work remains" a real action.
	expect(DECISION_MESSAGE).toContain("Do not answer with text");
	expect(DECISION_MESSAGE).toContain('"continue" if work remains');
	expect(DECISION_MESSAGE).toContain('"done" if the task is finished');
	expect(DECISION_MESSAGE).toContain('"wait_user" if you are waiting on a user decision');
	// A model that answers "continue" must know the work happens next turn, not now.
	expect(DECISION_MESSAGE).toContain("This turn never does work");
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
	expect(collapsed).toContain("no watchdog_decide call from model");
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
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found[0]).toMatchObject({ outcome: "stop", suspended: true });
});

it("a once-mode stop card has no paused state", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	expect(cards(rt)[0]).toMatchObject({ outcome: "stop", suspended: false });
});

it("an abort the plugin did not fire is never touched, in or out of a decision window", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision window opens

	// The tool ends its turn with terminate now, so it never produces an empty "error" row, and a row that
	// does appear is always somebody else's: it must reach the card and the TUI unchanged.
	const real = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
	});
	expect(real).toBeUndefined(); // untouched, so the error still reaches the TUI

	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	const afterStop = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	expect(afterStop).toBeUndefined(); // same for anything landing after the stop answer
});

it("a user ESC (stopReason aborted) still reads as a user ESC, not as something the plugin did", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decision window opens

	// Our own paths end their turn with terminate, so an "aborted" row is the user's own ESC and has to keep
	// working: nothing rewrites the row, and runWasAborted still sees it.
	const escaped = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Operation aborted",
	});
	expect(escaped).toBeUndefined(); // untouched, so runWasAborted still sees "aborted"
});

it("watchdog_decide's tool lines render empty (renderShell:self plus empty renderCall/renderResult)", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx); // lazy tool registration
	const tool = rt.tools.get("watchdog_decide");
	expect(tool.renderShell).toBe("self");
	const ctxArg = { args: {}, toolCallId: "t1", state: {}, expanded: false, isPartial: false };
	expect(tool.renderCall({}, theme, ctxArg).render(80)).toEqual([]);
	expect(
		tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: false }, theme, ctxArg).render(80),
	).toEqual([]);
});
