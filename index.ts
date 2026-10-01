import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_NUDGES = 50;
/** 催促触发行：固定语义，永不缺席（message= 只追加 Task instruction，不会替换本行） */
export const DEFAULT_MESSAGE =
	"[Automated, not user input] If work remains, continue working (no reply needed). " +
	"If waiting on a user decision, don't change code — state what you need, then call stop_watchdog as your final action. " +
	"If no work remains and no decision is pending, call stop_watchdog to end the turn.";

/** 组装继续消息（真正触发工作回合）：固定触发行 + 可选追加指令（message=），自定义内容不会替换触发行语义。 */
export function nudgeText(hint?: string): string {
	return hint ? `${DEFAULT_MESSAGE}\n\nTask instruction: ${hint}` : DEFAULT_MESSAGE;
}

/**
 * 决策回合提示词（折叠区间的起点）。
 * 这一回合禁止干活：除 stop_watchdog 外的工具全被拦截，模型只能
 *   1) 回文字 = 还有活（下一步由 watchdog 发继续消息让它开工），或
 *   2) 调 stop_watchdog = 没活 / 等用户。
 * 因为决策回合不产生任何需要保留的工作，它的全部内容能作为一个封闭交换被折叠掉，
 * 而后续工作回合追加在其后，prompt cache 前缀保持稳定。
 */
export function decisionText(): string {
	return (
		"[Automated, not user input] Watchdog check — do not use tools in this turn. " +
		"Reply with a brief acknowledgement if work remains; the watchdog will send the actual continue " +
		"instruction in the next turn. If no work remains, or you are waiting on a user decision, call " +
		"stop_watchdog as your final action."
	);
}

/** 用户最后一次按键后多久内视为「仍在操作」（上下选择、翻历史等），期间暂停倒计时 */
const ACTIVITY_GRACE_MS = 2000;

const TOOL_NAME = "stop_watchdog";

/** nudge/continuation/fold 三类可折叠消息共用的关联载荷版本 */
export const WATCHDOG_MESSAGE_VERSION = 1;
/** 决策消息（原催促触发行）：display:false，携带 exchangeId 供上下文折叠关联 */
export const NUDGE_MESSAGE_TYPE = "pi-watchdog:nudge";
/** 继续消息：决策结果为 continue 时发出，触发真正的工作回合，兼作折叠区间终止标记 */
export const CONTINUATION_MESSAGE_TYPE = "pi-watchdog:continuation";
/** 停止标记：决策结果为 stop 时写入，供折叠删除整个决策交换 */
export const FOLD_MESSAGE_TYPE = "pi-watchdog:fold";
/** 决策卡片：TUI-only 条目（appendEntry，不进上下文、不参与折叠），展示一次决策检查的结果与 AI 回复 */
export const DECISION_ENTRY_TYPE = "pi-watchdog:decision";
/** 决策卡片里 AI 回复的最大留存长度（会话文件体积 vs 可读性） */
const DECISION_REPLY_MAX_CHARS = 300;

/** 决策卡片的持久化载荷（写入 session 的 CustomEntry，不进 LLM 上下文） */
export interface DecisionCardData {
	version: number;
	exchangeId: string;
	outcome: "continue" | "stop" | "superseded";
	/** 决策回合里 AI 的回复文本（已截断）；被拦截工具调用附带的文字也在此 */
	reply?: string;
	nudgeCount: number;
	maxNudges: number;
	ts: number;
}

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
 *   PI_WATCHDOG_ON_STOP="<shell命令>"          stop_watchdog 被调用时执行的钩子（如写 exit 文件、tmux wait-for -S 发完成信号）
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

/**
 * 会话是否来自「恢复」而非全新开始：/resume 换会话（resume）、/fork / /clone 恢复旧树点（fork）。
 * 恢复进来的会话虽有历史消息，但本进程实例里 AI 还没干过活，立即倒计时会在用户
 * 只是想翻看旧会话时空催一轮——与「空会话等首次 agent_settled」同一原则。
 */
function isRestoredReason(reason: string | undefined): boolean {
	return reason === "resume" || reason === "fork";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 assistant 消息 content 里抽出纯文本（决策卡片用；忽略 toolCall / thinking 等块） */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 只把「合法关联的决策消息」当作折叠起点，其它一切 custom 消息都不动 */
function messageExchangeId(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "custom") return undefined;
	if (message.customType !== NUDGE_MESSAGE_TYPE) return undefined;
	const details = message.details;
	if (!isRecord(details) || details.version !== WATCHDOG_MESSAGE_VERSION) return undefined;
	const exchangeId = details.exchangeId;
	return typeof exchangeId === "string" && exchangeId.length > 0 ? exchangeId : undefined;
}

function sameExchange(message: unknown, customType: string, exchangeId: string): boolean {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== customType) return false;
	const details = message.details;
	if (!isRecord(details) || details.version !== WATCHDOG_MESSAGE_VERSION) return false;
	return details.exchangeId === exchangeId;
}

/**
 * 折叠一次决策交换（纯函数：结果只从消息本身推导，因此 resume/reload 后同样成立）。
 *
 * 删除区间 = [决策消息, 终止标记)：
 *  - 终止标记是同 exchangeId 的 continuation → 删掉整段决策交换、保留 continuation，
 *    后续工作回合就追加在它后面；
 *  - 终止标记是同 exchangeId 的折叠标记（stop = AI 主动停；superseded = 决策期间用户接管/
 *    回合出错而没有产出继续消息）→ 连标记一起删。
 * 区间内允许 assistant / toolResult（被拦截工具的结果也在区间里，成对一起删，不会破坏 tool_use 配对）。
 * 出现真实 user 消息、其它插件 custom、或另一个 exchange 的 watchdog 消息 → fail closed（原样保留）。
 * 找不到终止标记（决策回合还在进行中）→ 同样保留，否则模型将看不到决策提示词。
 */
export function foldWatchdogContext<T extends object>(messages: T[]): T[] {
	const drop = new Array<boolean>(messages.length).fill(false);
	for (let i = 0; i < messages.length; i += 1) {
		const exchangeId = messageExchangeId(messages[i]);
		if (exchangeId === undefined) continue;
		let end = -1; // 删除区间 [i, end)
		let complete = false;
		for (let j = i + 1; j < messages.length; j += 1) {
			const message: unknown = messages[j];
			if (isRecord(message) && message.role === "custom") {
				if (sameExchange(message, CONTINUATION_MESSAGE_TYPE, exchangeId)) {
					end = j; // 保留 continuation 本身
					complete = true;
				} else if (sameExchange(message, FOLD_MESSAGE_TYPE, exchangeId)) {
					end = j + 1; // 折叠标记一并删除
					complete = true;
				}
				break; // 其它 custom（含其它 exchange）一律视作边界，fail closed
			}
			if (isRecord(message) && (message.role === "assistant" || message.role === "toolResult")) continue;
			break; // 真实 user 消息 / 摘要等 → fail closed
		}
		if (!complete || end < 0) continue;
		for (let k = i; k < end; k += 1) drop[k] = true;
		i = end - 1;
	}
	return drop.some(Boolean) ? messages.filter((_, index) => !drop[index]) : messages;
}

/** 每次 provider 请求前注册折叠：只改请求视图，不碰会话记录 */
export function registerWatchdogContextFolding(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({ messages: foldWatchdogContext(event.messages) }));
}

const DECISION_OUTCOME_LABEL: Record<DecisionCardData["outcome"], string> = {
	continue: "还有活 → 继续",
	stop: "AI 主动停止",
	superseded: "用户接管，本次检查作废",
};

const DECISION_OUTCOME_COLOR: Record<DecisionCardData["outcome"], "accent" | "success" | "warning"> = {
	continue: "accent",
	stop: "success",
	superseded: "warning",
};

/** 被用户点击展开过的决策卡片（按 exchangeId）：跨 rebuild（全局 ctrl+o / 主题变化）保留单卡展开态 */
const expandedDecisionCards = new Set<string>();

/**
 * 决策卡片组件：把每次决策检查的结果（继续 / 主动停止 / 用户接管）展示在 TUI 时间线里。
 * 数据来自 appendEntry 的 CustomEntry——纯 TUI，不进上下文，也不参与折叠。
 *
 * 决策回合的 AI 回复已经随决策交换折叠出上下文，默认不再原样铺在时间线上：
 * 未展开时只留一行灰字说明「已折叠」，全屏下点击卡片、或按 `ctrl+o` 全局展开后才显示全文。
 */
class DecisionCardComponent implements Component {
	private expanded: boolean;
	private box: Box;

	constructor(
		private readonly data: DecisionCardData,
		private readonly theme: Theme,
		expanded: boolean,
	) {
		this.expanded = expanded;
		this.box = this.build();
	}

	private build(): Box {
		const { data, theme } = this;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				`${theme.fg("muted", "⏱")} ${theme.fg(
					DECISION_OUTCOME_COLOR[data.outcome],
					DECISION_OUTCOME_LABEL[data.outcome],
				)} ${theme.fg("dim", `(第 ${data.nudgeCount}/${data.maxNudges} 次检查)`)}`,
				0,
				0,
			),
		);
		if (data.reply) {
			const hint = this.expanded ? `AI：${data.reply}` : "（决策回复已折叠 · 点击或 ctrl+o 展开）";
			box.addChild(new Text(theme.fg("dim", hint), 0, 0));
		}
		return box;
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left" || !this.data.reply) return undefined;
		this.expanded = !this.expanded;
		if (this.expanded) expandedDecisionCards.add(this.data.exchangeId);
		else expandedDecisionCards.delete(this.data.exchangeId);
		this.box = this.build();
		return { handled: true };
	}

	invalidate(): void {
		this.box.invalidate();
	}
}

export function registerDecisionCardRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<DecisionCardData>(DECISION_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return new DecisionCardComponent(data, theme, expanded || expandedDecisionCards.has(data.exchangeId));
	});
}

export default function (pi: ExtensionAPI) {
	// 卡片渲染器必须在加载时就注册（而非启动监控时），这样 /resume 恢复的历史决策卡片也能渲染。
	registerDecisionCardRenderer(pi);

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
	/**
	 * 决策窗口：决策消息发出 → 该回合 settle 之间。窗口内除 stop_watchdog 外的工具全部拦截，
	 * 保证这一回合只产出可折叠的决策交换，不产出需要保留的真实工作。
	 */
	let decisionWindow: { exchangeId: string; stopCalled: boolean; replyText?: string } | null = null;
	let exchangeCounter = 0;

	/** 生成一次决策交换的关联 id（决定哪些消息属于同一可折叠区间） */
	function createExchangeId(): string {
		exchangeCounter += 1;
		return `w${Date.now().toString(36)}-${exchangeCounter}`;
	}

	/**
	 * 向其它扩展发布 watchdog 的生命周期真值。agent_settled 只表示 Pi 当前一轮结束，
	 * 不能表达 watchdog 稍后还会 sendUserMessage；状态集成应以 running 为准。
	 */
	function publishState() {
		pi.events.emit("watchdog:state", {
			running: state.running,
			suspended: state.suspended,
			keepAlive: state.keepAlive,
			countdownArmed: state.countdownDeadline != null,
			paused: state.pausedByInput || state.pausedByActivity,
			nudgeCount: state.nudgeCount,
			maxNudges: state.maxNudges,
			timeoutMs: state.timeoutMs,
		});
	}

	// 查询/响应避免依赖扩展加载顺序，也让 /reload 后的消费者拿到当前真值。
	pi.events.on("watchdog:state:query", publishState);

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
	function teardown(ctx?: ExtensionContext, explicit = true, publish = true) {
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
		if (publish) publishState();
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
		publishState();
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
			const exchangeId = createExchangeId();
			decisionWindow = { exchangeId, stopCalled: false };
			// marker 走 appendEntry（CustomEntry 不进上下文），跨 resume/reload 也能识别这次交换
			pi.appendEntry("pi-watchdog:nudge-marker", { version: WATCHDOG_MESSAGE_VERSION, exchangeId });
			// 决策回合：display:false 不污染 TUI 历史；details 里的 exchangeId 让 context 钩子定位这段交换
			pi.sendMessage(
				{
					customType: NUDGE_MESSAGE_TYPE,
					content: decisionText(),
					display: false,
					details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ctx.ui.notify(`watchdog: 已发起继续检查 (${state.nudgeCount}/${state.maxNudges})`, "info");
		} catch {
			// 极小概率竞态：发送瞬间 AI 开始运行。不计入次数，等 agent_settled 重新倒计时
			decisionWindow = null;
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
		// 支持运行中重新 start：重置参数和计数。内部重启不发布瞬时 false，
		// 避免状态集成误判完成并响铃。
		teardown(undefined, true, false);
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
		publishState();
	}

	// ---------- 事件 ----------

	// 每次 provider 请求前折叠决策交换：只影响请求视图，不碰会话记录，
	// 因此无需 beta 开关、也不依赖 navigateTree / 命令跳板。
	registerWatchdogContextFolding(pi);

	pi.on("session_start", async (event, ctx) => {
		const envConfig = parseEnvConfig();
		if (envConfig?.ok && !state.running) {
			// env 启动与手动命令同走 startWatchdog；上下文折叠由 context 钩子统一处理，与启动路径无关
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

	// 决策窗口内拦截除 stop_watchdog 外的所有工具：这一回合只允许产出决策，
	// 不产出需要保留的真实工作（这也让整段交换成为一个可整体折叠的封闭区间）。
	// 被拦截的 toolCall + 它的 toolResult 成对落在折叠区间里，一起删除，不会破坏 tool_use 配对。
	pi.on("tool_call", async (event) => {
		if (decisionWindow === null) return;
		if (event.toolName === TOOL_NAME) return;
		return {
			block: true,
			reason:
				"Watchdog decision turn: tools are blocked. Reply with a brief acknowledgement if work remains; " +
				"the watchdog will send the continue instruction next. Otherwise call stop_watchdog.",
		};
	});

	// 决策回合的模型回复只是「还有活」的确认，会被折叠掉、没有上下文价值：落盘前剥掉，
	// 避免它进会话文件与压缩摘要，也避免这段已折叠内容在 TUI 里以原始消息的形式再次出现。
	// 只剥掉 text 块；tool_use 要与 toolResult 配对、thinking 块带签名需随 tool_use 回传，
	// 都原样保留（否则 Anthropic 扩展思考 + 工具调用的回合会因缺块报错）。
	// 剥离前把文字抄进决策卡片（TUI-only entry），卡片默认收成一行灰字提示。
	pi.on("message_end", async (event) => {
		if (decisionWindow === null) return;
		if (event.message.role !== "assistant") return;
		const content = (event.message as { content?: unknown }).content;
		const hasToolCall =
			Array.isArray(content) &&
			content.some((block) => isRecord(block) && (block.type === "toolCall" || block.type === "tool_use"));
		const text = textFromContent(content);
		if (text) decisionWindow.replyText = text.slice(0, DECISION_REPLY_MAX_CHARS);
		return {
			message: {
				...event.message,
				content: hasToolCall
					? (content as unknown[]).filter((block) => !(isRecord(block) && block.type === "text"))
					: [],
			},
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// 决策窗口收口：这一回合的结果决定「继续」还是「停止」，并落下折叠终止标记。
		// 必须放在 running 检查之前——stop_watchdog 已把 running 置 false，但我们仍要落 stop 标记。
		const window = decisionWindow;
		decisionWindow = null;
		if (window !== null) {
			// 用户在决策回合内插话 / 回合没回到空闲 → 这次检查作废（superseded）：
			// 必须落终止标记，否则「无终态=保留」的保护会让决策提示词永久留在上下文里。
			const superseded = !ctx.isIdle() || ctx.hasPendingMessages();
			const outcome: DecisionCardData["outcome"] = window.stopCalled ? "stop" : superseded ? "superseded" : "continue";
			if (window.stopCalled || superseded) {
				pi.sendMessage(
					{
						customType: FOLD_MESSAGE_TYPE,
						content: "",
						display: false,
						details: {
							version: WATCHDOG_MESSAGE_VERSION,
							exchangeId: window.exchangeId,
							outcome,
						},
					},
					{ triggerTurn: false },
				);
			} else {
				// 模型没调 stop_watchdog → 还有活：发继续消息触发真正的工作回合。
				// continuation 本身就是折叠区间的终止标记，也是整段交换里唯一保留下来的消息。
				pi.sendMessage(
					{
						customType: CONTINUATION_MESSAGE_TYPE,
						content: nudgeText(state.message || undefined),
						display: true,
						details: { version: WATCHDOG_MESSAGE_VERSION, exchangeId: window.exchangeId },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			// 决策卡片：TUI-only，展示这次检查做了什么（结果 + AI 回复）。写在 sendMessage 之后，
			// 让卡片在时间线上落在继续消息附近；CustomEntry 不进上下文，折叠语义不受影响。
			pi.appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
				version: WATCHDOG_MESSAGE_VERSION,
				exchangeId: window.exchangeId,
				outcome,
				reply: window.replyText,
				nudgeCount: state.nudgeCount,
				maxNudges: state.maxNudges,
				ts: Date.now(),
			});
		}
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

	pi.on("session_shutdown", async (event, ctx) => {
		// reload 只是毫秒级重绑扩展，不应向状态集成广播一次假完成。
		decisionWindow = null;
		teardown(ctx, true, event.reason !== "reload");
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
				// PI_WATCHDOG_ON_STOP 钩子：stop_watchdog 被调用时执行外部命令（写 exit 文件、
				// 发 tmux wait-for -S done 等完成信号），供父进程（如 subagent 扩展）等待子 agent 结束。
				const onStop = process.env.PI_WATCHDOG_ON_STOP?.trim();
				if (onStop) {
					spawn("sh", ["-c", onStop], { stdio: "ignore", detached: true }).unref();
				}
				teardown(ctx, false);
				// 决策窗口内调用 = 决策结果为「停止」；折叠终止标记在 agent_settled 里落
				if (decisionWindow !== null) decisionWindow.stopCalled = true;
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
}
