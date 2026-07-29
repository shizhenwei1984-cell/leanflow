/**
 * LeanFlow runtime statistics helpers.
 *
 * Quantifies LeanFlow's core value prop — low-handoff token usage — using
 * only signals observable from the main session. Deliberately does NOT
 * estimate Scout/Gate token usage: those run in separate subagent sessions
 * whose usage is invisible to main-session events, and fabricating them
 * would make the numbers dishonest.
 *
 * Types live in state.ts (persisted with the state machine); this module
 * only provides mutation + formatting helpers.
 */

import { defaultStats } from "./state";
import type { LeanFlowPhase, LeanFlowState, PhaseTokens } from "./state";

/** Minimal usage shape read from message_end events. */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
}

/** Phases that accrue token stats. awaiting_approval/idle are not tracked. */
const TRACKED_PHASES: ReadonlySet<LeanFlowPhase> = new Set(["planning", "building", "gating"]);

/** Add one provider response's usage to the phase bucket. */
export function addUsage(state: LeanFlowState, usage: UsageLike): void {
	const phase = state.phase;
	if (!TRACKED_PHASES.has(phase)) return;
	const stats = (state.stats ??= defaultStats());
	const bucket = stats[phase as "planning" | "building" | "gating"];
	bucket.input += usage.input ?? 0;
	bucket.output += usage.output ?? 0;
	bucket.cacheRead += usage.cacheRead ?? 0;
	stats.turns++;
}

/** Record a context-filter observation (keep the largest reduction seen). */
export function recordContextFilter(state: LeanFlowState, before: number, after: number): void {
	const stats = (state.stats ??= defaultStats());
	if (before > stats.contextBefore) {
		stats.contextBefore = before;
		stats.contextAfter = after;
	}
}

/** Human-readable multi-line summary for display. */
export function formatStats(state: LeanFlowState): string {
	const s = state.stats;
	const lines = [
		"LeanFlow run statistics",
		"=======================",
		`Phase: ${state.phase}   Scout: ${state.scoutCalls}/3   Gate: ${state.gateCalls}/2`,
		"",
		"Main-session tokens by phase (input / output / cache-read):",
	];
	if (s) {
		const total = phaseTotal(s.planning) + phaseTotal(s.building) + phaseTotal(s.gating);
		lines.push(
			`  planning: ${fmt(s.planning)}`,
			`  building: ${fmt(s.building)}`,
			`  gating:   ${fmt(s.gating)}`,
			`  total:    ${total}`,
			"",
		);
		if (s.contextBefore > 0) {
			const pct = Math.round((1 - s.contextAfter / s.contextBefore) * 100);
			lines.push(`Builder context filter: ${s.contextBefore} → ${s.contextAfter} messages (${pct}% reduction)`);
		} else {
			lines.push("Builder context filter: not yet exercised this run.");
		}
	} else {
		lines.push("  (no token data recorded yet)");
	}
	lines.push("", "Note: Scout/Gate run in separate subagent sessions; their tokens are not counted here.");
	return lines.join("\n");
}

function phaseTotal(p: PhaseTokens): number {
	return p.input + p.output + p.cacheRead;
}

function fmt(p: PhaseTokens): string {
	return `${p.input} / ${p.output} / ${p.cacheRead}`;
}
