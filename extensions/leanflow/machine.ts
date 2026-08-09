import { createHash } from "node:crypto";
import type { GateOutcome, LeanFlowState, RepositoryFingerprint, RunMarkerStatus } from "./state";
import {
	recordGateBlocked,
	recordGateError,
	recordGateFailure,
	recordGateInterruption,
	recordGatePass,
	recordTerminalFailure,
	resetConsecutiveGateErrors,
} from "./stats";
import { parseApprovedValidation } from "./validation";

export type GateEvent =
	| {
			type: "gate_dispatch";
			toolCallId: string;
			runId: string;
			snapshotDigest: string;
			planDigest: string;
			buildRecordRound: number;
			repositoryFingerprint?: RepositoryFingerprint;
			now: number;
	  }
	| {
			type: "gate_settled";
			outcome: GateOutcome;
			findingsJson?: string;
			snapshotDigest?: string;
			observationBoundary?: number;
	  }
	| { type: "gate_error" }
	| { type: "gate_interrupted" }
	| { type: "restore_reconcile"; now: number }
	| { type: "repair_round_ready"; round: number; baselineCaptured: boolean }
	| { type: "repair_round_failed"; reason: string }
	| { type: "snapshot_evidence_invalid"; reason: string }
	| { type: "snapshot_record_invalid"; reason: string }
	| { type: "snapshot_plan_drift"; reason: string }
	| { type: "repository_changed_during_gate"; reason: string }
	| { type: "human_continue"; now: number }
	| { type: "human_finish_failed"; now: number };

/**
 * Classifies a failed Gate snapshot verification so the caller can pick a
 * typed recovery path instead of one uniform operational retry.
 */
export type SnapshotFailureKind =
	| "artifact_rebuildable"
	| "record_invalid"
	| "plan_drift"
	| "lease_invalid"
	| "repository_changed"
	| "snapshot_changed"
	| "transport_error";

export type Effect =
	| { kind: "write_marker"; status: RunMarkerStatus }
	| { kind: "begin_repair_round" }
	| { kind: "clear_artifacts" }
	| { kind: "notify"; level: "info" | "warning"; message: string };

const MAX_GATE_VERDICTS = 2;
const MAX_GATE_ERRORS = 4;
const MAX_SAME_SNAPSHOT_BLOCKED = 2;
const MAX_FINDINGS_LENGTH = 4_000;

/**
 * Applies a Gate lifecycle event to the persisted state in place.
 *
 * World-facing work is represented as ordered effects so callers can perform
 * filesystem writes, repair-record initialization, and UI notification outside
 * this pure state transition.
 */
export function reduceGate(state: LeanFlowState, event: GateEvent): { effects: Effect[] } {
	switch (event.type) {
		case "gate_dispatch":
			return reduceGateDispatch(state, event);
		case "gate_settled":
			return reduceGateSettlement(state, event);
		case "gate_error":
			return reduceGateError(state);
		case "gate_interrupted":
			return reduceGateInterrupted(state);
		case "restore_reconcile":
			return reduceRestoreReconcile(state);
		case "repair_round_ready":
			return reduceRepairRoundReady(state, event as Extract<GateEvent, { type: "repair_round_ready" }>);
		case "repair_round_failed":
			return reduceRepairRoundFailed(state, event);
		case "snapshot_evidence_invalid":
			return reduceSnapshotEvidenceInvalid(state, event);
		case "snapshot_record_invalid":
			return reduceSnapshotRecordInvalid(state, event);
		case "snapshot_plan_drift":
			return reduceSnapshotPlanDrift(state);
		case "repository_changed_during_gate":
			return reduceRepositoryChangedDuringGate(state, event);
		case "human_continue":
			return reduceHumanContinue(state);
		case "human_finish_failed":
			return reduceHumanFinishFailed(state);
	}
}

/** Returns state combinations that violate the Gate lifecycle contract. */
export function checkInvariants(state: LeanFlowState): string[] {
	const violations: string[] = [];

	const gateLease = state.gateLease;
	if (state.phase === "gating" && !gateLease) {
		violations.push("gating phase requires a gate lease");
	} else if (state.phase === "gating" && !gateLease?.repositoryFingerprint) {
		violations.push("gating phase requires a repository fingerprint");
	}
	if (state.phase === "repair_preparing") {
		if (state.gateRetryMode !== "repair") violations.push("repair_preparing phase requires gateRetryMode=repair");
		if ((state.writtenArtifacts?.length ?? 0) !== 0) violations.push("repair_preparing phase requires no written artifacts");
		if (!state.repairLease) violations.push("repair_preparing phase requires a repair lease");
	}
	if (state.phase === "awaiting_human" && state.terminalOutcome !== undefined) {
		violations.push("awaiting_human phase must not have a terminal outcome");
	}
	if (state.phase === "finalizing" && state.terminalOutcome === undefined) {
		violations.push("finalizing phase requires a terminal outcome");
	}
	if (state.gateCalls < 0 || state.gateCalls > MAX_GATE_VERDICTS) {
		violations.push(`gateCalls must be between 0 and ${MAX_GATE_VERDICTS}`);
	}
	if (state.baselineCaptured && state.phase !== "building" && state.phase !== "gating" && state.phase !== "awaiting_human" && state.phase !== "repair_preparing") {
		violations.push("baselineCaptured is only valid during building, gating, awaiting_human, or repair_preparing");
	}
	if ((state.consecutiveGateErrors ?? 0) < 0 || (state.consecutiveGateErrors ?? 0) > MAX_GATE_ERRORS) {
		violations.push(`consecutiveGateErrors must be between 0 and ${MAX_GATE_ERRORS}`);
	}
	const blockedCount = state.consecutiveSameSnapshotBlocked ?? 0;
	const hasBlockedIdentity =
		state.lastBlockedSnapshotDigest !== undefined ||
		state.lastBlockedObservationBoundary !== undefined ||
		state.lastBlockedFindingDigest !== undefined;
	if (blockedCount < 0 || blockedCount > MAX_SAME_SNAPSHOT_BLOCKED) {
		violations.push(`consecutiveSameSnapshotBlocked must be between 0 and ${MAX_SAME_SNAPSHOT_BLOCKED}`);
	}
	if ((blockedCount === 0) !== !hasBlockedIdentity) {
		violations.push("BLOCKED recovery identity and count must be present together");
	}
	if (
		blockedCount > 0 &&
		(state.lastBlockedSnapshotDigest === undefined ||
			state.lastBlockedObservationBoundary === undefined ||
			state.lastBlockedFindingDigest === undefined)
	) {
		violations.push("BLOCKED recovery identity must be complete");
	}
	const approvedDigests = new Set<string>();
	for (const approved of state.approvedValidations ?? []) {
		const canonical = parseApprovedValidation(approved.displayCommand);
		if (
			!canonical ||
			canonical.digest !== approved.digest ||
			canonical.executable !== approved.executable ||
			canonical.kind !== approved.kind ||
			canonical.argv.length !== approved.argv.length ||
			canonical.argv.some((argument, index) => argument !== approved.argv[index])
		) {
			violations.push("approvedValidations must contain only canonical parsed commands");
			break;
		}
		if (approvedDigests.has(approved.digest)) {
			violations.push("approvedValidations must not contain duplicates");
			break;
		}
		approvedDigests.add(approved.digest);
	}

	for (const counter of nonNegativeStats(state)) {
		if (counter.value < 0) violations.push(`stats.${counter.name} must not be negative`);
	}

	return violations;
}
function findingDigest(value: string | undefined): string {
	return `finding-${createHash("sha256").update(value ?? "", "utf8").digest("hex")}`;
}
export function resetBlockedEvidenceRecovery(state: LeanFlowState): void {
	state.lastBlockedSnapshotDigest = undefined;
	state.lastBlockedObservationBoundary = undefined;
	state.lastBlockedFindingDigest = undefined;
	state.consecutiveSameSnapshotBlocked = 0;
}

function reduceGateDispatch(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_dispatch" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" || !event.repositoryFingerprint) return { effects: [] };

	state.gateDispatches = (state.gateDispatches ?? 0) + 1;
	state.gateLease = {
		toolCallId: event.toolCallId,
		kind: "gate",
		runId: event.runId,
		cycle: state.gateAttempt + 1,
		startedAt: event.now,
		snapshotDigest: event.snapshotDigest,
		planDigest: event.planDigest,
		buildRecordRound: event.buildRecordRound,
		repositoryFingerprint: event.repositoryFingerprint,
	};
	state.gateAttempt++;
	state.phase = "gating";
	return { effects: [] };
}

function reduceGateSettlement(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_settled" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	const repaired = state.gateRetryMode === "repair";
	state.gateLease = undefined;

	switch (event.outcome) {
		case "PASS":
			state.gateCalls++;
			state.gateRetryMode = undefined;
			state.terminalOutcome = "pass";
			recordGatePass(state, repaired);
			resetConsecutiveGateErrors(state);
			resetBlockedEvidenceRecovery(state);
			state.baselineCaptured = false;
			state.phase = "finalizing";
			return {
				effects: [
					{ kind: "write_marker", status: "completed" },
					{ kind: "notify", level: "info", message: "Gate passed; finalizing LeanFlow run." },
				],
			};
		case "FAIL":
			state.gateCalls++;
			state.lastGateFindings = truncateFindings(event.findingsJson);
			resetBlockedEvidenceRecovery(state);
			if (state.gateCalls < MAX_GATE_VERDICTS) {
				state.gateRetryMode = "repair";
				recordGateFailure(state, true);
				resetConsecutiveGateErrors(state);
				state.repairLease = {
					fromRound: state.gateAttempt,
					toRound: state.gateAttempt + 1,
					reason: "gate_fail",
					startedAt: Date.now(),
				};
				state.phase = "repair_preparing";
				state.writtenArtifacts = [];
				return {
					effects: [
						{ kind: "clear_artifacts" },
						{ kind: "notify", level: "warning", message: "Gate failed; beginning the repair round." },
						{ kind: "begin_repair_round" },
					],
				};
			}

			recordGateFailure(state, false);
			resetConsecutiveGateErrors(state);
			state.repairLease = undefined;
			state.phase = "awaiting_human";
			return {
				effects: [
					{ kind: "write_marker", status: "paused" },
					{
						kind: "notify",
						level: "warning",
						message: "Gate failed twice; review the findings and use /flowcontinue to begin a human repair cycle.",
					},
				],
			};
		case "BLOCKED": {
			const snapshotDigest = event.snapshotDigest;
			const observationBoundary = event.observationBoundary;
			const findingsDigest = findingDigest(event.findingsJson);
			if (snapshotDigest === undefined || observationBoundary === undefined) {
				resetBlockedEvidenceRecovery(state);
			} else {
				const repeated =
					state.lastBlockedSnapshotDigest === snapshotDigest &&
					state.lastBlockedObservationBoundary === observationBoundary &&
					state.lastBlockedFindingDigest === findingsDigest;
				state.lastBlockedSnapshotDigest = snapshotDigest;
				state.lastBlockedObservationBoundary = observationBoundary;
				state.lastBlockedFindingDigest = findingsDigest;
				state.consecutiveSameSnapshotBlocked = repeated ? (state.consecutiveSameSnapshotBlocked ?? 0) + 1 : 1;
			}
			state.gateRetryMode = "evidence";
			recordGateBlocked(state);
			resetConsecutiveGateErrors(state);
			if ((state.consecutiveSameSnapshotBlocked ?? 0) >= MAX_SAME_SNAPSHOT_BLOCKED) {
				state.baselineCaptured = false;
				state.phase = "awaiting_human";
				return {
					effects: [
						{ kind: "write_marker", status: "paused" },
						{
							kind: "notify",
							level: "warning",
							message: "Gate remained BLOCKED with unchanged evidence; add new validation evidence, edit the plan, or use /flowcontinue.",
						},
					],
				};
			}
			state.phase = "building";
			return {
				effects: [
					{ kind: "clear_artifacts" },
					{
						kind: "notify",
						level: "warning",
						message: "Gate evidence is insufficient; re-validate and re-finalize without source changes.",
					},
				],
			};
		}
	}
}

function reduceGateError(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	state.gateLease = undefined;
	recordGateError(state, false);
	state.gateRetryMode = "operational";
	if ((state.consecutiveGateErrors ?? 0) >= MAX_GATE_ERRORS) {
		state.baselineCaptured = false;
		state.phase = "awaiting_human";
		return {
			effects: [
				{ kind: "write_marker", status: "paused" },
				{
					kind: "notify",
					level: "warning",
					message: "Gate repeatedly failed to execute; use /flowcontinue after resolving the operational issue.",
				},
			],
		};
	}

	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: "Gate execution failed; retry with unchanged evidence.",
			},
		],
	};
}

function reduceGateInterrupted(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	state.gateLease = undefined;
	recordGateInterruption(state);
	state.gateRetryMode = "operational";
	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: "Gate interrupted by session switch; retry Gate with unchanged evidence.",
			},
		],
	};
}

function reduceRepairRoundReady(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "repair_round_ready" }>,
): { effects: Effect[] } {
	if (state.phase !== "repair_preparing") return { effects: [] };

	if (state.repairLease && event.round !== state.repairLease.toRound) {
		state.repairLease = undefined;
		state.phase = "awaiting_human";
		return {
			effects: [
				{ kind: "write_marker", status: "paused" },
				{ kind: "notify", level: "warning", message: `Repair round mismatch: ${event.round} vs lease` },
			],
		};
	}
	const reason = state.repairLease?.reason;
	state.gateAttempt = event.round - 1;
	if (state.gateAttempt < 0) state.gateAttempt = 0;
	state.gateRetryMode = "repair";
	resetBlockedEvidenceRecovery(state);
	state.baselineCaptured = event.baselineCaptured;
	state.phase = "building";
	state.repairLease = undefined;
	return {
		effects: [
			{ kind: "write_marker", status: "building" },
			{
				kind: "notify",
				level: "info",
				message:
					reason === "human_continue"
						? "Human repair cycle started; rebuild and re-gate."
						: `Repair round ${event.round} ready; rebuild and re-gate.`,
			},
		],
	};
}

function reduceRepairRoundFailed(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "repair_round_failed" }>,
): { effects: Effect[] } {
	if (state.phase !== "repair_preparing") return { effects: [] };

	state.repairLease = undefined;
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{
				kind: "notify",
				level: "warning",
				message: `Gate repair setup failed: ${event.reason}. Use /flowcontinue to retry after resolving the issue.`,
			},
		],
	};
}

function reduceRestoreReconcile(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase === "gating") {
		if (!state.gateLease) {
			state.gateRetryMode = "operational";
			state.phase = "building";
			recordGateInterruption(state);
			return {
				effects: [{ kind: "notify", level: "warning", message: "Gate lease missing; restored to BUILD." }],
			};
		}
		return { effects: [] };
	}
	if (state.phase === "building" && state.lspProbeStatus === "pending") {
		state.lspLease = undefined;
	}
	return { effects: [] };
}

function reduceHumanContinue(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "awaiting_human") return { effects: [] };

	state.humanRepairCycles = (state.humanRepairCycles ?? 0) + 1;
	state.gateCalls = 0;
	state.gateRetryMode = "repair";
	state.terminalOutcome = undefined;
	resetConsecutiveGateErrors(state);
	resetBlockedEvidenceRecovery(state);
	state.repairLease = { fromRound: state.gateAttempt, toRound: state.gateAttempt + 1, reason: "human_continue", startedAt: Date.now() };
	state.phase = "repair_preparing";
	return {
		effects: [
			{ kind: "clear_artifacts" },
			{ kind: "begin_repair_round" },
		],
	};
}

function reduceRepositoryChangedDuringGate(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "repository_changed_during_gate" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };
	state.gateLease = undefined;
	state.gateRetryMode = undefined;
	state.writtenArtifacts = [];
	state.buildMutationObserved = true;
	resetConsecutiveGateErrors(state);
	resetBlockedEvidenceRecovery(state);
	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: `Gate result was discarded because repository state changed during review: ${event.reason}`,
			},
		],
	};
}

function reduceSnapshotEvidenceInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "snapshot_evidence_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	state.gateLease = undefined;
	state.gateRetryMode = "evidence";
	state.writtenArtifacts = [];
	resetConsecutiveGateErrors(state);
	resetBlockedEvidenceRecovery(state);
	state.phase = "building";
	return {
		effects: [
			{ kind: "notify", level: "warning", message: `Gate snapshot invalid: ${event.reason}; re-finalize evidence.` },
		],
	};
}

function reduceSnapshotRecordInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "snapshot_record_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	state.gateLease = undefined;
	state.repairLease = undefined;
	state.gateRetryMode = undefined;
	resetConsecutiveGateErrors(state);
	resetBlockedEvidenceRecovery(state);
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{ kind: "notify", level: "warning", message: `BUILD record invalid: ${event.reason}; use /flowcontinue or /flowcancel.` },
		],
	};
}

function reduceSnapshotPlanDrift(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	// The approved plan changed under an in-flight Gate: discard the whole
	// Gate cycle so re-approval starts from a fresh BUILD record round. The
	// captured baseline and any repair lease belong to the invalidated cycle;
	// keeping them would violate checkInvariants once the run leaves the
	// build phases via refreshCanonicalPlanState.
	state.gateLease = undefined;
	state.repairLease = undefined;
	state.baselineCaptured = false;
	state.gateCalls = 0;
	state.gateAttempt = 0;
	state.gateDispatches = 0;
	state.gateRetryMode = undefined;
	state.writtenArtifacts = [];
	resetConsecutiveGateErrors(state);
	resetBlockedEvidenceRecovery(state);
	return { effects: [] };
}

function reduceHumanFinishFailed(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "awaiting_human") return { effects: [] };

	state.terminalOutcome = "fail_after_retry";
	recordTerminalFailure(state);
	state.baselineCaptured = false;
	resetBlockedEvidenceRecovery(state);
	state.phase = "finalizing";
	return { effects: [{ kind: "write_marker", status: "failed" }] };
}

function truncateFindings(findings: string | undefined): string | undefined {
	if (findings === undefined || findings.length <= MAX_FINDINGS_LENGTH) return findings;
	return `${findings.slice(0, MAX_FINDINGS_LENGTH - 1)}…`;
}

function nonNegativeStats(state: LeanFlowState): Array<{ name: string; value: number }> {
	const stats = state.stats;
	if (!stats) return [];

	const counters: Array<{ name: string; value: number }> = [
		{ name: "gatePasses", value: stats.gatePasses },
		{ name: "gateVerdictFailures", value: stats.gateVerdictFailures },
		{ name: "gateBlocked", value: stats.gateBlocked },
		{ name: "gateErrors", value: stats.gateErrors },
		{ name: "gateInterruptions", value: stats.gateInterruptions ?? 0 },
		{ name: "gateReadinessBlocks", value: stats.gateReadinessBlocks },
		{ name: "repairRounds", value: stats.repairRounds },
		{ name: "repairSuccesses", value: stats.repairSuccesses },
		{ name: "terminalFailures", value: stats.terminalFailures },
	];

	for (const [phaseName, phase] of Object.entries({
		planning: stats.planning,
		awaitingApproval: stats.awaitingApproval,
		building: stats.building,
		gating: stats.gating,
	})) {
		counters.push(
			{ name: `${phaseName}.input`, value: phase.input },
			{ name: `${phaseName}.output`, value: phase.output },
			{ name: `${phaseName}.cacheRead`, value: phase.cacheRead },
			{ name: `${phaseName}.responses`, value: phase.responses },
			{ name: `${phaseName}.elapsedMs`, value: phase.elapsedMs },
		);
	}

	for (const [name, value] of Object.entries({
		beforeMessages: stats.beforeMessages,
		afterMessages: stats.afterMessages,
		beforeBytes: stats.beforeBytes,
		afterBytes: stats.afterBytes,
	})) {
		if (value !== undefined) counters.push({ name, value });
	}
	return counters;
}
