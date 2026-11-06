import { getGlobals } from "./state.ts";

/**
 * Entry ids whose note is open in the TUI. The components live in pi's finished-entry cache and
 * cannot reach this state, and the TUI keeps them alive past a session switch, so the plugin clears
 * these when the factory runs for a new session.
 *
 * Reads go through the process-global carrier (see state.ts): pi's jiti loader can instantiate this
 * file into several module graphs in one process, and module-level Sets would split the state.
 */
export function getExpandedHintIds(): Set<string> {
	return getGlobals().expandedHintIds;
}

export function getExpandedCardIds(): Set<string> {
	return getGlobals().expandedCardIds;
}
