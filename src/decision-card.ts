import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DECISION_ENTRY_TYPE } from "./constants.ts";

/** Decision card data saved as a session CustomEntry; never goes to the LLM. */
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

const DECISION_OUTCOME_LABEL: Record<DecisionCardData["outcome"], string> = {
	continue: "Work left → continue",
	stop: "AI stopped on purpose",
	superseded: "You took over, check dropped",
};

const DECISION_OUTCOME_COLOR: Record<DecisionCardData["outcome"], "accent" | "success" | "warning"> = {
	continue: "accent",
	stop: "success",
	superseded: "warning",
};

/** Cards the user opened, keyed by exchangeId, so they stay open after a global ctrl+o or a theme change. */
const expandedDecisionCards = new Set<string>();

/**
 * TUI card that shows one check's result; its reply is already folded out of context, so it stays collapsed until you click it or press ctrl+o.
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
		// Put the paused-vs-stopped note on the same line, so no extra notify pollutes the timeline.
		const label =
			data.outcome === "stop" && data.suspended
				? "AI stopped on purpose (keep mode paused, next message resumes)"
				: DECISION_OUTCOME_LABEL[data.outcome];
		box.addChild(
			new Text(
				`${theme.fg("muted", "⏱")} ${theme.fg(
					DECISION_OUTCOME_COLOR[data.outcome],
					label,
				)} ${theme.fg("dim", `(check ${data.nudgeCount}/${data.maxNudges})`)}`,
				0,
				0,
			),
		);
		if (data.reply) {
			const hint = this.expanded ? `AI: ${data.reply}` : "(reply folded · click or ctrl+o to expand)";
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
