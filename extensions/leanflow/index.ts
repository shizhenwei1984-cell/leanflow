/**
 * LeanFlow Extension — control layer for the plan → build → gate workflow.
 *
 * Replaces the prompt-driven flow.md approach with an extension-driven
 * state machine, tool guard, handoff advisor, and builder context filter.
 *
 * Phase lifecycle:
 *   /flow            → planning
 *   write *-plan.md  → awaiting_approval  (plan exists; NOT yet approved)
 *   first build action after approval → building
 *   task(gate)       → gating
 *   Gate PASS / 2nd FAIL → idle
 *   Gate 1st FAIL    → building (repair)
 *
 * The critical correctness property: writing the plan artifact does NOT
 * advance to building. The builder phase begins only when the model takes
 * its first implementation action (edit/bash/non-plan write), which can only
 * happen after the native plan-mode approval overlay is accepted.
 *
 * State persists via appendEntry and restores from the session branch,
 * surviving compaction and session switches.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CUSTOM_TYPE, defaultState, restoreState } from "./state";
import type { LeanFlowState } from "./state";
import { checkTaskGuard, extractAgentNames, resolveRole } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
import { filterForBuilder } from "./context";
import { addUsage, formatStats, recordContextFilter } from "./stats";

/** Tools that mutate the repository — signal that building has started.
 *  `lsp` is intentionally excluded: definition/hover/rename-preview are reads. */
const BUILD_ACTION_TOOLS = new Set(["edit", "bash", "ast_edit"]);

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();
	// Correlate tool_call → tool_result for plan writes and gate calls.
	const pendingPlanWrites = new Map<string, string>(); // toolCallId → plan content
	const pendingGateCalls = new Set<string>(); // toolCallIds
	const pendingArtifactWrites = new Map<string, string>(); // toolCallId → artifact kind

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (state.phase === "idle") {
			ctx.ui.setStatus("leanflow", "");
			return;
		}
		const parts = [`LeanFlow: ${state.phase}`];
		if (state.scoutCalls > 0) parts.push(`scout:${state.scoutCalls}/3`);
		if (state.gateCalls > 0) parts.push(`gate:${state.gateCalls}/2`);
		ctx.ui.setStatus("leanflow", parts.join(" | "));
	}

	// -----------------------------------------------------------------------
	// State restoration on session lifecycle events
	// -----------------------------------------------------------------------

	const restoreEvents = ["session_start", "session_switch", "session_branch", "session_tree"] as const;
	for (const eventName of restoreEvents) {
		pi.on(eventName, async (_event, ctx) => {
			state = restoreState(ctx.sessionManager.getBranch());
			updateStatus(ctx);
		});
	}

	// -----------------------------------------------------------------------
	// /flow command
	// -----------------------------------------------------------------------

	pi.registerCommand("flow", {
		description:
			"Start LeanFlow: extension-driven plan → build → gate with tool guards and context optimization.",
		handler: async (rawArgs, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("LeanFlow /flow requires the interactive TUI.", "error");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("/flow can only start when the session is idle with no pending messages.", "error");
				return;
			}

			let task = (rawArgs ?? "").trim();
			if (!task) {
				const input = await ctx.ui.input("LeanFlow", "Describe the task:");
				if (!input?.trim()) return;
				task = input.trim();
			}

			// Generate a slug from the task text.
			const slug =
				task
					.toLowerCase()
					.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 40) || "task";

			// Initialize state machine.
			state = {
				phase: "planning",
				scoutCalls: 0,
				gateCalls: 0,
				gateAttempt: 0,
				planSlug: slug,
				startedAt: Date.now(),
			};
			persist();
			updateStatus(ctx);

			// Enter native plan mode with a Planner-only prompt.
			const prompt = buildPlanningPrompt(task, slug);
			ctx.ui.setEditorText(`/plan ${prompt}`);
		},
	});

	// -----------------------------------------------------------------------
	// Tool guard + phase transitions (pre-execution)
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "idle") return;

		// Guard: block forbidden agent spawns via `task` tool.
		if (event.toolName === "task") {
			const guard = checkTaskGuard(state.phase, event.input as Record<string, unknown>);
			if (guard.block) {
				return { block: true, reason: guard.reason };
			}

			const names = extractAgentNames(event.input as Record<string, unknown>);
			const roles = new Set(names.map((n) => resolveRole(n)).filter((r): r is string => !!r));

			// Track scout budget.
			if (roles.has("scout")) {
				state.scoutCalls++;
				if (state.scoutCalls > 3) {
					return {
						block: true,
						reason: "LeanFlow guard: Scout budget exhausted (3/3). Improve the plan directly.",
					};
				}
				persist();
				updateStatus(ctx);
			}

			// Track gate calls and transition to gating phase.
			if (roles.has("gate")) {
				// Gate readiness: build evidence must exist before gating.
				const missing = missingArtifacts(state);
				if (missing.length > 0) {
					return {
						block: true,
						reason: `LeanFlow: Gate unavailable — complete build evidence first (missing: ${missing.join(", ")}).`,
					};
				}
				state.gateCalls++;
				state.gateAttempt++;
				if (state.gateCalls > 2) {
					return {
						block: true,
						reason: "LeanFlow guard: Gate budget exhausted (2/2). Report findings and finish.",
					};
				}
				state.phase = "gating";
				pendingGateCalls.add(event.toolCallId);
				persist();
				updateStatus(ctx);
			}
		}
		// Detect plan write for handoff assessment (planning → awaiting_approval).
		if (event.toolName === "write" && state.phase === "planning") {
			const path = String((event.input as Record<string, unknown>).path ?? "");
			if (path.includes("-plan.md")) {
				const content = String((event.input as Record<string, unknown>).content ?? "");
				pendingPlanWrites.set(event.toolCallId, content);
			}
		}

		// Track build-evidence artifact writes (build/diff/evidence) for gate readiness.
		if (event.toolName === "write" && state.phase === "building") {
			const path = String((event.input as Record<string, unknown>).path ?? "");
			const kind = artifactKind(path);
			if (kind) pendingArtifactWrites.set(event.toolCallId, kind);
		}

		// Approval detection: the first repository-mutating action means the
		// plan was approved and building has begun. Native plan mode only
		// releases the model to execute after the approval overlay, so a
		// build action is a reliable post-approval signal.
		if (state.phase === "awaiting_approval" && isBuildAction(event)) {
			state.phase = "building";
			state.approvalBoundary = ctx.sessionManager.getBranch().length;
			state.writtenArtifacts = [];
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: plan approved — entering BUILD.", "info");
		}
	});

	// -----------------------------------------------------------------------
	// Post-execution: handoff assessment + gate verdict
	// -----------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// Handoff: plan was written successfully → assess, then await approval.
		if (event.toolName === "write" && pendingPlanWrites.has(event.toolCallId)) {
			const content = pendingPlanWrites.get(event.toolCallId)!;
			pendingPlanWrites.delete(event.toolCallId);

			const result = assessHandoff(content);
			state.handoffStatus = result.status;
			state.handoffWarnings = result.warnings;

			if (result.status === "NEEDS_UPDATE") {
				// Critically incomplete — stay in planning, advise revision.
				state.phase = "planning";
				persist();
				updateStatus(ctx);
				ctx.ui.notify(formatHandoffNotification(result), "warn");
			} else {
				// Plan artifact ready — wait for native approval, do NOT build yet.
				state.phase = "awaiting_approval";
				persist();
				updateStatus(ctx);
				ctx.ui.notify(
					`${formatHandoffNotification(result)}\nRequest approval via xd://propose.`,
					"info",
				);
			}
		}

		// Record successfully-written build-evidence artifacts for gate readiness.
		if (event.toolName === "write" && pendingArtifactWrites.has(event.toolCallId)) {
			const kind = pendingArtifactWrites.get(event.toolCallId)!;
			pendingArtifactWrites.delete(event.toolCallId);
			const written = state.writtenArtifacts ?? [];
			if (!written.includes(kind)) {
				state.writtenArtifacts = [...written, kind];
				persist();
			}
		}

		// Gate verdict processing.
		if (event.toolName === "task" && pendingGateCalls.has(event.toolCallId)) {
			pendingGateCalls.delete(event.toolCallId);
			const verdict = extractVerdict(event.content);

			if (verdict === "PASS" || state.gateCalls >= 2) {
				// Done: PASS or second FAIL (no more retries).
				state.phase = "idle";
				persist();
				updateStatus(ctx);
				ctx.ui.notify(
					verdict === "PASS"
						? "LeanFlow: Gate PASS. Run complete."
						: "LeanFlow: Gate FAIL (2/2). Report findings and finish.",
					verdict === "PASS" ? "info" : "warn",
				);
			} else {
				// First FAIL → back to building for repair; evidence must be refreshed.
				state.phase = "building";
				state.writtenArtifacts = [];
				persist();
				updateStatus(ctx);
				ctx.ui.notify("LeanFlow: Gate FAIL. Repair, refresh evidence, and re-gate (1 retry left).", "warn");
			}
		}
	});

	// -----------------------------------------------------------------------
	// Context filter: remove planning history from builder context
	// -----------------------------------------------------------------------

	pi.on("context", async (event) => {
		const messages = event.messages as Array<Record<string, unknown>>;
		const filtered = filterForBuilder(messages, state);
		if (filtered) {
			// Quantify the handoff reduction: messages removed from the builder context.
			recordContextFilter(state, messages.length, filtered.length);
			persist();
			return { messages: filtered as typeof event.messages };
		}
	});

	// -----------------------------------------------------------------------
	// Token statistics: accrue main-session usage per phase
	// -----------------------------------------------------------------------

	pi.on("message_end", async (event) => {
		if (state.phase === "idle") return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;
		addUsage(state, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead });
		persist();
	});
	// -----------------------------------------------------------------------

	pi.registerCommand("flowstats", {
		description: "Show LeanFlow run statistics (per-phase tokens, context reduction).",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStats(state), "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Build-action detection (approval signal)
// ---------------------------------------------------------------------------

function isBuildAction(event: { toolName: string; input: Record<string, unknown> }): boolean {
	if (BUILD_ACTION_TOOLS.has(event.toolName)) return true;
	// A `write` to a non-plan path (build/diff/evidence/source) is a build action.
	if (event.toolName === "write") {
		const path = String(event.input.path ?? "");
		return !path.includes("-plan.md");
	}
	return false;
}

// ---------------------------------------------------------------------------
// Build-evidence artifact tracking (gate readiness)
// ---------------------------------------------------------------------------

/** The three evidence artifacts Gate requires, keyed by path suffix. */
const REQUIRED_ARTIFACTS = ["build", "diff", "evidence"] as const;

/** Classify a written path as a build-evidence artifact kind, or undefined. */
function artifactKind(path: string): string | undefined {
	for (const kind of REQUIRED_ARTIFACTS) {
		if (path.includes(`-${kind}.md`)) return kind;
	}
	return undefined;
}

/** Evidence artifacts not yet written this round. */
function missingArtifacts(state: LeanFlowState): string[] {
	const written = new Set(state.writtenArtifacts ?? []);
	return REQUIRED_ARTIFACTS.filter((kind) => !written.has(kind)).map((k) => `${k}.md`);
}

// ---------------------------------------------------------------------------
// Planner-only prompt — no Gate schema, no build artifact detail
// ---------------------------------------------------------------------------

function buildPlanningPrompt(task: string, slug: string): string {
	return [
		`You are LeanFlow Planner (@plan). Task: ${task}`,
		"",
		"## Responsibilities",
		"- Understand the request; investigate code directly or via Scout",
		"- Write a decision-complete canonical plan",
		"- Request approval via xd://propose",
		"",
		"## Plan artifact",
		`Write to local://${slug}-plan.md. It is a decision document covering:`,
		"what changes, which files/symbols, how it will be verified, and key assumptions.",
		"The Builder needs no planning reasoning — only the decisions.",
		"",
		"## Scout (optional, max 3)",
		"```text",
		'task({ context: "LeanFlow investigation", tasks: [{ agent: "scout", name: "scout-<topic>",',
		'  task: "<one focused factual question>", schemaMode: "strict" }] })',
		"```",
		"",
		"## Approval",
		`After writing the plan, request approval by writing \`${slug}\` to xd://propose.`,
		"The extension advances the workflow to BUILD only after approval.",
		"",
		"## Forbidden",
		"No reviewer, audit, validator, implementer, architect, or builder subagents.",
		"Acceptance criteria are a checklist, not a reason to spawn agents.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Gate verdict extraction from tool_result content
// ---------------------------------------------------------------------------

function extractVerdict(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") {
				// Try to parse JSON from the text block.
				const match = b.text.match(/\{[\s\S]*"verdict"\s*:\s*"(PASS|FAIL)"[\s\S]*\}/);
				if (match) return match[1];
			}
		}
	}
	return undefined;
}
