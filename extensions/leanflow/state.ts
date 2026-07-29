/**
 * LeanFlow state machine types and persistence.
 *
 * State is persisted via `pi.appendEntry(CUSTOM_TYPE, state)` and restored
 * from the session branch on session_start/switch/branch/tree. Custom entries
 * survive compaction, so the state machine recovers without conversation history.
 */

export type LeanFlowPhase = "idle" | "planning" | "handoff" | "building" | "gating";

export type HandoffStatus = "READY" | "READY_WITH_WARNINGS" | "NEEDS_UPDATE";

export interface LeanFlowState {
	phase: LeanFlowPhase;
	scoutCalls: number;
	gateCalls: number;
	planSlug?: string;
	startedAt?: number;
	handoffStatus?: HandoffStatus;
	handoffWarnings?: string[];
}

export const CUSTOM_TYPE = "leanflow-state";

export function defaultState(): LeanFlowState {
	return { phase: "idle", scoutCalls: 0, gateCalls: 0 };
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
