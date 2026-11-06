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

/**
 * pi keeps the extension module cached for the whole process and only re-runs its factory for a new
 * session, so a module-scope "already registered" flag leaks into the next session and skips
 * registration there. Without resetModules every setup() stands in for one more session in the same
 * process: the module is imported once, the factory runs again with a fresh empty tool table.
 */
it("every session in the same process gets watchdog_decide registered", async () => {
	// A cached module, like real pi: imported once, reused by the second factory run below.
	const { default: watchdog } = await import("../index.ts");

	// vi.resetModules() would hand out a fresh module, which is the very thing that hid this bug.
	vi.resetModules = () => {};

	const first = await setup();
	await first.commands.get("watchdog").handler("timeout=60", first.ctx);
	expect(first.tools.has("watchdog_decide")).toBe(true);

	// Second session of the same process: new session, new empty tool table, same cached module.
	const second = await setup();
	await second.commands.get("watchdog").handler("timeout=60", second.ctx);
	expect(second.tools.has("watchdog_decide")).toBe(true);
	expect(watchdog).toBeTypeOf("function"); // the module really was reused, not re-imported
});

it("a tick on a ctx from a replaced session stops the watchdog instead of killing pi", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));
	await rt.commands.get("watchdog").handler("timeout=60", rt.ctx);

	// Replacement invalidates the old ctx; if our shutdown hook never reached the ticker, it keeps the dead
	// ctx and an uncaught throw from the next paint takes the whole pi process down.
	Object.defineProperty(rt.ctx, "ui", {
		configurable: true,
		get() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});

	expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
	rt.pi.events.emit("watchdog:state:query");
	expect(states.at(-1)).toMatchObject({ running: false, countdownArmed: false });
});
