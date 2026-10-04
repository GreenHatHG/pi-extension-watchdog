/**
 * Restored sessions (resume/fork) have old history but no work yet in this process, so wait like an empty session.
 */
export function isRestoredReason(reason: string | undefined): boolean {
	return reason === "resume" || reason === "fork";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull plain text out of an assistant message, skipping toolCall and thinking blocks. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}
