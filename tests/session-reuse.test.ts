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
it("every session in the same process gets stop_watchdog registered", async () => {
	// A cached module, like real pi: imported once, reused by the second factory run below.
	const { default: watchdog } = await import("../index.ts");

	// vi.resetModules() would hand out a fresh module, which is the very thing that hid this bug.
	vi.resetModules = () => {};

	const first = await setup();
	await first.commands.get("watchdog").handler("timeout=60", first.ctx);
	expect(first.tools.has("stop_watchdog")).toBe(true);

	// Second session of the same process: new session, new empty tool table, same cached module.
	const second = await setup();
	await second.commands.get("watchdog").handler("timeout=60", second.ctx);
	expect(second.tools.has("stop_watchdog")).toBe(true);
	expect(watchdog).toBeTypeOf("function"); // the module really was reused, not re-imported
});
