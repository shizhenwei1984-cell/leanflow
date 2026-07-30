/**
 * LeanFlow builder context filter.
 *
 * During the building phase, filters the LLM context to remove verbose
 * planning-phase messages (Scout results, reasoning) and inject a compact
 * builder preamble. This is the primary token optimization: the builder
 * reads the approved plan artifact instead of carrying planning history.
 *
 * Uses `state.approvalBoundary`, which the lifecycle sets only after a native
 * plan-mode exit. Message filtering locates the proposal call itself because
 * branch-entry indexes and model-context indexes are different coordinate spaces.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import type { LeanFlowState } from "./state";

/**
 * Filter context only after native approval, then preserve that compact Builder
 * context through building.
 */
export function filterForBuilder(
	messages: AgentMessage[],
	state: LeanFlowState,
): AgentMessage[] | undefined {
	if (state.phase !== "building" && (state.phase !== "awaiting_approval" || state.approvalBoundary === undefined)) return undefined;

	// Prefer the proposal call in model context; persisted boundaries are branch
	// positions and only serve as a compatibility fallback for older sessions.
	let boundaryIndex = findProposeBoundary(messages);
	if (boundaryIndex < 0) {
		boundaryIndex = state.approvalBoundary ?? -1;
	}
	if (boundaryIndex < 0) return undefined; // can't find boundary, pass through

	// Keep the first user message (the task) + everything after the boundary.
	const firstUser = messages.find((m) => m.role === "user");
	const postBoundary = messages.slice(boundaryIndex + 1);

	const filtered: AgentMessage[] = [];
	if (firstUser && !postBoundary.includes(firstUser)) {
		filtered.push(firstUser);
	}

	// Inject compact builder preamble.
	const preamble: CustomMessage = {
		role: "custom",
		customType: "leanflow-builder-context",
		content: [{ type: "text", text: buildBuilderPreamble(state) }],
		display: false,
		timestamp: Date.now(),
	};
	filtered.push(preamble);
	filtered.push(...postBoundary);
	return filtered;
}

/** Find the xd://propose write in message history. */
function findProposeBoundary(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isProposeMessage(messages[i])) return i;
	}
	return -1;
}

function isProposeMessage(message: AgentMessage): boolean {
	if (!("content" in message) || !Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === "write") {
			const path = String(block.arguments.path ?? "");
			if (path.includes("xd://propose")) return true;
		}
		if (block.type === "text" && block.text.includes("xd://propose")) {
			return true;
		}
	}
	return false;
}

function buildBuilderPreamble(state: LeanFlowState): string {
	const slug = state.planSlug ?? "<slug>";
	const lines = [
		"LeanFlow Builder context (injected by extension):",
		"",
		`Phase: building | Plan: local://${slug}-plan.md`,
	];
	if (state.gateAttempt > 0) {
		lines.push(`Gate attempt: ${state.gateAttempt}/2 — this is a repair round.`);
	}
	if (state.handoffWarnings && state.handoffWarnings.length > 0) {
		lines.push(`Handoff warnings: ${state.handoffWarnings.join("; ")}`);
	}
	lines.push(
		"",
		"Read the approved plan, implement it, run verification, and write:",
		`  local://${slug}-build.md, local://${slug}-diff.md, local://${slug}-evidence.md`,
		"Before Baseline HEAD or any other build action, run LSP diagnostics for the first planned source path (or `*` when none is planned) and wait for its result. This runtime probe is the authoritative LSP configuration detector for project, user/profile, plugin, marketplace, and auto-detected servers. Record the target, responding server or no server, result, and fallback.",
		"For each changed source path served by LSP, attempt diagnostics before and after edits; a new file has no pre-edit baseline and is checked after creation. Attempt references before exported-symbol edits. Record every probe/request/result in build.md and evidence.md. Repair all introduced errors and warnings; a completed no-server/error probe is a fallback, never a substitute for compiler checks, executable tests, or runtime smoke validation.",
		"Then call Gate:",
		"```text",
		`task({ agent: "gate", task: "Review plan local://${slug}-plan.md, diff local://${slug}-diff.md,`,
		`  build local://${slug}-build.md, evidence local://${slug}-evidence.md.",`,
		'  outputSchema: { type: "object", properties: { verdict: { type: "string", enum: ["PASS","FAIL"] },',
		'    findings: { type: "array", items: { type: "object", properties: {',
		'      category: { type: "string" }, severity: { type: "string", enum: ["blocking","nonblocking"] },',
		'      file: { type: "string" }, location: { type: "string" },',
		'      issue: { type: "string" }, required_fix: { type: "string" } },',
		'      required: ["category","severity","file","location","issue","required_fix"],',
		'      additionalProperties: false } } }, required: ["verdict","findings"], additionalProperties: false },',
		'  schemaMode: "strict" })',
		"```",
		"Gate PASS → done. First FAIL → repair + re-gate (max 2 Gate calls).",
		"Do not spawn implementer, reviewer, or audit agents. You are the sole writer.",
	);
	return lines.join("\n");
}
