import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { filterForBuilder } from "../extensions/leanflow/context";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles } from "../extensions/leanflow/guard";

import { CUSTOM_TYPE, defaultState, restoreState } from "../extensions/leanflow/state";
import {
	addUsage,
	formatStats,
	recordContextFilter,
	recordGateBlocked,
	recordGateError,
	recordGateFailure,
	recordGatePass,
	recordGateReadinessBlock,
	recordTerminalFailure,
	serializedByteLength,
	stableSerialize,
	resumePhaseTiming,
	transitionPhase,
} from "../extensions/leanflow/stats";

test("deterministic UTF-8 context bytes use sorted object keys", () => {
	const first = [{ role: "user", content: { zebra: "雪", alpha: ["é", { b: 2, a: 1 }] } }];
	const second = [{ content: { alpha: ["é", { a: 1, b: 2 }], zebra: "雪" }, role: "user" }];

	expect(stableSerialize(first)).toBe(stableSerialize(second));
	expect(serializedByteLength(first)).toBe(serializedByteLength(second));

	const state = defaultState();
	recordContextFilter(state, first, []);
	expect(state.stats?.beforeMessages).toBe(1);
	expect(state.stats?.afterMessages).toBe(0);
	expect(state.stats?.removedMessages).toBe(1);
	expect(state.stats?.messageReductionPercent).toBe(100);
	expect(state.stats?.beforeBytes).toBe(serializedByteLength(first));
	expect(state.stats?.afterBytes).toBe(serializedByteLength([]));
	expect(state.stats?.removedBytes).toBe(state.stats?.beforeBytes! - state.stats?.afterBytes!);
	expect(state.stats?.byteReductionPercent).toBe(((state.stats?.beforeBytes! - state.stats?.afterBytes!) / state.stats?.beforeBytes!) * 100);
});

test("deterministic serialization preserves sparse-array JSON semantics", () => {
	const nestedSparse: unknown[] = new Array(2);
	const child: unknown[] = new Array(2);
	child[1] = "x";
	nestedSparse[1] = child;

	expect(stableSerialize(nestedSparse)).toBe('[null,[null,"x"]]');
	expect(serializedByteLength(nestedSparse)).toBe(new TextEncoder().encode('[null,[null,"x"]]').byteLength);
});

test("latest context observation replaces older values and safely handles zero, growth, and byte failure", () => {
	const state = defaultState();
	recordContextFilter(state, [{ old: true }, { old: true }], [{ kept: true }]);
	recordContextFilter(state, [], []);
	expect(state.stats?.beforeMessages).toBe(0);
	expect(state.stats?.messageReductionPercent).toBe(0);
	recordContextFilter(state, [{ before: true }], [{ after: 1 }, { after: 2 }]);
	expect(state.stats?.removedMessages).toBe(-1);
	expect(state.stats?.messageReductionPercent).toBe(-100);
	recordContextFilter(state, [BigInt(1)], []);
	expect(state.stats?.beforeMessages).toBe(1);
	expect(state.stats?.beforeBytes).toBeUndefined();
	expect(state.stats?.afterBytes).toBeUndefined();
});

test("phase usage, response counts, and elapsed time accrue through all observable phases", () => {
	const state = defaultState();
	state.phase = "planning";
	state.phaseStartedAt = 100;
	addUsage(state, { input: 10, output: 3, cacheRead: 2 });
	transitionPhase(state, "awaiting_approval", 150);
	addUsage(state);
	transitionPhase(state, "building", 200);
	addUsage(state, { input: 4, output: 5, cacheRead: 6 });
	transitionPhase(state, "gating", 260);
	addUsage(state, { input: 1 });
	transitionPhase(state, "idle", 300);

	expect(state.stats?.planning).toEqual({ input: 10, output: 3, cacheRead: 2, responses: 1, elapsedMs: 50 });
	expect(state.stats?.awaitingApproval).toEqual({ input: 0, output: 0, cacheRead: 0, responses: 1, elapsedMs: 50 });
	expect(state.stats?.building).toEqual({ input: 4, output: 5, cacheRead: 6, responses: 1, elapsedMs: 60 });
	expect(state.stats?.gating).toEqual({ input: 1, output: 0, cacheRead: 0, responses: 1, elapsedMs: 40 });
	expect(state.phaseStartedAt).toBeUndefined();
});

test("restore normalizes an older persisted state without new metric fields", () => {
	const restored = restoreState([
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				phase: "building",
				scoutCalls: 1,

				gateCalls: 2,
				gateAttempt: 1,
				stats: {
					planning: { input: 2, output: 1, cacheRead: 0 },
					building: { input: 3, output: 4, cacheRead: 5 },
					gating: { input: 0, output: 0, cacheRead: 0 },
					contextBefore: 4,
					contextAfter: 1,
					gateFailures: 1,
					repairs: 1,
				},
			},
			},
	]);

	expect(restored.phase).toBe("building");
	expect(restored.phaseStartedAt).toBeUndefined();
	expect(restored.lspProbeStatus).toBe("pending");
	expect(restored.stats?.planning.responses).toBe(0);
	expect(restored.stats?.awaitingApproval.elapsedMs).toBe(0);
	expect(restored.stats?.beforeMessages).toBe(4);
	expect(restored.stats?.removedMessages).toBe(3);
	expect(restored.stats?.gateVerdictFailures).toBe(1);
	expect(restored.stats?.repairRounds).toBe(1);
	expect(restored.gateCalls).toBe(1);
	expect(restored.gateDispatches).toBe(0);
	expect(restored.humanRepairCycles).toBe(0);
	expect(restored.stats?.gateBlocked).toBe(0);
});

test("restore re-parses persisted approved validations instead of trusting derived fields", () => {
	const restored = restoreState([
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				phase: "building",
				approvedValidations: [
					{ displayCommand: "make test", executable: "rm", argv: ["-rf", "/"], digest: "forged", kind: "build" },
					{ displayCommand: "make test", executable: "rm", argv: ["-rf", "/"], digest: "forged", kind: "build" },
					{ displayCommand: "make test", executable: "make", argv: ["test"], digest: "duplicate", kind: "test" },
					{ displayCommand: "rm -rf /", executable: "make", argv: ["test"], digest: "forged", kind: "test" },
				],
			},
		},
	]);

	expect(restored.approvedValidations).toEqual([
		expect.objectContaining({ displayCommand: "make test", executable: "make", argv: ["test"], kind: "test" }),
	]);
});


test("restore drops incomplete BLOCKED recovery identities and preserves valid v4 gating state", () => {
	const invalid = restoreState([
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				phase: "building",
				stateVersion: 5,
				consecutiveSameSnapshotBlocked: 2,
				lastBlockedSnapshotDigest: "not-a-digest",
				lastBlockedObservationBoundary: -1,
				lastBlockedFindingDigest: "forged",
			},
		},
	]);
	expect(invalid).toMatchObject({ stateVersion: 5, consecutiveSameSnapshotBlocked: 0 });
	expect(invalid.lastBlockedSnapshotDigest).toBeUndefined();
	expect(invalid.lastBlockedObservationBoundary).toBeUndefined();
	expect(invalid.lastBlockedFindingDigest).toBeUndefined();

	const sha = "a".repeat(64);
	const valid = restoreState([
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				phase: "gating",
				stateVersion: 4,
				gateLease: {
					toolCallId: "gate",
					kind: "gate",
					runId: "11111111-1111-4111-8111-111111111111",
					cycle: 1,
					startedAt: 1,
					snapshotDigest: sha,
					planDigest: sha,
					buildRecordRound: 1,
					repositoryFingerprint: {
						head: "a".repeat(40),
						trackedDiffDigest: sha,
						untrackedDigest: sha,
						combinedDigest: sha,
					},
				},
			},
		},
	]);
	expect(valid.phase).toBe("gating");
	expect(valid.gateLease?.repositoryFingerprint?.combinedDigest).toBe(sha);
	expect(valid.stateVersion).toBe(5);
});

test("restore rejects a non-object persisted state without throwing", () => {
	const restored = restoreState([{ type: "custom", customType: CUSTOM_TYPE, data: "corrupt" }]);
	expect(restored).toMatchObject({ phase: "idle", stateVersion: 5, gateCalls: 0 });
});
test("restore accepts paused state and preserves only valid compact operation metadata", () => {
	const validRunId = "11111111-1111-4111-8111-111111111111";
	const sha = "a".repeat(64);
	const restored = restoreState([
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: {
				phase: "awaiting_human",
				scoutCalls: 0,
				gateCalls: 2,
				gateAttempt: 2,
				runMarkerStatus: "paused",
				gateRetryMode: "evidence",
				gateDispatches: 3,
				humanRepairCycles: 1,
				handoffBlockers: ["TARGET_MISSING", "unstructured detail", "VERIFICATION_MISSING"],
				lastGateFindings: "x".repeat(4_001),
				gateLease: {
					toolCallId: "gate-call",
					kind: "gate",
					runId: validRunId,
					cycle: 2,
					startedAt: 1,
					snapshotDigest: sha,
					planDigest: sha,
					buildRecordRound: 2,
					repositoryFingerprint: {
						head: "b".repeat(40),
						trackedDiffDigest: sha,
						untrackedDigest: sha,
						combinedDigest: sha,
					},
				},
				lspLease: {
					toolCallId: "lsp-call",
					kind: "lsp",
					runId: "not-a-run-id",
					cycle: Number.POSITIVE_INFINITY,
					startedAt: 1,
				},
			},
		},
	]);

	expect(restored).toMatchObject({
		phase: "awaiting_human",
		runMarkerStatus: "paused",
		gateRetryMode: "evidence",
		gateDispatches: 3,
		humanRepairCycles: 1,
		handoffBlockers: ["TARGET_MISSING", "VERIFICATION_MISSING"],
		gateLease: {
			toolCallId: "gate-call",
			kind: "gate",
			runId: validRunId,
			cycle: 2,
			startedAt: 1,
			snapshotDigest: sha,
			planDigest: sha,
			buildRecordRound: 2,
		},
	});
	expect(restored.lspLease).toBeUndefined();
	expect(restored.lastGateFindings).toHaveLength(4_000);
	expect(restored.lastGateFindings?.endsWith("…")).toBe(true);
});

test("restored phases restart timing observation without charging inactive time", () => {
	const original = defaultState();
	original.phase = "building";
	original.phaseStartedAt = 100;
	original.lspProbeStatus = "completed";
	original.lspProbeTarget = "*";
	const restored = restoreState([{ type: "custom", customType: CUSTOM_TYPE, data: original }]);

	resumePhaseTiming(restored, 1_000_000);
	expect(restored).toMatchObject({ lspProbeStatus: "completed", lspProbeTarget: "*" });
	transitionPhase(restored, "idle", 1_000_010);
	expect(restored.stats?.building.elapsedMs).toBe(10);
});

test("finalizing usage remains attributed to gating until the terminal response settles", () => {
	const state = defaultState();
	state.phase = "gating";
	state.phaseStartedAt = 100;
	transitionPhase(state, "finalizing", 110);
	addUsage(state, { input: 5, output: 2 });
	transitionPhase(state, "idle", 120);
	expect(state.stats?.gating).toMatchObject({ input: 5, output: 2, responses: 1, elapsedMs: 20 });
});

test("Gate counters distinguish repair entry, repair success, terminal failure, BLOCKED, error, and readiness block", () => {
	const state = defaultState();
	recordGateFailure(state, true); // first FAIL enters repair
	recordGatePass(state, true); // repaired run passes
	recordGateFailure(state, false); // second FAIL
	recordGateBlocked(state); // evidence was insufficient
	recordGateError(state, false); // tool/unparseable failure
	recordGateReadinessBlock(state);
	recordTerminalFailure(state);

	expect(state.stats?.gatePasses).toBe(1);
	expect(state.stats?.gateVerdictFailures).toBe(2);
	expect(state.stats?.gateBlocked).toBe(1);
	expect(state.stats?.gateErrors).toBe(1);
	expect(state.stats?.gateReadinessBlocks).toBe(1);
	expect(state.stats?.repairRounds).toBe(1);
	expect(state.stats?.repairSuccesses).toBe(1);
	expect(state.stats?.terminalFailures).toBe(1);
});

test("flowstats labels message, byte, and token measures without conflation", () => {
	const state = defaultState();
	state.phase = "building";
	state.gateCalls = 1;
	state.gateDispatches = 3;
	state.humanRepairCycles = 2;
	recordContextFilter(state, [{ role: "user" }, { role: "assistant" }], [{ role: "user" }]);
	const output = formatStats(state);

	expect(output).toContain("Message-count reduction");
	expect(output).toContain("latest serialized bytes (KiB)");
	expect(output).toContain("Byte-count reduction");
	expect(output).toContain("provider token reduction: not measured");
	expect(output).toContain("Scout/Gate tokens: not measured");
	expect(output).toContain("verdict attempts: 1   passes: 0   verdict failures: 0");
	expect(output).toContain("dispatches: 3   blocked: 0   execution/unparseable errors: 0");
	expect(output).toContain("interruptions: 0   consecutive errors: 0   readiness blocks: 0");
	expect(output).toContain("human repair cycles: 2");
});

test("filtering survives an unavailable byte observation and preserves builder essentials", () => {
	const state = defaultState();
	state.phase = "building";
	state.planSlug = "metrics";
	state.approvedPlanArtifact = "local://metrics-plan.md";
	const firstUser: AgentMessage = { role: "user", content: "implement metrics", timestamp: 1 };
	const planningHistory: AgentMessage = { role: "user", content: "planning history", timestamp: 2 };
	const approval = {
		role: "developer",
		content: "Plan approved.\n\n<instruction>\nYou MUST read `local://metrics-plan.md` before executing.\n</instruction>",
		timestamp: 3,
	} as unknown as AgentMessage;
	const postApproval: AgentMessage = { role: "user", content: "implement", timestamp: 4 };
	const filtered = filterForBuilder([firstUser, planningHistory, approval, postApproval], state);

	expect(filtered?.[0]).toBe(firstUser);
	expect(filtered?.[1]).toMatchObject({ customType: "leanflow-builder-context" });
	expect(filtered?.[2]).toBe(postApproval);
	expect(() => recordContextFilter(state, [{ content: BigInt(1) }], filtered ?? [])).not.toThrow();
	expect(state.stats?.beforeBytes).toBeUndefined();
	expect(formatStats(state)).toContain("Byte-count reduction: unavailable");
});

test("filtering starts at the exact native approval identity", () => {
	const state = defaultState();
	state.phase = "awaiting_approval";
	state.approvedPlanArtifact = "local://fallback-plan.md";
	state.planSlug = "fallback";
	const firstUser: AgentMessage = { role: "user", content: "implement fallback", timestamp: 1 };
	const approval = {
		role: "developer",
		content: "Plan approved.\n\n<instruction>\nYou MUST read `local://fallback-plan.md` before executing.\n</instruction>",
	} as unknown as AgentMessage;
	const postApproval: AgentMessage = { role: "user", content: "approved", timestamp: 2 };

	const filtered = filterForBuilder([firstUser, approval, postApproval], state);

	expect(filtered).toHaveLength(3);
	expect(filtered?.[0]).toBe(firstUser);
	expect(filtered?.[2]).toBe(postApproval);
});

test("guard denies empty phases and atomically preflights actual requested role counts", () => {
	expect(checkTaskGuard("awaiting_approval", { agent: "scout" }).block).toBe(true);
	expect(checkTaskGuard("gating", { agent: "gate" }).block).toBe(true);
	for (const phase of ["planning", "awaiting_approval", "building", "gating"] as const) {
		expect(checkTaskGuard(phase, { agent: "helper" }).block).toBe(true);
	}
	expect(checkTaskGuard("planning", { task: "investigate" }).block).toBe(true);
	expect(checkTaskGuard("planning", { tasks: [{ agent: "scout" }, { name: "missing-agent" }] }).block).toBe(true);
	expect(checkTaskGuard("planning", { tasks: [{ agent: "scout", name: "review-test-coverage" }] }).block).toBe(false);

	const state = { phase: "building", scoutCalls: 2, gateCalls: 1 };
	const duplicateScouts = extractAgentRoles({
		tasks: [
			{ agent: "scout", name: "scout-one" },
			{ agent: "scout", name: "scout-two" },
		],
	});
	expect(duplicateScouts).toEqual(["scout", "scout"]);
	expect(checkAgentBudget(state, duplicateScouts).block).toBe(true);
	expect(state).toEqual({ phase: "building", scoutCalls: 2, gateCalls: 1 });

	const duplicateGates = extractAgentRoles({ tasks: [{ agent: "gate" }, { agent: "gate" }] });
	expect(checkAgentBudget(state, duplicateGates).block).toBe(true);
	expect(state).toEqual({ phase: "building", scoutCalls: 2, gateCalls: 1 });
});
