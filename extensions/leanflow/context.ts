/**
 * LeanFlow builder context filter.
 *
 * During the building phase, filters the LLM context to remove verbose
 * planning-phase messages (Scout results, reasoning) and inject a compact
 * builder preamble. This is the primary token optimization: the builder
 * reads the approved plan artifact instead of carrying planning history.
 *
 * Uses `state.approvalBoundary` (message index captured at propose time)
 * instead of scanning messages each call. Falls back to a scan only when
 * the boundary is not set (e.g. state restored from an older version).
 */

import type { LeanFlowState } from "./state";

interface MessageLike {
	role?: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Filter context messages for the building phase.
 * Returns undefined to pass through unchanged (non-building phases).
 */
export function filterForBuilder(
	messages: MessageLike[],
	state: LeanFlowState,
): MessageLike[] | undefined {
	if (state.phase !== "building") return undefined;

	// Use the stored boundary if available; otherwise fall back to a scan.
	let boundaryIndex = state.approvalBoundary ?? -1;
	if (boundaryIndex < 0 || boundaryIndex >= messages.length) {
		boundaryIndex = findProposeBoundary(messages);
	}
	if (boundaryIndex < 0) return undefined; // can't find boundary, pass through

	// Keep the first user message (the task) + everything after the boundary.
	const firstUser = messages.find((m) => m.role === "user");
	const postBoundary = messages.slice(boundaryIndex + 1);

	const filtered: MessageLike[] = [];
	if (firstUser && !postBoundary.includes(firstUser)) {
		filtered.push(firstUser);
	}

	// Inject compact builder preamble.
	filtered.push({
		role: "custom",
		customType: "leanflow-builder-context",
		content: [{ type: "text", text: buildBuilderPreamble(state) }],
	});

	filtered.push(...postBoundary);
	return filtered;
}

/** Fallback: find the xd://propose write in message history. */
function findProposeBoundary(messages: MessageLike[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isProposeMessage(messages[i])) return i;
	}
	return -1;
}

function isProposeMessage(msg: MessageLike): boolean {
	const content = msg.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "tool_use" && b.name === "write") {
				const input = b.input as Record<string, unknown> | undefined;
				const path = String(input?.path ?? "");
				if (path.includes("xd://propose")) return true;
			}
			if (b.type === "text" && typeof b.text === "string") {
				if (b.text.includes("xd://propose")) return true;
			}
		}
	}
	return false;
}

function buildBuilderPreamble(state: LeanFlowState): string {
	const slug = state.planSlug ?? "<slug>";
	const lines = [
		"LeanFlow Builder context (injected by extension):",
		"",
		`Phase: building | Plan: local://${slug}-plan.md`,
	];
	if (state.gateAttempt > 0) {
		lines.push(`Gate attempt: ${state.gateAttempt}/2 — this is a repair round.`);
	}
	if (state.handoffWarnings && state.handoffWarnings.length > 0) {
		lines.push(`Handoff warnings: ${state.handoffWarnings.join("; ")}`);
	}
	lines.push(
		"",
		"Read the approved plan, implement it, run verification, and write:",
		`  local://${slug}-build.md, local://${slug}-diff.md, local://${slug}-evidence.md`,
		"Then call Gate:",
		"```text",
		`task({ agent: "gate", task: "Review plan local://${slug}-plan.md, diff local://${slug}-diff.md,`,
		`  build local://${slug}-build.md, evidence local://${slug}-evidence.md.",`,
		'  outputSchema: { type: "object", properties: { verdict: { type: "string", enum: ["PASS","FAIL"] },',
		'    findings: { type: "array", items: { type: "object", properties: {',
		'      category: { type: "string" }, severity: { type: "string", enum: ["blocking","nonblocking"] },',
		'      file: { type: "string" }, location: { type: "string" },',
		'      issue: { type: "string" }, required_fix: { type: "string" } },',
		'      required: ["category","severity","file","location","issue","required_fix"],',
		'      additionalProperties: false } } }, required: ["verdict","findings"], additionalProperties: false },',
		'  schemaMode: "strict" })',
		"```",
		"Gate PASS → done. First FAIL → repair + re-gate (max 2 Gate calls).",
		"Do not spawn implementer, reviewer, or audit agents. You are the sole writer.",
	);
	return lines.join("\n");
}
