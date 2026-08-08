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

import type { LeanFlowPhase, LeanFlowState } from "./state";

/** Canonical agent roles → accepted name aliases. */
export const LEANFLOW_AGENTS = {
	scout: ["scout", "lean-scout"],
	gate: ["gate", "lean-gate"],
} as const satisfies Record<string, readonly string[]>;

export type LeanFlowAgentRole = keyof typeof LEANFLOW_AGENTS;

/** Reverse lookup: any known alias → canonical role. */
const ALIAS_TO_ROLE: Record<string, LeanFlowAgentRole> = {};
for (const [role, aliases] of Object.entries(LEANFLOW_AGENTS)) {
	for (const alias of aliases) {
		ALIAS_TO_ROLE[alias] = role as LeanFlowAgentRole;
	}
}

/** Agent names/roles outside the two canonical aliases are never accepted. */

/** Canonical roles allowed per phase. Empty = no task spawns allowed. */
const ALLOWED_BY_PHASE: Record<LeanFlowPhase, readonly LeanFlowAgentRole[]> = {
	idle: [],
	planning: ["scout"],
	awaiting_approval: [],
	building: ["gate"],
	gating: [],
	repair_preparing: [],
	awaiting_human: [],
	finalizing: [],
};

export interface GuardResult {
	block: boolean;
	reason?: string;
}

export interface GateArtifacts {
	plan: string;
	build: string;
	diff: string;
	evidence: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function canonicalGateTask(artifacts: GateArtifacts): string {
	return `Review the LeanFlow run whose plan is ${artifacts.plan}, diff is ${artifacts.diff}, build record is ${artifacts.build}, and runtime evidence is ${artifacts.evidence}. Read all four artifacts and return the verdict object.`;
}

/** Validate the complete Gate wire shape before readiness checks or budget mutation. */
export function validateGateTaskCall(input: Record<string, unknown>, artifacts: GateArtifacts): GuardResult {
	const invalid = (detail: string): GuardResult => ({
		block: true,
		reason: `LeanFlow guard: invalid Gate call — ${detail}`,
	});
	if (!isPlainRecord(input)) return invalid("the task input must be a plain object.");

	const validateItem = (value: unknown): GuardResult => {
		if (!isPlainRecord(value)) return invalid("the Gate task item must be a plain object.");
		if (!hasExactKeys(value, ["agent", "task", "schemaMode"])) {
			return invalid("use only agent, task, and schemaMode; caller outputSchema, name, isolated, and extra fields are forbidden.");
		}
		if (typeof value.agent !== "string" || resolveRole(value.agent.trim()) !== "gate") {
			return invalid("the item must select a Gate alias.");
		}
		if (value.schemaMode !== "strict") return invalid('schemaMode must be exactly "strict".');
		if (typeof value.task !== "string" || value.task.trim() !== canonicalGateTask(artifacts)) {
			return invalid("the task text must exactly reference this run's four canonical artifacts.");
		}
		return { block: false };
	};

	if (Object.prototype.hasOwnProperty.call(input, "tasks")) {
		if (!hasExactKeys(input, ["context", "tasks"])) {
			return invalid("batch form allows only a non-empty context and one tasks array.");
		}
		if (typeof input.context !== "string" || input.context.trim().length === 0) {
			return invalid("batch context must be a non-empty string.");
		}
		if (!Array.isArray(input.tasks) || input.tasks.length !== 1) {
			return invalid("batch form must contain exactly one Gate task item.");
		}
		return validateItem(input.tasks[0]);
	}

	return validateItem(input);
}

/** Resolve a raw agent name to its canonical LeanFlow role, or undefined. */
export function resolveRole(name: string): LeanFlowAgentRole | undefined {
	const role = ALIAS_TO_ROLE[name];
	return role === "scout" || role === "gate" ? role : undefined;
}

/** Check a `task` tool call against the phase allow-list, failing closed. */
export function checkTaskGuard(phase: LeanFlowPhase, input: Record<string, unknown>): GuardResult {
	const spawns = extractRequestedSpawns(input);
	const allowed = ALLOWED_BY_PHASE[phase];

	if (spawns.length > 0 && allowed.length === 0) {
		return { block: true, reason: `LeanFlow guard: no subagents are allowed during ${phase} phase.` };
	}
	for (const spawn of spawns) {
		if (!spawn.agentName) {
			return { block: true, reason: "LeanFlow guard: every task item must explicitly select an agent." };
		}
		const role = resolveRole(spawn.agentName);
		if (!role) {
			return { block: true, reason: `LeanFlow guard: unknown LeanFlow agent "${spawn.agentName}".` };
		}
		if (!allowed.includes(role)) {
			return {
				block: true,
				reason: `LeanFlow guard: agent "${spawn.agentName}" (${role}) is not allowed in ${phase} phase. Allowed: ${allowed.join(", ") || "none"}.`,
			};
		}
	}
	return { block: false };
}

interface RequestedSpawn {
	agentName?: string;
	taskLabel?: string;
}

function extractRequestedSpawns(input: Record<string, unknown>): RequestedSpawn[] {
	if (Array.isArray(input.tasks)) {
		return input.tasks.map((item) => {
			if (!item || typeof item !== "object") return {};
			const task = item as Record<string, unknown>;
			return {
				agentName: typeof task.agent === "string" && task.agent.trim() ? task.agent : undefined,
				taskLabel: typeof task.name === "string" ? task.name : undefined,
			};
		});
	}
	return [{ agentName: typeof input.agent === "string" && input.agent.trim() ? input.agent : undefined }];
}

/** Extract actual requested known roles; task labels do not consume budgets. */
export function extractAgentRoles(input: Record<string, unknown>): LeanFlowAgentRole[] {
	const roles: LeanFlowAgentRole[] = [];
	const addRole = (value: unknown): void => {
		if (typeof value !== "string") return;
		const role = resolveRole(value);
		if (role) roles.push(role);
	};
	addRole(input.agent);
	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			if (task && typeof task === "object") addRole((task as Record<string, unknown>).agent);
		}
	}
	return roles;
}

/** Preflight exact requested role counts without mutating workflow state. */
export function checkAgentBudget(
	state: Pick<LeanFlowState, "scoutCalls" | "gateCalls">,
	roles: readonly LeanFlowAgentRole[],
): GuardResult {
	const scoutCount = roles.filter((role) => role === "scout").length;
	const gateCount = roles.filter((role) => role === "gate").length;
	if (gateCount > 1) {
		return { block: true, reason: "LeanFlow guard: exactly one Gate may run per task call." };
	}
	if (state.scoutCalls + scoutCount > 3) {
		return { block: true, reason: "LeanFlow guard: Scout budget exhausted (3/3). Improve the plan directly." };
	}
	if (state.gateCalls + gateCount > 2) {
		return { block: true, reason: "LeanFlow guard: Gate budget exhausted (2/2). Report findings and finish." };
	}
	return { block: false };
}

/** Extract only agent selectors; display labels never participate in policy. */
export function extractAgentNames(input: Record<string, unknown>): string[] {
	return extractRequestedSpawns(input).flatMap((spawn) => (spawn.agentName ? [spawn.agentName] : []));
}
