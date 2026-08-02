/**
 * LeanFlow state machine types and persistence.
 *
 * State is persisted via `pi.appendEntry(CUSTOM_TYPE, state)` and restored
 * from the session branch on session_start/switch/branch/tree. Custom entries
 * survive compaction, so the state machine recovers without conversation history.
 *
 * Phase lifecycle:
 *   idle → planning → awaiting_approval → building → gating → finalizing → idle
 *
 * Transitions:
 *   write canonical plan artifact → awaiting_approval (plan exists; not yet approved)
 *   native approved-plan prompt    → building
 *   task(gate)                     → gating
 *   Gate PASS / 2nd FAIL           → finalizing
 *   settled final response         → idle
 *   Gate 1st FAIL                  → building (repair)
 */

export type LeanFlowPhase =
	| "idle"
	| "planning"
	| "awaiting_approval"
	| "building"
	| "gating"
	| "finalizing";
export type RunMarkerStatus = "awaiting_approval" | "building" | "completed" | "failed" | "abandoned" | "invalidated";

export type ObservablePhase = Exclude<LeanFlowPhase, "idle">;

export type HandoffStatus = "READY" | "READY_WITH_WARNINGS" | "NEEDS_UPDATE";
export type LspProbeStatus = "not_required" | "pending" | "completed";

/** Main-session provider usage accrued while a workflow phase is active. */
export interface PhaseMetrics {
	input: number;
	output: number;
	cacheRead: number;
	responses: number;
	elapsedMs: number;
}

/**
 * Runtime statistics quantifying LeanFlow's low-handoff value prop.
 * Only main-session-observable signals are recorded. Scout/Gate subagent
 * tokens run in separate sessions and are therefore explicitly not measured.
 */
export interface LeanFlowStats {
	planning: PhaseMetrics;
	awaitingApproval: PhaseMetrics;
	building: PhaseMetrics;
	gating: PhaseMetrics;

	/** Latest builder-filter message-count observation. */
	beforeMessages?: number;
	afterMessages?: number;
	removedMessages?: number;
	messageReductionPercent?: number;
	/** Latest deterministic JSON UTF-8 payload observation; absent if unavailable. */
	beforeBytes?: number;
	afterBytes?: number;
	removedBytes?: number;
	byteReductionPercent?: number;

	gatePasses: number;
	gateVerdictFailures: number;
	gateErrors: number;
	gateReadinessBlocks: number;
	repairRounds: number;
	repairSuccesses: number;
	terminalFailures: number;
}

export interface LeanFlowState {
	phase: LeanFlowPhase;
	/** Timestamp at which the current observable phase started, when observed. */
	phaseStartedAt?: number;
	scoutCalls: number;
	gateCalls: number;
	/** Which gate round: 0 = not yet gated, 1 = first gate, 2 = repair gate. */
	gateAttempt: number;
	/** Stable opaque identity persisted in the fresh-session run marker. */
	runId?: string;
	/** Why BUILD resumed after a Gate attempt. */
	gateRetryMode?: "repair" | "operational";
	/** Stable slug naming all canonical workflow artifacts. */
	planSlug?: string;
	/** Canonical local:// plan artifact written for this run. */
	planArtifact?: string;
	/** SHA-256 of the latest assessed canonical plan content. */
	planDigest?: string;
	startedAt?: number;
	handoffStatus?: HandoffStatus;
	handoffWarnings?: string[];
	/** Branch index immediately after the exact proposal request was dispatched. */
	proposalBoundary?: number;
	/** Canonical artifact named by the successful xd://propose request. */
	proposedPlanArtifact?: string;
	/** Canonical artifact named by OMP's native approved-plan execution prompt. */
	approvedPlanArtifact?: string;
	/** Plan digest captured when the current approval proposal completed. */
	proposedPlanDigest?: string;
	/** Native approval saw an invalid final plan; repository mutations stay locked. */
	approvalInvalidated?: boolean;
	/** Branch boundary after invalid approval; re-proposal requires a later native plan-mode entry. */
	approvalRepairBoundary?: number;
	/** Durable marker copied with local:// artifacts into an approved fresh session. */
	runMarkerArtifact?: string;
	/** Terminal truth, independent of marker persistence success. */
	terminalOutcome?: "pass" | "fail_after_retry" | "gate_operational_failure";
	/** Latest durable lifecycle status written to the run marker. */
	runMarkerStatus?: RunMarkerStatus;
	/** Marker/pointer persistence failed; current in-memory control remains authoritative. */
	persistenceDegraded?: boolean;
	/** Last failed persistence step, retained for actionable diagnostics. */
	persistenceFailureStage?: "precondition" | "marker" | "pointer";
	/** Filesystem path, or unresolved local:// target, for the failed step. */
	persistenceFailurePath?: string;
	/** Node filesystem error code when available. */
	persistenceFailureCode?: string;
	/** Original filesystem error message when available. */
	persistenceFailureMessage?: string;
	/** Whether a valid diagnostics probe is required, pending, or completed. */
	lspProbeStatus: LspProbeStatus;
	/** Path (or `*`) passed to the completed diagnostics probe. */
	lspProbeTarget?: string;
	/** Whether the immutable BUILD HEAD/status has been captured for this run. */
	baselineCaptured?: boolean;
	/** Whether any repository mutation was conservatively allowed after baseline capture. */
	buildMutationObserved?: boolean;
	/** Build evidence artifacts written this round: build / diff / evidence. */
	writtenArtifacts?: string[];
	/** Runtime token/context statistics for the current run. */
	stats?: LeanFlowStats;
}

export const CUSTOM_TYPE = "leanflow-state";

function defaultPhaseMetrics(): PhaseMetrics {
	return { input: 0, output: 0, cacheRead: 0, responses: 0, elapsedMs: 0 };
}

export function defaultStats(): LeanFlowStats {
	return {
		planning: defaultPhaseMetrics(),
		awaitingApproval: defaultPhaseMetrics(),
		building: defaultPhaseMetrics(),
		gating: defaultPhaseMetrics(),
		gatePasses: 0,
		gateVerdictFailures: 0,
		gateErrors: 0,
		gateReadinessBlocks: 0,
		repairRounds: 0,
		repairSuccesses: 0,
		terminalFailures: 0,
	};
}

export function defaultState(): LeanFlowState {
	return { phase: "idle", scoutCalls: 0, gateCalls: 0, gateAttempt: 0, lspProbeStatus: "pending", stats: defaultStats() };
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Whether this branch contains any LeanFlow state entry. */
export function hasPersistedState(branch: Iterable<BranchEntry>): boolean {
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) return true;
	}
	return false;
}

/** Walk the session branch and restore the latest persisted state. */
export function restoreState(branch: Iterable<BranchEntry>): LeanFlowState {
	let latest: LeanFlowState | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			latest = entry.data as LeanFlowState;
		}
	}
	return normalizeState(latest);
}

function normalizeState(value: LeanFlowState | undefined): LeanFlowState {
	const state = value ?? defaultState();
	return {
		phase: isPhase(state.phase) ? state.phase : "idle",
		phaseStartedAt: optionalNumber(state.phaseStartedAt),
		scoutCalls: numberOr(state.scoutCalls, 0),
		gateCalls: numberOr(state.gateCalls, 0),
		gateAttempt: numberOr(state.gateAttempt, 0),
		runId: typeof state.runId === "string" ? state.runId : undefined,
		planSlug: typeof state.planSlug === "string" ? state.planSlug : undefined,
		planArtifact: typeof state.planArtifact === "string" ? state.planArtifact : undefined,
		startedAt: optionalNumber(state.startedAt),
		gateRetryMode: state.gateRetryMode === "repair" || state.gateRetryMode === "operational" ? state.gateRetryMode : undefined,
		handoffStatus: isHandoffStatus(state.handoffStatus) ? state.handoffStatus : undefined,
		handoffWarnings: Array.isArray(state.handoffWarnings) ? state.handoffWarnings.filter((v) => typeof v === "string") : undefined,
		proposalBoundary: optionalNumber(state.proposalBoundary),
		planDigest: typeof state.planDigest === "string" ? state.planDigest : undefined,
		proposedPlanArtifact: typeof state.proposedPlanArtifact === "string" ? state.proposedPlanArtifact : undefined,
		approvedPlanArtifact: typeof state.approvedPlanArtifact === "string" ? state.approvedPlanArtifact : undefined,
		runMarkerArtifact: typeof state.runMarkerArtifact === "string" ? state.runMarkerArtifact : undefined,
		runMarkerStatus: isRunMarkerStatus(state.runMarkerStatus) ? state.runMarkerStatus : undefined,
		persistenceDegraded: state.persistenceDegraded === true,
		persistenceFailureStage:
			state.persistenceFailureStage === "precondition" ||
			state.persistenceFailureStage === "marker" ||
			state.persistenceFailureStage === "pointer"
				? state.persistenceFailureStage
				: undefined,
		persistenceFailurePath:
			typeof state.persistenceFailurePath === "string" ? state.persistenceFailurePath : undefined,
		persistenceFailureCode:
			typeof state.persistenceFailureCode === "string" ? state.persistenceFailureCode : undefined,
		persistenceFailureMessage:
			typeof state.persistenceFailureMessage === "string" ? state.persistenceFailureMessage : undefined,
		lspProbeStatus: normalizeLspProbeStatus(state),
		proposedPlanDigest: typeof state.proposedPlanDigest === "string" ? state.proposedPlanDigest : undefined,
		approvalInvalidated: state.approvalInvalidated === true,
		approvalRepairBoundary: optionalNumber(state.approvalRepairBoundary),
		lspProbeTarget: typeof state.lspProbeTarget === "string" ? state.lspProbeTarget : undefined,
		baselineCaptured: state.baselineCaptured === true,
		buildMutationObserved: state.buildMutationObserved === true,
		writtenArtifacts: Array.isArray(state.writtenArtifacts) ? state.writtenArtifacts.filter((v) => typeof v === "string") : undefined,
		terminalOutcome:
			state.terminalOutcome === "pass" ||
			state.terminalOutcome === "fail_after_retry" ||
			state.terminalOutcome === "gate_operational_failure"
				? state.terminalOutcome
				: undefined,
		stats: normalizeStats(state.stats),
	};
}

function normalizeStats(value: LeanFlowStats | undefined): LeanFlowStats {
	const legacy = value as (Partial<LeanFlowStats> & { contextBefore?: number; contextAfter?: number; gateFailures?: number; repairs?: number }) | undefined;
	const beforeMessages = optionalNumber(legacy?.beforeMessages ?? legacy?.contextBefore);
	const afterMessages = optionalNumber(legacy?.afterMessages ?? legacy?.contextAfter);
	return {
		...defaultStats(),
		planning: normalizePhaseMetrics(legacy?.planning),
		awaitingApproval: normalizePhaseMetrics(legacy?.awaitingApproval),
		building: normalizePhaseMetrics(legacy?.building),
		gating: normalizePhaseMetrics(legacy?.gating),
		beforeMessages,
		afterMessages,
		removedMessages: optionalNumber(legacy?.removedMessages) ?? deriveRemoved(beforeMessages, afterMessages),
		messageReductionPercent:
			optionalNumber(legacy?.messageReductionPercent) ?? derivePercent(beforeMessages, afterMessages),
		beforeBytes: optionalNumber(legacy?.beforeBytes),
		afterBytes: optionalNumber(legacy?.afterBytes),
		removedBytes: optionalNumber(legacy?.removedBytes) ?? deriveRemoved(legacy?.beforeBytes, legacy?.afterBytes),
		byteReductionPercent:
			optionalNumber(legacy?.byteReductionPercent) ?? derivePercent(legacy?.beforeBytes, legacy?.afterBytes),
		gatePasses: numberOr(legacy?.gatePasses, 0),
		gateVerdictFailures: numberOr(legacy?.gateVerdictFailures ?? legacy?.gateFailures, 0),
		gateErrors: numberOr(legacy?.gateErrors, 0),
		gateReadinessBlocks: numberOr(legacy?.gateReadinessBlocks, 0),
		repairRounds: numberOr(legacy?.repairRounds ?? legacy?.repairs, 0),
		repairSuccesses: numberOr(legacy?.repairSuccesses, 0),
		terminalFailures: numberOr(legacy?.terminalFailures, 0),
	};
}

function normalizePhaseMetrics(value: Partial<PhaseMetrics> | undefined): PhaseMetrics {
	return {
		input: numberOr(value?.input, 0),
		output: numberOr(value?.output, 0),
		cacheRead: numberOr(value?.cacheRead, 0),
		responses: numberOr(value?.responses, 0),
		elapsedMs: numberOr(value?.elapsedMs, 0),
	};
}

function deriveRemoved(before: number | undefined, after: number | undefined): number | undefined {
	return before === undefined || after === undefined ? undefined : before - after;
}

function derivePercent(before: number | undefined, after: number | undefined): number | undefined {
	return before === undefined || after === undefined ? undefined : before === 0 ? 0 : ((before - after) / before) * 100;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLspProbeStatus(state: LeanFlowState): LspProbeStatus {
	if (state.lspProbeStatus === "not_required" || state.lspProbeStatus === "pending" || state.lspProbeStatus === "completed") {
		return state.lspProbeStatus;
	}
	return (state as LeanFlowState & { lspProbeCompleted?: boolean }).lspProbeCompleted === true ? "completed" : "pending";
}

function isPhase(value: unknown): value is LeanFlowPhase {
	return value === "idle" || value === "planning" || value === "awaiting_approval" || value === "building" || value === "gating" || value === "finalizing";
}

function isRunMarkerStatus(value: unknown): value is RunMarkerStatus {
	return value === "awaiting_approval" || value === "building" || value === "completed" || value === "failed" || value === "abandoned" || value === "invalidated";
}

function isHandoffStatus(value: unknown): value is HandoffStatus {
	return value === "READY" || value === "READY_WITH_WARNINGS" || value === "NEEDS_UPDATE";
}
