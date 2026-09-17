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

it("倒计时中用户开始输入 → 暂停；清空后恢复并催促", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=输入测试", rt.ctx);
	await rt.settleAfterRun();

	rt.state.editorText = "我先打点字";
	await vi.advanceTimersByTimeAsync(1400);
	expect(rt.sentMessages).not.toContain("输入测试");

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100); // ticker 先轮询恢复（≤1s）+ 完整超时 1s
	expect(rt.sentMessages.at(-1)).toBe(nudge("输入测试"));
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("agent_settled 时编辑器已有文字 → 暂停不催促；清空后恢复", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=输入测试2", rt.ctx);
	rt.state.editorText = "还剩一点没删完";
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages).not.toContain("输入测试2");

	rt.state.editorText = "";
	await vi.advanceTimersByTimeAsync(2100);
	expect(rt.sentMessages.at(-1)).toBe(nudge("输入测试2"));
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("倒计时中按键操作 → 立即暂停；操作停止（2s grace）后恢复催促", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=操作测试", rt.ctx);
	await rt.settleAfterRun();

	rt.pressKey();
	await vi.advanceTimersByTimeAsync(1400);
	expect(rt.sentMessages).not.toContain("操作测试");

	await vi.advanceTimersByTimeAsync(3000); // 2s grace 过去 → ticker 恢复倒计时 → 超时催促
	expect(rt.sentMessages.at(-1)).toBe(nudge("操作测试"));
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("agent_settled 时用户刚按过键 → 暂停不倒计时", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=操作测试2", rt.ctx);
	rt.pressKey();
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1300);
	expect(rt.sentMessages).not.toContain("操作测试2");
});
