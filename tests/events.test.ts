import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});

afterEach(() => {
	delete process.env.PI_WATCHDOG;
	vi.useRealTimers();
});

it("publishes start/stop state and answers a state query", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (state: unknown) => states.push(state));

	rt.pi.events.emit("watchdog:state:query");
	expect(states.at(-1)).toMatchObject({ running: false, suspended: false });

	await rt.commands.get("watchdog").handler("timeout=10 mode=keep", rt.ctx);
	expect(states.at(-1)).toMatchObject({
		running: true,
		suspended: false,
		keepAlive: true,
		timeoutMs: 10_000,
	});

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(states.at(-1)).toMatchObject({ running: false, suspended: false, keepAlive: false });
});

it("keep mode pause publishes running=false; a new user message brings it back to true", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (state: unknown) => states.push(state));

	await rt.commands.get("watchdog").handler("timeout=10 mode=keep", rt.ctx);
	await rt.tools.get("watchdog_decide").execute("stop", { decision: "done" }, undefined, undefined, rt.ctx);
	expect(states.at(-1)).toMatchObject({ running: false, suspended: true, keepAlive: true });

	await rt.emit("input", { text: "next task", source: "interactive" });
	expect(states.at(-1)).toMatchObject({ running: true, suspended: false, keepAlive: true });
});

it("a reload shutdown does not broadcast a momentary false", async () => {
	process.env.PI_WATCHDOG = "timeout=10 mode=keep";
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (state: unknown) => states.push(state));

	await rt.emit("session_start", { reason: "startup" });
	expect(states.at(-1)?.running).toBe(true);
	const count = states.length;

	await rt.emit("session_shutdown", { reason: "reload" });
	expect(states).toHaveLength(count);
});

it("session replacement (/clear): starts with the new ctx after the old one goes stale, without touching the old one", async () => {
	process.env.PI_WATCHDOG = "timeout=10";
	const rt = await setup();
	// the old session starts, activeCtx points at it
	await rt.emit("session_start", { reason: "startup" });

	// pi lifecycle: the old ctx is still valid during old-session shutdown; then it goes stale and the new session brings a new ctx.
	await rt.emit("session_shutdown", { reason: "new" });
	Object.defineProperty(rt.ctx, "ui", {
		configurable: true,
		get() {
			throw new Error("stale extension ctx");
		},
	});

	const replacementCtx = rt.makeCtx();
	await expect(rt.emit("session_start", { reason: "new" }, replacementCtx)).resolves.toBeUndefined();
	expect(rt.statusBars.get("watchdog")).toBeDefined();
});
