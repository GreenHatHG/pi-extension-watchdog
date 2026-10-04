import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DECISION_MESSAGE_TYPE } from "./constants.ts";

/**
 * Decision result saved as a session CustomEntry: a history record only. It has no TUI
 * renderer (so the timeline stays quiet) and never enters the LLM context.
 */
export interface DecisionCardData {
	exchangeId: string;
	outcome: "continue" | "stop" | "superseded";
	/** AI reply from the decision turn (truncated); text from blocked tool calls also lands here. */
	reply?: string;
	/** outcome=stop in keep mode: monitoring only paused, the next user message resumes it. */
	suspended?: boolean;
	nudgeCount: number;
	maxNudges: number;
	ts: number;
}

/** Hints the user opened, keyed by exchangeId, so they stay open after a theme change. */
const expandedDecisionHints = new Set<string>();

/**
 * The one visible element per decision check: the nudge message itself, collapsed to a
 * "sending decision message" line. Click it to read the prompt the model was given.
 */
class DecisionHintComponent implements Component {
	private expanded: boolean;
	private box: Box;

	constructor(
		private readonly exchangeId: string,
		private readonly prompt: string,
		private readonly theme: Theme,
		expanded: boolean,
	) {
		this.expanded = expanded;
		this.box = this.build();
	}

	private build(): Box {
		const { theme } = this;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const toggle = this.expanded ? "click to collapse" : "click to expand";
		box.addChild(
			new Text(
				`${theme.fg("muted", "⏱")} ${theme.fg("accent", "Sending decision message")} ${theme.fg("dim", `· ${toggle}`)}`,
				0,
				0,
			),
		);
		if (this.expanded) {
			box.addChild(new Text(theme.fg("dim", this.prompt), 0, 0));
		}
		return box;
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.expanded = !this.expanded;
		if (this.expanded) expandedDecisionHints.add(this.exchangeId);
		else expandedDecisionHints.delete(this.exchangeId);
		this.box = this.build();
		return { handled: true };
	}

	invalidate(): void {
		this.box.invalidate();
	}
}

/** The nudge message is the visible check hint; the saved result card stays out of the TUI. */
export function registerDecisionHintRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(DECISION_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { exchangeId?: unknown } | undefined;
		const exchangeId = typeof details?.exchangeId === "string" ? details.exchangeId : "";
		const prompt = typeof message.content === "string" ? message.content : "";
		return new DecisionHintComponent(exchangeId, prompt, theme, expanded || expandedDecisionHints.has(exchangeId));
	});
}
