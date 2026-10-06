/**
 * Shared pi runtime mock: fakes extension registration, tools and commands, run idle state, raw key broadcasts,
 * custom message saving, and the context fold hook. Every test gets its own instance, so nothing leaks.
 */
export type Handler = (event: any, ctx: any) => Promise<any>;

export function createMockRuntime() {
	const handlers = new Map<string, Handler[]>();
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	// Like real pi: a registered tool joins the active set by default.
	const activeTools = new Set<string>(["read", "bash", "edit", "write"]);
	// Text sent by sendUserMessage / sendMessage; fold markers are empty and not counted.
	const sentMessages: string[] = [];
	// Full payload of each sendMessage, for fold and link checks.
	const customMessages: { customType: string; content: any; display: boolean; details: any; options: any }[] = [];
	// CustomEntry rows written by appendEntry; never go to the LLM.
	const entries: { customType: string; data: any }[] = [];
	// Renderers from registerEntryRenderer, used by decision-card render checks.
	const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	// Renderers from registerMessageRenderer, used by the nudge-hint render checks.
	const messageRenderers = new Map<string, (message: any, options: any, theme: any) => any>();
	let abortedTurns = 0;
	const notifications: { msg: string; kind: string }[] = [];
	const sessionEntries: any[] = [{ type: "message" }]; // A non-empty session by default; tests that need a fresh session clear this.
	let leafId: string | null = null;
	const setLeaf = (id: string | null) => {
		leafId = id;
	};
	const statusBars = new Map<string, string | undefined>();
	let idle = true;
	let editorText = "";
	let pendingMessages = 0;
	// Raw key broadcasts like real pi; every onTerminalInput listener the watchdog registered sits here.
	const inputListeners = new Set<(data: string) => any>();

	const makeCtx = (): any => ({
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages > 0,
		// Like real pi: abort the running turn and go idle.
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
	});
	const ctx: any = makeCtx();

	let entrySeq = 0;
	/** Like real pi: save the message as a row and move the leaf. */
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
			activeTools.add(tool.name); // Like real pi: a registered tool joins the active set.
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerMessageRenderer: (customType: string, renderer: any) => messageRenderers.set(customType, renderer),
		registerEntryRenderer: (customType: string, renderer: any) => entryRenderers.set(customType, renderer),
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		sendMessage: (message: any, options?: any) => {
			customMessages.push({ ...message, options });
			const text = typeof message.content === "string" ? message.content : "";
			// Fold markers are empty internal markers, not text sent to the model.
			if (text) sentMessages.push(text);
			pushMessage({
				role: "custom",
				customType: message.customType,
				content: text,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
			if (options?.triggerTurn) idle = false; // a custom message triggers a new run
		},
		sendUserMessage: async (content: string, options?: any) => {
			// Like real pi: with expandPromptTemplates, a slash command runs at the prompt gate,
			// so it is not sent as a user message and does not start a run.
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

	/** Fire an event, calling every handler in order; ctxOverride stands in for a new ctx after session replacement. */
	const emit = async (name: string, event: any = {}, ctxOverride?: any) => {
		const eventCtx = ctxOverride ?? ctx;
		for (const h of handlers.get(name) ?? []) await h(event, eventCtx);
	};

	/** Run the fold like pi's context hook; real pi deep-copies, here we change the array copy directly. */
	const emitContext = async (messages: any[]) => {
		let current = messages;
		for (const h of handlers.get("context") ?? []) {
			const result = await h({ type: "context", messages: current }, ctx);
			if (result?.messages) current = result.messages;
		}
		return current;
	};

	/** Fire the tool_call hook and return the first non-empty result, like pi's block behavior. */
	const emitToolCall = async (event: any) => {
		for (const h of handlers.get("tool_call") ?? []) {
			const result = await h({ type: "tool_call", ...event }, ctx);
			if (result) return result;
		}
		return undefined;
	};

	/** Fire the message_end hook and return the first non-empty result, like pi's message rewrite. */
	const emitMessageEnd = async (message: any) => {
		for (const h of handlers.get("message_end") ?? []) {
			const result = await h({ type: "message_end", message }, ctx);
			if (result) return result;
		}
		return undefined;
	};

	/** AgentMessage list for the current branch; custom messages show up as role:"custom". */
	const currentMessages = () => sessionEntries.map((e: any) => e?.message).filter((m: any) => m !== undefined);

	/** Simulate a key press (picking a command, history, ...); any key counts. */
	const pressKey = () => {
		for (const l of inputListeners) l("x");
	};

	/**
	 * Simulate a finished run: go idle and fire agent_settled, so the watchdog counts down again.
	 * Pass the assistant message the run produced when a test needs a specific reply (text, tool call,
	 * or nothing at all). The default is a plain text answer that ends the decision turn with "continue".
	 */
	const settleAfterRun = async (message?: any) => {
		entrySeq += 1;
		const entry: any = { type: "message", id: `s${entrySeq}` };
		sessionEntries.push(entry); // this run produced one session message
		setLeaf(entry.id);
		// Like real pi: the run's assistant message is saved first, then the run ends.
		const assistant = message ?? {
			role: "assistant",
			content: [{ type: "text", text: "still working" }],
			stopReason: "stop",
		};
		await emitMessageEnd(assistant);
		await emit("agent_end", { messages: [assistant] });
		idle = true;
		await emit("agent_settled");
	};

	/** Simulate an aborted turn (user pressed ESC): no new message, assistant stopReason "aborted". */
	const settleAbortedTurn = async () => {
		await emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
		idle = true;
		await emit("agent_settled");
	};

	/** Create a fresh plugin instance; default(pi) makes fresh state on every call. */
	const newPlugin = async () => {
		const mod = await import("../../index.ts");
		mod.default(pi as any);
	};

	return {
		pi,
		ctx,
		makeCtx,
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
		messageRenderers,
		notifications,
		statusBars,
		sessionEntries,
		eventBusHandlers,
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
