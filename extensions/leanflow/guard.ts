/**
 * LeanFlow tool guard.
 *
 * Intercepts `task` tool calls and blocks forbidden agent names/roles.
 * Each phase has an allow-list; anything matching the forbidden pattern
 * (reviewer, audit, implementer, etc.) is always blocked.
 */

import type { LeanFlowPhase } from "./state";

/** Agent names/roles that are always forbidden in LeanFlow. */
const FORBIDDEN_PATTERN =
	/audit|review(?:er)?|reaudit|coverage|runtime.?audit|schema.?audit|approval.?audit|failure.?audit|final.?audit|implementer|developer|coder|builder|architect|validator|planner/i;

/** Agents allowed per phase. Empty = no task spawns allowed. */
const ALLOWED_BY_PHASE: Record<LeanFlowPhase, string[]> = {
	idle: [],
	planning: ["scout"],
	handoff: ["scout"],
	building: ["gate"],
	gating: [],
};

export interface GuardResult {
	block: boolean;
	reason?: string;
}

/** Check a `task` tool call against the phase allow-list and forbidden pattern. */
export function checkTaskGuard(phase: LeanFlowPhase, input: Record<string, unknown>): GuardResult {
	const names = extractAgentNames(input);
	const allowed = ALLOWED_BY_PHASE[phase];

	for (const name of names) {
		if (FORBIDDEN_PATTERN.test(name)) {
			return {
				block: true,
				reason: `LeanFlow guard: "${name}" matches a forbidden role. No reviewer, audit, validator, or implementer agents exist in LeanFlow.`,
			};
		}
		if (allowed.length > 0 && !allowed.includes(name)) {
			return {
				block: true,
				reason: `LeanFlow guard: agent "${name}" is not allowed in ${phase} phase. Allowed: ${allowed.join(", ")}.`,
			};
		}
	}
	return { block: false };
}

/** Extract agent names and task names from a `task` tool input. */
export function extractAgentNames(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (typeof input.agent === "string") names.push(input.agent);
	if (Array.isArray(input.tasks)) {
		for (const t of input.tasks) {
			if (t && typeof t === "object") {
				const task = t as Record<string, unknown>;
				if (typeof task.agent === "string") names.push(task.agent);
				if (typeof task.name === "string") names.push(task.name);
			}
		}
	}
	return names;
}
