/**
 * LeanFlow Extension — control layer for the plan → build → gate workflow.
 *
 * Replaces the prompt-driven flow.md approach with an extension-driven
 * state machine, tool guard, handoff advisor, and builder context filter.
 *
 * Phase lifecycle:
 *   /flow            → planning
 *   write *-plan.md  → awaiting_approval  (plan exists; NOT yet approved)
 *   completed LSP diagnostics + first build action after approval → building
 *   task(gate)       → gating
 *   Gate PASS / 2nd FAIL → idle
 *   Gate 1st FAIL    → building (repair)
 *
 * The critical correctness property: writing the plan artifact does NOT
 * advance to building. The Builder receives its protocol after approval, must
 * complete diagnostics before the first repository mutation, and enters
 * building only on that subsequent implementation action.
 *
 * State persists via appendEntry and restores from the session branch,
 * surviving compaction and session switches.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { CUSTOM_TYPE, defaultState, defaultStats, restoreState } from "./state";
import type { LeanFlowState } from "./state";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
import { filterForBuilder } from "./context";
import {
	addUsage,
	formatStats,
	recordContextFilter,
	recordGateError,
	recordGateFailure,
	recordGatePass,
	recordGateReadinessBlock,
	recordTerminalFailure,
	resumePhaseTiming,
	transitionPhase,
} from "./stats";

/** Tools that mutate the repository — signal that building has started. */
const BUILD_ACTION_TOOLS: Readonly<Record<string, true>> = { edit: true, bash: true, ast_edit: true };

type WriteToolInput = { content: string; path: string };

function isTaskToolCall(event: ToolCallEvent): event is ToolCallEvent & { input: Record<string, unknown>; toolName: "task" } {
	return event.toolName === "task" && typeof event.input === "object" && event.input !== null && !Array.isArray(event.input);
}

function isWriteToolCall(event: ToolCallEvent): event is ToolCallEvent & { input: WriteToolInput; toolName: "write" } {
	return (
		event.toolName === "write" &&
		"path" in event.input &&
		"content" in event.input &&
		typeof event.input.path === "string" &&
		typeof event.input.content === "string"
	);
}

function lspDiagnosticsTarget(event: ToolCallEvent): string | undefined {
	if (!isWriteToolCall(event) || event.input.path !== "xd://lsp") return undefined;
	try {
		const input: unknown = JSON.parse(event.input.content);
		if (
			typeof input === "object" &&
			input !== null &&
			!Array.isArray(input) &&
			"action" in input &&
			input.action === "diagnostics" &&
			"file" in input &&
			typeof input.file === "string"
		) {
			return input.file;
		}
	} catch {
		// Malformed device input is neither a diagnostics probe nor a mutation.
	}
	return undefined;
}

function isProposalWrite(event: ToolCallEvent): event is ToolCallEvent & { input: WriteToolInput; toolName: "write" } {
	return isWriteToolCall(event) && event.input.path === "xd://propose";
}

function hasPlanModeExitAfter(branch: Iterable<unknown>, boundary: number): boolean {
	let index = 0;
	for (const entry of branch) {
		if (
			index >= boundary &&
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "mode_change" &&
			"mode" in entry &&
			entry.mode === "none"
		) {
			return true;
		}
		index++;
	}
	return false;
}

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();
	// Correlate tool_call → tool_result for plan writes, LSP probes, and gate calls.
	const pendingPlanWrites = new Map<string, string>(); // toolCallId → plan content
	const pendingLspProbes = new Map<string, string>(); // toolCallId → diagnostics target
	const pendingApprovalWrites = new Set<string>(); // toolCallIds
	const pendingGateCalls = new Set<string>(); // toolCallIds
	const pendingArtifactWrites = new Map<string, string>(); // toolCallId → artifact kind

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, state);
	}

	/** Statistics observation and its standalone persistence are non-blocking. */
	function recordStats(mutator: () => void, persistObservation = true): void {
		try {
			mutator();
			if (persistObservation) {
				try {
					persist();
				} catch {
					// Losing an observation cannot affect workflow control.
				}
			}
		} catch {
			// Statistics must never break an otherwise valid workflow action.
		}
	}

	function nativeApprovalConfirmed(ctx: ExtensionContext): boolean {
		if (state.phase === "building") return true;
		if (state.phase !== "awaiting_approval" || state.proposalBoundary === undefined) return false;
		if (state.approvalBoundary === state.proposalBoundary) return true;
		if (!hasPlanModeExitAfter(ctx.sessionManager.getBranch(), state.proposalBoundary)) return false;

		state.approvalBoundary = state.proposalBoundary;
		persist();
		return true;
	}

	function finishGateResult(verdict: "PASS" | "FAIL" | undefined, isError: boolean, ctx: ExtensionContext): void {
		const repaired = state.gateCalls < 2;
		if (verdict === "PASS") {
			recordStats(() => recordGatePass(state, state.gateAttempt > 1), false);
			transitionPhase(state, "idle");
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: Gate PASS. Run complete.", "info");
			return;
		}

		recordStats(
			() => {
				if (isError || verdict === undefined) {
					recordGateError(state, repaired);
				} else {
					recordGateFailure(state, repaired);
				}
				if (!repaired) recordTerminalFailure(state);
			},
			false,
		);
		if (repaired) {
			transitionPhase(state, "building");
			state.writtenArtifacts = [];
			persist();
			updateStatus(ctx);
			ctx.ui.notify(
				"LeanFlow: Gate result unavailable or FAIL. Repair, refresh evidence, and re-gate (1 retry left).",
				"warning",
			);
			return;
		}

		transitionPhase(state, "idle");
		persist();
		updateStatus(ctx);
		ctx.ui.notify("LeanFlow: Gate FAIL (2/2). Report findings and finish.", "warning");
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

	const restoreSessionState = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		state = restoreState(ctx.sessionManager.getBranch());
		resumePhaseTiming(state);
		updateStatus(ctx);
	};
	pi.on("session_start", restoreSessionState);
	pi.on("session_switch", restoreSessionState);
	pi.on("session_branch", restoreSessionState);
	pi.on("session_tree", restoreSessionState);

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

			// Initialize state machine and the first observable phase.
			const now = Date.now();
			state = {
				phase: "planning",
				phaseStartedAt: now,
				scoutCalls: 0,
				gateCalls: 0,
				gateAttempt: 0,
				lspProbeCompleted: false,
				planSlug: slug,
				startedAt: now,
				stats: defaultStats(),
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
		if (isTaskToolCall(event)) {
			const guard = checkTaskGuard(state.phase, event.input);
			if (guard.block) {
				return { block: true, reason: guard.reason };
			}

			const roles = extractAgentRoles(event.input);
			const budget = checkAgentBudget(state, roles);
			if (budget.block) return { block: true, reason: budget.reason };

			const scoutCount = roles.filter((role) => role === "scout").length;
			const gateCount = roles.filter((role) => role === "gate").length;
			if (gateCount > 0) {
				// Readiness is still checked before any Gate attempt is counted.
				const missing = missingArtifacts(state);
				if (missing.length > 0) {
					recordStats(() => recordGateReadinessBlock(state));
					return {
						block: true,
						reason: `LeanFlow: Gate unavailable — complete build evidence first (missing: ${missing.join(", ")}).`,
					};
				}
			}

			// Every preflight passed; mutate exact request counts atomically.
			state.scoutCalls += scoutCount;
			if (gateCount === 1) {
				state.gateCalls++;
				state.gateAttempt++;
				transitionPhase(state, "gating");
				pendingGateCalls.add(event.toolCallId);
			}
			if (roles.length > 0) {
				persist();
				updateStatus(ctx);
			}
		}

		const approvalConfirmed =
			state.phase === "awaiting_approval" && nativeApprovalConfirmed(ctx);
		// Refine keeps native plan mode active, so revised plans remain assessable.
		if (
			isWriteToolCall(event) &&
			(state.phase === "planning" || (state.phase === "awaiting_approval" && !approvalConfirmed)) &&
			event.input.path.includes("-plan.md")
		) {
			pendingPlanWrites.set(event.toolCallId, event.input.content);
		}

		const diagnosticsTarget = lspDiagnosticsTarget(event);
		if (state.phase === "awaiting_approval" && approvalConfirmed && diagnosticsTarget !== undefined) {
			pendingLspProbes.set(event.toolCallId, diagnosticsTarget);
		}

		if (state.phase === "awaiting_approval" && !approvalConfirmed && isProposalWrite(event)) {
			pendingApprovalWrites.add(event.toolCallId);
		}

		// Track build-evidence artifact writes (build/diff/evidence) for gate readiness.
		if (isWriteToolCall(event) && state.phase === "building") {
			const kind = artifactKind(event.input.path);
			if (kind) pendingArtifactWrites.set(event.toolCallId, kind);
		}

		// A mutation is a build action only after native plan mode actually exits.
		if (state.phase === "awaiting_approval" && isBuildAction(event)) {
			if (!approvalConfirmed) {
				return {
					block: true,
					reason: "LeanFlow: the plan is still awaiting native approval; approve it before starting BUILD.",
				};
			}
			if (!state.lspProbeCompleted) {
				return {
					block: true,
					reason:
						"LeanFlow: before the first build action, write a diagnostics request for a planned source path (or `*`) to xd://lsp and wait for its result. Record an unavailable or no-server result as fallback.",
				};
			}
			transitionPhase(state, "building");
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
		if (event.toolName === "write" && pendingApprovalWrites.has(event.toolCallId)) {
			pendingApprovalWrites.delete(event.toolCallId);
			if (event.isError) return;
			state.proposalBoundary = ctx.sessionManager.getBranch().length;
			state.approvalBoundary = undefined;
			state.lspProbeCompleted = false;
			state.lspProbeTarget = undefined;
			persist();
			updateStatus(ctx);
			return;
		}

		if (event.toolName === "write" && pendingLspProbes.has(event.toolCallId)) {
			const target = pendingLspProbes.get(event.toolCallId)!;
			pendingLspProbes.delete(event.toolCallId);
			state.lspProbeCompleted = true;
			state.lspProbeTarget = target;
			persist();
			updateStatus(ctx);
			return;
		}

		// Failed plan/artifact writes must not leave stale pending bookkeeping.
		if (event.toolName === "write" && pendingPlanWrites.has(event.toolCallId)) {
			const content = pendingPlanWrites.get(event.toolCallId)!;
			pendingPlanWrites.delete(event.toolCallId);
			if (event.isError) return;

			// Handoff: plan was written successfully → assess, then await approval.
			const result = assessHandoff(content);
			state.handoffStatus = result.status;
			state.handoffWarnings = result.warnings;
			state.proposalBoundary = undefined;
			state.approvalBoundary = undefined;
			state.lspProbeCompleted = false;
			state.lspProbeTarget = undefined;

			if (result.status === "NEEDS_UPDATE") {
				// Critically incomplete — stay in planning, advise revision.
				transitionPhase(state, "planning");
				persist();
				updateStatus(ctx);
				ctx.ui.notify(formatHandoffNotification(result), "warning");
			} else {
				// Plan artifact ready — wait for native approval, do NOT build yet.
				transitionPhase(state, "awaiting_approval");
				persist();
				updateStatus(ctx);
				ctx.ui.notify(
					`${formatHandoffNotification(result)}\nRequest approval via xd://propose.`,
					"info",
				);
			}
			return;
		}

		if (event.toolName === "write" && pendingArtifactWrites.has(event.toolCallId)) {
			const kind = pendingArtifactWrites.get(event.toolCallId)!;
			pendingArtifactWrites.delete(event.toolCallId);
			if (event.isError) return;
			const written = state.writtenArtifacts ?? [];
			if (!written.includes(kind)) {
				state.writtenArtifacts = [...written, kind];
				persist();
			}
			return;
		}

		if (event.toolName === "task" && pendingGateCalls.has(event.toolCallId)) {
			pendingGateCalls.delete(event.toolCallId);
			finishGateResult(event.isError ? undefined : extractVerdict(event.content), event.isError, ctx);
			return;
		}
	});

	// -----------------------------------------------------------------------
	// Context filter: remove planning history from builder context
	// -----------------------------------------------------------------------

	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (state.phase === "awaiting_approval" && !nativeApprovalConfirmed(ctx)) return;
		const filtered = filterForBuilder(messages, state);
		if (!filtered) return;

		// Filtering is the deliverable; measurements and their persistence are isolated.
		recordStats(() => recordContextFilter(state, messages, filtered));
		return { messages: filtered };
	});

	// -----------------------------------------------------------------------
	// Token statistics: accrue main-session usage per phase
	// -----------------------------------------------------------------------

	pi.on("message_end", async (event) => {
		if (state.phase === "idle") return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		recordStats(() => addUsage(state, usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead } : {}));
	});
	// -----------------------------------------------------------------------

	pi.registerCommand("flowstats", {
		description: "Show LeanFlow run statistics (per-phase tokens, context reduction).",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(formatStats(state), "info");
			} catch {
				ctx.ui.notify("LeanFlow run statistics unavailable for this observation.", "warning");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Build-action detection (approval signal)
// ---------------------------------------------------------------------------

function isBuildAction(event: ToolCallEvent): boolean {
	if (Object.hasOwn(BUILD_ACTION_TOOLS, event.toolName)) return true;
	// Plans and mounted devices do not mutate the repository.
	if (isWriteToolCall(event)) {
		return !event.input.path.includes("-plan.md") && !event.input.path.startsWith("xd://");
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
		"- Use LSP symbol references and diagnostics best-effort; if unavailable or timed out, continue with read/grep, compiler checks, executable tests, and runtime smoke tests.",
		"- LSP diagnostics supplement executable validation; record any LSP availability/result in build.md and evidence.md without adding runtime statistics to context.",
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

function extractVerdict(content: unknown): "PASS" | "FAIL" | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") {
				// Try to parse JSON from the text block.
				const match = b.text.match(/\{[\s\S]*"verdict"\s*:\s*"(PASS|FAIL)"[\s\S]*\}/);
				if (match) return match[1] as "PASS" | "FAIL";
			}
		}
	}
	return undefined;
}
