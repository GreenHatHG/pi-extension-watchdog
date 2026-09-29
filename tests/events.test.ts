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

it("发布启动、停止状态并响应状态查询", async () => {
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

it("keep 模式挂起发布 running=false，新用户消息恢复为 true", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (state: unknown) => states.push(state));

	await rt.commands.get("watchdog").handler("timeout=10 mode=keep", rt.ctx);
	await rt.tools.get("stop_watchdog").execute("stop", {}, undefined, undefined, rt.ctx);
	expect(states.at(-1)).toMatchObject({ running: false, suspended: true, keepAlive: true });

	await rt.emit("input", { text: "下一项任务", source: "interactive" });
	expect(states.at(-1)).toMatchObject({ running: true, suspended: false, keepAlive: true });
});

it("reload shutdown 不广播瞬时 false", async () => {
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
