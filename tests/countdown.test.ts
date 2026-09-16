import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup } from "./helpers/setup.js";

const DEFAULT_MSG = "若任务已全部完成，请调用 stop_watchdog 工具停止自动继续，否则继续执行";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("首次启动且会话无消息 → 不倒计时，等首轮 agent_settled 后才开始，用默认文案", async () => {
	const rt = await setup();
	rt.sessionEntries.length = 0; // 模拟全新会话
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true); // 启动后工具激活

	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages.filter((m) => m === DEFAULT_MSG)).toHaveLength(0); // 无消息时不催促
	expect(rt.notifications.some((n) => n.msg.includes("暂无消息"))).toBe(true);

	await rt.settleAfterRun(); // AI 第一轮结束 → 开始倒计时
	await vi.advanceTimersByTimeAsync(1200);
	expect(rt.sentMessages.filter((m) => m === DEFAULT_MSG)).toHaveLength(1);

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.activeTools.has("stop_watchdog")).toBe(false); // 停止后工具移出 active tools
});

it("AI 运行中不催促；停止后重新倒计时再催促", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=测试继续", rt.ctx);
	await rt.settleAfterRun();

	await rt.emit("agent_start");
	await vi.advanceTimersByTimeAsync(1200);
	expect(rt.sentMessages).not.toContain("测试继续"); // 运行期间不催促

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(600);
	await rt.emit("agent_start"); // AI 又跑一下（倒计时被取消重建）
	await vi.advanceTimersByTimeAsync(600);
	expect(rt.sentMessages).not.toContain("测试继续");

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.at(-1)).toBe("测试继续");
	expect(rt.state.idle).toBe(false); // 发送后模拟 AI 开始运行
});

it("max= 次数上限：达到后自动停止并通知", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=上限测试", rt.ctx);
	for (let i = 0; i < 2; i++) {
		await rt.settleAfterRun();
		await vi.advanceTimersByTimeAsync(1100);
	}
	expect(rt.sentMessages.filter((m) => m === "上限测试")).toHaveLength(2);

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 第 3 次应被拦截并自动停止
	expect(rt.sentMessages.filter((m) => m === "上限测试")).toHaveLength(2);
	expect(rt.notifications.some((n) => n.msg.includes("已自动停止"))).toBe(true);
});

it("手动 stop 后不再催促；status 正确反映运行/未运行状态", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=手动测试", rt.ctx);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	await vi.advanceTimersByTimeAsync(1200);
	expect(rt.sentMessages).not.toContain("手动测试");

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);

	await rt.commands.get("watchdog").handler("", rt.ctx); // 无参数 = 默认参数启动
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("运行中"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("status 细分：倒计时中 / 输入暂停 / 操作暂停 / 等待 AI 空闲", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60 message=状态测试", rt.ctx);

	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("后催促"))).toBe(true);

	rt.state.editorText = "草稿"; // 编辑器有未发送文字 → ticker 轮询后暂停
	await vi.advanceTimersByTimeAsync(1100);
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("输入中暂停"))).toBe(true);

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100); // 超过按键宽限期，ticker 恢复倒计时
	rt.pressKey(); // 倒计时中按键 → 立即进入操作暂停
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("操作中暂停"))).toBe(true);

	await rt.emit("agent_start"); // AI 运行中 → 等待空闲
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("等待 AI 空闲"))).toBe(true);
});

it("运行中重新 /watchdog：重置参数、文案与催促计数，旧倒计时不残留", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=5 message=旧文案", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.filter((m) => m === "旧文案")).toHaveLength(1); // 已催 1 次

	await rt.commands.get("watchdog").handler("timeout=1 message=新文案", rt.ctx); // 运行中重入
	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("已催 0/"))).toBe(true); // 计数清零
	expect(rt.notifications.some((n) => n.msg.includes("已催 0/5"))).toBe(true); // 未指定 max 时沿用旧值

	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1200);
	expect(rt.sentMessages.filter((m) => m === "旧文案")).toHaveLength(1); // 旧参数/旧计时器已清
	expect(rt.sentMessages.filter((m) => m === "新文案")).toHaveLength(1);
});
