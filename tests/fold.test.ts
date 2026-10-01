import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CONTINUATION_MESSAGE_TYPE,
	decisionText,
	FOLD_MESSAGE_TYPE,
	foldWatchdogContext,
	NUDGE_MESSAGE_TYPE,
	nudgeText as nudge,
	WATCHDOG_MESSAGE_VERSION,
} from "../index.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

const EXCHANGE = "exchange-1";

const nudgeMsg = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: NUDGE_MESSAGE_TYPE,
	content: decisionText(),
	display: false,
	details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId },
});
const continuationMsg = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: CONTINUATION_MESSAGE_TYPE,
	content: nudge(),
	display: true,
	details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId },
});
const stopMarker = (exchangeId = EXCHANGE) => ({
	role: "custom",
	customType: FOLD_MESSAGE_TYPE,
	content: "",
	display: false,
	details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId, outcome: "stop" },
});
const assistant = (content: unknown[]) => ({ role: "assistant", content });
const toolResult = (toolCallId: string, toolName: string) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [],
});
const user = (text: string) => ({ role: "user", content: text });

it("continue 交换折叠成只保留继续消息", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([{ type: "text", text: "ok" }]),
		continuationMsg(),
		user("later"),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task"), continuationMsg(), user("later")]);
});

it("stop 交换连同被拦截的工具对被整体删除", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([
			{ type: "toolCall", id: "c1", name: "edit", arguments: {} }, // 被拦截
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
			{ type: "text", text: "done" },
		]),
		toolResult("c1", "edit"),
		toolResult("cs", "stop_watchdog"),
		stopMarker(),
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task")]);
});

it("决策回合仍在进行（无终止标记）→ 原样保留，模型要能看到提示词", () => {
	const messages = [user("task"), nudgeMsg(), assistant([{ type: "text", text: "..." }])];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("区间内混入真实用户消息 → fail closed，原样保留", () => {
	const messages = [nudgeMsg(), user("等等"), continuationMsg()];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("区间内混入其它插件的 custom 消息 → fail closed，原样保留", () => {
	const messages = [
		nudgeMsg(),
		{ role: "custom", customType: "other:x", content: "x", display: false },
		continuationMsg(),
	];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("多个交换各自独立折叠", () => {
	const messages = [
		nudgeMsg("e1"),
		assistant([]),
		continuationMsg("e1"),
		nudgeMsg("e2"),
		assistant([]),
		stopMarker("e2"),
		user("after"),
	];
	expect(foldWatchdogContext(messages)).toEqual([continuationMsg("e1"), user("after")]);
});

it("区间内混入压缩摘要等非消息角色 → fail closed，原样保留", () => {
	const messages = [nudgeMsg(), { role: "compactionSummary", summary: "..." }, continuationMsg()];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("没有决策消息的孤儿 continuation 原样保留", () => {
	const messages = [user("a"), continuationMsg(), user("b")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("无终态且后面已有新用户消息 → 原样保留", () => {
	const messages = [nudgeMsg(), assistant([{ type: "text", text: "..." }]), user("interrupt")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

it("superseded 折叠标记同样终止区间", () => {
	const messages = [
		user("task"),
		nudgeMsg(),
		assistant([]),
		{
			role: "custom",
			customType: FOLD_MESSAGE_TYPE,
			content: "",
			display: false,
			details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId: EXCHANGE, outcome: "superseded" },
		},
	];
	expect(foldWatchdogContext(messages)).toEqual([user("task")]);
});

it("非关联的普通消息不受影响", () => {
	const messages = [user("a"), assistant([{ type: "text", text: "b" }]), user("c")];
	expect(foldWatchdogContext(messages)).toEqual(messages);
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

it("context 钩子：决策回合结束后请求视图里不再有决策交换", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=折叠测试", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合
	expect(rt.entries.some((e) => e.customType === "pi-watchdog:nudge-marker")).toBe(true);
	await rt.settleAfterRun(); // 决策回合结束（模型没调 stop）→ 继续消息

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.some((m) => m.customType === NUDGE_MESSAGE_TYPE)).toBe(false);
	expect(folded.filter((m) => m.role === "custom").map((m) => m.customType)).toEqual([CONTINUATION_MESSAGE_TYPE]);
});

it("context 钩子：AI 调 stop_watchdog 后决策交换整体移除", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=停止折叠", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAfterRun(); // 决策回合结束 → 落 stop 折叠标记

	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.filter((m) => m.role === "custom")).toHaveLength(0);
});

it("决策窗口内拦截除 stop_watchdog 外的工具，结算后恢复放行", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合开启

	const blocked = await rt.emitToolCall({ toolName: "bash", toolCallId: "c1", input: {} });
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("tools are blocked");

	const allowed = await rt.emitToolCall({ toolName: "stop_watchdog", toolCallId: "cs", input: {} });
	expect(allowed).toBeUndefined();

	await rt.settleAfterRun(); // 结算决策窗口
	const after = await rt.emitToolCall({ toolName: "bash", toolCallId: "c2", input: {} });
	expect(after).toBeUndefined();
});

it("继续消息在决策回合结算后才发出，且仍是固定触发行文案", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=延迟发送", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)).toHaveLength(0); // 尚未结算，继续消息未发

	await rt.settleAfterRun();
	expect(continuationMessages(rt)).toHaveLength(1);
	expect(continuationMessages(rt)[0].content).toBe(nudge("延迟发送"));
});

it("决策回合的模型回复在落盘前被清空；带工具调用时只保留工具调用块", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合开启

	const ack = { role: "assistant", content: [{ type: "text", text: "ok, continuing" }], stopReason: "stop" };
	const replaced = await rt.emitMessageEnd(ack);
	expect(replaced?.message.content).toEqual([]);

	const withTool = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "需要收尾", signature: "sig" },
			{ type: "text", text: "all done" },
			{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
		],
	};
	const replacedWithTool = await rt.emitMessageEnd(withTool);
	expect(replacedWithTool?.message.content).toEqual([
		{ type: "thinking", thinking: "需要收尾", signature: "sig" },
		{ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} },
	]); // 只剥掉 text；toolCall / thinking 保留（配对与签名）

	await rt.settleAfterRun(); // 决策窗口关闭
	const normal = { role: "assistant", content: [{ type: "text", text: "hi" }] };
	expect(await rt.emitMessageEnd(normal)).toBeUndefined(); // 不再干预普通回合
});

it("决策期间用户插话 → 本次检查作废、不发继续消息，决策交换仍被折叠", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 决策回合

	rt.state.pendingMessages = 1; // 用户排队了一条消息
	await rt.settleAfterRun();

	expect(continuationMessages(rt)).toHaveLength(0);
	expect(rt.customMessages.some((m) => m.customType === FOLD_MESSAGE_TYPE)).toBe(true);
	const folded = (await rt.emitContext(rt.currentMessages())) as any[];
	expect(folded.some((m) => m.customType === NUDGE_MESSAGE_TYPE)).toBe(false);

	// watchdog 仍在运行，用户回合结束后会重新倒计时
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("运行中"))).toBe(true);
});
