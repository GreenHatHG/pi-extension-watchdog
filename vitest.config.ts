import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The sub-agent that runs these tests may carry a REAL PI_WATCHDOG_ON_STOP in its env (the
		// tmux-subagent wrap-up chain that kill-sessions the pane). Any test reaching stopWatchdog
		// would then fire that chain for real: write the run's exit file, release the parent waiter,
		// and kill-session the sub-agent pane mid-test-run. Tests must never inherit operator hook
		// env: drop the watchdog hooks before any test module loads.
		setupFiles: "./tests/helpers/env-guard.ts",
	},
});
