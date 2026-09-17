import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nudgeText as nudge } from "../index.ts";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("AI 调用 stop_watchdog（once 模式）→ 彻底停止，工具常驻不移出", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=工具测试", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.at(-1)).toBe(nudge("工具测试")); // 停止前已催促过一次

	const result = await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("OK.");

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages.at(-1)).toBe(nudge("工具测试")); // 停止后不再催促
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // 常驻注册：工具始终保留，不再随启停移出
});

it("未运行时调用 stop_watchdog 返回无需停止", async () => {
	const rt = await setup();
	const result = await rt.tools.get("stop_watchdog").execute("t0", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("not running");
});

it("挂起状态下再调 stop_watchdog → 返回已挂起，状态不变", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=重复停止", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t2", {}, undefined, undefined, rt.ctx); // 挂起

	const result = await rt.tools.get("stop_watchdog").execute("t3", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(result.content)).toContain("Already suspended");
	await rt.commands.get("watchdog").handler("status", rt.ctx); // 状态仍是挂起，未被二次调用破坏
	expect(rt.notifications.some((n) => n.msg.includes("挂起中"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
