import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nudgeText as nudge } from "../index.ts";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	process.env.PI_WATCHDOG_ROLLBACK = "1"; // 本文件默认开启回滚；关闭场景单独覆盖
});
afterEach(() => {
	vi.useRealTimers();
	delete process.env.PI_WATCHDOG_ROLLBACK;
});

/** 回滚点之前的历史叶子 */
function buildHistory(rt: Awaited<ReturnType<typeof setup>>) {
	rt.sessionEntries.length = 0;
	rt.sessionEntries.push({ type: "message", id: "hist", message: { role: "user", content: "历史任务" } });
	rt.setLeaf("hist");
}

/** 模型侧的 stop 交换落盘：assistant 工具调用（+可选真活/收尾文字）→ toolResult */
function appendStopExchange(
	rt: Awaited<ReturnType<typeof setup>>,
	opts?: { extraWork?: boolean; userMessage?: string; closingText?: string; leadingText?: string },
) {
	const content: any[] = [];
	if (opts?.extraWork)
		content.push({ type: "text", text: "我来改点东西" }, { type: "toolCall", id: "c1", name: "edit", arguments: {} });
	content.push({ type: "toolCall", id: "cs", name: "stop_watchdog", arguments: {} });
	if (opts?.leadingText) content.unshift({ type: "text", text: opts.leadingText });
	rt.sessionEntries.push({ type: "message", id: "ast", message: { role: "assistant", content } });
	if (opts?.closingText)
		rt.sessionEntries.push({
			type: "message",
			id: "ast2",
			message: { role: "assistant", content: [{ type: "text", text: opts.closingText }] },
		});
	if (opts?.userMessage)
		rt.sessionEntries.push({ type: "message", id: "um", message: { role: "user", content: opts.userMessage } });
	rt.sessionEntries.push({
		type: "message",
		id: "tr",
		message: { role: "toolResult", toolCallId: "cs", toolName: "stop_watchdog", content: [], isError: false },
	});
}

/** 完整跑一遍「催促 → 模型调 stop → settled」并返回工具返回值 */
async function runStopFlow(
	rt: Awaited<ReturnType<typeof setup>>,
	text: string,
	opts?: Parameters<typeof appendStopExchange>[1],
) {
	buildHistory(rt);
	await rt.commands
		.get("watchdog")
		.handler(`timeout=1 message=${text.replace(/^(?:\[Automated[^\]]*\]\s*)?/, "")}`, rt.ctx);
	await vi.advanceTimersByTimeAsync(1100); // fireNudge：记录回滚点（=hist）→ 发送催促（mock 落盘 user 条目）
	expect(rt.sentMessages.at(-1)).toBe(nudge(text));
	appendStopExchange(rt, opts);
	return rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
}

it("默认不开 PI_WATCHDOG_ROLLBACK → 不回滚，上下文保持现状", async () => {
	delete process.env.PI_WATCHDOG_ROLLBACK;
	const rt = await setup();
	await runStopFlow(rt, "默认关闭");
	await rt.settleAbortedTurn();

	expect(rt.rollbackCalls).toHaveLength(0);
	expect(rt.sessionEntries.length).toBeGreaterThan(2); // 交换全部保留
});

it("PI_WATCHDOG_ROLLBACK=false 同样不回滚", async () => {
	process.env.PI_WATCHDOG_ROLLBACK = "false";
	const rt = await setup();
	await runStopFlow(rt, "显式关闭");
	await rt.settleAbortedTurn();
	expect(rt.rollbackCalls).toHaveLength(0);
});

it("stop_watchdog 后回滚：nudge 交换从上下文砍掉，叶子回到催促前", async () => {
	const rt = await setup();
	const result = await runStopFlow(rt, "回滚测试");
	expect(JSON.stringify(result.content)).toContain("OK.");
	await rt.settleAbortedTurn(); // agent_settled → 跳板 → 校验 → 回滚

	expect(rt.rollbackCalls).toEqual(["hist"]); // navigateTree 回到催促前叶子
	expect(rt.sessionEntries).toHaveLength(1); // mock navigateTree 已砍掉 hist 之后的条目
	expect(rt.sessionEntries[0].id).toBe("hist");
});

it("nudge 后模型干了真活 → 不回滚，保留全部上下文", async () => {
	const rt = await setup();
	await runStopFlow(rt, "真活测试", { extraWork: true });
	await rt.settleAbortedTurn();

	expect(rt.rollbackCalls).toHaveLength(0); // 校验失败，跳过回滚
	expect(rt.sessionEntries.length).toBeGreaterThan(2); // 条目全部保留
});

it("尾部混入真实用户消息 → 不回滚", async () => {
	const rt = await setup();
	await runStopFlow(rt, "混入测试", { userMessage: "等等，先别停" });
	await rt.settleAbortedTurn();

	expect(rt.rollbackCalls).toHaveLength(0);
	expect(rt.sessionEntries.at(-1).id).toBe("tr");
});

it("assistant 在 toolResult 后补了纯文字收尾（无工具调用）→ 仍回滚", async () => {
	const rt = await setup();
	await runStopFlow(rt, "收尾文字测试", { closingText: "已停止监控，等你确认后再继续。" });
	await rt.settleAbortedTurn();

	// 纯文字无状态、删掉无损失，真活证据是工具调用；此处无任何非 stop 工具 → 回滚
	expect(rt.rollbackCalls).toEqual(["hist"]);
});

it("assistant 在 stop 调用前流式吐了收尾文字（同一条消息）→ 仍回滚", async () => {
	const rt = await setup();
	await runStopFlow(rt, "前置文字测试", { leadingText: "好的，完成了。" });
	await rt.settleAbortedTurn();

	// abort 截不掉 toolCall 之前已落盘的文字，这类文字属于 stop 交换的预期形态，不应阻断回滚
	expect(rt.rollbackCalls).toEqual(["hist"]);
});

it("keep 模式 stop 后同样回滚，且挂起状态不受影响", async () => {
	const rt = await setup();
	buildHistory(rt);
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=keep回滚", rt.ctx);
	await vi.advanceTimersByTimeAsync(1100);
	appendStopExchange(rt);

	await rt.tools.get("stop_watchdog").execute("t4", {}, undefined, undefined, rt.ctx);
	await rt.settleAbortedTurn();

	expect(rt.rollbackCalls).toEqual(["hist"]);
	// 挂起仍生效：新消息恢复监控
	await rt.emit("input", { text: "新任务", source: "interactive" });
	expect(rt.notifications.some((n) => n.msg.includes("已恢复"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("回滚后有新内容时校验拒绝（stop 后用户已发言）", async () => {
	const rt = await setup();
	await runStopFlow(rt, "新内容测试");
	await rt.settleAbortedTurn();
	expect(rt.rollbackCalls).toEqual(["hist"]);

	// 模拟用户在回滚后的分支上继续对话 → pendingRollback 已消费，不会二次触发
	await rt.settleAfterRun();
	expect(rt.rollbackCalls).toEqual(["hist"]);
});
