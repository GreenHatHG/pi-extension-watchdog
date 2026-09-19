import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_NUDGES = 50;
/** 催促触发行：固定语义，永不缺席（message= 只追加 Task instruction，不会替换本行） */
export const DEFAULT_MESSAGE =
	"[Automated, not user input] If work remains, continue working (no reply needed). " +
	"If waiting on a user decision, don't change code — state what you need, then call stop_watchdog as your final action. " +
	"If no work remains and no decision is pending, call stop_watchdog to end the turn.";

/** 组装催促消息：固定触发行 + 可选追加指令（message=），自定义内容不会替换触发行语义。 */
export function nudgeText(hint?: string): string {
	return hint ? `${DEFAULT_MESSAGE}\n\nTask instruction: ${hint}` : DEFAULT_MESSAGE;
}

/** 用户最后一次按键后多久内视为「仍在操作」（上下选择、翻历史等），期间暂停倒计时 */
const ACTIVITY_GRACE_MS = 2000;

const TOOL_NAME = "stop_watchdog";

const STATUS_KEY = "watchdog";

/**
 * 共用配置解析器：命令参数与环境变量 PI_WATCHDOG 都走这里。
 * 语法：key=value 键值对（空格分隔），严格解析，无任何隐式容错：
 *   timeout=秒      空闲 N 秒后催促
 *   max=次数        最多催 N 次
 *   message=文案    追加指令（=后可含空格，后续所有 token 都算文案）；作为 Task instruction 拼在固定触发行之后，不替换触发行
 *   mode=once|keep  once 默认；keep 常驻（stop_watchdog 仅挂起，新消息自动恢复）
 * 非法 token（缺少 = 、未知 key、非法值）返回 ok=false，error 已含 token 与原因，调用方原样 notify。 */
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
		if (eq <= 0) return { ok: false, error: `无法识别的参数 "${token}"（只接受 key=value 形式，支持 ${KNOWN_KEYS}）` };
		const key = token.slice(0, eq);
		const value = token.slice(eq + 1);
		if (key === "timeout") {
			if (!/^\d+$/.test(value)) return { ok: false, error: `timeout 值 "${value}" 不是正整数，例如 timeout=30` };
			timeoutSeconds = Math.max(1, parseInt(value, 10));
		} else if (key === "max") {
			if (!/^\d+$/.test(value)) return { ok: false, error: `max 值 "${value}" 不是正整数，例如 max=5` };
			maxNudges = Math.max(1, parseInt(value, 10));
		} else if (key === "mode") {
			if (value !== "once" && value !== "keep") return { ok: false, error: `mode 值 "${value}" 只能是 once 或 keep` };
			keepAlive = value === "keep";
		} else if (key === "message") {
			const joined = [value, ...tokens.slice(i + 1)].filter(Boolean).join(" ").trim();
			message = joined || undefined;
			break;
		} else {
			return { ok: false, error: `未知参数 "${key}"（只支持 ${KNOWN_KEYS}）` };
		}
	}
	return { ok: true, timeoutSeconds, maxNudges, message, keepAlive };
}

/**
 * 环境变量 PI_WATCHDOG：设置后 session 启动时自动开始监控（适合 sub-agent 等无法手动
 * 执行命令的场景）。
 *   PI_WATCHDOG=1                    使用默认秒数/次数/文案
 *   PI_WATCHDOG=0 / false            不启动
 *   PI_WATCHDOG="timeout=30 max=100"           空闲 30s，最多催 100 次
 *   PI_WATCHDOG="timeout=5 mode=keep"          常驻模式（stop_watchdog 仅挂起）
 */
function parseEnvConfig(): ParsedConfig | null {
	const raw = process.env.PI_WATCHDOG?.trim();
	if (!raw || raw === "0" || raw === "false") return null;
	if (raw === "1" || raw === "true") return parseConfig("");
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

/** PI_WATCHDOG_ROLLBACK=1/true 开启 stop 后上下文回滚，默认关闭 */
function isRollbackEnvEnabled(): boolean {
	const flag = process.env.PI_WATCHDOG_ROLLBACK?.trim().toLowerCase();
	return flag === "1" || flag === "true";
}

/**
 * 会话是否来自「恢复」而非全新开始：/resume 换会话（resume）、/fork / /clone 恢复旧树点（fork）。
 * 恢复进来的会话虽有历史消息，但本进程实例里 AI 还没干过活，立即倒计时会在用户
 * 只是想翻看旧会话时空催一轮——与「空会话等首次 agent_settled」同一原则。
 */
function isRestoredReason(reason: string | undefined): boolean {
	return reason === "resume" || reason === "fork";
}

/**
 * 校验回滚点之后是否只有本次催促的 stop 交换（纯尾巴）。
 * 只允许删后缀：中段删除会位移后续字节打爆 prompt cache，
 * 且会产生未配对的 tool_use。发现任何非催促交换的内容（真活）都返回 false。
 */
function validateRollbackTail(sessionManager: any, targetId: string, nudgeFullText: string): boolean {
	let branch: any[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		return false;
	}
	const idx = branch.findIndex((e: any) => e?.id === targetId);
	if (idx === -1) return false;
	const tail = branch.slice(idx + 1);
	if (tail.length === 0) return false;
	let sawStopExchange = false;
	for (const e of tail) {
		if (e.type !== "message") return false; // custom/compaction 等任何其他类型都不可回滚
		const msg = e.message;
		if (!msg) return false;
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: (msg.content ?? [])
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join("");
			if (text !== nudgeFullText) return false; // 有真实用户消息混入
		} else if (msg.role === "assistant") {
			// 文字不作为真活证据：回滚会把 nudge 后整段交换删掉（含本条消息），
			// 文字本身无状态、删掉无损失；真活的证据是工具调用。
			for (const c of msg.content ?? []) {
				if (c.type === "toolCall") {
					if (c.name !== TOOL_NAME) return false; // 调了别的工具 = 干了活
					sawStopExchange = true;
				}
				// text/thinking 允许：abort 截不掉 toolCall 前已落盘的文字，纯文字回复也无状态
			}
		} else if (msg.role === "toolResult") {
			if (msg.toolName !== TOOL_NAME) return false;
			sawStopExchange = true;
		} else {
			return false;
		}
	}
	return sawStopExchange;
}

export default function (pi: ExtensionAPI) {
	const state: WatchdogState = {
		running: false,
		keepAlive: false,
		suspended: false,
		timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
		message: "", // 追加指令（Task instruction）本体；触发行由 nudgeText 固定拼接
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
	/** 是否启用 stop 后上下文回滚：默认关闭，设 PI_WATCHDOG_ROLLBACK=1 开启（加载时读取，会话重载时刷新） */
	let rollbackEnabled = isRollbackEnvEnabled();
	/** 最近一次催促发送前的 leaf id + 催促全文，供 stop 后回滚校验 */
	let rollbackMark: { leafId: string; nudgeFullText: string } | null = null;
	/** 待执行的上下文回滚：stop_watchdog 调用后，把 nudge 交换从会话尾部砍掉 */
	let pendingRollback: { leafId: string; nudgeFullText: string; attempts: number; lastError?: string } | null = null;

	/** 截断错误文本，保证 notify 单行不超过终端宽度 */
	function truncateError(err: unknown, max = 80): string {
		const msg = err instanceof Error ? err.message : String(err);
		return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
	}

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

	/** 工具是否已注册：只在首次启动监控时注册一次，之后常驻不移出（保缓存前缀稳定） */
	let toolRegistered = false;

	/**
	 * 停止/挂起：清定时器、清状态栏。工具保持注册不移出（pi 无 unregisterTool，
	 * 且移出 active 集会破坏 prompt cache 前缀）。常驻模式下只临时挂起
	 * （新用户消息可恢复）；非常驻模式或 explicit=true 时彻底关闭。幂等。
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
			// 记录回滚点：发送前的 leaf。stop 后若 nudge 之后只有 stop 交换，可砸尾回滚
			// 仅在启用回滚时记录标记；默认关闭，stop 后上下文保持现状
			if (rollbackEnabled) {
				try {
					const leafId = (ctx.sessionManager as any)?.getLeafId?.();
					const fullText = nudgeText(state.message || undefined);
					rollbackMark = typeof leafId === "string" ? { leafId, nudgeFullText: fullText } : null;
				} catch {
					rollbackMark = null;
				}
			}
			// 空闲状态直接发送，触发新一轮
			pi.sendUserMessage(nudgeText(state.message || undefined));
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
		restored = false,
	) {
		// 首次启动才注册工具：未启用监控的会话里工具定义不进请求，不占 token；
		// 注册后常驻不移出，中途不再变更 tools 列表（保缓存前缀稳定）
		if (!toolRegistered) {
			toolRegistered = true;
			registerStopTool();
		}
		// 支持运行中重新 start：重置参数和计数
		teardown();
		state.keepAlive = keepAlive;
		state.running = true;
		state.timeoutMs = timeoutSeconds * 1000;
		state.message = message;
		if (maxNudges !== undefined) state.maxNudges = maxNudges;
		state.nudgeCount = 0;
		activeCtx = ctx;
		startTicker();
		ensureTerminalInputListener(ctx);

		// 若当前已空闲则考虑立即开始倒计时；否则等 agent_settled。
		// 启动时会话还没有本实例的消息时不倒计时（AI 还没开始干活，催促无意义），
		// 等第一轮 agent_settled 后再开始；恢复的会话（resume/fork）同理：历史消息不算活，
		// 用户没有别的操作就不开定时器，等 AI 真跑过一轮再说。
		if (ctx.isIdle()) {
			if (hasMessages(ctx) && !restored) {
				armCountdown(ctx);
			} else {
				renderStatus(ctx);
				const why = restored ? "恢复的会话，等待实际操作" : "会话暂无消息";
				ctx.ui.notify(`watchdog: ${why}，将在 AI 首次运行结束后开始倒计时`, "info");
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

	pi.on("session_start", async (event, ctx) => {
		rollbackEnabled = isRollbackEnvEnabled(); // 会话重载/切换时重新读取
		const envConfig = parseEnvConfig();
		if (envConfig?.ok && !state.running) {
			// env 启动与手动命令同走 startWatchdog；回滚能力由内部命令跳板提供，
			// 不依赖启动路径，因此无需借命令自举
			startWatchdog(
				ctx,
				envConfig.timeoutSeconds,
				envConfig.message ?? "", // 只传追加指令；触发行固定，语义不随自定义内容丢失
				envConfig.maxNudges,
				envConfig.keepAlive,
				isRestoredReason(event.reason), // 恢复的会话（/resume、/fork）不立即倒计时，等首次 agent_settled
			);
		} else {
			// 环境变量设了但解析失败：明确提示具体原因，而不是静默不启动
			const raw = process.env.PI_WATCHDOG?.trim();
			if (raw && raw !== "0" && raw !== "false" && raw !== "1" && raw !== "true") {
				const r = parseConfig(raw);
				if (!r.ok) {
					ctx.ui.notify(
						`watchdog: PI_WATCHDOG 格式无效（${r.error}），未自动启动。用法：PI_WATCHDOG="timeout=30 max=100 message=继续 mode=keep"`,
						"warning",
					);
				}
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

	// 回滚跳板：把 /watchdog-internal 命令经 pi.sendUserMessage 送进命令管线，
	// 借命令 ctx 拿到 navigateTree。注意扩展 API 的 pi.sendUserMessage 是
	// fire-and-forget：返回 undefined（AgentSession.sendUserMessage 才返回 Promise），
	// 底层失败（如 stop 后 abort 窗口内的 "This operation was aborted"）只会经
	// emitError 打到界面上，扩展侧拿不到 rejection，无法 .catch() 观察失败。
	// 因此以 watchdog-internal 命令是否消费掉 pendingRollback 作为"发送成功"回执：
	// 超时未消费就重发；命令侧一次性消费，重复发送只会空跑，安全。
	function sendRollbackJump() {
		const pr = pendingRollback;
		if (!pr) return;
		if (activeCtx && !activeCtx.isIdle()) {
			// stop_watchdog 的 ctx.abort() 窗口内发送会被吞（"This operation was aborted"），
			// 等回合真正结束后再发（等待不计次数，上限由重试链兜底）
			setTimeout(() => sendRollbackJump(), 200);
			return;
		}
		try {
			(pi.sendUserMessage as any)(`/watchdog-internal op=rollback target=${pr.leafId}`, {
				expandPromptTemplates: true,
			});
		} catch (err) {
			// 同步抛出：记录真实错误，最终告警时截断展示
			pr.lastError = err instanceof Error ? err.message : String(err);
		}
		pr.attempts += 1;
		setTimeout(() => retryRollbackJump(pr), 300 * pr.attempts); // 递增退避：300ms → 600ms → 1200ms
	}

	function retryRollbackJump(pr: NonNullable<typeof pendingRollback>) {
		if (pendingRollback !== pr) return; // 命令已消费（或会话关闭已清理），跳板完成使命
		if (pr.attempts >= 3) {
			// 彻底放弃本次回滚：不清掉的话残留目标会在之后每个 agent_settled
			// 反复重发跳板（且 attempts 已超限，每轮都会再告警一次）。
			// 放弃的后果是良性的：催促交换留在上下文，不影响正确性。
			pendingRollback = null;
			// 异步 rejection 由 runtime 吞掉并打横幅，扩展侧拿不到；
			// 未捕获到同步错误时，标注最可能的已知原因，截断后展示
			const cause = pr.lastError
				? truncateError(pr.lastError)
				: "This operation was aborted（abort 窗口内 rejection 被 runtime 吞掉）";
			activeCtx?.ui.notify(
				`watchdog: 连发 3 次回滚请求都没成功，本次不回滚了。刚才那轮“催促 AI 继续干活”的对话会留在会话记录里，不影响使用。（原因：${cause}）`,
				"warning",
			);
			return;
		}
		if (activeCtx && !activeCtx.isIdle()) {
			// 有回合在跑：可能是上一次发送已落地，等它结束再决定是否重发
			setTimeout(() => retryRollbackJump(pr), 600);
			return;
		}
		sendRollbackJump();
	}

	pi.on("agent_settled", async (_event, ctx) => {
		// stop_watchdog 刚被调用：把本次 nudge 交换从上下文砸尾回滚。
		// 通过内部命令跳板拿到 command ctx（只有命令 handler 才有 navigateTree）。
		// 注意放在 running 检查之前：stop 后 running 已是 false。
		// 不在此处消费 pendingRollback，由 watchdog-internal 命令统一消费。
		if (pendingRollback) sendRollbackJump();
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
		pendingRollback = null;
	});

	// ---------- 给 AI 的停止工具 ----------

	/** 注册 stop_watchdog 工具。由 startWatchdog 首次启动时调用（pi.registerTool 支持 startup 后调用） */
	function registerStopTool() {
		pi.registerTool({
			name: TOOL_NAME,
			label: "停止自动继续",
			description: "Ends the turn immediately; call only after a watchdog nudge when no work remains.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				if (!state.running) {
					return {
						content: [
							{
								type: "text",
								text: state.suspended
									? "Already suspended. Nothing to do — end your turn normally."
									: 'Watchdog is not running. Only call this after a "[Automated, not user input]" nudge.',
							},
						],
						details: {},
					};
				}
				teardown(ctx, false);
				// 记录待回滚标记：agent_settled 后经内部命令砸尾，把 nudge 交换从上下文移除
				if (rollbackMark) {
					pendingRollback = { ...rollbackMark, attempts: 0 };
					rollbackMark = null;
				}
				const suspendedNow = state.keepAlive;
				ctx.ui.notify(
					suspendedNow
						? "watchdog: AI 已调用 stop_watchdog，常驻监控挂起（下次发消息自动恢复）"
						: "watchdog: AI 已调用 stop_watchdog，监控已停止（回合结束）",
					"info",
				);
				// 模拟用户按 ESC（app.interrupt）：stop_watchdog 之后 AI 通常只剩收尾文字或多余动作，
				// 直接中止当前回合，强行截断 LLM 的后续回复。与 ESC 走同一路径（agent.abort()）。
				if (!ctx.isIdle()) ctx.abort();
				return {
					content: [
						{
							type: "text",
							text: "OK.",
						},
					],
					details: {},
				};
			},
		});
	}

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
						`watchdog: 运行中 · ${countdown} · 已催 ${state.nudgeCount}/${state.maxNudges} · 追加指令: "${msgPreview || "-"}"`,
						"info",
					);
					break;
				}

				default: {
					// 启动：/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]
					// 与环境变量共用同一解析器，严格 key=value，非法参数提示用法而非静默当文案
					const config = parseConfig(args);
					const cfg = config.ok ? config : undefined;
					if (args.trim() && !config.ok) {
						ctx.ui.notify(
							`watchdog: 参数无效（${config.error}）。用法：/watchdog [timeout=秒] [max=次数] [message=文案] [mode=once|keep]，例如 /watchdog timeout=30 message=继续 mode=keep`,
							"warning",
						);
						break;
					}
					startWatchdog(
						ctx,
						cfg?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
						cfg?.message ?? "", // 追加指令；未指定时为空，不沿用上一次的（避免隐式状态残留）
						cfg?.maxNudges,
						cfg?.keepAlive ?? false,
					);
					break;
				}
			}
		},
	});

	// ---------- 内部回滚命令 ----------
	// 隐藏命令（无 description，不进补全列表）：唯一调用方是 agent_settled 里的
	// sendUserMessage 跳板，作用是把命令专属的 command ctx（含 navigateTree）带进扩展。
	pi.registerCommand("watchdog-internal", {
		handler: async (args, cmdCtx) => {
			const pr = pendingRollback;
			pendingRollback = null; // 只在命令里消费一次
			if (!pr) return;
			const target = /(?:^|\s)target=(\S+)/.exec(args)?.[1];
			if (!target || target !== pr.leafId) return; // 参数不匹配（防误调）
			const sm: any = cmdCtx.sessionManager;
			if (!validateRollbackTail(sm, target, pr.nudgeFullText)) {
				// 尾部有真活，放弃回滚并明示原因（否则静默失败无从排查）
				cmdCtx.ui.notify(
					"watchdog: 没有回滚：停止之后会话里又出现了新的真实对话内容（不是刚才那轮催促），删掉会连带删掉它们。",
					"warning",
				);
				return;
			}
			try {
				await (cmdCtx as any).navigateTree(target, { summarize: false });
				cmdCtx.ui.notify(
					"watchdog: 已回滚：把刚才那轮“催促 AI 继续干活”的对话从会话记录里删掉了，上下文回到催促前。",
					"info",
				);
			} catch (err) {
				// navigateTree 失败则保留现状（nudge 交换留在上下文，不影响正确性），但要可见
				const msg = err instanceof Error ? err.message : String(err);
				cmdCtx.ui.notify(
					`watchdog: 没有回滚：切回之前的会话位置时出错（${msg}）。刚才那轮“催促 AI 继续干活”的对话会留在会话记录里，不影响使用。`,
					"warning",
				);
			}
		},
	});
}
