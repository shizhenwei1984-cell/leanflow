/**
 * LeanFlow Extension — control layer for the plan → build → gate workflow.
 *
 * Replaces the prompt-driven flow.md approach with an extension-driven
 * state machine, tool guard, handoff advisor, and builder context filter.
 *
 * Architecture:
 *   /flow command → initialize state → native plan mode (minimal prompt)
 *   tool_call     → guard (block forbidden agents) + phase transitions
 *   tool_result   → handoff assessment + gate verdict processing
 *   context       → filter planning history from builder context
 *
 * State persists via appendEntry and restores from the session branch,
 * surviving compaction and session switches.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CUSTOM_TYPE, defaultState, restoreState } from "./state";
import type { LeanFlowState } from "./state";
import { checkTaskGuard, extractAgentNames } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
import { filterForBuilder } from "./context";

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();

	// Correlate tool_call → tool_result for plan writes and gate calls.
	const pendingPlanWrites = new Map<string, string>(); // toolCallId → plan content
	const pendingGateCalls = new Set<string>(); // toolCallIds

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
				planSlug: slug,
				startedAt: Date.now(),
			};
			persist();
			updateStatus(ctx);

			// Enter native plan mode with minimal planning context.
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

			// Track scout budget.
			if (names.includes("scout")) {
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
			if (names.includes("gate")) {
				state.gateCalls++;
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

		// Detect plan write for handoff assessment.
		if (event.toolName === "write" && state.phase === "planning") {
			const path = String((event.input as Record<string, unknown>).path ?? "");
			if (path.includes("-plan.md")) {
				const content = String((event.input as Record<string, unknown>).content ?? "");
				pendingPlanWrites.set(event.toolCallId, content);
			}
		}
	});

	// -----------------------------------------------------------------------
	// Post-execution: handoff assessment + gate verdict
	// -----------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// Handoff: plan was written successfully → assess and transition.
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
				// READY or READY_WITH_WARNINGS — proceed to building.
				state.phase = "building";
				persist();
				updateStatus(ctx);
				ctx.ui.notify(formatHandoffNotification(result), "info");
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
				// First FAIL → back to building for repair.
				state.phase = "building";
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
		const filtered = filterForBuilder(
			event.messages as Array<Record<string, unknown>>,
			state,
		);
		if (filtered) {
			return { messages: filtered as typeof event.messages };
		}
	});
}

// ---------------------------------------------------------------------------
// Minimal planning prompt — replaces the 125-line flow.md injection
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
		`Write to local://${slug}-plan.md with these sections:`,
		"Context, Approach, Critical files & anchors, Verification, Assumptions & contingencies",
		"The plan is a decision document — Builder needs no planning reasoning.",
		"",
		"## Scout (optional, max 3)",
		"```text",
		'task({ context: "LeanFlow investigation", tasks: [{ agent: "scout", name: "scout-<topic>",',
		'  task: "<one focused factual question>", schemaMode: "strict" }] })',
		"```",
		"",
		"## After approval",
		"You become Builder (@default) in the same session. The extension injects a compact",
		"builder context. Read the approved plan, implement it, run verification, write",
		`local://${slug}-build.md, local://${slug}-diff.md, local://${slug}-evidence.md, then call Gate:`,
		"```text",
		'task({ agent: "gate", task: "Review plan local://' + slug + '-plan.md, diff local://' + slug + '-diff.md,',
		"  build local://" + slug + '-build.md, evidence local://' + slug + '-evidence.md.",',
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
