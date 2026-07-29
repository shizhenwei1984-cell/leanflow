/**
 * LeanFlow builder context filter.
 *
 * During the building phase, filters the LLM context to remove verbose
 * planning-phase messages (Scout results, reasoning) and inject a compact
 * builder preamble. This is the primary token optimization: the builder
 * reads the approved plan artifact instead of carrying planning history.
 *
 * The filter finds the approval boundary (last write to *-plan.md or
 * xd://propose) and keeps only the first user message + post-boundary
 * messages. Returns undefined for non-building phases (pass through).
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

	// Find the approval boundary: the last write to xd://propose or *-plan.md
	let boundaryIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isPlanOrProposeMessage(messages[i])) {
			boundaryIndex = i;
			break;
		}
	}

	if (boundaryIndex < 0) return undefined; // can't find boundary, pass through

	// Keep the first user message (the task) + everything after the boundary
	const firstUser = messages.find((m) => m.role === "user");
	const postBoundary = messages.slice(boundaryIndex + 1);

	const filtered: MessageLike[] = [];
	if (firstUser && !postBoundary.includes(firstUser)) {
		filtered.push(firstUser);
	}

	// Inject compact builder preamble
	filtered.push({
		role: "custom",
		customType: "leanflow-builder-context",
		content: [{ type: "text", text: buildBuilderPreamble(state) }],
	});

	filtered.push(...postBoundary);
	return filtered;
}

function isPlanOrProposeMessage(msg: MessageLike): boolean {
	const content = msg.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "tool_use" && b.name === "write") {
				const input = b.input as Record<string, unknown> | undefined;
				const path = String(input?.path ?? "");
				if (path.includes("-plan.md") || path.includes("xd://propose")) return true;
			}
			if (b.type === "text" && typeof b.text === "string") {
				if (b.text.includes("xd://propose") || b.text.includes("-plan.md")) return true;
			}
		}
	}
	return false;
}

function buildBuilderPreamble(state: LeanFlowState): string {
	const lines = [
		"LeanFlow Builder context (injected by extension):",
		"",
		`Phase: building | Plan: local://${state.planSlug ?? "<slug>"}-plan.md`,
	];
	if (state.handoffWarnings && state.handoffWarnings.length > 0) {
		lines.push(`Handoff warnings: ${state.handoffWarnings.join("; ")}`);
	}
	lines.push(
		"",
		"Read the approved plan, implement it, run verification, and write build/diff/evidence artifacts.",
		"Do not spawn implementer, reviewer, or audit agents. You are the sole writer.",
	);
	return lines.join("\n");
}
