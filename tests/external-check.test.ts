import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExternalCheckEvent } from "../src/constants.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});

afterEach(() => {
	delete process.env.PI_WATCHDOG;
	vi.useRealTimers();
});

const startAndSettle = async (rt: Awaited<ReturnType<typeof setup>>) => {
	await rt.commands.get("watchdog").handler("timeout=10", rt.ctx);
	// First run: no countdown before it, so the settle is what arms the timer.
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(10_000);
};

it("an external continue answer replaces the model check and sends the message instead", async () => {
	const rt = await setup();
	let answered = false;
	rt.pi.events.on("watchdog:check", (event: ExternalCheckEvent) => {
		if (answered) return;
		answered = true;
		event.answer = { decision: "continue", message: "you still owe a commit" };
	});
	await startAndSettle(rt);

	// No decision check went to the model; the external message went out instead.
	expect(nudgeMessages(rt)).toHaveLength(0);
	const conts = continuationMessages(rt);
	expect(conts).toHaveLength(1);
	expect(conts[0].content).toBe("you still owe a commit");
	expect(conts[0].options?.triggerTurn).toBe(true);
});

it("an external done answer stops the watchdog without any model check", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));
	rt.pi.events.on("watchdog:check", (event: ExternalCheckEvent) => {
		event.answer = { decision: "done" };
	});
	await startAndSettle(rt);

	expect(nudgeMessages(rt)).toHaveLength(0);
	expect(continuationMessages(rt)).toHaveLength(0);
	expect(states.at(-1)).toMatchObject({ running: false });
});

it("no external answer keeps the built-in model check", async () => {
	const rt = await setup();
	rt.pi.events.on("watchdog:check", () => undefined);
	await startAndSettle(rt);

	// The normal decision message went out, no external continuation did.
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(0);
});

it("an invalid answer is ignored and the built-in check runs", async () => {
	const rt = await setup();
	rt.pi.events.on("watchdog:check", (event: ExternalCheckEvent) => {
		event.answer = { decision: "wait_user" } as any;
	});
	await startAndSettle(rt);

	expect(nudgeMessages(rt)).toHaveLength(1);
});

it("the answer is one shot: the next countdown asks again", async () => {
	const rt = await setup();
	let calls = 0;
	rt.pi.events.on("watchdog:check", (event: ExternalCheckEvent) => {
		calls += 1;
		if (calls === 1) event.answer = { decision: "continue", message: "first" };
	});
	await startAndSettle(rt);

	// First nudge: external answer; its continuation started a work turn. That turn settles,
	// the countdown re-arms: the second nudge asks again, nobody answers, the model check goes out.
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(10_000);

	expect(calls).toBe(2);
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(1);
});

it("watchdog:stopped fires when the nudge cap is hit", async () => {
	const rt = await setup();
	const stops: any[] = [];
	rt.pi.events.on("watchdog:stopped", (s: unknown) => stops.push(s));
	await rt.commands.get("watchdog").handler("timeout=10 max=2", rt.ctx);
	await rt.settleAfterRun();
	// Three unanswered checks burn the max=2 budget: fire 1 (nudge 1), fire 2 (nudge 2),
	// then fire 3 spends nudge 3 over the cap and the auto-stop runs.
	for (let i = 0; i < 3; i++) {
		await vi.advanceTimersByTimeAsync(10_000);
		await rt.settleAfterRun({
			role: "assistant",
			content: [],
			stopReason: "stop",
		});
	}
	expect(stops).toHaveLength(1);
	expect(stops[0]).toMatchObject({ reason: "max-reached", nudgeCount: 3, maxNudges: 2 });
	expect(nudgeMessages(rt)).toHaveLength(2);
});

it("watchdog:stopped fires on /watchdog stop; an AI stop in keep mode fires too, with suspended=true", async () => {
	const rt = await setup();
	const stops: any[] = [];
	rt.pi.events.on("watchdog:stopped", (s: unknown) => stops.push(s));
	await rt.commands.get("watchdog").handler("timeout=10 mode=keep", rt.ctx);
	// AI calls watchdog_decide("done") outside a check: keep mode suspends (a nap), but the done
	// signal still fires — "the AI declared done" and "monitoring sleeps" are separate facts, and
	// consumers (e.g. a verification gate) need the first even when the watchdog naps.
	await rt.tools.get("watchdog_decide").execute("p1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(stops).toHaveLength(1);
	expect(stops[0]).toMatchObject({ reason: "ai-stop", suspended: true });

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(stops).toHaveLength(2);
	expect(stops[1]).toMatchObject({ reason: "manual", suspended: false });
});

it("an AI stop in once mode fires watchdog:stopped with suspended=false", async () => {
	const rt = await setup();
	const stops: any[] = [];
	rt.pi.events.on("watchdog:stopped", (s: unknown) => stops.push(s));
	await rt.commands.get("watchdog").handler("timeout=10", rt.ctx);
	await rt.tools.get("watchdog_decide").execute("p1", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(stops).toHaveLength(1);
	expect(stops[0]).toMatchObject({ reason: "ai-stop", suspended: false });
});
