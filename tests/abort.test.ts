import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, nudgeText as nudge } from "../index.ts";
import { continuationMessages, nudgeMessages, setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});
afterEach(() => {
	vi.useRealTimers();
});

/**
 * 模拟「用户按 ESC 中止当前回合」：
 * AI 先开始运行，然后这一轮以 assistant.stopReason === "aborted" 结束。
 */
async function abortRunningTurn(rt: Awaited<ReturnType<typeof setup>>) {
	rt.state.idle = false; // AI 正在跑
	await rt.emit("agent_start");
	await rt.settleAbortedTurn(); // 用户按 ESC → 这一轮被中止
}

it("运行中被 ESC 中止 → 本次空闲不催促，状态栏显示已打断", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));

	await rt.commands.get("watchdog").handler("timeout=1 message=ESC测试", rt.ctx);
	await rt.settleAfterRun(); // 正常跑完一轮 → 本来会开始倒计时

	await abortRunningTurn(rt);
	expect(states.at(-1)).toMatchObject({ running: true, interrupted: true });

	await vi.advanceTimersByTimeAsync(3000); // 远超 timeout，也不该催
	expect(nudgeMessages(rt)).toHaveLength(0);
	expect(rt.statusBars.get("watchdog")).toContain("⏹"); // 状态栏不再骗人显示「AI 运行中」

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("已被 ESC 打断"))).toBe(true);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("ESC 打断后，用户发下一条消息、AI 重新跑完 → 恢复正常倒计时与催促", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=ESC恢复", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0); // 打断期间不催

	await rt.emit("input", { text: "继续", source: "interactive" }); // 用户真实消息 → 清掉打断标志
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // 恢复催促：先发决策回合
	await rt.settleAfterRun(); // 决策回合结束 → 发继续消息
	expect(rt.sentMessages.at(-1)).toBe(nudge("ESC恢复"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("常驻模式下 ESC 打断同样生效，之后仍可继续监控", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 mode=keep message=KEEP测试", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0);

	await rt.emit("input", { text: "继续", source: "interactive" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // 恢复催促：先发决策回合
	await rt.settleAfterRun(); // 决策回合结束 → 发继续消息
	expect(rt.sentMessages.at(-1)).toBe(nudge("KEEP测试"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("扩展来源的新一轮不算用户回归，只有真实用户消息才解除打断", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=扩展来源", rt.ctx);
	await rt.settleAfterRun();
	await abortRunningTurn(rt);

	// 其它扩展注入的消息（source=extension）触发新一轮：不代表用户回来了
	await rt.emit("input", { text: "扩展注入", source: "extension" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(3000);
	expect(nudgeMessages(rt)).toHaveLength(0);

	// 真实用户消息才解除打断状态
	await rt.emit("input", { text: "我来接手", source: "interactive" });
	rt.state.idle = false;
	await rt.emit("agent_start");
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(nudgeMessages(rt)).toHaveLength(1); // 恢复催促：先发决策回合
	await rt.settleAfterRun(); // 决策回合结束 → 发继续消息
	expect(rt.sentMessages.at(-1)).toBe(nudge("扩展来源"));

	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("决策回合被 ESC 中止 → 不发继续消息，卡片记为 superseded，本次空闲不再催促", async () => {
	const rt = await setup();
	const states: any[] = [];
	rt.pi.events.on("watchdog:state", (s: unknown) => states.push(s));

	await rt.commands.get("watchdog").handler("timeout=1 message=决策中止", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // 倒计时归零 → 发决策消息，decisionWindow 打开
	expect(nudgeMessages(rt)).toHaveLength(1);

	await rt.settleAbortedTurn(); // 用户按 ESC 中止决策回合

	// 修复前这里会被判成「还有活 → 继续」发出 continuation，触发新一轮
	expect(continuationMessages(rt)).toHaveLength(0);
	expect(states.at(-1)).toMatchObject({ running: true, interrupted: true });

	const cards = rt.entries.filter((e) => e.customType === DECISION_ENTRY_TYPE).map((e) => e.data as any);
	expect(cards.at(-1)).toMatchObject({ outcome: "superseded" });

	// interrupted 让本次空闲不再倒计时/催促
	await vi.advanceTimersByTimeAsync(5000);
	expect(nudgeMessages(rt)).toHaveLength(1);
	expect(rt.statusBars.get("watchdog")).toContain("⏹");

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("决策回合内插话后又按 ESC → 提示插话可能未被处理，且不发继续消息", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=插话中止", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100); // decisionWindow 打开

	rt.notifications.length = 0;
	// 中止的 run 里混入一条真实 user 消息（决策提示词是 role:"custom"，不算）
	await rt.emit("agent_end", {
		messages: [
			{ role: "user", content: "插话内容" },
			{ role: "assistant", content: [], stopReason: "aborted" },
		],
	});
	rt.state.idle = true;
	await rt.emit("agent_settled");

	expect(rt.notifications.some((n) => n.msg.includes("可能未被处理"))).toBe(true);
	expect(continuationMessages(rt)).toHaveLength(0);

	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("stop_watchdog 自己触发的 abort 不会被当成用户 ESC 打断", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=60 message=自停测试", rt.ctx);
	await rt.settleAfterRun();

	// 工具内部 teardown 先于 abort：stop_watchdog 之后 running=false
	await rt.tools.get("stop_watchdog").execute("t1", {}, undefined, undefined, rt.ctx);
	await rt.settleAbortedTurn(); // 工具 abort 触发的 agent_end

	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);
	expect(rt.statusBars.get("watchdog")).toBeUndefined(); // 状态栏已清空，未残留「已打断」
});
