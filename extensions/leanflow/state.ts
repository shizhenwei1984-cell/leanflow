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
 *   Transitions:
 *     write canonical plan artifact → awaiting_approval (plan exists; not yet approved)
 *     native approved-plan prompt    → building
 *     task(gate)                     → gating
 *     Gate PASS                      → finalizing
 *     Gate 2nd valid FAIL            → awaiting_human → building (via /flowcontinue)
 *     Gate 1st valid FAIL            → repair_preparing → building (repair record ready)
 *                          ↘ awaiting_human (repair record failed)
 *     Gate BLOCKED                   → building (evidence recovery)
 *     Gate operational error ×4 (per-cycle) → awaiting_human
 *     settled final response         → idle
 */

export type LeanFlowPhase =
	| "idle"
	| "planning"
	| "awaiting_approval"
	| "building"
	| "gating"
	| "repair_preparing"
	| "awaiting_human"
	| "finalizing";
export type RunMarkerStatus = "awaiting_approval" | "building" | "paused" | "completed" | "failed" | "abandoned" | "invalidated";

export type ObservablePhase = Exclude<LeanFlowPhase, "idle">;

export type HandoffStatus = "READY" | "READY_WITH_WARNINGS" | "NEEDS_UPDATE";
export type LspProbeStatus = "not_required" | "pending" | "completed";
export type GateOutcome = "PASS" | "FAIL" | "BLOCKED";
export type OperationLeaseKind = "gate" | "lsp";

export interface OperationLease {
	toolCallId: string;
	kind: OperationLeaseKind;
	runId: string;
	/** Gate round (gateAttempt) or LSP probe cycle the lease belongs to. */
	cycle: number;
	startedAt: number;
	/** SHA-256 over the pre-Gate artifact snapshot; gate leases only. */
	snapshotDigest?: string;
	/** SHA-256 of the canonical plan at dispatch; gate leases only. */
	planDigest?: string;
	/** Durable BUILD record round validated at dispatch; gate leases only. */
	buildRecordRound?: number;
	/** Diagnostics target; LSP leases only. */
	lspTarget?: string;
}

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
	gateBlocked: number;
	/** Cumulative operational/unparseable Gate failures. */
	gateErrors: number;
	/** Session-switch interruptions while Gate was in flight; not counted toward the per-cycle error budget. */
	gateInterruptions?: number;
	gateReadinessBlocks: number;
	repairRounds: number;
	repairSuccesses: number;
	terminalFailures: number;
}

export interface RepairLease {
	fromRound: number;
	toRound: number;
	reason: "gate_fail" | "repair_setup_failed" | "human_continue";
	startedAt: number;
}

export interface LeanFlowState {
	phase: LeanFlowPhase;
	/** Timestamp at which the current observable phase started, when observed. */
	phaseStartedAt?: number;
	scoutCalls: number;
	/** Settled Gate verdicts in the current human repair cycle. */
	gateCalls: number;
	/** Gate dispatches, including BLOCKED and operationally failed calls. */
	gateDispatches?: number;
	/** Which gate round: 0 = not yet gated, 1 = first gate, 2+ including human repair cycles. */
	gateAttempt: number;
	/** Stable opaque identity persisted in the fresh-session run marker. */
	runId?: string;
	/** Why BUILD resumed after a Gate attempt. */
	gateRetryMode?: "repair" | "evidence" | "operational";
	/** Stable slug naming all canonical workflow artifacts. */
	planSlug?: string;
	/** Canonical local:// plan artifact written for this run. */
	planArtifact?: string;
	/** SHA-256 of the latest assessed canonical plan content. */
	planDigest?: string;
	startedAt?: number;
	handoffStatus?: HandoffStatus;
	handoffWarnings?: string[];
	/** Structured handoff blocker codes, without human-readable details. */
	handoffBlockers?: string[];
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
	/** Persisted in-flight Gate operation, if any. */
	gateLease?: OperationLease;
	/** Persisted in-flight LSP diagnostics operation, if any. */
	lspLease?: OperationLease;
	/** Number of Gate-retry cycles explicitly resumed by a human. */
	humanRepairCycles?: number;
	/** Compact JSON findings from the most recent settled Gate verdict. */
	lastGateFindings?: string;
	/** Whether the immutable BUILD HEAD/status has been captured for this run. */
	baselineCaptured?: boolean;
	/** Whether any repository mutation was conservatively allowed after baseline capture. */
	buildMutationObserved?: boolean;
	/** Build evidence artifacts written this round: build / diff / evidence. */
	writtenArtifacts?: string[];
	/** Per-cycle consecutive operational Gate errors used for the 4-error pause cap; reset on PASS/FAIL/BLOCKED and /flowcontinue. */
	consecutiveGateErrors?: number;
	/** Persisted repair transaction lease for crash recovery. */
	repairLease?: RepairLease;
	/** Persisted workflow schema version; absence implies v1 (pre-7614368). */
	stateVersion?: number;
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
		gateBlocked: 0,
		gateErrors: 0,
		gateReadinessBlocks: 0,
		repairRounds: 0,
		repairSuccesses: 0,
		terminalFailures: 0,
	};
}

export function defaultState(): LeanFlowState {
	return {
		phase: "idle",
		scoutCalls: 0,
		gateCalls: 0,
		gateDispatches: 0,
		gateAttempt: 0,
		humanRepairCycles: 0,
		consecutiveGateErrors: 0,
		stateVersion: STATE_VERSION,
		lspProbeStatus: "pending",
		stats: defaultStats(),
	};
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

export const STATE_VERSION = 3;

function migrateLegacyGateState(
	state: LeanFlowState,
	rawPhase: LeanFlowPhase,
): { phase: LeanFlowPhase; gateCalls: number } {
	const version = typeof (state as Record<string, unknown>).stateVersion === "number" ? (state.stateVersion as number) : 1;
	const rawGateCalls = numberOr(state.gateCalls, 0);
	if (version >= STATE_VERSION) {
		return { phase: rawPhase, gateCalls: rawGateCalls };
	}
	if (rawPhase === "repair_preparing") {
		return { phase: "awaiting_human", gateCalls: rawGateCalls >= 2 ? 1 : rawGateCalls };
	}
	if (rawPhase === "gating") {
		const repair = state.gateRetryMode === "repair";
		return { phase: "building", gateCalls: repair ? 1 : 0 };
	}
	if (rawPhase === "building" && rawGateCalls >= 2) {
		return { phase: "building", gateCalls: 1 };
	}
	return { phase: rawPhase, gateCalls: rawGateCalls };
}

function normalizeRepairLease(value: unknown): RepairLease | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const lease = value as { fromRound?: unknown; toRound?: unknown; reason?: unknown; startedAt?: unknown };
	const fromRound = optionalNumber(lease.fromRound);
	const toRound = optionalNumber(lease.toRound);
	const startedAt = optionalNumber(lease.startedAt);
	if (
		fromRound === undefined || toRound === undefined || startedAt === undefined ||
		!Number.isInteger(fromRound) || !Number.isInteger(toRound) ||
		fromRound < 0 || toRound < 1 || toRound !== fromRound + 1 ||
		(lease.reason !== "gate_fail" && lease.reason !== "repair_setup_failed" && lease.reason !== "human_continue")
	) {
		return undefined;
	}
	return { fromRound, toRound, reason: lease.reason, startedAt };
}

function normalizeState(value: LeanFlowState | undefined): LeanFlowState {
	const state = value ?? defaultState();
	const rawPhase = isPhase(state.phase) ? state.phase : "idle";
	const migrated = migrateLegacyGateState(state, rawPhase);
	const phase = migrated.phase;
	const gateCalls = migrated.gateCalls;
	return {
		phase,
		stateVersion: STATE_VERSION,
		phaseStartedAt: optionalNumber(state.phaseStartedAt),
		scoutCalls: numberOr(state.scoutCalls, 0),
		gateCalls,
		gateDispatches:
			typeof state.gateDispatches === "number" && Number.isFinite(state.gateDispatches) && state.gateDispatches >= 0
				? state.gateDispatches
				: 0,
		gateAttempt: numberOr(state.gateAttempt, 0),
		runId: typeof state.runId === "string" ? state.runId : undefined,
		planSlug: typeof state.planSlug === "string" ? state.planSlug : undefined,
		planArtifact: typeof state.planArtifact === "string" ? state.planArtifact : undefined,
		startedAt: optionalNumber(state.startedAt),
		gateRetryMode:
			state.gateRetryMode === "repair" || state.gateRetryMode === "evidence" || state.gateRetryMode === "operational"
				? state.gateRetryMode
				: undefined,
		handoffStatus: isHandoffStatus(state.handoffStatus) ? state.handoffStatus : undefined,
		handoffWarnings: Array.isArray(state.handoffWarnings) ? state.handoffWarnings.filter((v) => typeof v === "string") : undefined,
		handoffBlockers: Array.isArray(state.handoffBlockers)
			? state.handoffBlockers.filter(
					(blocker): blocker is string => typeof blocker === "string" && HANDOFF_BLOCKER_CODES[blocker] === true,
				)
			: undefined,
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
		gateLease: normalizeOperationLease(state.gateLease),
		lspLease: normalizeOperationLease(state.lspLease),
		humanRepairCycles:
			typeof state.humanRepairCycles === "number" &&
			Number.isFinite(state.humanRepairCycles) &&
			state.humanRepairCycles >= 0
				? state.humanRepairCycles
				: 0,
		lastGateFindings:
			typeof state.lastGateFindings === "string"
				? state.lastGateFindings.length <= 4_000
					? state.lastGateFindings
					: `${state.lastGateFindings.slice(0, 3_999)}…`
				: undefined,
		baselineCaptured: state.baselineCaptured === true,
		buildMutationObserved: state.buildMutationObserved === true,
		writtenArtifacts: Array.isArray(state.writtenArtifacts) ? state.writtenArtifacts.filter((v) => typeof v === "string") : undefined,
		consecutiveGateErrors:
			typeof state.consecutiveGateErrors === "number" && Number.isFinite(state.consecutiveGateErrors) && state.consecutiveGateErrors >= 0
				? Math.floor(state.consecutiveGateErrors)
				: 0,
		repairLease: normalizeRepairLease((state as Record<string, unknown>).repairLease),
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
		gateBlocked:
			typeof legacy?.gateBlocked === "number" && Number.isFinite(legacy.gateBlocked) && legacy.gateBlocked >= 0
				? legacy.gateBlocked
				: 0,
		gateErrors: numberOr(legacy?.gateErrors, 0),
		gateInterruptions:
			typeof legacy?.gateInterruptions === "number" && Number.isFinite(legacy.gateInterruptions) && legacy.gateInterruptions >= 0
				? Math.floor(legacy.gateInterruptions)
				: 0,
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

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const HANDOFF_BLOCKER_CODES: Record<string, true> = {
	TARGET_MISSING: true,
	BEHAVIOR_MISSING: true,
	ACCEPTANCE_MISSING: true,
	VERIFICATION_MISSING: true,
};

function normalizeOperationLease(value: unknown): OperationLease | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const lease = value as {
		toolCallId?: unknown;
		kind?: unknown;
		runId?: unknown;
		cycle?: unknown;
		startedAt?: unknown;
		snapshotDigest?: unknown;
		planDigest?: unknown;
		buildRecordRound?: unknown;
		lspTarget?: unknown;
	};
	const cycle = optionalNumber(lease.cycle);
	const startedAt = optionalNumber(lease.startedAt);
	if (
		(lease.kind !== "gate" && lease.kind !== "lsp") ||
		typeof lease.toolCallId !== "string" ||
		lease.toolCallId.length === 0 ||
		typeof lease.runId !== "string" ||
		!RUN_ID_PATTERN.test(lease.runId) ||
		cycle === undefined ||
		startedAt === undefined
	) {
		return undefined;
	}
	if (lease.kind === "gate") {
		const snapshotDigest = typeof lease.snapshotDigest === "string" && SHA256_PATTERN.test(lease.snapshotDigest) ? lease.snapshotDigest : undefined;
		const planDigest = typeof lease.planDigest === "string" && SHA256_PATTERN.test(lease.planDigest) ? lease.planDigest : undefined;
		const buildRecordRound = optionalNumber(lease.buildRecordRound);
		return {
			toolCallId: lease.toolCallId,
			kind: lease.kind,
			runId: lease.runId,
			cycle,
			startedAt,
			snapshotDigest,
			planDigest,
			buildRecordRound: buildRecordRound !== undefined && Number.isInteger(buildRecordRound) && buildRecordRound >= 1 ? buildRecordRound : undefined,
		};
	}
	return {
		toolCallId: lease.toolCallId,
		kind: lease.kind,
		runId: lease.runId,
		cycle,
		startedAt,
		lspTarget: typeof lease.lspTarget === "string" ? lease.lspTarget : undefined,
	};
}
function normalizeLspProbeStatus(state: LeanFlowState): LspProbeStatus {
	if (state.lspProbeStatus === "not_required" || state.lspProbeStatus === "pending" || state.lspProbeStatus === "completed") {
		return state.lspProbeStatus;
	}
	return (state as LeanFlowState & { lspProbeCompleted?: boolean }).lspProbeCompleted === true ? "completed" : "pending";
}

function isPhase(value: unknown): value is LeanFlowPhase {
	return (
		value === "idle" ||
		value === "planning" ||
		value === "awaiting_approval" ||
		value === "building" ||
		value === "gating" ||
		value === "repair_preparing" ||
		value === "awaiting_human" ||
		value === "finalizing"
	);
}

function isRunMarkerStatus(value: unknown): value is RunMarkerStatus {
	return (
		value === "awaiting_approval" ||
		value === "building" ||
		value === "paused" ||
		value === "completed" ||
		value === "failed" ||
		value === "abandoned" ||
		value === "invalidated"
	);
}

function isHandoffStatus(value: unknown): value is HandoffStatus {
	return value === "READY" || value === "READY_WITH_WARNINGS" || value === "NEEDS_UPDATE";
}
