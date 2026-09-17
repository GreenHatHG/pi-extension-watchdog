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
	const notifications: { msg: string; kind: string }[] = [];
	const sessionEntries: any[] = [{ type: "message" }]; // 默认已有对话消息（模拟非空会话）；需要全新会话的用例显式清空
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
		sendUserMessage: (content: string) => {
			if (!idle) throw new Error("busy");
			sentMessages.push(content);
			idle = false; // 模拟真实 pi：发消息触发一轮 agent 运行
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

	/** 模拟 agent 跑完一轮：回到空闲并触发 agent_settled（watchdog 由此重新倒计时） */
	const settleAfterRun = async () => {
		sessionEntries.push({ type: "message" }); // 模拟本轮产生了一条会话消息
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
		newPlugin,
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
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
