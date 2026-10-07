import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup } from "./helpers/setup.js";

const exitFile = join(tmpdir(), `pi-watchdog-on-stop-${process.pid}.test`);

beforeEach(() => {
	rmSync(exitFile, { force: true });
});
afterEach(() => {
	rmSync(exitFile, { force: true });
	delete process.env.PI_WATCHDOG_ON_STOP;
});

/** Poll until the hook file shows up (spawn is an async detached process, so there is no callback to await). */
async function waitForFile(ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (existsSync(exitFile)) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return false;
}

it("watchdog_decide fires the PI_WATCHDOG_ON_STOP hook (writes the exit file)", async () => {
	process.env.PI_WATCHDOG = "timeout=60";
	process.env.PI_WATCHDOG_ON_STOP = `echo 0 > ${exitFile}`;
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });

	// after one nudge the AI calls watchdog_decide
	await vi.advanceTimersByTimeAsync(61_000);
	await rt.settleAfterRun();
	vi.useRealTimers(); // polling and the child process both need the real clock
	const tool = rt.tools.get("watchdog_decide");
	expect(tool).toBeDefined();
	await tool.execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);

	expect(await waitForFile()).toBe(true);
	expect(readFileSync(exitFile, "utf8").trim()).toBe("0");
});

it("with no PI_WATCHDOG_ON_STOP, no hook runs", async () => {
	process.env.PI_WATCHDOG = "timeout=60";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	await rt.settleAfterRun();
	vi.useRealTimers();
	await rt.tools.get("watchdog_decide").execute("t1", { decision: "done" }, undefined, undefined, rt.ctx);
	await new Promise((r) => setTimeout(r, 100));
	expect(existsSync(exitFile)).toBe(false);
});
