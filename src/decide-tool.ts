import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	BAD_DECISION_NOTE,
	DECISION_CONTINUE,
	DECISION_DONE,
	DECISION_ENTRY_TYPE,
	DECISION_NOTE_MAX_CHARS,
	DECISION_WAIT_USER,
	DECISIONS,
	type Decision,
	NOT_IN_CHECK_TURN_NOTE,
	STOP_MESSAGE_TYPE,
	type StopDecision,
	TOOL_DESCRIPTION,
	TOOL_NAME,
	TOOL_PROMPT_GUIDELINES,
	TOOL_PROMPT_SNIPPET,
	UNDELIVERED_STOP_NOTE,
} from "./constants.ts";
import { teardown } from "./countdown.ts";
import type { DecisionCardData } from "./decision-card.ts";
import { turnCarriesText } from "./run-scan.ts";
import {
	createExchangeId,
	getDecisionWindow,
	getPi,
	hasOnStopFired,
	isRunning,
	isSilentStopWarned,
	isSuspended,
	type PendingProactiveStop,
	setOnStopFired,
	setPendingProactiveStop,
	setSilentStopWarned,
	state,
} from "./state.ts";
import { publishStopped } from "./status.ts";

/**
 * Write the history card for an AI-initiated stop taken outside a decision turn.
 *
 * A check leaves a trace on the timeline by itself (its hint, its reply, its result card). A proactive
 * stop has no check behind it, so without this row the watchdog goes quiet with nothing on screen but
 * the status bar blinking off — the user cannot tell the AI finished on purpose from the plugin dying.
 * A history record, so it stays readable in `/tree` and never enters the model context.
 */
export function recordProactiveStop(stop: PendingProactiveStop) {
	getPi().appendEntry<DecisionCardData>(DECISION_ENTRY_TYPE, {
		// The card and the fold marker share one id, so a card can be read next to the range it explains.
		exchangeId: stop.exchangeId,
		outcome: "stop",
		decision: stop.decision,
		reply: stop.reply,
		proactive: true,
		suspended: stop.suspended,
		nudgeCount: stop.nudgeCount,
		maxNudges: state.maxNudges,
		ts: Date.now(),
	});
}

/**
 * Write the marker that closes a proactive stop's fold range.
 *
 * Sent after the run rather than from the tool: a `pi.sendMessage` from a running tool defers to
 * turn_end, which is too late — the wrap-up text the AI wrote after the tool call sits queued in front
 * of it, and would end up on the wrong side of the range. Written here, the marker lands last, naming
 * the tool call so folding can find the range without depending on the order it was saved in.
 */
export function markProactiveStop(stop: PendingProactiveStop) {
	getPi().sendMessage(
		{
			customType: STOP_MESSAGE_TYPE,
			content: "",
			display: false,
			details: { exchangeId: stop.exchangeId, toolCallId: stop.toolCallId },
		},
		{ triggerTurn: false },
	);
}

/**
 * The one tool: answer a check, or stop on your own. Called from the check turn for all three answers, and
 * from a normal work turn with "done"/"wait_user" for a proactive stop (a proactive "continue" says nothing).
 * Registered once by startWatchdog; pi lets us register after startup.
 */
export function registerDecideTool() {
	getPi().registerTool({
		name: TOOL_NAME,
		label: "Watchdog decide",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: TOOL_PROMPT_GUIDELINES,
		parameters: Type.Object({
			decision: Type.Union([
				Type.Literal(DECISION_CONTINUE),
				Type.Literal(DECISION_DONE),
				Type.Literal(DECISION_WAIT_USER),
			]),
			// The description carries the one-line rule: it rides along with every request, so the model sees
			// it without paying an example round trip. The 200-char slice is only a backstop.
			note: Type.Optional(
				Type.String({
					description:
						"One short line for the user (under ~100 characters). It shows in the watchdog card; never a report or a deliverable — " +
						"it is not where your conclusion goes, that belongs in a normal text message.",
				}),
			),
		}),
		// The card already shows the content, so render nothing; a zero-line Text with renderShell "self" keeps the call/result lines blank.
		renderShell: "self",
		renderCall: () => new Text("", 0, 0),
		renderResult: () => new Text("", 0, 0),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = params?.decision as Decision | undefined;
			const note = typeof params?.note === "string" ? params.note.slice(0, DECISION_NOTE_MAX_CHARS) : undefined;
			// Nothing to answer or stop when monitoring is off; a second call in one turn lands here too.
			if (!isRunning()) {
				return {
					content: [
						{
							type: "text",
							text: isSuspended()
								? "Already suspended. Nothing to do — end your turn normally."
								: "Watchdog is not running. Nothing to stop — end your turn normally.",
						},
					],
					details: {},
				};
			}
			// The check turn is open: this call is the answer. Guarded rather than trusted: pi validates the
			// schema before execute, but the check turn runs with every other tool blocked, so a payload that
			// slipped through must not be silently read as "no answer".
			const decisionWindow = getDecisionWindow();
			if (decisionWindow !== null) {
				const window = decisionWindow; // keep the window we answered, even if a later send clears it
				if (decision === undefined || !DECISIONS.includes(decision)) {
					// Throw, not return isError: pi only marks a result as an error when execute() throws, and the
					// model has to see this as a failure it can fix inside the same check turn.
					throw new Error(
						BAD_DECISION_NOTE +
							(decision === undefined ? "" : ` Got ${JSON.stringify(decision)}.`) +
							" This check is not answered yet — call again with a valid decision.",
					);
				}
				window.decision = decision;
				window.note = note;
				if (decision === DECISION_CONTINUE) {
					// Work remains: end this turn on the tool result, onAgentSettled sends the continuation. Ending
					// the turn with terminate is what keeps the model from starting the work inside the check turn;
					// it is not an abort, so no "request ended" row appears and the answer cannot read as a user ESC.
					return { content: [{ type: "text", text: "Continuing in the next turn." }], details: {}, terminate: true };
				}
				// "done" / "wait_user": the check ends the watchdog's interest; the card and fold marker drop in agent_settled.
				return stopWatchdog(toolCallId, decision, note, ctx);
			}

			// No check turn: the AI is closing out on its own. "continue" has nothing to answer here.
			if (decision === DECISION_CONTINUE) {
				throw new Error(NOT_IN_CHECK_TURN_NOTE);
			}
			if (decision !== DECISION_DONE && decision !== DECISION_WAIT_USER) {
				throw new Error(
					`${BAD_DECISION_NOTE} Here, outside a check, only "${DECISION_DONE}" and "${DECISION_WAIT_USER}" do anything.`,
				);
			}
			// A silent proactive stop reads as "conclusion left in a tool result"; nudge once, then fail open.
			if (!isSilentStopWarned() && !turnCarriesText(toolCallId, ctx)) {
				setSilentStopWarned(true);
				throw new Error(UNDELIVERED_STOP_NOTE);
			}
			return stopWatchdog(toolCallId, decision, note, ctx);
		},
	});
}

/**
 * The "stop" half of the tool, shared by a check answer and a proactive stop: soft-stop, remember what it
 * was (proactive stops are recorded once the run settles, so the AI's wrap-up lands inside the folded
 * range), then end the turn with a terminating tool result.
 *
 * `terminate: true` is what `ctx.abort()` used to do here: pi skips the follow-up model call after this
 * batch, so no further moves ride along. Unlike an abort it never throws, so pi writes no synthesized
 * "request ended" row. It does not erase text the model already streamed — a tool call only runs after its
 * assistant message is complete — but that text stays inside the proactive stop's fold range either way, so
 * nothing extra is paid for keeping it.
 */
function stopWatchdog(
	toolCallId: string,
	decision: StopDecision,
	note: string | undefined,
	ctx: ExtensionContext,
): AgentToolResult<unknown> {
	// PI_WATCHDOG_ON_STOP hook: run an external command when the AI stops the watchdog, e.g. touch an exit file or `tmux wait-for -S done` for a parent (subagent) to wait on.
	// Once per run: a second stop (or a child process inheriting this env re-running the chain, e.g.
	// a test suite spawned by a sub-agent) must not re-run it — a stale wait-for or kill-session
	// from a repeat firing kills the wrong pane.
	const onStop = process.env.PI_WATCHDOG_ON_STOP?.trim();
	if (onStop && !hasOnStopFired()) {
		setOnStopFired(true);
		// Stamp the flight recorder so a "mystery SIGHUP + exit=98" can be attributed after the fact.
		const dbg = process.env.PI_SUBAGENT_DEBUG?.trim();
		if (dbg) {
			try {
				appendFileSync(dbg, `${new Date().toISOString()} ON_STOP fired (watchdog stop path: ${toolCallId})\n`);
			} catch {}
		}
		// Write the pidfile HERE, not at session_start: the ON_STOP chain this spawn creates compares
		// its $PPID against the pidfile, and this process IS that $PPID. A session_start-time snapshot
		// went stale whenever the pi host replaced itself (reload, restart), so the guard compared a
		// dead pid against a live one and silently skipped the whole wrap-up. Writing at stop time
		// makes writer and $PPID the same process by construction — nothing to drift.
		const pidFile = process.env.PI_WATCHDOG_PIDFILE?.trim();
		if (pidFile) {
			try {
				writeFileSync(pidFile, `${process.pid}\n`);
			} catch {}
		}
		spawn("sh", ["-c", onStop], { stdio: "ignore", detached: true }).unref();
	}
	// Soft stop: in keep mode this only pauses us until the user talks again.
	teardown(ctx, false);
	// Always announce "the AI declared done" — keep mode's nap is only a monitoring detail, and a
	// consumer (e.g. a verification gate) must see the done signal even when the watchdog sleeps on.
	publishStopped("ai-stop", isSuspended());
	// Capture the nap now: a user message between here and agent_settled resumes us, and the card
	// would read fresh state instead of the state the stop actually left.
	const decisionWindow = getDecisionWindow();
	if (decisionWindow !== null) decisionWindow.suspended = isSuspended();
	if (decisionWindow === null) {
		// No check turn: hold the record until the run settles. The marker has to be the last row of the turn
		// it closes, and the card describes a stop that is over.
		setPendingProactiveStop({
			exchangeId: createExchangeId(),
			toolCallId,
			decision,
			reply: note,
			suspended: isSuspended(),
			nudgeCount: state.nudgeCount,
		});
	}
	return { content: [{ type: "text", text: "OK." }], details: {}, terminate: true };
}
