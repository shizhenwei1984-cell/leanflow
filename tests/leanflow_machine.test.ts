import { expect, test } from "bun:test";

import { checkInvariants, reduceGate, type Effect, type GateEvent } from "../extensions/leanflow/machine";
import {
	createFinalizedGateSnapshot,
	createOperationalRetrySnapshot,
	finalizedGateSnapshotDigest,
} from "../extensions/leanflow/provenance";
import { defaultState, type LeanFlowPhase, type LeanFlowState } from "../extensions/leanflow/state";
import { createApprovedValidationContract, parseApprovedValidation } from "../extensions/leanflow/validation";

const GATE_RUN_ID = "f8e46687-2719-4fa1-8b6f-f5bb9a4e1f42";
const LEGAL_PHASES: readonly LeanFlowPhase[] = [
	"idle",
	"planning",
	"awaiting_approval",
	"building",
	"gating",
	"repair_preparing",
	"awaiting_human",
	"finalizing",
];

const planDigest = sha64("b");
const approvedValidation = parseApprovedValidation("bun test")!;
const validationContract = createApprovedValidationContract(planDigest, [approvedValidation]);

function buildingState() {
	const state = defaultState();
	state.phase = "building";
	state.runId = GATE_RUN_ID;
	state.planSlug = "test";
	state.planDigest = planDigest;
	state.approvedValidationContract = validationContract;
	state.approvedValidationDigest = validationContract.digest;
	state.currentBuildRound = 1;
	return state;
}

function sha64(char: string): string {
	return char.repeat(64);
}

function repositoryFingerprint() {
	return {
		head: "c".repeat(40),
		trackedDiffDigest: sha64("c"),
		untrackedDigest: sha64("d"),
		combinedDigest: sha64("e"),
	};
}
function attachFinalizedSnapshot(state: LeanFlowState): void {
	if (state.gateRetryMode === "operational" && state.finalizedGateSnapshot) return;
	const round = state.currentBuildRound ?? Math.max(1, state.gateAttempt + 1);
	state.currentBuildRound = round;
	state.finalizedGateSnapshot = createFinalizedGateSnapshot({
		runId: state.runId ?? GATE_RUN_ID,
		planSlug: state.planSlug ?? "test",
		planDigest: state.planDigest ?? planDigest,
		approvedValidationDigest: state.approvedValidationDigest ?? validationContract.digest,
		buildRecordRound: round,
		buildRecordDigest: sha64("1"),
		buildArtifactDigest: sha64("2"),
		diffArtifactDigest: sha64("3"),
		evidenceArtifactDigest: sha64("4"),
		repositoryFingerprint: repositoryFingerprint(),
		validationStates: [
			{
				id: approvedValidation.id,
				status: "passed",
				observationId: `validation-${round}`,
				normalizedOutputDigest: sha64("5"),
				repositoryFingerprintAfter: repositoryFingerprint().combinedDigest,
			},
		],
	});
	state.finalizationCommitNonce = state.finalizedGateSnapshot.finalizationCommitNonce;
}

function operationalEvent(state: LeanFlowState, type: "gate_error" | "gate_interrupted"): GateEvent {
	if (!state.gateLease || !state.finalizedGateSnapshot) throw new Error("Gate provenance is unavailable");
	return {
		type,
		operationalRetrySnapshot: createOperationalRetrySnapshot(
			state.gateLease,
			state.finalizedGateSnapshot,
			type === "gate_error" ? "tool_error" : "session_switch",
		),
	};
}
function blockedEvent(semanticEvidenceDigest = sha64("9")): GateEvent {
	return {
		type: "gate_settled",
		outcome: "BLOCKED",
		findingsJson: '{"finding":"missing evidence"}',
		reasonCode: "stale_validation",
		evidenceIds: [approvedValidation.id],
		validationStates: [
			{
				id: approvedValidation.id,
				status: "stale",
				observationId: "validation-1",
				normalizedOutputDigest: sha64("5"),
				repositoryFingerprintAfter: repositoryFingerprint().combinedDigest,
			},
		],
		semanticEvidenceDigest,
	};
}
function detachedOperationalEvent(type: "gate_error" | "gate_interrupted"): GateEvent {
	const state = dispatch(buildingState(), `fixture-${type}`);
	return operationalEvent(state, type);
}




function dispatch(state = buildingState(), toolCallId = "gate-1") {
	attachFinalizedSnapshot(state);
	const snapshot = state.finalizedGateSnapshot!;
	const result = reduceGate(state, {
		type: "gate_dispatch",
		toolCallId,
		runId: GATE_RUN_ID,
		snapshotDigest: finalizedGateSnapshotDigest(snapshot),
		planDigest,
		buildRecordRound: state.currentBuildRound!,
		repositoryFingerprint: repositoryFingerprint(),
		reuseCycle: state.gateRetryMode === "operational" || state.gateRetryMode === "evidence",
		now: 10,
	});
	expect(result.effects).toEqual([]);
	return state;
}

test("dispatch records a persisted lease without consuming a Gate verdict", () => {
	const state = dispatch();

	expect(state.phase).toBe("gating");
	expect(state.gateCalls).toBe(0);
	expect(state.gateDispatches).toBe(1);
	expect(state.gateAttempt).toBe(1);
	expect(state.gateLease).toEqual({
		toolCallId: "gate-1",
		kind: "gate",
		runId: GATE_RUN_ID,
		cycle: 1,
		startedAt: 10,
		snapshotDigest: finalizedGateSnapshotDigest(state.finalizedGateSnapshot!),
		planDigest: sha64("b"),
		buildRecordRound: 1,
		repositoryFingerprint: repositoryFingerprint(),
	});
	expect(checkInvariants(state)).toEqual([]);
});

test("dispatch rejects a foreign run even when every artifact digest matches", () => {
	const state = buildingState();
	attachFinalizedSnapshot(state);
	const snapshot = state.finalizedGateSnapshot!;
	reduceGate(state, {
		type: "gate_dispatch",
		toolCallId: "foreign-gate",
		runId: "11111111-1111-4111-8111-111111111111",
		snapshotDigest: finalizedGateSnapshotDigest(snapshot),
		planDigest,
		buildRecordRound: state.currentBuildRound!,
		repositoryFingerprint: repositoryFingerprint(),
		reuseCycle: false,
		now: 10,
	});
	expect(state).toMatchObject({ phase: "building", gateDispatches: 0, gateAttempt: 0 });
	expect(state.gateLease).toBeUndefined();
	expect(checkInvariants(state)).toEqual([]);
});

test("legacy evidence migration revokes old authority before re-finalization", () => {
	const state = buildingState();
	attachFinalizedSnapshot(state);
	state.phase = "finalizing";
	state.terminalOutcome = "pass";
	state.baselineCaptured = false;
	const { effects } = reduceGate(state, {
		type: "legacy_evidence_migration",
		fromVersion: 2,
		baselineCaptured: true,
		resumeTerminalPass: true,
	});
	expect(state).toMatchObject({
		phase: "building",
		terminalOutcome: undefined,
		finalizedGateSnapshot: undefined,
		finalizationCommitNonce: undefined,
		gateRetryMode: "evidence",
		recoveryAction: "refinalize_legacy_pass",
		baselineCaptured: true,
	});
	expect(effects.map((effect) => effect.kind)).toEqual(["notify"]);
	reduceGate(state, {
		type: "record_invalid",
		reason: "v2 to v3 rewrite failed",
		checkpointRecoverable: true,
	});
	expect(state.recoveryAction).toBe("refinalize_legacy_pass");
	expect(checkInvariants(state)).toEqual([]);
});

test("PASS settles a verdict, preserves repair attribution, and finalizes", () => {
	const state = buildingState();
	state.gateRetryMode = "repair";
	state.baselineCaptured = true;
	dispatch(state);

	const { effects } = reduceGate(state, { type: "gate_settled", outcome: "PASS" });

	expect(state).toMatchObject({
		phase: "finalizing",
		gateCalls: 1,
		gateRetryMode: undefined,
		terminalOutcome: "pass",
		gateLease: undefined,
	});
	expect(state.stats).toMatchObject({ gatePasses: 1, repairSuccesses: 1 });
	expect(state.baselineCaptured).toBeFalse();
	expect(checkInvariants(state)).toEqual([]);
	expect(effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);
	expect(effects[0]).toEqual({ kind: "write_marker", status: "completed" });
});

test("first FAIL starts a repair round with artifacts cleared before initialization", () => {
	const state = dispatch();
	const { effects } = reduceGate(state, { type: "gate_settled", outcome: "FAIL", findingsJson: '{"id":"first"}' });

	expect(state).toMatchObject({
		phase: "repair_preparing",
		gateCalls: 1,
		gateRetryMode: "repair",
		gateLease: undefined,
		lastGateFindings: '{"id":"first"}',
		writtenArtifacts: [],
	});
	expect(state.finalizationCommitNonce).toBeUndefined();
	expect(state.stats).toMatchObject({ gateVerdictFailures: 1, repairRounds: 1 });
	expect(state.consecutiveGateErrors).toBe(0);
	expect(effects.map((effect) => effect.kind)).toEqual(["clear_artifacts", "notify", "begin_repair_round"]);
	expect(checkInvariants(state)).toEqual([]);
	const ready = reduceGate(state, { type: "repair_round_ready", round: 2, baselineCaptured: true, freshRecord: false, lspEvidencePresent: true });
	expect(state.phase).toBe("building");
	expect(state.baselineCaptured).toBe(true);
	expect(ready.effects.map((e) => e.kind)).toEqual(["write_marker", "notify"]);
	expect(ready.effects[1]).toEqual({
		kind: "notify",
		level: "info",
		message: "Repair round 2 ready; rebuild and re-gate.",
	});
	const human = buildingState();
	human.phase = "awaiting_human";
	human.gateAttempt = 1;
	reduceGate(human, { type: "human_continue", now: 10 });
	const humanReady = reduceGate(human, { type: "repair_round_ready", round: 2, baselineCaptured: false, freshRecord: false, lspEvidencePresent: true });
	expect(humanReady.effects[1]).toEqual({
		kind: "notify",
		level: "info",
		message: "Human repair cycle started; rebuild and re-gate.",
	});
	const failed = dispatch();
	reduceGate(failed, { type: "gate_settled", outcome: "FAIL" });
	const failEffects = reduceGate(failed, { type: "repair_round_failed", reason: "disk full" });
	expect(failed.phase).toBe("awaiting_human");
	expect(failEffects.effects.map((e) => e.kind)).toEqual(["write_marker", "notify"]);
});

test("fresh repair records require a new durable LSP probe when the plan requires LSP", () => {
	const state = buildingState();
	state.phase = "repair_preparing";
	state.gateAttempt = 1;
	state.currentBuildRound = 1;
	state.gateRetryMode = "repair";
	state.repairLease = { fromRound: 1, toRound: 2, reason: "human_continue", startedAt: 10 };
	state.lspProbeStatus = "completed";
	state.lspProbeTarget = "src/example.ts";
	state.buildMutationObserved = true;

	reduceGate(state, {
		type: "repair_round_ready",
		round: 2,
		baselineCaptured: false,
		freshRecord: true,
		lspEvidencePresent: false,
	});
	expect(state).toMatchObject({
		phase: "building",
		currentBuildRound: 2,
		gateAttempt: 1,
		lspProbeStatus: "pending",
		lspProbeTarget: undefined,
		buildMutationObserved: false,
		baselineCaptured: false,
	});
	expect(checkInvariants(state)).toEqual([]);
});

test("second FAIL pauses for a human without setting a terminal outcome", () => {
	const state = dispatch();
	state.baselineCaptured = true;
	reduceGate(state, { type: "gate_settled", outcome: "FAIL" });
	reduceGate(state, { type: "repair_round_ready", round: 2, baselineCaptured: true, freshRecord: false, lspEvidencePresent: true });
	dispatch(state, "gate-2");

	const { effects } = reduceGate(state, { type: "gate_settled", outcome: "FAIL", findingsJson: "x".repeat(4_001) });

	expect(state).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 2,
		lastGateFindings: `${"x".repeat(3_999)}…`,
	});
	expect(state.terminalOutcome).toBeUndefined();
	expect(state.baselineCaptured).toBe(true);
	expect(checkInvariants(state)).toEqual([]);
	expect(state.stats).toMatchObject({ gateVerdictFailures: 2, repairRounds: 1 });
	expect(effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);
	expect(effects[0]).toEqual({ kind: "write_marker", status: "paused" });
});

test("BLOCKED returns to BUILD without consuming a verdict", () => {
	const state = dispatch();
	const { effects } = reduceGate(state, blockedEvent());

	expect(state).toMatchObject({ phase: "building", gateCalls: 0, gateRetryMode: "evidence", gateLease: undefined });
	expect(state.finalizationCommitNonce).toBeUndefined();
	expect(state.stats).toMatchObject({ gateBlocked: 1 });
	expect(effects.map((effect) => effect.kind)).toEqual(["clear_artifacts", "notify"]);
	expect(checkInvariants(state)).toEqual([]);
});

test("typed provenance recovery events accept BUILD, Gate, and operational BUILD sources without consuming verdicts", () => {
	const repository = buildingState();
	attachFinalizedSnapshot(repository);
	repository.baselineCaptured = true;
	repository.gateRetryMode = "operational";
	repository.operationalRetrySnapshot = createOperationalRetrySnapshot(
		{
			toolCallId: "old-gate",
			kind: "gate",
			runId: GATE_RUN_ID,
			cycle: 1,
			startedAt: 1,
			snapshotDigest: finalizedGateSnapshotDigest(repository.finalizedGateSnapshot!),
			planDigest,
			buildRecordRound: 1,
			repositoryFingerprint: repositoryFingerprint(),
		},
		repository.finalizedGateSnapshot!,
		"tool_error",
	);
	const repositoryCalls = repository.gateCalls;
	const repositoryDispatches = repository.gateDispatches;
	reduceGate(repository, { type: "repository_changed", reason: "working tree changed" });
	expect(repository).toMatchObject({
		phase: "building",
		baselineCaptured: true,
		buildMutationObserved: true,
		gateRetryMode: undefined,
		finalizedGateSnapshot: undefined,
		gateCalls: repositoryCalls,
		gateDispatches: repositoryDispatches,
	});
	expect(checkInvariants(repository)).toEqual([]);

	const plan = dispatch();
	plan.baselineCaptured = true;
	plan.gateCalls = 1;
	const planDispatches = plan.gateDispatches;
	reduceGate(plan, { type: "plan_drift", reason: "canonical plan changed" });
	expect(plan).toMatchObject({
		phase: "planning",
		baselineCaptured: false,
		approvedPlanArtifact: undefined,
		approvedValidationContract: undefined,
		finalizedGateSnapshot: undefined,
		gateRetryMode: undefined,
		gateCalls: 1,
		gateDispatches: planDispatches,
		recoveryAction: "repair_plan_and_reapprove",
	});
	expect(checkInvariants(plan)).toEqual([]);

	const operational = dispatch(buildingState(), "operational-source");
	reduceGate(operational, operationalEvent(operational, "gate_error"));
	expect(operational.gateRetryMode).toBe("operational");
	reduceGate(operational, { type: "snapshot_invalid", reason: "manifest is missing" });
	expect(operational).toMatchObject({
		phase: "building",
		gateRetryMode: "evidence",
		finalizedGateSnapshot: undefined,
		operationalRetrySnapshot: undefined,
	});
	expect(checkInvariants(operational)).toEqual([]);

	const lease = dispatch();
	reduceGate(lease, { type: "lease_invalid", reason: "durable lease changed" });
	expect(lease).toMatchObject({
		phase: "awaiting_human",
		gateLease: undefined,
		recoveryAction: "flowcontinue_after_lease_failure",
	});
	expect(checkInvariants(lease)).toEqual([]);
});

test("operational errors return to BUILD until the fourth error pauses the run", () => {
	const state = buildingState();

	state.baselineCaptured = true;
	let effects: Effect[] = [];

	for (let attempt = 1; attempt <= 4; attempt++) {
		dispatch(state, `gate-${attempt}`);
		effects = reduceGate(state, operationalEvent(state, "gate_error")).effects;
	}

	expect(state).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 0,
		gateRetryMode: undefined,
		gateLease: undefined,
	});
	expect(state.baselineCaptured).toBeFalse();
	expect(checkInvariants(state)).toEqual([]);
	expect(state.stats).toMatchObject({ gateErrors: 4 });
	expect(effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);
	expect(effects[0]).toEqual({ kind: "write_marker", status: "paused" });
});
test("repeated structured BLOCKED identity ignores prose and pauses while new evidence resets the cap", () => {
	const state = dispatch();
	reduceGate(state, blockedEvent(sha64("9")));
	expect(state.blockedRecovery?.consecutiveEquivalentBlocked).toBe(1);

	dispatch(state, "gate-2");
	const repeated = reduceGate(state, blockedEvent(sha64("9")));
	expect(state.phase).toBe("awaiting_human");
	expect(state.blockedRecovery?.consecutiveEquivalentBlocked).toBe(2);
	expect(state.baselineCaptured).toBeFalse();
	expect(repeated.effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);

	const reset = dispatch(buildingState(), "gate-3");
	reduceGate(reset, blockedEvent(sha64("9")));
	dispatch(reset, "gate-4");
	reduceGate(reset, blockedEvent(sha64("8")));
	expect(reset.phase).toBe("building");
	expect(reset.blockedRecovery?.consecutiveEquivalentBlocked).toBe(1);
});

test("restore reconciliation preserves gating lease; interruption is explicit", () => {
	const state = dispatch();
	const preserved = reduceGate(state, { type: "restore_reconcile", now: 30 });
	expect(state.phase).toBe("gating");
	expect(state.gateLease?.toolCallId).toBe("gate-1");
	expect(preserved.effects).toEqual([]);

	const interrupted = reduceGate(state, operationalEvent(state, "gate_interrupted"));
	expect(state).toMatchObject({ phase: "building", gateCalls: 0, gateRetryMode: "operational", gateLease: undefined });
	expect(state.stats).toMatchObject({ gateInterruptions: 1, gateErrors: 0 });
	expect(interrupted.effects.map((effect) => effect.kind)).toEqual(["notify"]);

	state.lspProbeStatus = "pending";
	state.lspLease = {
		toolCallId: "lsp-1",
		kind: "lsp",
		runId: "f8e46687-2719-4fa1-8b6f-f5bb9a4e1f42",
		cycle: 0,
		startedAt: 20,
	};
	const building = buildingState();
	building.lspProbeStatus = "pending";
	building.lspLease = state.lspLease;
	expect(reduceGate(building, { type: "restore_reconcile", now: 40 }).effects).toEqual([]);
	expect(building.lspLease).toBeUndefined();
});

test("human controls begin a fresh repair cycle or terminally fail after the complete two-FAIL chain", () => {
	const continued = pausedAfterTwoFailures();
	const continuation = reduceGate(continued, { type: "human_continue", now: 50 });
	expect(continued).toMatchObject({
		phase: "repair_preparing",
		gateCalls: 0,
		gateAttempt: 2,
		gateRetryMode: "repair",
		humanRepairCycles: 1,
		terminalOutcome: undefined,
	});
	expect(continuation.effects.map((effect) => effect.kind)).toEqual([
		"clear_artifacts",
		"begin_repair_round",
	]);
	expect(checkInvariants(continued)).toEqual([]);

	const failed = pausedAfterTwoFailures();
	const finish = reduceGate(failed, { type: "human_finish_failed", now: 60 });
	expect(failed).toMatchObject({ phase: "finalizing", terminalOutcome: "fail_after_retry" });
	expect(failed.stats).toMatchObject({ terminalFailures: 1 });
	expect(failed.baselineCaptured).toBeFalse();
	expect(checkInvariants(failed)).toEqual([]);
	expect(finish.effects).toEqual([{ kind: "write_marker", status: "failed" }]);
});

test("every event is a no-op when its transition is inapplicable", () => {
	const building = buildingState();
	const gating = dispatch();
	const idle = buildingState();
	idle.phase = "idle";

	const finalizing = buildingState();
	finalizing.phase = "finalizing";
	finalizing.terminalOutcome = "pass";

	const cases: Array<{ state: LeanFlowState; event: GateEvent }> = [
		{ state: building, event: { type: "gate_settled", outcome: "PASS" } },
		{ state: building, event: { type: "gate_settled", outcome: "FAIL" } },
		{ state: building, event: { type: "gate_settled", outcome: "BLOCKED" } },
		{ state: building, event: detachedOperationalEvent("gate_error") },
		{ state: building, event: { type: "human_continue", now: 1 } },
		{ state: building, event: { type: "human_finish_failed", now: 1 } },
		{
			state: gating,
			event: {
				type: "gate_dispatch",
				toolCallId: "ignored",
				runId: GATE_RUN_ID,
				snapshotDigest: "ignored",
				planDigest: "ignored",
				buildRecordRound: 1,
				repositoryFingerprint: repositoryFingerprint(),
				reuseCycle: false,
				now: 1,
			},
		},
		{ state: idle, event: { type: "restore_reconcile", now: 1 } },
		...terminalInvalidEvents(0, 0).map((event) => ({ state: finalizing, event })),
	];

	for (const { state, event } of cases) {
		const before = structuredClone(state);
		expect(reduceGate(state, event).effects).toEqual([]);
		expect(state).toEqual(before);
	}
});

test("invariant checker reports every specified invalid state", () => {
	const state = buildingState();
	state.phase = "gating";
	state.gateCalls = 3;
	state.stats!.gateBlocked = -1;

	const violations = checkInvariants(state);
	expect(violations).toContain("gating phase requires a gate lease");
	expect(violations).toContain("gateCalls must be between 0 and 2");
	expect(violations).toContain("stats.gateBlocked must not be negative");

	const negativeGateCalls = buildingState();
	negativeGateCalls.gateCalls = -1;
	expect(checkInvariants(negativeGateCalls)).toContain("gateCalls must be between 0 and 2");

	const pausedWithBaseline = buildingState();
	pausedWithBaseline.phase = "awaiting_human";
	pausedWithBaseline.baselineCaptured = true;
	expect(checkInvariants(pausedWithBaseline)).toEqual([]);

	state.phase = "awaiting_human";
	state.terminalOutcome = "pass";
	expect(checkInvariants(state)).toContain("awaiting_human phase must not have a terminal outcome");

	state.phase = "finalizing";
	state.terminalOutcome = undefined;
	expect(checkInvariants(state)).toContain("finalizing phase requires a terminal outcome");
});

test("fixed-seed mulberry32 event runs preserve invariants, legal phases, and bounded verdicts", () => {
	for (const seed of [1, 7, 42, 101, 999]) {
		const random = mulberry32(seed);
		let state = buildingState();

		for (let index = 0; index < 40; index++) {
			// A terminal run is complete. Exercise every deterministic invalid follow-up
			// before starting a fresh run, so terminal events cannot silently mutate it.
			if (state.phase === "finalizing") {
				for (const event of terminalInvalidEvents(seed, index)) {
					const before = structuredClone(state);
					expect(reduceGate(state, event).effects).toEqual([]);
					expect(state).toEqual(before);
					expect(checkInvariants(state)).toEqual([]);
				}
				state = buildingState();
			}

			reduceGate(state, randomGateEvent(state, random, seed, index));
			expect(checkInvariants(state)).toEqual([]);
			expect(LEGAL_PHASES).toContain(state.phase);
			expect(state.gateCalls).toBeGreaterThanOrEqual(0);
			expect(state.gateCalls).toBeLessThanOrEqual(2);
		}

	}
});

function mulberry32(seed: number): () => number {
	let value = seed;
	return () => {
		value |= 0;
		value = (value + 0x6d2b79f5) | 0;
		let result = Math.imul(value ^ (value >>> 15), 1 | value);
		result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
		return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function pausedAfterTwoFailures(): LeanFlowState {
	const state = dispatch();
	reduceGate(state, { type: "gate_settled", outcome: "FAIL", findingsJson: '{"id":"first"}' });
	reduceGate(state, { type: "repair_round_ready", round: 2, baselineCaptured: true, freshRecord: false, lspEvidencePresent: true });
	dispatch(state, "gate-2");
	reduceGate(state, { type: "gate_settled", outcome: "FAIL", findingsJson: '{"id":"second"}' });
	expect(state.phase).toBe("awaiting_human");
	return state;
}

function randomGateEvent(state: LeanFlowState, random: () => number, seed: number, index: number): GateEvent {
	if (state.phase === "finalizing") {
		return invalidGateEvent(state, seed, index);
	}

	if (random() < 0.25) return invalidGateEvent(state, seed, index);

	switch (state.phase) {
		case "building": {
			attachFinalizedSnapshot(state);
			return {
				type: "gate_dispatch",
				toolCallId: `gate-${seed}-${index}`,
				runId: GATE_RUN_ID,
				snapshotDigest: finalizedGateSnapshotDigest(state.finalizedGateSnapshot!),
				planDigest,
				buildRecordRound: state.currentBuildRound!,
				repositoryFingerprint: repositoryFingerprint(),
				reuseCycle: state.gateRetryMode === "operational" || state.gateRetryMode === "evidence",
				now: index,
			};
		}
		case "gating":
			if (random() < 0.2) return operationalEvent(state, "gate_error");
			if (random() < 0.2) return operationalEvent(state, "gate_interrupted");
			if (random() < 0.4) return { type: "restore_reconcile", now: index };
			return { type: "gate_settled", outcome: randomOutcome(random) };
		case "repair_preparing":
			return random() < 0.5 ? { type: "repair_round_ready", round: state.gateAttempt + 1, baselineCaptured: true, freshRecord: false, lspEvidencePresent: true } : { type: "repair_round_failed", reason: "disk full" };
		case "awaiting_human":
			return random() < 0.5
				? { type: "human_continue", now: index }
				: { type: "human_finish_failed", now: index };
		default:
			return invalidGateEvent(state, seed, index);
	}
}

function invalidGateEvent(state: LeanFlowState, seed: number, index: number): GateEvent {
	switch (state.phase) {
		case "building":
			return { type: "gate_settled", outcome: "PASS" };
		case "gating":
			return {
				type: "gate_dispatch",
				toolCallId: `ignored-${seed}-${index}`,
				runId: GATE_RUN_ID,
				snapshotDigest: sha64("a"),
				planDigest: sha64("b"),
				buildRecordRound: 1,
				repositoryFingerprint: repositoryFingerprint(),
				reuseCycle: false,
				now: index,
			};
		case "repair_preparing":
			return {
				type: "gate_dispatch",
				toolCallId: `ignored-${seed}-${index}`,
				runId: GATE_RUN_ID,
				snapshotDigest: sha64("a"),
				planDigest,
				buildRecordRound: 1,
				repositoryFingerprint: repositoryFingerprint(),
				reuseCycle: false,
				now: index,
			};
		case "awaiting_human":
			return detachedOperationalEvent("gate_error");
		case "finalizing":
			return terminalInvalidEvents(seed, index)[0]!;
		default:
			return { type: "human_continue", now: index };
	}
}

function terminalInvalidEvents(seed: number, index: number): GateEvent[] {
	return [
		{
			type: "gate_dispatch",
			toolCallId: `ignored-terminal-${seed}-${index}`,
			runId: GATE_RUN_ID,
			snapshotDigest: sha64("a"),
			planDigest: sha64("b"),
			buildRecordRound: 1,
			now: index,
			repositoryFingerprint: repositoryFingerprint(),
			reuseCycle: false,
		},
		{ type: "gate_settled", outcome: "PASS" },
		{ type: "gate_settled", outcome: "FAIL" },
		{ type: "gate_settled", outcome: "BLOCKED" },
		detachedOperationalEvent("gate_error"),
		detachedOperationalEvent("gate_interrupted"),
		{ type: "restore_reconcile", now: index },
		{ type: "repair_round_ready", round: 99, baselineCaptured: true, freshRecord: false, lspEvidencePresent: true },
		{ type: "repair_round_failed", reason: "x" },
		{ type: "human_continue", now: index },
		{ type: "human_finish_failed", now: index },
	];
}

function randomOutcome(random: () => number): "PASS" | "FAIL" | "BLOCKED" {
	const roll = random();
	if (roll < 1 / 3) return "PASS";
	if (roll < 2 / 3) return "FAIL";
	return "BLOCKED";
}
