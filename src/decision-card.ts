import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DECISION_ENTRY_TYPE, DECISION_MESSAGE_TYPE } from "./constants.ts";
import { expandedCardIds, expandedHintIds } from "./expanded.ts";

/**
 * Decision result saved as a session CustomEntry: it gets a TUI renderer and stays readable, but never enters the LLM context.
 */
export interface DecisionCardData {
	exchangeId: string;
	outcome: "continue" | "stop" | "superseded" | "failed" | "empty";
	/** Short note the AI passed to watchdog_decide (truncated); provider error text on a failed check. */
	reply?: string;
	/**
	 * Why the AI stopped: "done" (task finished) or "wait_user" (it is waiting on the user). Only set on
	 * a stop, and only to pick the card label — both stop the same way.
	 */
	decision?: "done" | "wait_user";
	/** outcome=stop in keep mode: monitoring only paused, the next user message resumes it. */
	suspended?: boolean;
	/** The AI stopped the watchdog itself, mid-turn: there was no check turn, so the row says so. */
	proactive?: boolean;
	nudgeCount: number;
	maxNudges: number;
	ts: number;
}

/** How the AI answered the check, in the same words the fold marker and the history use. */
const OUTCOME_LABEL: Record<DecisionCardData["outcome"], string> = {
	continue: "still working",
	stop: "finished — stopped on purpose",
	superseded: "superseded",
	failed: "check failed, will retry",
	empty: "no watchdog_decide call from model",
};

/** A stop that is really a wait: the label tells the user what to do, not just what happened. */
const WAIT_USER_LABEL = "waiting on you — reply to resume";

/**
 * All plugin output on the timeline carries this marker, so a card is recognizable as watchdog's
 * and not some other extension's, whatever the user has installed alongside it.
 */
const CARD_PREFIX = "watchdog:";

/**
 * One line per check, expandable to its detail: collapsed it announces what happened, expanded it
 * shows the text that never reached the timeline. A click toggles it, and the open set survives a
 * theme change, which rebuilds the component.
 */
abstract class DecisionRow implements Component {
	/** The row's own id: it is what a click remembers, so the two renderers share one key per check. */
	private readonly rowId: string;
	private expanded: boolean;
	/** Built on the first render, not in the constructor: a subclass field is not set until super() returns. */
	private box: Box | null = null;

	constructor(
		rowId: string,
		/** Detail text; empty means there is nothing to expand. */
		private readonly detail: string,
		protected readonly theme: Theme,
		/** The row remembers being open, so a rebuilt component shows it open again. */
		private readonly openIds: Set<string>,
		expanded: boolean,
	) {
		this.rowId = rowId;
		this.expanded = expanded && detail.length > 0;
	}

	/** The headline, without the toggle hint. */
	protected abstract label(theme: Theme, expanded: boolean): string;

	private build(): Box {
		const { theme } = this;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(this.label(theme, this.expanded), 0, 0));
		if (this.expanded) box.addChild(new Text(theme.fg("dim", this.detail), 0, 0));
		return box;
	}

	/** The `watchdog:` tag every row starts with, so the card names its source. */
	protected prefix(theme: Theme): string {
		return `${theme.fg("muted", CARD_PREFIX)} `;
	}

	/** `· click to expand` / `· click to collapse`, added only when there is a detail to show. */
	protected toggleHint(expanded: boolean): string {
		if (!this.detail) return "";
		return ` ${this.theme.fg("dim", `· ${expanded ? "click to collapse" : "click to expand"}`)}`;
	}

	render(width: number): string[] {
		this.box ??= this.build();
		return this.box.render(width);
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left" || !this.detail) return undefined;
		this.expanded = !this.expanded;
		if (this.expanded) this.openIds.add(this.rowId);
		else this.openIds.delete(this.rowId);
		this.box = this.build();
		return { handled: true };
	}

	invalidate(): void {
		this.box?.invalidate();
	}
}

/** The check itself: the nudge, collapsed to a "sending decision message" line; expanded it shows the prompt the model got. */
class DecisionHintComponent extends DecisionRow {
	constructor(rowId: string, prompt: string, theme: Theme, expanded: boolean) {
		super(rowId, prompt, theme, expandedHintIds, expanded);
	}

	protected label(theme: Theme, expanded: boolean): string {
		return `${theme.fg("muted", "⏱")} ${this.prefix(theme)}${theme.fg("accent", "Sending decision message")}${this.toggleHint(expanded)}`;
	}
}

/** How the AI answered the check: the outcome, and the reply the timeline never showed. */
class DecisionCardComponent extends DecisionRow {
	constructor(
		rowId: string,
		private readonly data: DecisionCardData,
		theme: Theme,
		expanded: boolean,
	) {
		super(rowId, data.reply ?? "", theme, expandedCardIds, expanded);
	}

	protected label(theme: Theme, expanded: boolean): string {
		const outcome =
			this.data.outcome === "stop" && this.data.decision === "wait_user"
				? WAIT_USER_LABEL
				: (OUTCOME_LABEL[this.data.outcome] ?? this.data.outcome);
		const paused =
			this.data.outcome === "stop" && this.data.suspended ? ` ${theme.fg("dim", "· monitoring paused")}` : "";
		const noCheck = this.data.proactive ? ` ${theme.fg("dim", "· no check")}` : "";
		return `${theme.fg("muted", "⏱")} ${this.prefix(theme)}${theme.fg("accent", outcome)}${this.toggleHint(expanded)}${paused}${noCheck}`;
	}
}

/** The nudge message announces the check, the entry holds its answer. Both live for the whole session. */
export function registerDecisionCardRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(DECISION_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { exchangeId?: unknown } | undefined;
		const exchangeId = typeof details?.exchangeId === "string" ? details.exchangeId : "";
		const prompt = typeof message.content === "string" ? message.content : "";
		// A custom message carries no id, and one nudge per exchange means the exchange id is its row key.
		return new DecisionHintComponent(exchangeId, prompt, theme, expanded || expandedHintIds.has(exchangeId));
	});
	pi.registerEntryRenderer(DECISION_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as DecisionCardData;
		return new DecisionCardComponent(
			entry.id ?? data.exchangeId,
			data,
			theme,
			expanded || expandedCardIds.has(entry.id ?? data.exchangeId),
		);
	});
}
