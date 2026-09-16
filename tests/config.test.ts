import { beforeEach, expect, it, vi } from "vitest";
import { setup } from "./helpers/setup.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
});

it("注册了 stop_watchdog 工具、/watchdog 命令，且工具默认激活", async () => {
	const rt = await setup();
	expect(rt.tools.has("stop_watchdog")).toBe(true);
	expect(rt.commands.has("watchdog")).toBe(true);
	expect(rt.activeTools.has("stop_watchdog")).toBe(true);
});

it("key=value 严格解析：裸 token / 未知 key / 非法值 / 非法 mode 都被拒绝并提示用法", async () => {
	const rt = await setup();
	for (const bad of ["30 继续吧", "foo=bar", "timeout=abc", "mode=always"]) {
		await rt.commands.get("watchdog").handler(bad, rt.ctx);
	}
	const warns = rt.notifications.filter((n) => n.msg.includes("参数无效"));
	expect(warns).toHaveLength(4);
	expect(warns[0].msg).toContain("用法");

	// 拒绝后监控未启动
	rt.notifications.length = 0;
	await rt.commands.get("watchdog").handler("status", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("未在运行"))).toBe(true);
});

it("合法参数组合 timeout/max/message 解析生效并按配置催促", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 max=2 message=解析测试", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.at(-1)).toBe("解析测试");
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("监控已停止"))).toBe(true);
});

it("message= 含空格的多 token 文案拼接", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("timeout=1 message=继续 下一步", rt.ctx);
	await rt.settleAfterRun();
	await vi.advanceTimersByTimeAsync(1100);
	expect(rt.sentMessages.at(-1)).toBe("继续 下一步");
	await rt.settleAfterRun();
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});

it("无参数 = 默认参数（60s）启动", async () => {
	const rt = await setup();
	await rt.commands.get("watchdog").handler("", rt.ctx);
	expect(rt.notifications.some((n) => n.msg.includes("监控已启动") && n.msg.includes("空闲 60s"))).toBe(true);
	await rt.commands.get("watchdog").handler("stop", rt.ctx);
});
