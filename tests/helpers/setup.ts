import { vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./mockPi.js";

/**
 * 每个测试共享的 setup：全新模块 + 全新插件实例 + fake timers。
 * vi.resetModules() 保证每次 import("../index.ts") 拿到干净模块
 * （等价于 smoke 测试里 import("../index.ts?env-test") 的新进程语义）。
 */
export async function setup(): Promise<MockRuntime> {
	vi.useFakeTimers();
	vi.resetModules();
	const rt = createMockRuntime();
	await rt.newPlugin();
	return rt;
}

/** 已发出的决策消息（即「催促」）次数 */
export const nudgeMessages = (rt: MockRuntime) => rt.customMessages.filter((m) => m.customType === "pi-watchdog:nudge");

/** 已发出的继续消息（真正触发工作回合的那条）次数 */
export const continuationMessages = (rt: MockRuntime) =>
	rt.customMessages.filter((m) => m.customType === "pi-watchdog:continuation");
