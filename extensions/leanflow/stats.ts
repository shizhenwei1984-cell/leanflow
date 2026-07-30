/**
 * LeanFlow runtime statistics helpers.
 *
 * Quantifies observable Main Session work without estimating separate
 * Scout/Gate subagent sessions. Statistics are best-effort and must never
 * control workflow transitions, readiness, or budget enforcement.
 */

import { defaultStats } from "./state";
import type { LeanFlowPhase, LeanFlowState, ObservablePhase, PhaseMetrics } from "./state";

/** Minimal usage shape read from message_end events. */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
}

const TRACKED_PHASES: ReadonlySet<ObservablePhase> = new Set([
	"planning",
	"awaiting_approval",
	"building",
	"gating",
]);

/** Add one observable Main Session provider response to the current phase. */
export function addUsage(state: LeanFlowState, usage: UsageLike = {}): void {
	if (!isTrackedPhase(state.phase)) return;
	const bucket = (state.stats ??= defaultStats())[phaseMetricKey(state.phase)];
	bucket.input += usage.input ?? 0;
	bucket.output += usage.output ?? 0;
	bucket.cacheRead += usage.cacheRead ?? 0;
	bucket.responses++;
}

/**
 * Switch workflow phase before best-effort metrics settlement. The state
 * transition remains correct even if an observation cannot be recorded.
 */
export function transitionPhase(state: LeanFlowState, next: LeanFlowPhase, now = Date.now()): void {
	const previous = state.phase;
	const previousStartedAt = state.phaseStartedAt;
	state.phase = next;
	if (previous === next) return;
	state.phaseStartedAt = next === "idle" ? undefined : now;
	try {
		if (!isTrackedPhase(previous) || previousStartedAt === undefined) return;
		const bucket = (state.stats ??= defaultStats())[phaseMetricKey(previous)];
		bucket.elapsedMs += Math.max(0, now - previousStartedAt);
	} catch {
		// Metrics cannot affect the state transition.
	}
}

/** Resume an active persisted phase without charging the inactive interval. */
export function resumePhaseTiming(state: LeanFlowState, now = Date.now()): void {
	if (isTrackedPhase(state.phase)) state.phaseStartedAt = now;
}

/**
 * Deterministically serialize a JSON-like value. Object keys are recursively
 * sorted while array order remains unchanged. Unsupported values fail closed.
 */
export function stableSerialize(value: unknown): string {
	const serialized = serializeValue(value, new Set<object>(), false);
	if (serialized === undefined) throw new TypeError("Value is not JSON-serializable");
	return serialized;
}

/** UTF-8 bytes in the deterministic serialized payload. */
export function serializedByteLength(value: unknown): number {
	return new TextEncoder().encode(stableSerialize(value)).byteLength;
}

/**
 * Replace the latest context-filter observation. Message counts always record;
 * byte metrics are intentionally unavailable if either payload cannot serialize.
 */
export function recordContextFilter(
	state: LeanFlowState,
	before: readonly unknown[],
	after: readonly unknown[],
): void {
	const stats = (state.stats ??= defaultStats());
	stats.beforeMessages = before.length;
	stats.afterMessages = after.length;
	stats.removedMessages = before.length - after.length;
	stats.messageReductionPercent = reductionPercent(before.length, after.length);
	try {
		stats.beforeBytes = serializedByteLength(before);
		stats.afterBytes = serializedByteLength(after);
		stats.removedBytes = stats.beforeBytes - stats.afterBytes;
		stats.byteReductionPercent = reductionPercent(stats.beforeBytes, stats.afterBytes);
	} catch {
		stats.beforeBytes = undefined;
		stats.afterBytes = undefined;
		stats.removedBytes = undefined;
		stats.byteReductionPercent = undefined;
	}
}

/** Record a parsed Gate FAIL verdict and, if applicable, the entered repair. */
export function recordGateFailure(state: LeanFlowState, repaired: boolean): void {
	const stats = (state.stats ??= defaultStats());
	stats.gateVerdictFailures++;
	if (repaired) stats.repairRounds++;
}

/** Record a failed or unparseable Gate execution and optional repair. */
export function recordGateError(state: LeanFlowState, repaired: boolean): void {
	const stats = (state.stats ??= defaultStats());
	stats.gateErrors++;
	if (repaired) stats.repairRounds++;
}

/** Record a successful Gate verdict and whether it followed a repair. */
export function recordGatePass(state: LeanFlowState, repaired: boolean): void {
	const stats = (state.stats ??= defaultStats());
	stats.gatePasses++;
	if (repaired) stats.repairSuccesses++;
}

/** Record that a Gate call was blocked before consuming its attempt budget. */
export function recordGateReadinessBlock(state: LeanFlowState): void {
	(state.stats ??= defaultStats()).gateReadinessBlocks++;
}

/** Record a final non-PASS Gate outcome after the retry budget is exhausted. */
export function recordTerminalFailure(state: LeanFlowState): void {
	(state.stats ??= defaultStats()).terminalFailures++;
}

/** Human-readable multi-line summary for display. */
export function formatStats(state: LeanFlowState): string {
	const stats = state.stats ?? defaultStats();
	const total = phaseTotal(stats.planning) + phaseTotal(stats.awaitingApproval) + phaseTotal(stats.building) + phaseTotal(stats.gating);
	const lines = [
		"LeanFlow run statistics",
		"=======================",
		`Phase: ${state.phase}   Scout: ${state.scoutCalls}/3   Gate: ${state.gateCalls}/2`,
		"",
		"Main-session provider usage by phase (input / output / cache-read; responses; elapsed):",
		`  planning:          ${fmtPhase(stats.planning)}`,
		`  awaiting_approval: ${fmtPhase(stats.awaitingApproval)}`,
		`  building:          ${fmtPhase(stats.building)}`,
		`  gating:            ${fmtPhase(stats.gating)}`,
		`  total tokens:      ${total}`,
		"",
		"Workflow outcomes:",
		`  attempts: ${state.gateCalls}   passes: ${stats.gatePasses}   verdict failures: ${stats.gateVerdictFailures}`,
		`  execution/unparseable errors: ${stats.gateErrors}   readiness blocks: ${stats.gateReadinessBlocks}`,
		`  repair rounds/successes: ${stats.repairRounds}/${stats.repairSuccesses}   terminal failures: ${stats.terminalFailures}`,
		`  handoff: ${state.handoffStatus ?? "n/a"}   warnings: ${state.handoffWarnings?.length ?? 0}`,
		"",
		"Builder context filter:",
	];
	if (stats.beforeMessages === undefined || stats.afterMessages === undefined) {
		lines.push("  latest messages: not yet exercised this run.");
	} else {
		lines.push(
			`  latest messages: ${stats.beforeMessages} → ${stats.afterMessages} (${stats.removedMessages ?? 0} removed)`,
			`  Message-count reduction: ${fmtPercent(stats.messageReductionPercent)}`,
		);
	}
	if (stats.beforeBytes === undefined || stats.afterBytes === undefined) {
		lines.push("  latest serialized bytes (KiB): unavailable", "  Byte-count reduction: unavailable");
	} else {
		lines.push(
			`  latest serialized bytes (KiB): ${fmtKiB(stats.beforeBytes)} → ${fmtKiB(stats.afterBytes)}`,
			`  Byte-count reduction: ${fmtPercent(stats.byteReductionPercent)}`,
		);
	}
	lines.push(
		"  provider token reduction: not measured",
		"",
		"Notes:",
		"- Scout/Gate tokens: not measured (separate subagent sessions).",
		"- LSP availability and results belong in build/evidence artifacts, not runtime statistics.",
	);
	return lines.join("\n");
}

function isTrackedPhase(phase: LeanFlowPhase): phase is ObservablePhase {
	return TRACKED_PHASES.has(phase as ObservablePhase);
}

function phaseMetricKey(phase: ObservablePhase): "planning" | "awaitingApproval" | "building" | "gating" {
	return phase === "awaiting_approval" ? "awaitingApproval" : phase;
}

function serializeValue(value: unknown, ancestors: Set<object>, inArray: boolean): string | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			return Number.isFinite(value) ? String(value) : "null";
		case "bigint":
			throw new TypeError("BigInt is not JSON-serializable");
		case "undefined":
		case "function":
		case "symbol":
			return inArray ? "null" : undefined;
		case "object":
			if (ancestors.has(value)) throw new TypeError("Circular value is not JSON-serializable");
			ancestors.add(value);
			try {
				if (Array.isArray(value)) {
					const items: string[] = [];
					for (let index = 0; index < value.length; index++) {
						items.push(serializeValue(value[index], ancestors, true) ?? "null");
					}
					return `[${items.join(",")}]`;
				}
				const entries = Object.keys(value)
					.sort()
					.flatMap((key) => {
						const serialized = serializeValue((value as Record<string, unknown>)[key], ancestors, false);
						return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
					});
				return `{${entries.join(",")}}`;
			} finally {
				ancestors.delete(value);
			}
	}
}

function reductionPercent(before: number, after: number): number {
	return before === 0 ? 0 : ((before - after) / before) * 100;
}

function phaseTotal(phase: PhaseMetrics): number {
	return phase.input + phase.output + phase.cacheRead;
}

function fmtPhase(phase: PhaseMetrics): string {
	return `${phase.input} / ${phase.output} / ${phase.cacheRead}; ${phase.responses}; ${fmtElapsed(phase.elapsedMs)}`;
}

function fmtElapsed(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

function fmtPercent(value: number | undefined): string {
	return value === undefined || !Number.isFinite(value) ? "unavailable" : `${Math.round(value * 100) / 100}%`;
}

function fmtKiB(bytes: number): string {
	return (bytes / 1024).toFixed(2);
}
