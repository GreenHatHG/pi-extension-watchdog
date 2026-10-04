import { vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./mockPi.js";

/**
 * Shared setup for every test: fresh modules, fresh plugin instance, fake timers.
 * vi.resetModules() gives each import("../index.ts") a clean module, like loading the plugin in a new process.
 */
export async function setup(): Promise<MockRuntime> {
	vi.useFakeTimers();
	vi.resetModules();
	const rt = createMockRuntime();
	await rt.newPlugin();
	return rt;
}

/** Decision messages sent so far (each one is a nudge). */
export const nudgeMessages = (rt: MockRuntime) => rt.customMessages.filter((m) => m.customType === "pi-watchdog:nudge");

/** Continue messages sent so far (the ones that start a real work turn). */
export const continuationMessages = (rt: MockRuntime) =>
	rt.customMessages.filter((m) => m.customType === "pi-watchdog:continuation");
