import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("keep 模式：超时催促 → AI 调 stop_watchdog 仅挂起 → interactive 新消息自动恢复", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=常驻测试", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.filter((m) => m === "常驻测试")).toHaveLength(1);

	// AI 调用 stop_watchdog → 挂起而非关闭
	const r = await rt.tools.get("stop_watchdog").execute("t10", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(r.content)).toContain("挂起");
	expect(rt.activeTools.has("stop_watchdog")).toBe(true);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages.filter((m) => m === "常驻测试")).toHaveLength(1); // 挂起期间不催促

	// 用户发新消息 → 自动恢复
	await rt.emit("input", { text: "新任务", source: "interactive" });
	expect(rt.notifications.some((n) => n.msg.includes("已恢复"))).toBe(true);
	await vi.advanceTimersByTimeAsync(1200);
	expect(rt.sentMessages.filter((m) => m === "常驻测试")).toHaveLength(2);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("keep 模式：extension 来源的 input 不触发恢复", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=常驻测试2", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t10b", {}, undefined, undefined, rt.ctx); // 挂起
	await rt.settleAfterRun();

	await rt.emit("input", { text: "催促消息", source: "extension" });
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("挂起中"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("keep 模式：运行中手动 stop 也彻底停止，新消息不唤醒", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=常驻测试3", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("监控已停止"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false);

	await rt.emit("input", { text: "普通消息", source: "interactive" });
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);
});

it("keep 模式：挂起中手动 stop → 彻底关闭", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=常驻测试4", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t10c", {}, undefined, undefined, rt.ctx); // 挂起
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("挂起中"))).toBe(true);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("已彻底关闭"))).toBe(true);
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);
});

it("keep 模式：达到 max 上限 → 兕底彻底关闭，新消息不恢复", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=1 mode=keep message=常驻上限", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.filter((m) => m === "常驻上限")).toHaveLength(1);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 第 2 次被拦截，常驻也彻底关闭
	expect(rt.sentMessages.filter((m) => m === "常驻上限")).toHaveLength(1);
	expect(rt.notifications.some((n) => n.msg.includes("已自动停止"))).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false);

	await rt.emit("input", { text: "新任务", source: "interactive" }); // 不再恢复
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);
});

it("PI_WATCHDOG mode=keep：自动以常驻模式启动，挂起后新消息恢复", async () => {
	process.env.PI_WATCHDOG = "timeout=1 mode=keep message=常驻env文案";
	const rt = await setup();
	await rt.emit("session_start", { reason: "startup" });
	expect(rt.notifications.some((n) => n.msg.includes("常驻模式") && n.msg.includes("监控已启动"))).toBe(true);

	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages.at(-1)).toBe("常驻env文案");

	const r = await rt.tools.get("stop_watchdog").execute("t11", {}, undefined, undefined, rt.ctx);
	expect(JSON.stringify(r.content)).toContain("挂起");

	await rt.emit("input", { text: "继续新任务", source: "interactive" });
	expect(rt.notifications.some((n) => n.msg.includes("已恢复"))).toBe(true);
	await rt.settleAfterRun(); // 恢复消息触发的一轮运行结束
	await vi.advanceTimersByTimeAsync(2300); // ticker 恢复倒计时（≤1s）+ 超时 1s
	expect(rt.sentMessages.filter((m) => m === "常驻env文案").length).toBeGreaterThanOrEqual(2);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false);
});
