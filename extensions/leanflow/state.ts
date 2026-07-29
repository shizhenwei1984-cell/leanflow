/**
 * LeanFlow state machine types and persistence.
 *
 * State is persisted via `pi.appendEntry(CUSTOM_TYPE, state)` and restored
 * from the session branch on session_start/switch/branch/tree. Custom entries
 * survive compaction, so the state machine recovers without conversation history.
 *
 * Phase lifecycle:
 *   idle → planning → awaiting_approval → building → gating → idle
 *
 * Transitions:
 *   /flow command         → planning
 *   write *-plan.md       → awaiting_approval (plan exists, not yet approved)
 *   first edit/bash/write(non-plan) after propose → building (approval implied)
 *   task(gate)            → gating
 *   Gate PASS / 2nd FAIL  → idle
 *   Gate 1st FAIL         → building (repair)
 */

export type LeanFlowPhase =
	| "idle"
	| "planning"
	| "awaiting_approval"
	| "building"
	| "gating";

export type HandoffStatus = "READY" | "READY_WITH_WARNINGS" | "NEEDS_UPDATE";

export interface LeanFlowState {
	phase: LeanFlowPhase;
	scoutCalls: number;
	gateCalls: number;
	/** Which gate round: 0 = not yet gated, 1 = first gate, 2 = repair gate. */
	gateAttempt: number;
	planSlug?: string;
	startedAt?: number;
	handoffStatus?: HandoffStatus;
	handoffWarnings?: string[];
	/** Message index of the approval boundary (xd://propose write), for context filter. */
	approvalBoundary?: number;
	/** Build evidence artifacts written this round: build / diff / evidence. */
	writtenArtifacts?: string[];
}

export const CUSTOM_TYPE = "leanflow-state";

export function defaultState(): LeanFlowState {
	return { phase: "idle", scoutCalls: 0, gateCalls: 0, gateAttempt: 0 };
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Walk the session branch and restore the latest persisted state. */
export function restoreState(branch: Iterable<BranchEntry>): LeanFlowState {
	let latest: LeanFlowState | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			latest = entry.data as LeanFlowState;
		}
	}
	return latest ?? defaultState();
}
