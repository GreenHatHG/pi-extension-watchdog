import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, type DecisionCardData } from "../index.ts";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

/** 已落盘的决策卡片（appendEntry 的 CustomEntry） */
const cards = (rt: { entries: { customType: string; data: any }[] }) =>
	rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as DecisionCardData);

/** 主题在测试里退化为恒等函数 */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

it("决策结果为继续时落一张卡片，带上 AI 回复", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合

	await rt.emitMessageEnd({ role: "assistant", content: [{ type: "text", text: "still working on it" }] });
	await rt.settleAfterRun(); // 结算 → 继续

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({
		outcome: "continue",
		reply: "still working on it",
		nudgeCount: 1,
		maxNudges: 50,
	});
});

it("AI 调 stop_watchdog 时卡片记为主动停止，并保留附带文字", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合

	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.emitMessageEnd({
		role: "assistant",
		content: [
			{ type: "text", text: "all done" },
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
		],
	});
	await rt.settleAfterRun(); // 结算 → 停止

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0]).toMatchObject({ outcome: "stop", reply: "all done" });
});

it("用户插话作废时卡片记为 superseded，而非 stop", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合

	rt.state.pendingMessages = 1; // 用户排队了一条消息
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found).toHaveLength(1);
	expect(found[0].outcome).toBe("superseded");
});

it("过长的 AI 回复在落盘前被截断到上限", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);

	const long = "字".repeat(400);
	await rt.emitMessageEnd({ role: "assistant", content: [{ type: "text", text: long }] });
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found[0].reply).toHaveLength(300);
	expect(found[0].reply).toBe(long.slice(0, 300));
});

it("决策卡片渲染器：折叠时只给灰字提示，展开后给回复全文", async () => {
	const rt = await setup();
	const renderer = rt.entryRenderers.get(DECISION_ENTRY_TYPE);
	expect(renderer).toBeTypeOf("function");

	const data: DecisionCardData = {
		exchangeId: "w1",
		outcome: "continue",
		reply: "still working on it",
		nudgeCount: 2,
		maxNudges: 50,
		ts: Date.now(),
	};
	const entry = { customType: DECISION_ENTRY_TYPE, data };
	const collapsed = renderer!(entry, { expanded: false }, theme).render(80).join("\n");
	expect(collapsed).toContain("还有活 → 继续");
	expect(collapsed).toContain("2/50");
	expect(collapsed).toContain("决策回复已折叠");
	expect(collapsed).not.toContain("still working on it");

	const expanded = renderer!(entry, { expanded: true }, theme).render(80).join("\n");
	expect(expanded).toContain("still working on it");
});

it("决策卡片在 fullscreen 下可点击展开、再点击收起", async () => {
	const rt = await setup();
	const renderer = rt.entryRenderers.get(DECISION_ENTRY_TYPE);
	const data: DecisionCardData = {
		exchangeId: "click-1",
		outcome: "continue",
		reply: "still working on it",
		nudgeCount: 1,
		maxNudges: 50,
		ts: Date.now(),
	};
	const view = renderer!({ customType: DECISION_ENTRY_TYPE, data }, { expanded: false }, theme);
	const clickLeft = {
		type: "click",
		button: "left",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 80,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
	};

	expect(view.render(80).join("\n")).toContain("决策回复已折叠");
	view.handleMouse(clickLeft);
	expect(view.render(80).join("\n")).toContain("still working on it");
	view.handleMouse(clickLeft);
	expect(view.render(80).join("\n")).toContain("决策回复已折叠");
});

it("keep 模式下的 stop 卡片记录挂起态，并渲染「常驻监控挂起」文案", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	const found = cards(rt);
	expect(found[0]).toMatchObject({ outcome: "stop", suspended: true });

	const renderer = rt.entryRenderers.get(DECISION_ENTRY_TYPE);
	const line = renderer!({ customType: DECISION_ENTRY_TYPE, data: found[0] }, { expanded: false }, theme)
		.render(120)
		.join("\n");
	expect(line).toContain("常驻监控挂起");
});

it("once 模式下的 stop 卡片不带挂起态", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun();

	expect(cards(rt)[0]).toMatchObject({ outcome: "stop", suspended: false });
});

it("stop 后 abort 产生的幻影 error 消息在决策窗口被清成空消息", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策窗口开启

	// 决策窗口里真实的错误不能被吞掉（未调用 stop_watchdog 时原样保留）
	const real = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "boom",
	});
	expect(real.message.stopReason).toBe("error");
	expect(real.message.errorMessage).toBe("boom");

	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	const phantom = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	expect(phantom.message.stopReason).toBe("stop");
	expect(phantom.message.content).toEqual([]);
	expect(phantom.message.errorMessage).toBeUndefined();
});

it("用户 ESC（stopReason aborted）不被 rewrite，保住 runWasAborted 检测", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策窗口开启

	// 用户插话后自己按 ESC：不能在 stopCalled 分支里被误碰
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	const escaped = await rt.emitMessageEnd({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Operation aborted",
	});
	expect(escaped.message.stopReason).toBe("aborted");
	expect(escaped.message.errorMessage).toBe("Operation aborted");
});

it("stop_watchdog 的工具行渲染为空（renderShell:self + 空 renderCall/renderResult）", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx); // 懒注册工具
	const tool = rt.tools.get("stop_watchdog");
	expect(tool.renderShell).toBe("self");
	const ctxArg = { args: {}, toolCallId: "t1", state: {}, expanded: false, isPartial: false };
	expect(tool.renderCall({}, theme, ctxArg).render(80)).toEqual([]);
	expect(
		tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: false }, theme, ctxArg).render(80),
	).toEqual([]);
});
