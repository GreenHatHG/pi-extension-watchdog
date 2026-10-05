/**
 * Entry ids whose note is open in the TUI. The components live in pi's finished-entry cache and
 * cannot reach this state, and the TUI keeps them alive past a session switch, so the plugin clears
 * these when the factory runs for a new session.
 */
export const expandedHintIds = new Set<string>();
export const expandedCardIds = new Set<string>();
