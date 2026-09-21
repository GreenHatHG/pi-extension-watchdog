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

/** 轮询等钩子文件出现（spawn 是异步分离进程，无回调可 await） */
async function waitForFile(ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (existsSync(exitFile)) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return false;
}

it("stop_watchdog 触发 PI_WATCHDOG_ON_STOP 钩子（写 exit 文件）", async () => {
	process.env.PI_WATCHDOG = "timeout=60";
	process.env.PI_WATCHDOG_ON_STOP = `echo 0 > ${exitFile}`;
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });

	// 催促一轮后 AI 调 stop_watchdog
	await vi.advanceTimersByTimeAsync(61_000);
	await rt.settleAfterRun();
	vi.useRealTimers(); // 轮询与子进程都依赖真实时钟
	const tool = rt.tools.get("stop_watchdog");
	expect(tool).toBeDefined();
	await tool.execute("t1", {}, undefined, undefined, rt.ctx);

	expect(await waitForFile()).toBe(true);
	expect(readFileSync(exitFile, "utf8").trim()).toBe("0");
});

it("未设置 PI_WATCHDOG_ON_STOP 时不执行任何钩子", async () => {
	process.env.PI_WATCHDOG = "timeout=60";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	await rt.settleAfterRun();
	vi.useRealTimers();
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await new Promise((r) => setTimeout(r, 100));
	expect(existsSync(exitFile)).toBe(false);
});
