import { DEFAULT_TIMEOUT_SECONDS } from "./constants.ts";

/**
 * Config parser shared by the command args and the PI_WATCHDOG env var: space-separated key=value, strict, no guessing.
 *   timeout=seconds  nudge after N idle seconds
 *   max=N            nudge at most N times
 *   message=text     extra order, glued after the fixed trigger line (never replaces it)
 *   mode=once|keep   once is the default; keep means watchdog_decide only pauses, and the next user message resumes
 * A bad token returns ok=false, and error is ready to show as-is.
 */
export type ParsedConfig =
	| { ok: true; timeoutSeconds: number; maxNudges?: number; message?: string; keepAlive: boolean }
	| { ok: false; error: string };

const KNOWN_KEYS = "timeout/max/message/mode";

export function parseConfig(raw: string): ParsedConfig {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, keepAlive: false };
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let maxNudges: number | undefined;
	let keepAlive = false;
	let message: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const eq = token.indexOf("=");
		if (eq <= 0) return { ok: false, error: `Unknown arg "${token}" (only key=value, supports ${KNOWN_KEYS})` };
		const key = token.slice(0, eq);
		const value = token.slice(eq + 1);
		if (key === "timeout") {
			if (!/^\d+$/.test(value))
				return { ok: false, error: `timeout value "${value}" is not a positive whole number, e.g. timeout=30` };
			timeoutSeconds = Math.max(1, parseInt(value, 10));
		} else if (key === "max") {
			if (!/^\d+$/.test(value))
				return { ok: false, error: `max value "${value}" is not a positive whole number, e.g. max=5` };
			maxNudges = Math.max(1, parseInt(value, 10));
		} else if (key === "mode") {
			if (value !== "once" && value !== "keep")
				return { ok: false, error: `mode value "${value}" must be once or keep` };
			keepAlive = value === "keep";
		} else if (key === "message") {
			const joined = [value, ...tokens.slice(i + 1)].filter(Boolean).join(" ").trim();
			message = joined || undefined;
			break;
		} else {
			return { ok: false, error: `Unknown arg "${key}" (only ${KNOWN_KEYS})` };
		}
	}
	return { ok: true, timeoutSeconds, maxNudges, message, keepAlive };
}

/**
 * Env var PI_WATCHDOG: when set, monitoring auto-starts on session start (handy for sub-agents).
 *   PI_WATCHDOG=1                     default seconds, count and text
 *   PI_WATCHDOG=0 / false             do not start
 *   PI_WATCHDOG="timeout=30 max=100"  idle 30s, up to 100 nudges
 *   PI_WATCHDOG="timeout=5 mode=keep" keep mode, watchdog_decide only pauses
 *   PI_WATCHDOG_ON_STOP="<shell>"     hook run when watchdog_decide is called, e.g. touch an exit file
 */
export function parseEnvConfig(): ParsedConfig | null {
	const raw = process.env.PI_WATCHDOG?.trim();
	if (!raw || raw === "0" || raw === "false") return null;
	if (raw === "1" || raw === "true") return parseConfig("");
	return parseConfig(raw);
}
