import { expect, test } from "bun:test";

import { checkInvariants, reduceGate, type Effect, type GateEvent } from "../extensions/leanflow/machine";
import { defaultState, type LeanFlowPhase, type LeanFlowState } from "../extensions/leanflow/state";

const GATE_RUN_ID = "f8e46687-2719-4fa1-8b6f-f5bb9a4e1f42";
const LEGAL_PHASES: readonly LeanFlowPhase[] = [
	"idle",
	"planning",
	"awaiting_approval",
	"building",
	"gating",
	"awaiting_human",
	"finalizing",
];

function buildingState() {
	const state = defaultState();
	state.phase = "building";
	return state;
}

function dispatch(state = buildingState(), toolCallId = "gate-1") {
	const result = reduceGate(state, {
		type: "gate_dispatch",
		toolCallId,
		runId: GATE_RUN_ID,
		snapshotDigest: "snapshot",
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
		snapshotDigest: "snapshot",
	});
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
		phase: "building",
		gateCalls: 1,
		gateRetryMode: "repair",
		gateLease: undefined,
		lastGateFindings: '{"id":"first"}',
	});
	expect(state.stats).toMatchObject({ gateVerdictFailures: 1, repairRounds: 1 });
	expect(effects.map((effect) => effect.kind)).toEqual(["clear_artifacts", "begin_repair_round", "notify"]);
});

test("second FAIL pauses for a human without setting a terminal outcome", () => {
	const state = dispatch();
	state.baselineCaptured = true;
	reduceGate(state, { type: "gate_settled", outcome: "FAIL" });
	dispatch(state, "gate-2");

	const { effects } = reduceGate(state, { type: "gate_settled", outcome: "FAIL", findingsJson: "x".repeat(4_001) });

	expect(state).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 2,
		lastGateFindings: `${"x".repeat(3_999)}…`,
	});
	expect(state.terminalOutcome).toBeUndefined();
	expect(state.baselineCaptured).toBeFalse();
	expect(checkInvariants(state)).toEqual([]);
	expect(state.stats).toMatchObject({ gateVerdictFailures: 2, repairRounds: 1 });
	expect(effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);
	expect(effects[0]).toEqual({ kind: "write_marker", status: "paused" });
});

test("BLOCKED returns to BUILD without consuming a verdict", () => {
	const state = dispatch();
	const { effects } = reduceGate(state, { type: "gate_settled", outcome: "BLOCKED" });

	expect(state).toMatchObject({ phase: "building", gateCalls: 0, gateRetryMode: "evidence", gateLease: undefined });
	expect(state.stats).toMatchObject({ gateBlocked: 1 });
	expect(effects.map((effect) => effect.kind)).toEqual(["clear_artifacts", "notify"]);
});

test("operational errors return to BUILD until the fourth error pauses the run", () => {
	const state = buildingState();
	state.baselineCaptured = true;
	let effects: Effect[] = [];

	for (let attempt = 1; attempt <= 4; attempt++) {
		dispatch(state, `gate-${attempt}`);
		effects = reduceGate(state, { type: "gate_error" }).effects;
	}

	expect(state).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 0,
		gateRetryMode: "operational",
		gateLease: undefined,
	});
	expect(state.baselineCaptured).toBeFalse();
	expect(checkInvariants(state)).toEqual([]);
	expect(state.stats).toMatchObject({ gateErrors: 4 });
	expect(effects.map((effect) => effect.kind)).toEqual(["write_marker", "notify"]);
	expect(effects[0]).toEqual({ kind: "write_marker", status: "paused" });
});

test("restore reconciliation folds an interrupted Gate and discards a pending LSP lease", () => {
	const state = dispatch();
	const interrupted = reduceGate(state, { type: "restore_reconcile", now: 30 });

	expect(state).toMatchObject({ phase: "building", gateCalls: 0, gateRetryMode: "operational", gateLease: undefined });
	expect(state.stats).toMatchObject({ gateErrors: 1 });
	expect(interrupted.effects.map((effect) => effect.kind)).toEqual(["notify"]);

	state.lspProbeStatus = "pending";
	state.lspLease = {
		toolCallId: "lsp-1",
		kind: "lsp",
		runId: "f8e46687-2719-4fa1-8b6f-f5bb9a4e1f42",
		cycle: 0,
		startedAt: 20,
	};
	expect(reduceGate(state, { type: "restore_reconcile", now: 40 }).effects).toEqual([]);
	expect(state.lspLease).toBeUndefined();

	const withoutLease = buildingState();
	withoutLease.phase = "gating";
	expect(reduceGate(withoutLease, { type: "restore_reconcile", now: 50 }).effects.map((effect) => effect.kind)).toEqual([
		"notify",
	]);
	expect(withoutLease).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateRetryMode: "operational",
		gateLease: undefined,
	});
	expect(withoutLease.stats).toMatchObject({ gateErrors: 1 });
});

test("human controls begin a fresh repair cycle or terminally fail after the complete two-FAIL chain", () => {
	const continued = pausedAfterTwoFailures();
	const continuation = reduceGate(continued, { type: "human_continue", now: 50 });
	expect(continued).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateAttempt: 2,
		gateRetryMode: "repair",
		humanRepairCycles: 1,
		terminalOutcome: undefined,
	});
	expect(continuation.effects.map((effect) => effect.kind)).toEqual([
		"clear_artifacts",
		"begin_repair_round",
		"write_marker",
		"notify",
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
		{ state: building, event: { type: "gate_error" } },
		{ state: building, event: { type: "human_continue", now: 1 } },
		{ state: building, event: { type: "human_finish_failed", now: 1 } },
		{ state: gating, event: { type: "gate_dispatch", toolCallId: "ignored", runId: GATE_RUN_ID, snapshotDigest: "ignored", now: 1 } },
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
	expect(checkInvariants(pausedWithBaseline)).toContain("baselineCaptured is only valid during building or gating");

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
		case "building":
			return {
				type: "gate_dispatch",
				toolCallId: `gate-${seed}-${index}`,
				runId: GATE_RUN_ID,
				snapshotDigest: `snapshot-${seed}-${index}`,
				now: index,
			};
		case "gating":
			if (random() < 0.2) return { type: "gate_error" };
			if (random() < 0.4) return { type: "restore_reconcile", now: index };
			return { type: "gate_settled", outcome: randomOutcome(random) };
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
				snapshotDigest: "ignored",
				now: index,
			};
		case "awaiting_human":
			return { type: "gate_error" };
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
			snapshotDigest: "ignored",
			now: index,
		},
		{ type: "gate_settled", outcome: "PASS" },
		{ type: "gate_settled", outcome: "FAIL" },
		{ type: "gate_settled", outcome: "BLOCKED" },
		{ type: "gate_error" },
		{ type: "restore_reconcile", now: index },
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
