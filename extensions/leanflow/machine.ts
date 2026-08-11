import { finalizedGateSnapshotDigest, type OperationalRetrySnapshot } from "./provenance";
import {
	STATE_VERSION,
	createRepairLease,
	type BlockedReasonCode,
	type GateOutcome,
	type GateRecoveryAction,
	type LeanFlowState,
	type RepositoryFingerprint,
	type RunMarkerStatus,
} from "./state";
import {
	recordGateBlocked,
	recordGateError,
	recordGateFailure,
	recordGateInterruption,
	recordGatePass,
	recordTerminalFailure,
	resetConsecutiveGateErrors,
} from "./stats";
import { createApprovedValidationContract, type ValidationSemanticState } from "./validation";

export type GateEvent =
	| {
			type: "gate_dispatch";
			toolCallId: string;
			runId: string;
			snapshotDigest: string;
			planDigest: string;
			buildRecordRound: number;
			repositoryFingerprint?: RepositoryFingerprint;
			reuseCycle: boolean;
			now: number;
	  }
	| {
			type: "gate_settled";
			outcome: GateOutcome;
			findingsJson?: string;
			reasonCode?: BlockedReasonCode;
			evidenceIds?: string[];
			validationStates?: ValidationSemanticState[];
			semanticEvidenceDigest?: string;
	  }
	| { type: "gate_error"; operationalRetrySnapshot: OperationalRetrySnapshot }
	| { type: "gate_interrupted"; operationalRetrySnapshot: OperationalRetrySnapshot }
	| { type: "restore_reconcile"; now: number }
	| {
			type: "repair_round_ready";
			transactionId: string;
			runId: string;
			fromRound: number;
			round: number;
			baselineCaptured: boolean;
			freshRecord: boolean;
			lspEvidencePresent: boolean;
	  }
	| { type: "repair_round_failed"; transactionId: string; runId: string; reason: string }
	| { type: "snapshot_invalid"; reason: string }
	| { type: "record_invalid"; reason: string; checkpointRecoverable: boolean }
	| { type: "plan_drift"; reason: string }
	| { type: "contract_invalid"; reason: string }
	| { type: "lease_invalid"; reason: string }
	| { type: "repository_changed"; reason: string }
	| { type: "blocked_no_progress"; reason: string }
	| { type: "finalization_authority_invalid"; reason: string }
	| {
			type: "legacy_evidence_migration";
			fromVersion: 1 | 2;
			baselineCaptured: boolean;
			resumeTerminalPass: boolean;
	  }
	| { type: "human_continue"; now: number }
	| { type: "human_finish_failed"; now: number };

/**
 * Classifies a failed Gate snapshot verification so the caller can pick a
 * typed recovery path instead of one uniform operational retry.
 */
export type SnapshotFailureKind =
	| "artifact_rebuildable"
	| "manifest_missing"
	| "record_invalid"
	| "plan_drift"
	| "validation_contract_invalid"
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
			return reduceGateError(state, event);
		case "gate_interrupted":
			return reduceGateInterrupted(state, event);
		case "restore_reconcile":
			return reduceRestoreReconcile(state);
		case "repair_round_ready":
			return reduceRepairRoundReady(state, event as Extract<GateEvent, { type: "repair_round_ready" }>);
		case "repair_round_failed":
			return reduceRepairRoundFailed(state, event);
		case "snapshot_invalid":
			return reduceSnapshotInvalid(state, event);
		case "record_invalid":
			return reduceRecordInvalid(state, event);
		case "plan_drift":
			return reducePlanOrContractInvalid(state, event, "repair_plan_and_reapprove");
		case "contract_invalid":
			return reducePlanOrContractInvalid(state, event, "repair_plan_and_reapprove");
		case "lease_invalid":
			return reduceLeaseInvalid(state, event);
		case "repository_changed":
			return reduceRepositoryChanged(state, event);
		case "blocked_no_progress":
			return reduceBlockedNoProgress(state, event);
		case "finalization_authority_invalid":
			return reduceFinalizationAuthorityInvalid(state, event);
		case "legacy_evidence_migration":
			return reduceLegacyEvidenceMigration(state, event);
		case "human_continue":
			return reduceHumanContinue(state);
		case "human_finish_failed":
			return reduceHumanFinishFailed(state);
	}
}

/** Returns state combinations that violate the Gate lifecycle contract. */
export function checkInvariants(state: LeanFlowState): string[] {
	const violations: string[] = [];
	if (state.phase !== "idle" && state.stateVersion !== STATE_VERSION) {
		violations.push(`active run requires stateVersion=${STATE_VERSION}`);
	}

	const gateLease = state.gateLease;
	const finalized = state.finalizedGateSnapshot;
	const gateReady = state.phase === "gating" || finalized !== undefined;
	if (!finalized && state.finalizationCommitNonce !== undefined) {
		violations.push("finalization commit nonce requires a finalized Gate snapshot");
	}
	if (gateReady && (!finalized || !state.finalizationCommitNonce)) {
		violations.push("Gate-ready state requires nonce-bound finalized authority");
	}
	if (state.phase === "gating") {
		if (!gateLease) violations.push("gating phase requires a gate lease");
		if (!gateLease?.repositoryFingerprint) violations.push("gating phase requires a repository fingerprint");
		if (!finalized) violations.push("gating phase requires a finalized Gate snapshot");
		if (
			gateLease &&
			finalized &&
			(gateLease.runId !== finalized.runId ||
				gateLease.snapshotDigest !== finalizedGateSnapshotDigest(finalized) ||
				gateLease.planDigest !== finalized.planDigest ||
				gateLease.buildRecordRound !== finalized.buildRecordRound ||
				gateLease.repositoryFingerprint?.combinedDigest !== finalized.repositoryFingerprint.combinedDigest)
		) {
			violations.push("gating lease must match the finalized Gate snapshot");
		}
	} else if (gateLease) {
		violations.push("gate lease is only valid while gating");
	}
	if (state.phase === "repair_preparing") {
		if (state.gateRetryMode !== "repair") violations.push("repair_preparing phase requires gateRetryMode=repair");
		if ((state.writtenArtifacts?.length ?? 0) !== 0) violations.push("repair_preparing phase requires no written artifacts");
		if (!state.repairLease) violations.push("repair_preparing phase requires a repair lease");
		if (state.finalizedGateSnapshot) violations.push("repair_preparing phase must not retain a finalized snapshot");
	} else if (state.repairLease) {
		violations.push("repair lease is only valid while preparing a repair round");
	}
	if (state.phase === "awaiting_human" && state.terminalOutcome !== undefined) {
		violations.push("awaiting_human phase must not have a terminal outcome");
	}
	if (state.phase === "finalizing" && state.terminalOutcome === undefined) {
		violations.push("finalizing phase requires a terminal outcome");
	}
	if (state.phase === "finalizing" && state.terminalOutcome === "pass" && (!finalized || !state.finalizationCommitNonce)) {
		violations.push("successful finalization requires nonce-bound Gate authority");
	}
	if (state.gateCalls < 0 || state.gateCalls > MAX_GATE_VERDICTS) {
		violations.push(`gateCalls must be between 0 and ${MAX_GATE_VERDICTS}`);
	}
	if (
		state.baselineCaptured &&
		state.phase !== "building" &&
		state.phase !== "gating" &&
		state.phase !== "awaiting_human" &&
		state.phase !== "repair_preparing"
	) {
		violations.push("baselineCaptured is only valid during building, gating, awaiting_human, or repair_preparing");
	}
	if ((state.consecutiveGateErrors ?? 0) < 0 || (state.consecutiveGateErrors ?? 0) > MAX_GATE_ERRORS) {
		violations.push(`consecutiveGateErrors must be between 0 and ${MAX_GATE_ERRORS}`);
	}
	if (
		state.phase !== "idle" &&
		state.phase !== "planning" &&
		state.phase !== "awaiting_approval" &&
		(!Number.isInteger(state.currentBuildRound) || (state.currentBuildRound ?? 0) < 1)
	) {
		violations.push("active BUILD lifecycle requires currentBuildRound");
	}
	if (finalized) {
		if (state.finalizationCommitNonce !== finalized.finalizationCommitNonce) {
			violations.push("finalized snapshot nonce must match state");
		}
		if (state.currentBuildRound !== finalized.buildRecordRound) {
			violations.push("finalized snapshot round must match currentBuildRound");
		}
		if (
			finalized.runId !== state.runId ||
			finalized.planSlug !== state.planSlug ||
			finalized.planDigest !== state.planDigest ||
			finalized.approvedValidationDigest !== state.approvedValidationDigest
		) {
			violations.push("finalized snapshot must match the active run identity");
		}
		if (finalized.validationStates.some((validation) => validation.status !== "passed")) {
			violations.push("finalized snapshot requires every validation to be passed");
		}
	}
	if (state.gateRetryMode === "operational") {
		const retry = state.operationalRetrySnapshot;
		if (!retry || !finalized) {
			violations.push("operational retry requires durable retry and finalized snapshots");
		} else if (retry.finalizedSnapshotDigest !== finalizedGateSnapshotDigest(finalized)) {
			violations.push("operational retry must retain the original finalized snapshot identity");
		}
		if (state.phase !== "building" && state.phase !== "gating") {
			violations.push("operational retry is only valid during BUILD or Gate");
		}
	} else if (state.operationalRetrySnapshot) {
		violations.push("operational retry snapshot is only valid in operational retry mode");
	}
	if (state.blockedRecovery) {
		if (
			state.blockedRecovery.consecutiveEquivalentBlocked < 1 ||
			state.blockedRecovery.consecutiveEquivalentBlocked > MAX_SAME_SNAPSHOT_BLOCKED ||
			state.blockedRecovery.evidenceIds.length === 0 ||
			new Set(state.blockedRecovery.evidenceIds).size !== state.blockedRecovery.evidenceIds.length
		) {
			violations.push("semantic BLOCKED recovery state is invalid");
		}
	}
	const contract = state.approvedValidationContract;
	if ((contract === undefined) !== (state.approvedValidationDigest === undefined)) {
		violations.push("approved validation contract and digest must be present together");
	} else if (contract) {
		if (
			createApprovedValidationContract(contract.planDigest, contract.validations).digest !== contract.digest ||
			contract.digest !== state.approvedValidationDigest ||
			contract.planDigest !== state.planDigest
		) {
			violations.push("approved validation contract must match the canonical plan");
		}
	}

	for (const counter of nonNegativeStats(state)) {
		if (counter.value < 0) violations.push(`stats.${counter.name} must not be negative`);
	}
	return violations;
}

export function resetBlockedRecovery(state: LeanFlowState): void {
	state.blockedRecovery = undefined;
}

function reduceGateDispatch(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_dispatch" }>,
): { effects: Effect[] } {
	if (
		state.phase !== "building" ||
		!event.repositoryFingerprint ||
		!state.finalizedGateSnapshot ||
		state.finalizationCommitNonce !== state.finalizedGateSnapshot.finalizationCommitNonce ||
		event.runId !== state.finalizedGateSnapshot.runId ||
		event.snapshotDigest !== finalizedGateSnapshotDigest(state.finalizedGateSnapshot) ||
		event.planDigest !== state.finalizedGateSnapshot.planDigest ||
		event.buildRecordRound !== state.currentBuildRound ||
		event.buildRecordRound !== state.finalizedGateSnapshot.buildRecordRound ||
		event.repositoryFingerprint.combinedDigest !== state.finalizedGateSnapshot.repositoryFingerprint.combinedDigest
	) {
		return { effects: [] };
	}
	const cycle = event.reuseCycle ? state.gateAttempt : state.gateAttempt + 1;
	state.gateDispatches = (state.gateDispatches ?? 0) + 1;
	state.gateLease = {
		toolCallId: event.toolCallId,
		kind: "gate",
		runId: event.runId,
		cycle,
		startedAt: event.now,
		snapshotDigest: event.snapshotDigest,
		planDigest: event.planDigest,
		buildRecordRound: event.buildRecordRound,
		repositoryFingerprint: event.repositoryFingerprint,
	};
	state.gateAttempt = cycle;
	state.recoveryAction = undefined;
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
			state.operationalRetrySnapshot = undefined;
			state.terminalOutcome = "pass";
			recordGatePass(state, repaired);
			resetConsecutiveGateErrors(state);
			resetBlockedRecovery(state);
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
			state.finalizedGateSnapshot = undefined;
			state.finalizationCommitNonce = undefined;
			state.operationalRetrySnapshot = undefined;
			resetBlockedRecovery(state);
			if (state.gateCalls < MAX_GATE_VERDICTS) {
				state.gateRetryMode = "repair";
				recordGateFailure(state, true);
				resetConsecutiveGateErrors(state);
				const fromRound = state.currentBuildRound ?? state.gateAttempt;
				state.repairLease = createRepairLease(state, fromRound, "gate_fail");
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
			if (
				!event.reasonCode ||
				!event.evidenceIds ||
				event.evidenceIds.length === 0 ||
				!event.validationStates ||
				!event.semanticEvidenceDigest
			) {
				state.finalizedGateSnapshot = undefined;
				state.finalizationCommitNonce = undefined;
				state.operationalRetrySnapshot = undefined;
				state.gateRetryMode = undefined;
				state.baselineCaptured = false;
				state.phase = "awaiting_human";
				return {
					effects: [
						{ kind: "write_marker", status: "paused" },
						{ kind: "notify", level: "warning", message: "Gate BLOCKED result lacked semantic recovery identity." },
					],
				};
			}
			const evidenceIds = [...new Set(event.evidenceIds)].sort();
			const previous = state.blockedRecovery;
			const repeated =
				previous?.reasonCode === event.reasonCode &&
				previous.semanticEvidenceDigest === event.semanticEvidenceDigest &&
				previous.evidenceIds.length === evidenceIds.length &&
				previous.evidenceIds.every((id, index) => id === evidenceIds[index]);
			const consecutiveEquivalentBlocked = repeated
				? (previous?.consecutiveEquivalentBlocked ?? 0) + 1
				: 1;
			state.blockedRecovery = {
				reasonCode: event.reasonCode,
				evidenceIds,
				validationStates: event.validationStates.map((validation) => ({ ...validation })),
				semanticEvidenceDigest: event.semanticEvidenceDigest,
				consecutiveEquivalentBlocked,
			};
			state.finalizedGateSnapshot = undefined;
			state.finalizationCommitNonce = undefined;
			state.operationalRetrySnapshot = undefined;
			state.writtenArtifacts = [];
			state.gateRetryMode = "evidence";
			recordGateBlocked(state);
			resetConsecutiveGateErrors(state);
			if (consecutiveEquivalentBlocked >= MAX_SAME_SNAPSHOT_BLOCKED) {
				state.baselineCaptured = false;
				state.gateRetryMode = undefined;
				state.phase = "awaiting_human";
				return {
					effects: [
						{ kind: "write_marker", status: "paused" },
						{
							kind: "notify",
							level: "warning",
							message: "Gate remained BLOCKED for the same reason and evidence IDs; use /flowcontinue.",
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
						message: "Gate evidence is insufficient; complete a missing or failed required validation and re-finalize.",
					},
				],
			};
		}
	}
}

function reduceGateError(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_error" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };
	state.gateLease = undefined;
	recordGateError(state, false);
	state.gateRetryMode = "operational";
	state.operationalRetrySnapshot = event.operationalRetrySnapshot;
	if ((state.consecutiveGateErrors ?? 0) >= MAX_GATE_ERRORS) {
		state.baselineCaptured = false;
		state.gateRetryMode = undefined;
		state.operationalRetrySnapshot = undefined;
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
				message: "Gate execution failed; retry the verified finalized snapshot unchanged.",
			},
		],
	};
}

function reduceGateInterrupted(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_interrupted" }>,
): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };
	state.gateLease = undefined;
	recordGateInterruption(state);
	state.gateRetryMode = "operational";
	state.operationalRetrySnapshot = event.operationalRetrySnapshot;
	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: "Gate interrupted by session switch; retry the verified finalized snapshot unchanged.",
			},
		],
	};
}

function reduceRepairRoundReady(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "repair_round_ready" }>,
): { effects: Effect[] } {
	if (
		state.phase !== "repair_preparing" ||
		!state.repairLease ||
		event.transactionId !== state.repairLease.transactionId ||
		event.runId !== state.runId ||
		event.fromRound !== state.repairLease.fromRound ||
		event.round !== state.repairLease.toRound
	) {
		return { effects: [] };
	}
	const reason = state.repairLease.reason;
	state.gateAttempt = event.round - 1;
	if (state.gateAttempt < 0) state.gateAttempt = 0;
	state.currentBuildRound = event.round;
	state.gateRetryMode = "repair";
	state.finalizedGateSnapshot = undefined;
	state.finalizationCommitNonce = undefined;
	state.operationalRetrySnapshot = undefined;
	state.writtenArtifacts = [];
	resetBlockedRecovery(state);
	state.baselineCaptured = event.baselineCaptured;
	if (event.freshRecord) {
		const lspRequired = state.lspProbeStatus !== "not_required";
		state.buildMutationObserved = false;
		state.lspLease = undefined;
		state.lspProbeTarget = undefined;
		state.lspProbeStatus = lspRequired && !event.lspEvidencePresent ? "pending" : lspRequired ? "completed" : "not_required";
	}
	state.phase = "building";
	state.recoveryAction = undefined;
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
	if (
		state.phase !== "repair_preparing" ||
		!state.repairLease ||
		event.transactionId !== state.repairLease.transactionId ||
		event.runId !== state.runId
	) {
		return { effects: [] };
	}
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
	state.finalizedGateSnapshot = undefined;
	state.finalizationCommitNonce = undefined;
	state.operationalRetrySnapshot = undefined;
	state.writtenArtifacts = [];
	resetBlockedRecovery(state);
	state.recoveryAction = undefined;
	const fromRound = state.currentBuildRound ?? state.gateAttempt;
	state.repairLease = createRepairLease(state, fromRound, "human_continue");
	state.phase = "repair_preparing";
	return {
		effects: [
			{ kind: "clear_artifacts" },
			{ kind: "begin_repair_round" },
		],
	};
}


function clearGateProvenanceForRecovery(state: LeanFlowState, resetBlockedBoundary: boolean): void {
	state.gateLease = undefined;
	state.repairLease = undefined;
	state.gateRetryMode = undefined;
	state.finalizedGateSnapshot = undefined;
	state.finalizationCommitNonce = undefined;
	state.operationalRetrySnapshot = undefined;
	state.writtenArtifacts = [];
	resetConsecutiveGateErrors(state);
	if (resetBlockedBoundary) resetBlockedRecovery(state);
}

function reduceRepositoryChanged(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "repository_changed" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating") return { effects: [] };
	clearGateProvenanceForRecovery(state, false);
	state.buildMutationObserved = true;
	state.recoveryAction = undefined;
	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: `Gate result was discarded because repository state changed: ${event.reason}`,
			},
		],
	};
}

function reduceSnapshotInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "snapshot_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating") return { effects: [] };
	clearGateProvenanceForRecovery(state, false);
	state.gateRetryMode = "evidence";
	state.recoveryAction = undefined;
	state.phase = "building";
	return {
		effects: [
			{ kind: "notify", level: "warning", message: `Gate snapshot invalid: ${event.reason}; re-finalize evidence.` },
		],
	};
}

function reduceLegacyEvidenceMigration(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "legacy_evidence_migration" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating" && state.phase !== "finalizing") {
		return { effects: [] };
	}
	clearGateProvenanceForRecovery(state, false);
	state.terminalOutcome = undefined;
	state.baselineCaptured = event.baselineCaptured;
	state.gateRetryMode = "evidence";
	state.recoveryAction = event.resumeTerminalPass
		? "refinalize_legacy_pass"
		: "refinalize_trusted_checkpoint";
	state.phase = "building";
	return {
		effects: [
			{
				kind: "notify",
				level: "info",
				message: `BUILD evidence v${event.fromVersion} requires a one-time v3 re-finalization.`,
			},
		],
	};
}

function reduceBlockedNoProgress(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "blocked_no_progress" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" || !state.blockedRecovery) {
		return { effects: [] };
	}
	state.blockedRecovery.consecutiveEquivalentBlocked = MAX_SAME_SNAPSHOT_BLOCKED;
	state.gateRetryMode = undefined;
	state.finalizedGateSnapshot = undefined;
	state.finalizationCommitNonce = undefined;
	state.operationalRetrySnapshot = undefined;
	state.baselineCaptured = false;
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{
				kind: "notify",
				level: "warning",
				message: `Gate evidence recovery made no semantic progress: ${event.reason}; use /flowcontinue.`,
			},
		],
	};
}

function reduceRecordInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "record_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating") return { effects: [] };
	clearGateProvenanceForRecovery(state, false);
	if (event.checkpointRecoverable) {
		state.gateRetryMode = "evidence";
		if (state.recoveryAction !== "refinalize_legacy_pass") {
			state.recoveryAction = "refinalize_trusted_checkpoint";
		}
		state.phase = "building";
		return {
			effects: [
				{
					kind: "notify",
					level: "warning",
					message: `BUILD record no longer matches the Gate manifest: ${event.reason}; re-finalize the trusted checkpoint.`,
				},
			],
		};
	}
	state.baselineCaptured = false;
	state.recoveryAction = "flowcontinue_rebuild_checkpoint";
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{
				kind: "notify",
				level: "warning",
				message: `BUILD record invalid: ${event.reason}; use /flowcontinue to rebuild a fresh checkpoint.`,
			},
		],
	};
}

function reducePlanOrContractInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "plan_drift" | "contract_invalid" }>,
	recoveryAction: GateRecoveryAction,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating") return { effects: [] };
	clearGateProvenanceForRecovery(state, true);
	state.baselineCaptured = false;
	state.currentBuildRound = undefined;
	state.approvedValidationContract = undefined;
	state.approvedValidationDigest = undefined;
	state.proposalBoundary = undefined;
	state.approvalRepairBoundary = undefined;
	state.proposedPlanArtifact = undefined;
	state.proposedPlanDigest = undefined;
	state.approvedPlanArtifact = undefined;
	state.approvalInvalidated = true;
	state.lspLease = undefined;
	state.recoveryAction = recoveryAction;
	state.phase = "planning";
	return {
		effects: [
			{
				kind: "notify",
				level: "warning",
				message: `${event.type === "plan_drift" ? "Canonical plan drifted" : "Approved validation contract is invalid"}: ${event.reason}; repair and re-propose the plan.`,
			},
		],
	};
}

function reduceLeaseInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "lease_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "building" && state.phase !== "gating") return { effects: [] };
	clearGateProvenanceForRecovery(state, false);
	state.baselineCaptured = false;
	state.recoveryAction = "flowcontinue_after_lease_failure";
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{
				kind: "notify",
				level: "warning",
				message: `Gate lease is invalid: ${event.reason}; use /flowcontinue after resolving the provenance issue.`,
			},
		],
	};
}

function reduceFinalizationAuthorityInvalid(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "finalization_authority_invalid" }>,
): { effects: Effect[] } {
	if (state.phase !== "finalizing" || state.terminalOutcome !== "pass") return { effects: [] };
	clearGateProvenanceForRecovery(state, true);
	state.terminalOutcome = undefined;
	state.baselineCaptured = false;
	state.recoveryAction = "flowcontinue_rebuild_checkpoint";
	state.phase = "awaiting_human";
	return {
		effects: [
			{ kind: "write_marker", status: "paused" },
			{
				kind: "notify",
				level: "warning",
				message: `Successful Gate finalization lost durable authority: ${event.reason}; use /flowcontinue to rebuild the checkpoint.`,
			},
		],
	};
}

function reduceHumanFinishFailed(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "awaiting_human") return { effects: [] };

	state.terminalOutcome = "fail_after_retry";
	recordTerminalFailure(state);
	state.baselineCaptured = false;
	state.finalizedGateSnapshot = undefined;
	state.finalizationCommitNonce = undefined;
	state.operationalRetrySnapshot = undefined;
	state.gateRetryMode = undefined;
	resetBlockedRecovery(state);
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
