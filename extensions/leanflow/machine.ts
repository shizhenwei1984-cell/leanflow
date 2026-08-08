import type { GateOutcome, LeanFlowState, RunMarkerStatus } from "./state";
import {
	recordGateBlocked,
	recordGateError,
	recordGateFailure,
	recordGatePass,
	recordTerminalFailure,
} from "./stats";

export type GateEvent =
	| { type: "gate_dispatch"; toolCallId: string; runId: string; snapshotDigest: string; now: number }
	| { type: "gate_settled"; outcome: GateOutcome; findingsJson?: string }
	| { type: "gate_error" }
	| { type: "restore_reconcile"; now: number }
	| { type: "human_continue"; now: number }
	| { type: "human_finish_failed"; now: number };

export type Effect =
	| { kind: "write_marker"; status: RunMarkerStatus }
	| { kind: "begin_repair_round" }
	| { kind: "clear_artifacts" }
	| { kind: "notify"; level: "info" | "warning"; message: string };

const MAX_GATE_VERDICTS = 2;
const MAX_GATE_ERRORS = 4;
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
		case "restore_reconcile":
			return reduceRestoreReconcile(state);
		case "human_continue":
			return reduceHumanContinue(state);
		case "human_finish_failed":
			return reduceHumanFinishFailed(state);
	}
}

/** Returns state combinations that violate the Gate lifecycle contract. */
export function checkInvariants(state: LeanFlowState): string[] {
	const violations: string[] = [];

	if (state.phase === "gating" && !state.gateLease) {
		violations.push("gating phase requires a gate lease");
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
	if (state.baselineCaptured && state.phase !== "building" && state.phase !== "gating") {
		violations.push("baselineCaptured is only valid during building or gating");
	}

	for (const counter of nonNegativeStats(state)) {
		if (counter.value < 0) violations.push(`stats.${counter.name} must not be negative`);
	}

	return violations;
}

function reduceGateDispatch(
	state: LeanFlowState,
	event: Extract<GateEvent, { type: "gate_dispatch" }>,
): { effects: Effect[] } {
	if (state.phase !== "building") return { effects: [] };

	state.gateDispatches = (state.gateDispatches ?? 0) + 1;
	state.gateLease = {
		toolCallId: event.toolCallId,
		kind: "gate",
		runId: event.runId,
		cycle: state.gateAttempt + 1,
		startedAt: event.now,
		snapshotDigest: event.snapshotDigest,
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
			if (state.gateCalls < MAX_GATE_VERDICTS) {
				state.gateRetryMode = "repair";
				recordGateFailure(state, true);
				state.phase = "building";
				return {
					effects: [
						{ kind: "clear_artifacts" },
						{ kind: "begin_repair_round" },
						{ kind: "notify", level: "warning", message: "Gate failed; beginning the repair round." },
					],
				};
			}

			recordGateFailure(state, false);
			state.baselineCaptured = false;
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
		case "BLOCKED":
			state.gateRetryMode = "evidence";
			recordGateBlocked(state);
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

function reduceGateError(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "gating") return { effects: [] };

	state.gateLease = undefined;
	recordGateError(state, false);
	state.gateRetryMode = "operational";
	if ((state.stats?.gateErrors ?? 0) >= MAX_GATE_ERRORS) {
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

function reduceRestoreReconcile(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase === "gating") {
		state.gateLease = undefined;
		recordGateError(state, false);
		state.gateRetryMode = "operational";
		state.phase = "building";
		return {
			effects: [
				{
					kind: "notify",
					level: "warning",
					message: "Gate interrupted by session restore; retry with unchanged evidence.",
				},
			],
		};
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
	state.phase = "building";
	return {
		effects: [
			{ kind: "clear_artifacts" },
			{ kind: "begin_repair_round" },
			{ kind: "write_marker", status: "building" },
			{ kind: "notify", level: "info", message: "Human repair cycle started; rebuild and re-gate." },
		],
	};
}

function reduceHumanFinishFailed(state: LeanFlowState): { effects: Effect[] } {
	if (state.phase !== "awaiting_human") return { effects: [] };

	state.terminalOutcome = "fail_after_retry";
	recordTerminalFailure(state);
	state.baselineCaptured = false;
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
