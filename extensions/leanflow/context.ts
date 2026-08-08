/**
 * LeanFlow builder context.
 *
 * A native approval is identified by OMP's synthetic developer prompt, which
 * names the exact approved local:// plan artifact. This survives "Approve and
 * execute" creating a fresh session; positional branch boundaries alone do not.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import { canonicalGateTask } from "./guard";
import type { LeanFlowState } from "./state";

const APPROVED_PLAN_PROMPT = /^Plan approved\.\s*[\s\S]*?You MUST read `([^`]+)` before executing\./m;

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
	const artifact = APPROVED_PLAN_PROMPT.exec(text)?.[1];
	return artifact?.startsWith("local://") && artifact.endsWith("-plan.md") ? artifact : undefined;
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
	if (state.phase !== "building" && state.phase !== "awaiting_approval" && state.phase !== "repair_preparing" && state.phase !== "finalizing") return undefined;
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
	const prefix = `local://${slug}`;
	const gateTask = canonicalGateTask({
		plan: `${prefix}-plan.md`,
		build: `${prefix}-build.md`,
		diff: `${prefix}-diff.md`,
		evidence: `${prefix}-evidence.md`,
	});
	if (state.phase === "finalizing") {
		return [
			"LeanFlow terminal response:",
			"",
			state.terminalOutcome === "pass"
				? "Gate passed."
				: state.terminalOutcome === "gate_operational_failure"
					? "Gate did not complete within the bounded retry budget."
					: "Gate returned FAIL after the bounded repair retry.",
			"",
			'If a completed task remains open in the todo list, you may call exactly one todo tool with input {"op":"done","task":"existing task content"}.',
			"Do not call any other tools, modify files, invoke Gate again, or use todo with any other operation, phase, or extra fields.",
			"Briefly report the terminal outcome and relevant findings to the user, then stop.",
		].join("\n");
	}
	const lines = [
		"LeanFlow Builder context (injected by extension):",
		"",
		`Phase: ${state.phase} | Plan: local://${slug}-plan.md`,
	];
	if (state.gateRetryMode === "repair") {
		lines.push(`Gate attempt: ${state.gateAttempt}/2 — repair the implementation and refresh evidence.`);
	} else if (state.gateRetryMode === "operational") {
		lines.push(`Gate attempt: ${state.gateAttempt}/2 — Gate did not complete; retry Gate with unchanged evidence.`);
	}
	if (state.handoffWarnings && state.handoffWarnings.length > 0) {
		lines.push(`Handoff warnings: ${state.handoffWarnings.join("; ")}`);
	}
	if (state.gateRetryMode !== "operational") {
		lines.push("", "Read the approved plan and implement it as the sole source writer.");
		if (state.gateRetryMode === "repair") {
			lines.push(
				"The immutable baseline is retained from the first BUILD round. Do not call leanflow_capture_baseline again.",
			);
		} else if (state.lspProbeStatus === "not_required") {
			lines.push(
				"The approved plan declares LSP not required for this documentation/resource-only change.",
				"Call leanflow_capture_baseline({}) before any repository mutation.",
			);
		} else {
			lines.push(
				"Before the baseline or any other build action, run LSP diagnostics for the first planned source path (or `*` when none is planned) and wait for its result. This runtime probe is the authoritative LSP configuration detector for project, user/profile, plugin, marketplace, and auto-detected servers.",
				"Then call leanflow_capture_baseline({}) before any repository mutation.",
			);
		}
		lines.push(
			"For each changed source path served by LSP, attempt diagnostics before and after edits; a new file has no pre-edit baseline and is checked after creation. Attempt references before exported-symbol edits. Repair all introduced errors and warnings; a completed no-server/error probe is a fallback, never a substitute for compiler checks, executable tests, or runtime smoke validation.",
			"Run every planned validation synchronously with bash. Then call leanflow_finalize_artifacts({ validationCommands: [\"<exact command already run>\"] }); list every selected command exactly once.",
			`Do not write or edit ${prefix}-build.md, ${prefix}-diff.md, or ${prefix}-evidence.md directly. The extension records results and generates all three artifacts mechanically.`,
		);
	}
	lines.push(
		"Then call Gate:",
		"```text",
		"task({",
		'  context: "LeanFlow Gate",',
		"  tasks: [{",
		'    agent: "gate",',
		`    task: ${JSON.stringify(gateTask)},`,
		'    schemaMode: "strict"',
		"  }]",
		"})",
		"```",
		"Gate PASS → done. First FAIL → repair + re-gate (max 2 Gate calls).",
		"Do not spawn implementer, reviewer, or audit agents. You are the sole writer.",
	);
	return lines.join("\n");
}
