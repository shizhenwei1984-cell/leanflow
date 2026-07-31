/**
 * LeanFlow builder context.
 *
 * A native approval is identified by OMP's synthetic developer prompt, which
 * names the exact approved local:// plan artifact. This survives "Approve and
 * execute" creating a fresh session; positional branch boundaries alone do not.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import type { LeanFlowState } from "./state";

const APPROVED_PLAN_PROMPT = /^Plan approved\.\s*[\s\S]*?\bMUST read (local:\/\/[A-Za-z0-9_-]+-plan\.md) before executing\./m;

/**
 * Return the exact canonical artifact from OMP's native approved-plan prompt.
 * Only OMP creates this prompt as a synthetic developer message.
 */
export function approvedPlanArtifact(message: unknown): string | undefined {
	if (!isDeveloperMessage(message)) return undefined;
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((block): block is { type: "text"; text: string } => isTextBlock(block))
						.map((block) => block.text)
						.join("\n")
				: "";
	return APPROVED_PLAN_PROMPT.exec(text)?.[1];
}

/** Locate a matching native approval prompt in model context. */
export function findApprovedPlanBoundary(messages: AgentMessage[], artifact: string): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (approvedPlanArtifact(messages[i]) === artifact) return i;
	}
	return -1;
}

/**
 * Filter context only after an exact native approval, then preserve the compact
 * Builder context through building.
 */
export function filterForBuilder(messages: AgentMessage[], state: LeanFlowState): AgentMessage[] | undefined {
	if (state.phase !== "building" && state.phase !== "awaiting_approval") return undefined;
	const artifact = state.approvedPlanArtifact;
	if (!artifact) return undefined;

	const boundaryIndex = findApprovedPlanBoundary(messages, artifact);
	if (boundaryIndex < 0) return undefined;

	// Keep the first user message (the task) + everything after native approval.
	const firstUser = messages.find((m) => m.role === "user");
	const postBoundary = messages.slice(boundaryIndex + 1);

	const filtered: AgentMessage[] = [];
	if (firstUser && !postBoundary.includes(firstUser)) {
		filtered.push(firstUser);
	}

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

function isDeveloperMessage(message: unknown): message is { role: "developer"; content: unknown } {
	return typeof message === "object" && message !== null && "role" in message && message.role === "developer" && "content" in message;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
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
