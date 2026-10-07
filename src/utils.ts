/**
 * Restored sessions (resume/fork) have old history but no work yet in this process, so wait like an empty session.
 */
export function isRestoredReason(reason: string | undefined): boolean {
	return reason === "resume" || reason === "fork";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
