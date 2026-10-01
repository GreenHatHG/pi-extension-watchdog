/**
 * 共享的 pi 运行时 mock：模拟 extension 注册、工具/命令、active tools、
 * 空闲状态、终端按键广播、custom message 落盘与 context 折叠钩子。
 * 每个测试创建独立实例，互不污染。
 */
export type Handler = (event: any, ctx: any) => Promise<any>;

export function createMockRuntime() {
	const handlers = new Map<string, Handler[]>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	// 模拟 pi 的 active tools：registerTool 注册的工具默认进入 active 集合
	const activeTools = new Set<string>(["read", "bash", "edit", "write"]);
	// sendUserMessage / sendMessage 发出的文本（折叠标记等空内容内部标记不计入）
	const sentMessages: string[] = [];
	// 每次 sendMessage 的完整载荷（含 customType / details / options），供折叠与关联断言
	const customMessages: { customType: string; content: any; display: boolean; details: any; options: any }[] = [];
	// appendEntry 写入的 CustomEntry（不进 LLM 上下文）
	const entries: { customType: string; data: any }[] = [];
	// registerEntryRenderer 注册的渲染器（供决策卡片渲染断言）
	const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	let abortedTurns = 0;
	const notifications: { msg: string; kind: string }[] = [];
	const sessionEntries: any[] = [{ type: "message" }]; // 默认已有对话消息（模拟非空会话）；需要全新会话的用例显式清空
	let leafId: string | null = null;
	const setLeaf = (id: string | null) => {
		leafId = id;
	};
	const statusBars = new Map<string, string | undefined>();
	let idle = true;
	let editorText = "";
	let pendingMessages = 0;
	// 模拟 pi 的原始终端按键广播：watchdog 注册的 onTerminalInput 监听器都在这里
	const inputListeners = new Set<(data: string) => any>();

	const ctx: any = {
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages > 0,
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

	let entrySeq = 0;
	/** 模拟真实 pi：消息随回合落盘为条目并推进 leaf */
	const pushMessage = (message: any) => {
		entrySeq += 1;
		const entry: any = { type: "message", id: `m${entrySeq}`, message };
		sessionEntries.push(entry);
		setLeaf(entry.id);
		return entry;
	};

	const pi = {
		events: {
			on: (name: string, handler: (data: unknown) => void) => {
				if (!eventBusHandlers.has(name)) eventBusHandlers.set(name, new Set());
				eventBusHandlers.get(name)!.add(handler);
				return () => eventBusHandlers.get(name)?.delete(handler);
			},
			emit: (name: string, data?: unknown) => {
				for (const handler of eventBusHandlers.get(name) ?? []) handler(data);
			},
		},
		on: (name: string, handler: Handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name)!.push(handler);
		},
		registerTool: (tool: any) => {
			tools.set(tool.name, tool);
			activeTools.add(tool.name); // 模拟真实 pi：注册的工具默认进入 active 集合
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerMessageRenderer: () => {},
		registerEntryRenderer: (customType: string, renderer: any) => entryRenderers.set(customType, renderer),
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		sendMessage: (message: any, options?: any) => {
			customMessages.push({ ...message, options });
			const text = typeof message.content === "string" ? message.content : "";
			// 折叠终止标记是空内容内部标记，不算「发给模型的文本」
			if (text) sentMessages.push(text);
			pushMessage({
				role: "custom",
				customType: message.customType,
				content: text,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
			if (options?.triggerTurn) idle = false; // custom message 触发新一轮运行
		},
		sendUserMessage: async (content: string, options?: any) => {
			// 模拟真实 pi：expandPromptTemplates 时斜杠命令在 prompt 入口被拦截执行，
			// 不会作为用户消息发送，也不会触发 agent 运行
			if (options?.expandPromptTemplates !== false && content.startsWith("/")) {
				const space = content.indexOf(" ");
				const name = space === -1 ? content.slice(1) : content.slice(1, space);
				const args = space === -1 ? "" : content.slice(space + 1);
				const cmd = commands.get(name);
				if (cmd) {
					await cmd.handler(args, ctx);
					return;
				}
			}
			if (!idle) throw new Error("busy");
			sentMessages.push(content);
			pushMessage({ role: "user", content });
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

	/** 按 pi 的 context 钩子语义跑一遍折叠（deep-copy 由真实 pi 负责；这里直接改数组副本） */
	const emitContext = async (messages: any[]) => {
		let current = messages;
		for (const h of handlers.get("context") ?? []) {
			const result = await h({ type: "context", messages: current }, ctx);
			if (result?.messages) current = result.messages;
		}
		return current;
	};

	/** 触发 tool_call 钩子并返回第一个非空结果（模拟 pi 的拦截语义） */
	const emitToolCall = async (event: any) => {
		for (const h of handlers.get("tool_call") ?? []) {
			const result = await h({ type: "tool_call", ...event }, ctx);
			if (result) return result;
		}
		return undefined;
	};

	/** 触发 message_end 钩子并返回第一个非空结果（模拟 pi 的消息替换） */
	const emitMessageEnd = async (message: any) => {
		for (const h of handlers.get("message_end") ?? []) {
			const result = await h({ type: "message_end", message }, ctx);
			if (result) return result;
		}
		return undefined;
	};

	/** 当前会话分支对应的 AgentMessage 列表（custom message 以 role:"custom" 呈现） */
	const currentMessages = () => sessionEntries.map((e: any) => e?.message).filter((m: any) => m !== undefined);

	/** 模拟用户按下一个键（上下选择命令、翻历史等任意按键） */
	const pressKey = () => {
		for (const l of inputListeners) l("x");
	};

	/** 模拟 agent 跑完一轮：回到空闲并触发 agent_settled（watchdog 由此重新倒计时） */
	const settleAfterRun = async () => {
		entrySeq += 1;
		const entry: any = { type: "message", id: `s${entrySeq}` };
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
		emitContext,
		emitToolCall,
		emitMessageEnd,
		currentMessages,
		pressKey,
		settleAfterRun,
		settleAbortedTurn,
		newPlugin,
		pushMessage,
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
			get pendingMessages() {
				return pendingMessages;
			},
			set pendingMessages(v: number) {
				pendingMessages = v;
			},
			get abortedTurns() {
				return abortedTurns;
			},
		},
		tools,
		commands,
		activeTools,
		sentMessages,
		customMessages,
		entries,
		entryRenderers,
		notifications,
		statusBars,
		sessionEntries,
		eventBusHandlers,
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
