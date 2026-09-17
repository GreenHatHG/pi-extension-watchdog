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

it("PI_WATCHDOG 合法配置：session_start 自动启动，超时后用自定义文案催促", async () => {
	process.env.PI_WATCHDOG = "timeout=1 message=环境变量文案";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("监控已启动"))).toBe(true);

	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages.at(-1)).toBe(nudge("环境变量文案"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("PI_WATCHDOG=0 时不自动启动（工具常驻，仅状态不启动）", async () => {
	process.env.PI_WATCHDOG = "0";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications).toHaveLength(0);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // 常驻注册：工具始终保留，不再随启停移出
});

it("PI_WATCHDOG 非法格式：明确提示，不静默，不启动", async () => {
	process.env.PI_WATCHDOG = "30:100|旧DSL";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("PI_WATCHDOG 格式无效"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // 常驻注册：工具始终保留，不再随启停移出
});

it("PI_WATCHDOG=1 使用默认参数（60s）", async () => {
	process.env.PI_WATCHDOG = "1";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("监控已启动") && n.msg.includes("空闲 60s"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
