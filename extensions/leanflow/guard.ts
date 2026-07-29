/**
 * LeanFlow tool guard.
 *
 * Intercepts `task` tool calls and blocks forbidden agent names/roles.
 * Each phase has an allow-list; anything matching the forbidden pattern
 * (reviewer, audit, implementer, etc.) is always blocked.
 *
 * Agent names are resolved through LEANFLOW_AGENTS aliases so renaming
 * an agent (e.g. scout → lean-scout) only requires updating one table.
 */

import type { LeanFlowPhase } from "./state";

/** Canonical agent roles → accepted name aliases. */
export const LEANFLOW_AGENTS: Record<string, string[]> = {
	scout: ["scout", "lean-scout"],
	gate: ["gate", "lean-gate"],
};

/** Reverse lookup: any known alias → canonical role. */
const ALIAS_TO_ROLE: Record<string, string> = {};
for (const [role, aliases] of Object.entries(LEANFLOW_AGENTS)) {
	for (const alias of aliases) {
		ALIAS_TO_ROLE[alias] = role;
	}
}

/** Agent names/roles that are always forbidden in LeanFlow. */
const FORBIDDEN_PATTERN =
	/audit|review(?:er)?|reaudit|coverage|runtime.?audit|schema.?audit|approval.?audit|failure.?audit|final.?audit|implementer|developer|coder|builder|architect|validator|planner/i;

/** Canonical roles allowed per phase. Empty = no task spawns allowed. */
const ALLOWED_BY_PHASE: Record<LeanFlowPhase, string[]> = {
	idle: [],
	planning: ["scout"],
	awaiting_approval: [],
	building: ["gate"],
	gating: [],
};

export interface GuardResult {
	block: boolean;
	reason?: string;
}

/** Resolve a raw agent name to its canonical LeanFlow role, or undefined. */
export function resolveRole(name: string): string | undefined {
	return ALIAS_TO_ROLE[name];
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
		const role = resolveRole(name);
		if (role && allowed.length > 0 && !allowed.includes(role)) {
			return {
				block: true,
				reason: `LeanFlow guard: agent "${name}" (${role}) is not allowed in ${phase} phase. Allowed: ${allowed.join(", ")}.`,
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
