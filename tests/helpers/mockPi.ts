/**
 * 共享的 pi 运行时 mock：模拟 extension 注册、工具/命令、active tools、
 * 空闲状态、终端按键广播。每个测试创建独立实例，互不污染。
 */
export type Handler = (event: any, ctx: any) => Promise<any>;

export function createMockRuntime() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	// 模拟 pi 的 active tools：registerTool 注册的工具默认进入 active 集合
	const activeTools = new Set<string>(["read", "bash", "edit", "write"]);
	const sentMessages: string[] = [];
	let abortedTurns = 0;
	const rollbackCalls: string[] = [];
	const notifications: { msg: string; kind: string }[] = [];
	const sessionEntries: any[] = [{ type: "message" }]; // 默认已有对话消息（模拟非空会话）；需要全新会话的用例显式清空
	// 会话树 helpers：模拟真实 SessionManager 的 leaf 语义（真实测试用例可用 markLeaf 给任意条目设置 id）
	let leafId: string | null = null;
	const setLeaf = (id: string | null) => {
		leafId = id;
	};
	const statusBars = new Map<string, string | undefined>();
	let idle = true;
	let editorText = "";
	// 模拟 pi 的原始终端按键广播：watchdog 注册的 onTerminalInput 监听器都在这里
	const inputListeners = new Set<(data: string) => any>();

	const ctx: any = {
		isIdle: () => idle,
		// 模拟真实 pi：中止当前 agent 回合并回到空闲
		abort: () => {
			abortedTurns++;
			idle = true;
		},
		sessionManager: {
			getBranch: () => sessionEntries,
			getLeafId: () => leafId,
			getEntry: (id: string) => sessionEntries.find((e: any) => e?.id === id),
		},
		ui: {
			notify: (msg: string, kind = "info") => notifications.push({ msg, kind }),
			setWidget: () => {},
			getEditorText: () => editorText,
			setStatus: (key: string, val: string | undefined) => statusBars.set(key, val),
			onTerminalInput: (handler: (data: string) => any) => {
				inputListeners.add(handler);
				return () => inputListeners.delete(handler);
			},
		},
	};

	const pi = {
		on: (name: string, handler: Handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name)!.push(handler);
		},
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
			activeTools.add(tool.name); // 模拟真实 pi：注册的工具默认进入 active 集合
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		sendUserMessage: async (content: string, options?: any) => {
			// 模拟真实 pi：expandPromptTemplates 时斜杠命令在 prompt 入口被拦截执行，
			// 不会作为用户消息发送，也不会触发 agent 运行
			if (options?.expandPromptTemplates !== false && content.startsWith("/")) {
				const space = content.indexOf(" ");
				const name = space === -1 ? content.slice(1) : content.slice(1, space);
				const args = space === -1 ? "" : content.slice(space + 1);
				const cmd = commands.get(name);
				if (cmd) {
					// 模拟 ExtensionCommandContext：普通 ctx + navigateTree
					const cmdCtx: any = {
						...ctx,
						navigateTree: (targetId: string) => {
							rollbackCalls.push(targetId);
							// 模拟真实 navigateTree：从 branch 里砍掉 target 之后的所有条目
							const idx = sessionEntries.findIndex((e: any) => e?.id === targetId);
							if (idx !== -1) sessionEntries.splice(idx + 1);
						},
					};
					await cmd.handler(args, cmdCtx);
					return;
				}
			}
			if (!idle) throw new Error("busy");
			sentMessages.push(content);
			// 模拟真实 pi：消息随回合启动落盘为 user 消息条目并推进 leaf
			appendNudgeMessage(content);
			idle = false;
		},
		getActiveTools: () => Array.from(activeTools),
		setActiveTools: (names: string[]) => {
			activeTools.clear();
			for (const n of names) activeTools.add(n);
		},
	};

	/** 触发一个事件（按注册顺序调用所有 handler） */
	const emit = async (name: string, event: any = {}) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};

	/** 模拟用户按下一个键（上下选择命令、翻历史等任意按键） */
	const pressKey = () => {
		for (const l of inputListeners) l("x");
	};

	/** 模拟催促消息落盘：push 一条 user 消息并置 leaf（与真实 pi 的 appendMessage 对齐） */
	const appendNudgeMessage = (text: string) => {
		const entry: any = { type: "message", id: `n${sessionEntries.length}`, message: { role: "user", content: text } };
		sessionEntries.push(entry);
		setLeaf(entry.id);
	};

	/** 模拟 agent 跑完一轮：回到空闲并触发 agent_settled（watchdog 由此重新倒计时） */
	const settleAfterRun = async () => {
		const entry: any = { type: "message", id: `m${sessionEntries.length}` };
		sessionEntries.push(entry); // 模拟本轮产生了一条会话消息
		setLeaf(entry.id);
		await emit("agent_end");
		idle = true;
		await emit("agent_settled");
	};

	/** 模拟被中止的回合结束：不追加新消息（tool result 已落盘），直接 settle */
	const settleAbortedTurn = async () => {
		await emit("agent_end");
		idle = true;
		await emit("agent_settled");
	};

	/** 创建一个全新的插件实例（default(pi) 每次调用都创建全新 state） */
	const newPlugin = async () => {
		const mod = await import("../../index.ts");
		mod.default(pi as any);
	};

	return {
		pi,
		ctx,
		emit,
		pressKey,
		settleAfterRun,
		settleAbortedTurn,
		newPlugin,
		appendNudgeMessage,
		setLeaf,
		state: {
			get idle() {
				return idle;
			},
			set idle(v: boolean) {
				idle = v;
			},
			get editorText() {
				return editorText;
			},
			set editorText(v: string) {
				editorText = v;
			},
			get abortedTurns() {
				return abortedTurns;
			},
		},
		tools,
		commands,
		activeTools,
		sentMessages,
		notifications,
		statusBars,
		sessionEntries,
		rollbackCalls,
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
