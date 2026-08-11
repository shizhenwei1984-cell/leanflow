import { randomUUID } from "node:crypto";
import {
	createApprovedValidationContract,
	parseApprovedValidation,
	type ApprovedValidation,
	type ApprovedValidationContract,
	type ValidationSemanticState,
} from "./validation";
import {
	createOperationalRetrySnapshot,
	isFinalizationCommitNonce,
	finalizedGateSnapshotDigest,
	parseFinalizedGateSnapshot,
	parseOperationalRetrySnapshot,
	type FinalizedGateSnapshot,
	type OperationalRetrySnapshot,
} from "./provenance";
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

/**
 * Stable repository identity: HEAD plus the binary tracked diff and sorted
 * untracked entries. Entries bind a regular file's type, executable mode, and
 * content digest, or a symlink's type and link target.
 */
export interface RepositoryFingerprint {
	head: string;
	trackedDiffDigest: string;
	untrackedDigest: string;
	combinedDigest: string;
}

export interface OperationLease {
	toolCallId: string;
	kind: OperationLeaseKind;
	runId: string;
	controlSessionId?: string;
	controlOperationEpoch?: number;
	/** Gate round (gateAttempt) or LSP probe cycle the lease belongs to. */
	cycle: number;
	startedAt: number;
	/** SHA-256 over the pre-Gate artifact snapshot; gate leases only. */
	snapshotDigest?: string;
	/** SHA-256 of the canonical plan at dispatch; gate leases only. */
	planDigest?: string;
	/** Durable BUILD record round validated at dispatch; gate leases only. */
	buildRecordRound?: number;
	/** Immutable repository state captured at Gate dispatch; gate leases only. */
	repositoryFingerprint?: RepositoryFingerprint;
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
	version: 1;
	transactionId: string;
	runId: string;
	planSlug: string;
	planDigest: string;
	approvedValidationDigest: string;
	fromRound: number;
	toRound: number;
	recordArtifact: string;
	reason: "gate_fail" | "human_continue" | "record_recovery";
	startedAt: number;
}

export function createRepairLease(
	state: Pick<LeanFlowState, "runId" | "planSlug" | "planDigest" | "approvedValidationDigest">,
	fromRound: number,
	reason: RepairLease["reason"],
): RepairLease {
	if (!state.runId || !state.planSlug || !state.planDigest || !state.approvedValidationDigest) {
		throw new Error("active LeanFlow run identity is incomplete for repair setup");
	}
	return {
		version: 1,
		transactionId: randomUUID(),
		runId: state.runId,
		planSlug: state.planSlug,
		planDigest: state.planDigest,
		approvedValidationDigest: state.approvedValidationDigest,
		fromRound,
		toRound: fromRound + 1,
		recordArtifact: `local://.leanflow/runs/${state.runId}-build-record.json`,
		reason,
		startedAt: Date.now(),
	};
}
export type BlockedReasonCode =
	| "missing_validation"
	| "failed_validation"
	| "stale_validation"
	| "run_mismatch"
	| "artifact_unreadable"
	| "artifact_inconsistent"
	| "build_record_invalid"
	| "other_validation_failure";

export interface BlockedRecoveryState {
	reasonCode: BlockedReasonCode;
	evidenceIds: string[];
	validationStates: ValidationSemanticState[];
	semanticEvidenceDigest: string;
	consecutiveEquivalentBlocked: number;
}

/**
 * The next explicit operator action after a provenance recovery pauses or
 * invalidates the active Gate cycle. It is persisted so restored sessions do
 * not reduce a safe recovery to an unexplained dead end.
 */
export type GateRecoveryAction =
	| "repair_plan_and_reapprove"
	| "refinalize_trusted_checkpoint"
	| "refinalize_legacy_pass"
	| "flowcontinue_rebuild_checkpoint"
	| "flowcontinue_after_lease_failure";

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
	/** Session that owns the current control-plane activation. */
	controlSessionId?: string;
	/** Monotonic control-plane activation; late operations from prior epochs fail closed. */
	controlOperationEpoch?: number;
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
	/** Canonical required Validation contract derived from the approved plan. */
	approvedValidationContract?: ApprovedValidationContract;
	/** Convenience copy of approvedValidationContract.digest for record/manifest identity checks. */
	approvedValidationDigest?: string;
	/** Durable BUILD record round used by every BUILD, finalization, and Gate path. */
	currentBuildRound?: number;
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
	/** Advisory UI marks only; never authoritative for Gate readiness. */
	writtenArtifacts?: string[];
	/** Atomic durable provenance manifest written after all Gate artifacts verify. */
	finalizedGateSnapshot?: FinalizedGateSnapshot;
	/** Cryptographic commit binding that makes the durable manifest authoritative for this state entry. */
	finalizationCommitNonce?: string;
	/** Identity retained only while retrying an operationally interrupted Gate. */
	operationalRetrySnapshot?: OperationalRetrySnapshot;
	/** Semantic BLOCKED identity and validation-state boundary. */
	blockedRecovery?: BlockedRecoveryState;
	/** Per-cycle consecutive operational Gate errors used for the 4-error pause cap. */
	consecutiveGateErrors?: number;
	/** Persisted repair transaction lease for crash recovery. */
	repairLease?: RepairLease;
	/** Explicit next action after provenance recovery; cleared on successful redispatch or repair. */
	recoveryAction?: GateRecoveryAction;
	/** Persisted workflow schema version; absence implies v1, and active output is always v9. */
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
		controlOperationEpoch: 1,
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
	let latest: unknown;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			latest = entry.data;
		}
	}
	return normalizeState(latest);
}

/**
 * v7 requires nonce-bound v2 Gate authority for every Gate-ready or successful
 * finalizing state. Older state is normalized and persisted immediately by the
 * restore flow; it is never allowed to regain authority by migration alone.
 */
export const STATE_VERSION = 9;

function migrateLegacyGateState(
	state: LeanFlowState,
	rawPhase: LeanFlowPhase,
): { phase: LeanFlowPhase; gateCalls: number } {
	const version = typeof state.stateVersion === "number" ? state.stateVersion : 1;
	const rawGateCalls = numberOr(state.gateCalls, 0);
	if (version >= 4) return { phase: rawPhase, gateCalls: rawGateCalls };
	if (version === 3) {
		if (rawPhase === "gating") {
			const repair = state.gateRetryMode === "repair";
			return { phase: "building", gateCalls: repair ? 1 : 0 };
		}
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
	const lease = value as Partial<RepairLease>;
	if (
		lease.version !== 1 ||
		typeof lease.transactionId !== "string" || lease.transactionId.length === 0 ||
		typeof lease.runId !== "string" || lease.runId.length === 0 ||
		typeof lease.planSlug !== "string" || lease.planSlug.length === 0 ||
		typeof lease.planDigest !== "string" || lease.planDigest.length === 0 ||
		typeof lease.approvedValidationDigest !== "string" || lease.approvedValidationDigest.length === 0 ||
		typeof lease.recordArtifact !== "string" || lease.recordArtifact.length === 0 ||
		typeof lease.fromRound !== "number" || !Number.isInteger(lease.fromRound) || lease.fromRound < 0 ||
		typeof lease.toRound !== "number" || !Number.isInteger(lease.toRound) || lease.toRound !== lease.fromRound + 1 ||
		typeof lease.startedAt !== "number" || !Number.isFinite(lease.startedAt) ||
		(lease.reason !== "gate_fail" && lease.reason !== "human_continue" && lease.reason !== "record_recovery")
	) {
		return undefined;
	}
	return lease as RepairLease;
}

function normalizeApprovedValidations(value: unknown): ApprovedValidation[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.flatMap((candidate) => {
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			!("displayCommand" in candidate) ||
			typeof candidate.displayCommand !== "string"
		) {
			return [];
		}
		const parsed = parseApprovedValidation(candidate.displayCommand);
		if (!parsed || seen.has(parsed.digest)) return [];
		seen.add(parsed.digest);
		return [parsed];
	});
}

function normalizeApprovedValidationContract(
	value: unknown,
	planDigest: string | undefined,
	legacyValidations: unknown,
): ApprovedValidationContract | undefined {
	if (!planDigest || !SHA256_PATTERN.test(planDigest)) return undefined;
	const candidate =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Partial<ApprovedValidationContract>)
			: undefined;
	const validations = normalizeApprovedValidations(candidate?.validations ?? legacyValidations);
	if (validations.length === 0) return undefined;
	try {
		const canonical = createApprovedValidationContract(planDigest, validations);
		if (candidate && candidate.digest !== canonical.digest) return undefined;
		return canonical;
	} catch {
		return undefined;
	}
}

const BLOCKED_REASON_CODES = new Set<BlockedReasonCode>([
	"missing_validation",
	"failed_validation",
	"stale_validation",
	"run_mismatch",
	"artifact_unreadable",
	"artifact_inconsistent",
	"build_record_invalid",
	"other_validation_failure",
]);
const VALIDATION_SEMANTIC_STATUSES = new Set(["missing", "failed", "stale", "passed"]);

function normalizeBlockedRecovery(value: unknown): BlockedRecoveryState | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Partial<BlockedRecoveryState>;
	if (
		typeof candidate.reasonCode !== "string" ||
		!BLOCKED_REASON_CODES.has(candidate.reasonCode as BlockedReasonCode) ||
		!Array.isArray(candidate.evidenceIds) ||
		candidate.evidenceIds.length === 0 ||
		candidate.evidenceIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
		new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length ||
		!Array.isArray(candidate.validationStates) ||
		typeof candidate.semanticEvidenceDigest !== "string" ||
		!SHA256_PATTERN.test(candidate.semanticEvidenceDigest) ||
		typeof candidate.consecutiveEquivalentBlocked !== "number" ||
		!Number.isInteger(candidate.consecutiveEquivalentBlocked) ||
		candidate.consecutiveEquivalentBlocked < 1
	) {
		return undefined;
	}
	const states: ValidationSemanticState[] = [];
	const seen = new Set<string>();
	for (const state of candidate.validationStates) {
		if (
			typeof state !== "object" ||
			state === null ||
			Array.isArray(state) ||
			!("id" in state) ||
			typeof state.id !== "string" ||
			!("status" in state) ||
			typeof state.status !== "string" ||
			!VALIDATION_SEMANTIC_STATUSES.has(state.status) ||
			seen.has(state.id)
		) {
			return undefined;
		}
		const observationId =
			"observationId" in state && typeof state.observationId === "string"
				? state.observationId
				: undefined;
		const normalizedOutputDigest =
			"normalizedOutputDigest" in state && typeof state.normalizedOutputDigest === "string"
				? state.normalizedOutputDigest
				: undefined;
		const repositoryFingerprintAfter =
			"repositoryFingerprintAfter" in state && typeof state.repositoryFingerprintAfter === "string"
				? state.repositoryFingerprintAfter
				: undefined;
		if (
			(state.status !== "missing" && (!observationId || observationId.trim().length === 0)) ||
			(normalizedOutputDigest !== undefined && !SHA256_PATTERN.test(normalizedOutputDigest)) ||
			(repositoryFingerprintAfter !== undefined && !SHA256_PATTERN.test(repositoryFingerprintAfter))
		) {
			return undefined;
		}
		seen.add(state.id);
		states.push({
			id: state.id,
			status: state.status as ValidationSemanticState["status"],
			...(observationId ? { observationId } : {}),
			...(normalizedOutputDigest ? { normalizedOutputDigest } : {}),
			...(repositoryFingerprintAfter ? { repositoryFingerprintAfter } : {}),
		});
	}
	return {
		reasonCode: candidate.reasonCode as BlockedReasonCode,
		evidenceIds: [...candidate.evidenceIds].sort(),
		validationStates: states,
		semanticEvidenceDigest: candidate.semanticEvidenceDigest,
		consecutiveEquivalentBlocked: Math.min(2, candidate.consecutiveEquivalentBlocked),
	};
}
function normalizeState(value: unknown): LeanFlowState {
	const raw =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const persistedVersion = typeof raw.stateVersion === "number" ? raw.stateVersion : undefined;
	const legacySchema = persistedVersion !== STATE_VERSION;
	const state = { ...defaultState(), ...raw } as LeanFlowState & Record<string, unknown>;
	state.stateVersion = persistedVersion;
	const rawPhase = isPhase(state.phase) ? state.phase : "idle";
	const migrated = migrateLegacyGateState(state, rawPhase);
	let phase = migrated.phase;
	let gateRetryMode =
		state.gateRetryMode === "repair" || state.gateRetryMode === "evidence" || state.gateRetryMode === "operational"
			? state.gateRetryMode
			: undefined;
	let terminalOutcome =
		state.terminalOutcome === "pass" ||
		state.terminalOutcome === "fail_after_retry" ||
		state.terminalOutcome === "gate_operational_failure"
			? state.terminalOutcome
			: undefined;
	let recoveryAction =
		state.recoveryAction === "repair_plan_and_reapprove" ||
		state.recoveryAction === "refinalize_trusted_checkpoint" ||
		state.recoveryAction === "refinalize_legacy_pass" ||
		state.recoveryAction === "flowcontinue_rebuild_checkpoint" ||
		state.recoveryAction === "flowcontinue_after_lease_failure"
			? state.recoveryAction
			: undefined;
	const planDigestValue = typeof state.planDigest === "string" ? state.planDigest : undefined;
	const approvedValidationContract = normalizeApprovedValidationContract(
		state.approvedValidationContract,
		planDigestValue,
		raw.approvedValidations,
	);
	const approvedValidationDigest = approvedValidationContract?.digest;
	let repairLease = normalizeRepairLease(state.repairLease);
	let gateLease = normalizeOperationLease(state.gateLease);
	let finalizedGateSnapshot = parseFinalizedGateSnapshot(state.finalizedGateSnapshot);
	let finalizationCommitNonce = isFinalizationCommitNonce(state.finalizationCommitNonce)
		? state.finalizationCommitNonce
		: undefined;
	let operationalRetrySnapshot = parseOperationalRetrySnapshot(state.operationalRetrySnapshot);
	let blockedRecovery = normalizeBlockedRecovery(state.blockedRecovery);
	let baselineCaptured = state.baselineCaptured === true;
	let writtenArtifacts = Array.isArray(state.writtenArtifacts)
		? state.writtenArtifacts.filter((item): item is string => typeof item === "string")
		: undefined;
	const declaredBuildRound =
		typeof state.currentBuildRound === "number" &&
		Number.isInteger(state.currentBuildRound) &&
		state.currentBuildRound >= 1
			? state.currentBuildRound
			: undefined;
	const clearFinalizationAuthority = (): void => {
		finalizedGateSnapshot = undefined;
		finalizationCommitNonce = undefined;
		operationalRetrySnapshot = undefined;
	};
	const pauseForRebuild = (): void => {
		clearFinalizationAuthority();
		gateLease = undefined;
		repairLease = undefined;
		gateRetryMode = undefined;
		baselineCaptured = false;
		writtenArtifacts = [];
		terminalOutcome = undefined;
		phase = "awaiting_human";
		recoveryAction = "flowcontinue_rebuild_checkpoint";
	};

	if (
		finalizedGateSnapshot &&
		(finalizedGateSnapshot.runId !== state.runId ||
			finalizedGateSnapshot.planSlug !== state.planSlug ||
			finalizedGateSnapshot.planDigest !== planDigestValue ||
			finalizedGateSnapshot.approvedValidationDigest !== approvedValidationDigest ||
			finalizedGateSnapshot.finalizationCommitNonce !== finalizationCommitNonce ||
			(declaredBuildRound !== undefined && finalizedGateSnapshot.buildRecordRound !== declaredBuildRound) ||
			phase === "idle" ||
			phase === "planning" ||
			phase === "awaiting_approval" ||
			phase === "repair_preparing" ||
			phase === "awaiting_human" ||
			finalizedGateSnapshot.validationStates.some((validation) => validation.status !== "passed"))
	) {
		clearFinalizationAuthority();
	}
	if (
		gateLease &&
		(gateLease.kind !== "gate" ||
			gateLease.runId !== state.runId ||
			gateLease.planDigest !== planDigestValue ||
			(declaredBuildRound !== undefined && gateLease.buildRecordRound !== declaredBuildRound) ||
			(finalizedGateSnapshot &&
				(gateLease.snapshotDigest !== finalizedGateSnapshotDigest(finalizedGateSnapshot) ||
					gateLease.buildRecordRound !== finalizedGateSnapshot.buildRecordRound ||
					gateLease.repositoryFingerprint?.combinedDigest !== finalizedGateSnapshot.repositoryFingerprint.combinedDigest)))
	) {
		gateLease = undefined;
	}
	if (
		operationalRetrySnapshot &&
		(!finalizedGateSnapshot ||
			operationalRetrySnapshot.originalGateLease.runId !== state.runId ||
			operationalRetrySnapshot.originalGateLease.planDigest !== planDigestValue ||
			operationalRetrySnapshot.originalGateLease.buildRecordRound !== finalizedGateSnapshot.buildRecordRound ||
			operationalRetrySnapshot.originalGateLease.repositoryFingerprint?.combinedDigest !==
				finalizedGateSnapshot.repositoryFingerprint.combinedDigest ||
			operationalRetrySnapshot.finalizedSnapshotDigest !== finalizedGateSnapshotDigest(finalizedGateSnapshot))
	) {
		operationalRetrySnapshot = undefined;
	}

	// State v8 retains only nonce-bound finalization authority. A pre-v9 repair
	// lease is deliberately not reconstructed here: restore must prove it from
	// the durable BUILD record before it can regain repair authority.
	if (legacySchema) {
		blockedRecovery = undefined;
		writtenArtifacts = [];
		if (!finalizedGateSnapshot) gateLease = undefined;
		if (phase === "repair_preparing" && !repairLease) {
			phase = "awaiting_human";
			gateRetryMode = undefined;
			recoveryAction = "flowcontinue_rebuild_checkpoint";
		}
	}
	if (persistedVersion === 7 && phase === "gating" && gateLease && finalizedGateSnapshot) {
		operationalRetrySnapshot = createOperationalRetrySnapshot(gateLease, finalizedGateSnapshot, "session_switch");
		gateLease = undefined;
		phase = "building";
		gateRetryMode = "operational";
	}
	if (!finalizedGateSnapshot) finalizationCommitNonce = undefined;

	if (gateRetryMode === "operational" && (!finalizedGateSnapshot || !operationalRetrySnapshot)) {
		pauseForRebuild();
	}
	if (gateRetryMode !== "operational") operationalRetrySnapshot = undefined;

	if (phase === "repair_preparing" && (!repairLease || gateRetryMode !== "repair")) {
		pauseForRebuild();
	}
	if (phase !== "repair_preparing") repairLease = undefined;

	if (phase === "finalizing" && terminalOutcome === "pass" && !finalizedGateSnapshot) {
		pauseForRebuild();
	}
	if (phase === "gating" && (!gateLease || !finalizedGateSnapshot)) {
		clearFinalizationAuthority();
		phase = "building";
		gateRetryMode = "evidence";
		gateLease = undefined;
		writtenArtifacts = [];
		recoveryAction = undefined;
	}
	if (phase !== "gating") gateLease = undefined;

	if (
		baselineCaptured &&
		phase !== "building" &&
		phase !== "gating" &&
		phase !== "awaiting_human" &&
		phase !== "repair_preparing"
	) {
		baselineCaptured = false;
	}

	const inferredBuildRound =
		finalizedGateSnapshot?.buildRecordRound ??
		operationalRetrySnapshot?.originalGateLease.buildRecordRound ??
		repairLease?.toRound ??
		gateLease?.buildRecordRound ??
		(gateRetryMode === "evidence" || gateRetryMode === "operational"
			? numberOr(state.gateAttempt, 0)
			: numberOr(state.gateAttempt, 0) + 1);
	const currentBuildRound =
		phase === "planning" || phase === "awaiting_approval" || phase === "idle"
			? undefined
			: declaredBuildRound ?? (inferredBuildRound >= 1 ? inferredBuildRound : undefined);

	return {
		phase,
		stateVersion: STATE_VERSION,
		phaseStartedAt: optionalNumber(state.phaseStartedAt),
		scoutCalls: numberOr(state.scoutCalls, 0),
		gateCalls: migrated.gateCalls,
		gateDispatches:
			typeof state.gateDispatches === "number" && Number.isFinite(state.gateDispatches) && state.gateDispatches >= 0
				? state.gateDispatches
				: 0,
		gateAttempt: numberOr(state.gateAttempt, 0),
		runId: typeof state.runId === "string" ? state.runId : undefined,
		controlSessionId: typeof state.controlSessionId === "string" ? state.controlSessionId : undefined,
		controlOperationEpoch:
			typeof state.controlOperationEpoch === "number" &&
			Number.isInteger(state.controlOperationEpoch) &&
			state.controlOperationEpoch >= 1
				? state.controlOperationEpoch
				: 1,
		planSlug: typeof state.planSlug === "string" ? state.planSlug : undefined,
		planArtifact: typeof state.planArtifact === "string" ? state.planArtifact : undefined,
		planDigest: planDigestValue,
		startedAt: optionalNumber(state.startedAt),
		gateRetryMode,
		handoffStatus: isHandoffStatus(state.handoffStatus) ? state.handoffStatus : undefined,
		handoffWarnings: Array.isArray(state.handoffWarnings) ? state.handoffWarnings.filter((v) => typeof v === "string") : undefined,
		handoffBlockers: Array.isArray(state.handoffBlockers)
			? state.handoffBlockers.filter(
					(blocker): blocker is string => typeof blocker === "string" && HANDOFF_BLOCKER_CODES[blocker] === true,
				)
			: undefined,
		approvedValidationContract,
		approvedValidationDigest,
		currentBuildRound,
		proposalBoundary: optionalNumber(state.proposalBoundary),
		proposedPlanArtifact: typeof state.proposedPlanArtifact === "string" ? state.proposedPlanArtifact : undefined,
		approvedPlanArtifact: typeof state.approvedPlanArtifact === "string" ? state.approvedPlanArtifact : undefined,
		proposedPlanDigest: typeof state.proposedPlanDigest === "string" ? state.proposedPlanDigest : undefined,
		approvalInvalidated: state.approvalInvalidated === true,
		approvalRepairBoundary: optionalNumber(state.approvalRepairBoundary),
		runMarkerArtifact: typeof state.runMarkerArtifact === "string" ? state.runMarkerArtifact : undefined,
		runMarkerStatus: isRunMarkerStatus(state.runMarkerStatus) ? state.runMarkerStatus : undefined,
		terminalOutcome,
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
		lspProbeTarget: typeof state.lspProbeTarget === "string" ? state.lspProbeTarget : undefined,
		gateLease,
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
		baselineCaptured,
		buildMutationObserved: state.buildMutationObserved === true,
		writtenArtifacts,
		finalizedGateSnapshot,
		finalizationCommitNonce,
		operationalRetrySnapshot,
		blockedRecovery,
		recoveryAction,
		consecutiveGateErrors:
			typeof state.consecutiveGateErrors === "number" &&
			Number.isFinite(state.consecutiveGateErrors) &&
			state.consecutiveGateErrors >= 0
				? Math.floor(state.consecutiveGateErrors)
				: 0,
		repairLease,
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
	VERIFICATION_INVALID: true,
};

function normalizeOperationLease(value: unknown): OperationLease | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const lease = value as {
		toolCallId?: unknown;
		kind?: unknown;
		runId?: unknown;
		controlSessionId?: unknown;
		controlOperationEpoch?: unknown;
		cycle?: unknown;
		startedAt?: unknown;
		snapshotDigest?: unknown;
		planDigest?: unknown;
		buildRecordRound?: unknown;
		lspTarget?: unknown;
		repositoryFingerprint?: unknown;
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
		const repositoryFingerprint = normalizeRepositoryFingerprint(lease.repositoryFingerprint);
		if (!snapshotDigest || !planDigest || buildRecordRound === undefined || !Number.isInteger(buildRecordRound) || buildRecordRound < 1 || !repositoryFingerprint) {
			return undefined;
		}
		return {
			toolCallId: lease.toolCallId,
			kind: lease.kind,
			runId: lease.runId,
			...(typeof lease.controlSessionId === "string" ? { controlSessionId: lease.controlSessionId } : {}),
			...(typeof lease.controlOperationEpoch === "number" && Number.isInteger(lease.controlOperationEpoch)
				? { controlOperationEpoch: lease.controlOperationEpoch }
				: {}),
			cycle,
			startedAt,
			snapshotDigest,
			planDigest,
			buildRecordRound,
			repositoryFingerprint,
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
function normalizeRepositoryFingerprint(value: unknown): RepositoryFingerprint | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const fingerprint = value as Partial<RepositoryFingerprint>;
	if (
		typeof fingerprint.head !== "string" ||
		!/^[0-9a-f]{40,64}$/i.test(fingerprint.head) ||
		typeof fingerprint.trackedDiffDigest !== "string" ||
		!SHA256_PATTERN.test(fingerprint.trackedDiffDigest) ||
		typeof fingerprint.untrackedDigest !== "string" ||
		!SHA256_PATTERN.test(fingerprint.untrackedDigest) ||
		typeof fingerprint.combinedDigest !== "string" ||
		!SHA256_PATTERN.test(fingerprint.combinedDigest)
	) {
		return undefined;
	}
	return {
		head: fingerprint.head,
		trackedDiffDigest: fingerprint.trackedDiffDigest,
		untrackedDigest: fingerprint.untrackedDigest,
		combinedDigest: fingerprint.combinedDigest,
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
