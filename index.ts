import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_NUDGES = 50;
const DEFAULT_MESSAGE =
	"[Automated, not user input, not approval] " +
	"1. All tasks done → call stop_watchdog to stop. " +
	"2. Not done, no user decision needed → continue. " +
	"3. Waiting for user's reply/confirmation (e.g. discuss before editing) → don't change code, call stop_watchdog and wait for the user's next message.";

/** 用户最后一次按键后多久内视为「仍在操作」（上下选择、翻历史等），期间暂停倒计时 */
const ACTIVITY_GRACE_MS = 2000;

const TOOL_NAME = "stop_watchdog";

const STATUS_KEY = "watchdog";

/**
 * 共用配置解析器：命令参数与环境变量 PI_WATCHDOG 都走这里。
 * 语法：key=value 键值对（空格分隔），严格解析，无任何隐式容错：
 *   timeout=秒      空闲 N 秒后催促
 *   max=次数        最多催 N 次
 *   message=文案    自定义催促文案（=后可含空格，后续所有 token 都算文案）
 *   mode=once|keep  once 默认；keep 常驻（stop_watchdog 仅挂起，新消息自动恢复）
 * 出现非法 token（缺少 = 、未知 key、非法值）返回 null，由调用方提示用法。
 */
function parseConfig(raw: string): {
	timeoutSeconds: number;
	maxNudges?: number;
	message?: string;
	keepAlive: boolean;
} | null {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let maxNudges: number | undefined;
	let keepAlive = false;
	let message: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const eq = token.indexOf("=");
		if (eq <= 0) return null; // 只接受 key=value
		const key = token.slice(0, eq);
		const value = token.slice(eq + 1);
		if (key === "timeout") {
			if (!/^\d+$/.test(value)) return null;
			timeoutSeconds = Math.max(1, parseInt(value, 10));
		} else if (key === "max") {
			if (!/^\d+$/.test(value)) return null;
			maxNudges = Math.max(1, parseInt(value, 10));
		} else if (key === "mode") {
			if (value !== "once" && value !== "keep") return null;
			keepAlive = value === "keep";
		} else if (key === "message") {
			const joined = [value, ...tokens.slice(i + 1)].filter(Boolean).join(" ").trim();
			message = joined || undefined;
			break;
		} else {
			return null; // 未知 key
		}
	}
	return { timeoutSeconds, maxNudges, message, keepAlive };
}

/**
 * 环境变量 PI_WATCHDOG：设置后 session 启动时自动开始监控（适合 sub-agent 等无法手动
 * 执行命令的场景）。
 *   PI_WATCHDOG=1                    使用默认秒数/次数/文案
 *   PI_WATCHDOG=0 / false            不启动
 *   PI_WATCHDOG="timeout=30 max=100"           空闲 30s，最多催 100 次
 *   PI_WATCHDOG="timeout=5 mode=keep"          常驻模式（stop_watchdog 仅挂起）
 */
function parseEnvConfig(): ReturnType<typeof parseConfig> {
	const raw = process.env.PI_WATCHDOG?.trim();
	if (!raw || raw === "0" || raw === "false") return null;
	if (raw === "1" || raw === "true")
		return parseConfig("") ?? { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, keepAlive: false };
	return parseConfig(raw);
}

interface WatchdogState {
	running: boolean;
	/** 常驻模式：stop 后仅临时挂起，下次用户发消息时自动恢复 */
	keepAlive: boolean;
	/** 常驻模式下被临时挂起（stop_watchdog / stop）；新用户消息可唤醒 */
	suspended: boolean;
	timeoutMs: number;
	message: string;
	maxNudges: number;
	nudgeCount: number;
	/** 倒计时截止时间戳（epoch ms）；null 表示 AI 正在运行或未在倒计时 */
	countdownDeadline: number | null;
	/** 因编辑器有未发送文字而暂停倒计时；清空输入后自动恢复 */
	pausedByInput: boolean;
	/** 因用户正在按键操作（上下选择命令等）而暂停倒计时；停止操作后自动恢复 */
	pausedByActivity: boolean;
	/** 用户最后一次按键（任意键）的时间戳，用于「正在操作」判断 */
	lastInputAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	ticker: ReturnType<typeof setInterval> | null;
}

export default function (pi: ExtensionAPI) {
	const state: WatchdogState = {
		running: false,
		keepAlive: false,
		suspended: false,
		timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
		message: DEFAULT_MESSAGE,
		maxNudges: DEFAULT_MAX_NUDGES,
		nudgeCount: 0,
		countdownDeadline: null,
		pausedByInput: false,
		pausedByActivity: false,
		lastInputAt: 0,
		timer: null,
		ticker: null,
	};

	/** 最近一次拿到的 ctx，供 ticker 刷新状态栏用 */
	let activeCtx: ExtensionContext | null = null;
	/** 当前是否处于挂起状态（供 input 监听等处查询） */
	let _suspendedStore = false;
	/** 原始按键监听的取消函数（interactive 模式才有） */
	let unsubTerminalInput: (() => void) | null = null;

	function clearCountdown() {
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		state.countdownDeadline = null;
	}

	/** 编辑器里是否有未发送的文字（用户正在手动输入）。 */
	function editorHasText(ctx: ExtensionContext): boolean {
		try {
			const text = (ctx.ui as any).getEditorText?.();
			return typeof text === "string" && text.trim().length > 0;
		} catch {
			return false;
		}
	}

	/** 用户最近是否仍在按键操作（上下选择命令、翻历史、导航选择器等）。 */
	function userActive(): boolean {
		return Date.now() - state.lastInputAt < ACTIVITY_GRACE_MS;
	}

	/** 主题上色；theme 不可用（测试 mock 等）时退回纯文本 */
	function fg(ctx: ExtensionContext, color: "accent" | "dim" | "muted", text: string): string {
		const theme = (ctx.ui as any).theme;
		return theme?.fg ? theme.fg(color, text) : text;
	}

	/** 状态栏：倒计时中 `⏱23s 2/50`，输入/操作暂停 `⏱✍ 2/50`，AI 运行中 `⏱▶ 2/50`，挂起 `⏱⏸ 2/50` */
	function renderStatus(ctx: ExtensionContext) {
		if (!state.running) return;
		const count = fg(ctx, "dim", ` ${state.nudgeCount}/${state.maxNudges}`);
		if (state.suspended) {
			ctx.ui.setStatus(STATUS_KEY, fg(ctx, "muted", "⏱⏸") + count);
		} else if (state.countdownDeadline != null) {
			const remaining = Math.max(0, Math.ceil((state.countdownDeadline - Date.now()) / 1000));
			ctx.ui.setStatus(STATUS_KEY, fg(ctx, "accent", `⏱${remaining}s`) + count);
		} else if (state.pausedByInput || state.pausedByActivity) {
			ctx.ui.setStatus(STATUS_KEY, fg(ctx, "muted", "⏱✍") + count);
		} else {
			ctx.ui.setStatus(STATUS_KEY, fg(ctx, "muted", "⏱▶") + count);
		}
	}

	/**
	 * 停止/挂起：清定时器、清状态栏、移出 stop_watchdog 工具。
	 * 常驻模式下只临时挂起（工具保持可见，新用户消息可恢复）；
	 * 非常驻模式或 explicit=true 时彻底关闭。幂等。
	 */
	function teardown(ctx?: ExtensionContext, explicit = true) {
		const suspend = state.keepAlive && !explicit && state.running;
		state.running = false;
		_suspendedStore = suspend;
		state.suspended = suspend;
		state.pausedByInput = false;
		state.pausedByActivity = false;
		clearCountdown();
		if (state.ticker) {
			clearInterval(state.ticker);
			state.ticker = null;
		}
		if (!suspend) {
			(ctx ?? activeCtx)?.ui.setStatus(STATUS_KEY, undefined);
			syncToolActive(false);
			if (unsubTerminalInput) {
				unsubTerminalInput();
				unsubTerminalInput = null;
			}
		} else {
			renderStatus((ctx ?? activeCtx)!);
		}
	}

	/** 恢复挂起的常驻监控（参数沿用挂起前的配置，催促计数清零） */
	function resumeWatchdog(ctx: ExtensionContext) {
		if (!state.suspended || state.running) return;
		state.suspended = false;
		_suspendedStore = false;
		state.running = true;
		syncToolActive(true);
		state.nudgeCount = 0;
		activeCtx = ctx;
		startTicker();
		ensureTerminalInputListener(ctx);
		if (ctx.isIdle()) {
			if (hasMessages(ctx)) {
				armCountdown(ctx);
			} else {
				renderStatus(ctx);
				ctx.ui.notify("watchdog: 已恢复监控，会话暂无消息，将在 AI 首次运行结束后开始倒计时", "info");
			}
		} else {
			renderStatus(ctx);
		}
		ctx.ui.notify(
			`watchdog: 常驻监控已恢复（空闲 ${Math.round(state.timeoutMs / 1000)}s 后催促，最多 ${state.maxNudges} 次）`,
			"info",
		);
	}

	/**
	 * 监听原始终端按键：任何按键（包括在上下选择命令、翻历史、在模型/会话等
	 * 选择器或 overlay 里导航时）都视为「用户正在操作」，与正在输入文字一样
	 * 立即暂停倒计时。仅 interactive 模式提供 onTerminalInput，其它模式静默跳过。
	 */
	function ensureTerminalInputListener(ctx: ExtensionContext) {
		if (unsubTerminalInput) return;
		const ui = ctx.ui as any;
		if (typeof ui.onTerminalInput !== "function") return;
		unsubTerminalInput = ui.onTerminalInput(() => {
			state.lastInputAt = Date.now();
			if (!state.running || state.countdownDeadline == null) return;
			// 用户按下了按键 → 不等 ticker 轮询，立即暂停倒计时
			clearCountdown();
			state.pausedByActivity = true;
			renderStatus(activeCtx ?? ctx);
		});
	}

	/** AI 空闲后启动/重启倒计时（编辑器有未发送文字或用户正在操作时先暂停，结束后再倒计时） */
	function armCountdown(ctx: ExtensionContext) {
		if (!state.running) return;
		clearCountdown();
		if (editorHasText(ctx)) {
			state.pausedByInput = true;
			renderStatus(ctx);
			return;
		}
		if (userActive()) {
			// 用户刚按过键（上下选择命令、翻历史等）→ 与输入文字一样先暂停
			state.pausedByActivity = true;
			renderStatus(ctx);
			return;
		}
		state.pausedByInput = false;
		state.pausedByActivity = false;
		state.countdownDeadline = Date.now() + state.timeoutMs;
		state.timer = setTimeout(() => {
			state.timer = null;
			void fireNudge(ctx);
		}, state.timeoutMs);
		renderStatus(ctx);
	}

	/** 倒计时归零：若仍空闲则发催促消息 */
	async function fireNudge(ctx: ExtensionContext) {
		state.countdownDeadline = null;
		if (!state.running) return;
		if (!ctx.isIdle()) return; // 期间 AI 又跑起来了，agent_settled 会重新倒计时
		if (editorHasText(ctx)) {
			// 用户正在输入（ticker 尚未暂停的竞态兜底）→ 不催促，等清空后恢复倒计时
			state.pausedByInput = true;
			renderStatus(ctx);
			return;
		}
		if (userActive()) {
			// 用户正在按键操作（选择/导航等，按键事件尚未到达的竞态兜底）→ 不催促
			state.pausedByActivity = true;
			renderStatus(ctx);
			return;
		}

		state.nudgeCount++;
		if (state.nudgeCount > state.maxNudges) {
			state.keepAlive = false; // 达到上限说明彻底卡死，常驻模式也直接关闭
			teardown(ctx);
			ctx.ui.notify(`watchdog: 已催促 ${state.maxNudges} 次仍未完成，已自动停止监控`, "warning");
			return;
		}

		try {
			// 空闲状态直接发送，触发新一轮
			pi.sendUserMessage(state.message);
			ctx.ui.notify(`watchdog: 已发送催促消息 (${state.nudgeCount}/${state.maxNudges})`, "info");
		} catch {
			// 极小概率竞态：发送瞬间 AI 开始运行。不计入次数，等 agent_settled 重新倒计时
			state.nudgeCount--;
			return;
		}
		renderStatus(ctx);
	}

	/** 会话中是否已有对话消息（用于判断是否为"全新无消息"的会话） */
	function hasMessages(ctx: ExtensionContext): boolean {
		try {
			return ctx.sessionManager.getBranch().some((e) => e.type === "message");
		} catch {
			return true; // 读取失败时保守处理，保持原有倒计时行为
		}
	}

	/** 把 stop_watchdog 加入/移出 active tools，让 AI 只在监控运行时看到该工具（节省上下文） */
	function syncToolActive(running: boolean) {
		try {
			const api = pi as any;
			if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;
			const active: string[] = api.getActiveTools();
			const has = active.includes(TOOL_NAME);
			if (running && !has) api.setActiveTools([...active, TOOL_NAME]);
			else if (!running && has) api.setActiveTools(active.filter((n) => n !== TOOL_NAME));
		} catch {
			// mock/测试环境无此 API 时跳过
		}
	}

	/** 1s ticker：刷新状态栏剩余秒数；轮询编辑器文字与按键活动实现输入/操作暂停恢复 */
	function startTicker() {
		if (state.ticker) clearInterval(state.ticker);
		state.ticker = setInterval(() => {
			if (!state.running || !activeCtx) return;
			if (state.countdownDeadline != null) {
				if (editorHasText(activeCtx) || userActive()) {
					// 倒计时中检测到输入或按键操作 → 暂停
					const byText = editorHasText(activeCtx);
					clearCountdown();
					state.pausedByInput = byText;
					state.pausedByActivity = !byText;
				}
				renderStatus(activeCtx);
			} else if ((state.pausedByInput || state.pausedByActivity) && !editorHasText(activeCtx) && !userActive()) {
				// 输入文字已清空（或已发送）且停止按键操作 → 恢复倒计时
				state.pausedByInput = false;
				state.pausedByActivity = false;
				if (activeCtx.isIdle()) {
					armCountdown(activeCtx);
				} else {
					renderStatus(activeCtx); // AI 运行中，agent_settled 后会重新倒计时
				}
			}
		}, 1000);
	}

	function startWatchdog(
		ctx: ExtensionContext,
		timeoutSeconds: number,
		message: string,
		maxNudges?: number,
		keepAlive = false,
	) {
		// 支持运行中重新 start：重置参数和计数
		teardown();
		state.keepAlive = keepAlive;
		state.running = true;
		syncToolActive(true);
		state.timeoutMs = timeoutSeconds * 1000;
		state.message = message;
		if (maxNudges !== undefined) state.maxNudges = maxNudges;
		state.nudgeCount = 0;
		activeCtx = ctx;
		startTicker();
		ensureTerminalInputListener(ctx);

		// 若当前已空闲则考虑立即开始倒计时；否则等 agent_settled。
		// 首次启动且会话中还没有任何消息时不倒计时（AI 还没开始干活，催促无意义），
		// 等第一轮 agent_settled 后再开始。
		if (ctx.isIdle()) {
			if (hasMessages(ctx)) {
				armCountdown(ctx);
			} else {
				renderStatus(ctx);
				ctx.ui.notify("watchdog: 会话暂无消息，将在 AI 首次运行结束后开始倒计时", "info");
			}
		} else {
			renderStatus(ctx);
		}

		ctx.ui.notify(
			`watchdog: 监控已启动（${keepAlive ? "常驻模式，" : ""}空闲 ${timeoutSeconds}s 后催促，最多 ${state.maxNudges} 次）`,
			"info",
		);
	}

	// ---------- 事件 ----------

	pi.on("session_start", async (_event, ctx) => {
		const envConfig = parseEnvConfig();
		if (envConfig && !state.running) {
			startWatchdog(
				ctx,
				envConfig.timeoutSeconds,
				envConfig.message || DEFAULT_MESSAGE,
				envConfig.maxNudges,
				envConfig.keepAlive,
			);
		} else {
			// 未启动时不把 stop_watchdog 暴露给 AI（注册时会默认进入 active tools，这里按实际状态同步）
			syncToolActive(state.running);
			// 环境变量设了但解析失败：明确提示，而不是静默不启动
			const raw = process.env.PI_WATCHDOG?.trim();
			if (raw && raw !== "0" && raw !== "false" && raw !== "1" && raw !== "true" && parseConfig(raw) === null) {
				ctx.ui.notify(
					'watchdog: PI_WATCHDOG 格式无效，未自动启动。用法：PI_WATCHDOG="timeout=30 max=100 message=继续 mode=keep"',
					"warning",
				);
			}
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!state.running) return;
		activeCtx = ctx;
		state.pausedByInput = false;
		state.pausedByActivity = false;
		clearCountdown(); // AI 开始运行，取消倒计时
		renderStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.running) return;
		activeCtx = ctx;
		armCountdown(ctx); // AI 停止输出（含重试/排队都结束后），重新倒计时
	});

	// 常驻模式：用户发新消息 → 自动恢复挂起的监控
	// （extension 来源是 watchdog 自己发的催促消息，排除；挂起期间催促本就不会发生）
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension" && state.keepAlive && state.suspended && !state.running) {
			resumeWatchdog(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		teardown(ctx);
	});

	// ---------- 给 AI 的停止工具 ----------

	pi.registerTool({
		name: TOOL_NAME,
		label: "停止自动继续",
		description:
			"停止 watchdog 自动继续监控。当你已完成全部任务、不需要再被自动催促继续时调用此工具。若监控处于常驻模式，此调用只是临时挂起，用户发送新消息时会自动恢复监控。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!state.running) {
				return {
					content: [
						{
							type: "text",
							text: state.suspended
								? "已处于挂起状态，无需停止；用户发送新消息时监控会自动恢复。"
								: "watchdog 未在运行，无需停止。",
						},
					],
					details: {},
				};
			}
			teardown(ctx, false);
			const suspendedNow = state.keepAlive;
			ctx.ui.notify(
				suspendedNow
					? "watchdog: AI 已调用 stop_watchdog，常驻监控挂起（下次发消息自动恢复）"
					: "watchdog: AI 已调用 stop_watchdog，监控已停止",
				"info",
			);
			return {
				content: [
					{
						type: "text",
						text: suspendedNow
							? "已临时挂起自动继续监控；用户发送新消息时会自动恢复，届时无需你再调用本工具。"
							: "已停止自动继续监控。",
					},
				],
				details: {},
			};
		},
	});

	// ---------- 用户命令 ----------

	pi.registerCommand("watchdog", {
		description:
			"自动继续监控：[timeout=秒] [max=次数] [message=文案] [mode=once|keep] 启动 | stop 彻底停止 | status 查看状态",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const [first, _second, ..._restTokens] = tokens;

			switch (first) {
				case "stop": {
					if (state.suspended && !state.running) {
						state.keepAlive = false;
						teardown(ctx);
						ctx.ui.notify("watchdog: 常驻监控已彻底关闭", "info");
						break;
					}
					if (!state.running) {
						ctx.ui.notify("watchdog: 未在运行", "info");
						break;
					}
					// stop 在任何模式下都彻底停止；挂起仅由 AI 调 stop_watchdog 在常驻模式下触发
					state.keepAlive = false;
					teardown(ctx);
					ctx.ui.notify("watchdog: 监控已停止", "info");
					break;
				}

				case "status": {
					if (state.suspended && !state.running) {
						ctx.ui.notify(
							`watchdog: 常驻监控挂起中（⏱⏸ 下次发消息自动恢复，已催 ${state.nudgeCount}/${state.maxNudges}）`,
							"info",
						);
						break;
					}
					if (!state.running) {
						ctx.ui.notify("watchdog: 未在运行（/watchdog timeout=30 message=继续 启动；mode=keep 常驻模式）", "info");
						break;
					}
					const countdown =
						state.countdownDeadline != null
							? `${Math.max(0, Math.ceil((state.countdownDeadline - Date.now()) / 1000))}s 后催促`
							: state.pausedByInput
								? "输入中暂停（清空输入后恢复倒计时）"
								: state.pausedByActivity
									? "操作中暂停（停止按键后恢复倒计时）"
									: "等待 AI 空闲";
					const msgPreview = state.message.length > 30 ? `${state.message.slice(0, 30)}…` : state.message;
					ctx.ui.notify(
						`watchdog: 运行中 · ${countdown} · 已催 ${state.nudgeCount}/${state.maxNudges} · 消息: "${msgPreview}"`,
						"info",
					);
					break;
				}

				default: {
					// 启动：/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]
					// 与环境变量共用同一解析器，严格 key=value，非法参数提示用法而非静默当文案
					const config = parseConfig(args);
					if (args.trim() && config === null) {
						ctx.ui.notify(
							"watchdog: 参数无效。用法：/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]，例如 /watchdog timeout=30 message=继续 mode=keep",
							"warning",
						);
						break;
					}
					startWatchdog(
						ctx,
						config?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
						config?.message || DEFAULT_MESSAGE, // 未指定 message 时用默认文案，不沿用上一次的（避免隐式状态残留）
						config?.maxNudges,
						config?.keepAlive ?? false,
					);
					break;
				}
			}
		},
	});
}
