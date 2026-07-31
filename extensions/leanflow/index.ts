/**
 * LeanFlow Extension — control layer for the plan → build → gate workflow.
 *
 * Replaces the prompt-driven flow.md approach with an extension-driven
 * state machine, tool guard, handoff advisor, and builder context filter.
 *
 * Phase lifecycle:
 *   /flow                          → planning
 *   write/edit canonical *-plan.md → awaiting_approval
 *   exact native approved-plan prompt → building (LSP may still lock mutation)
 *   task(gate)                     → gating
 *   Gate PASS / 2nd FAIL           → finalizing → idle
 *   Gate 1st valid FAIL            → building (repair)
 *
 * The critical correctness property: a successful proposal is not approval.
 * BUILD begins only when OMP's synthetic approval prompt names the exact plan
 * artifact that LeanFlow proposed. The Builder must then complete diagnostics
 * before its first repository mutation.
 *
 * State persists via appendEntry and restores from the session branch,
 * surviving compaction and session switches.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { approvedPlanArtifact, filterForBuilder } from "./context";
import { CUSTOM_TYPE, defaultState, defaultStats, hasPersistedState, restoreState } from "./state";
import type { LeanFlowState } from "./state";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles } from "./guard";
import type { LeanFlowAgentRole } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
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

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "web_search"]);
const LSP_READ_ONLY_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);
const REPOSITORY_MUTATION_TOOLS = new Set(["bash", "ast_edit", "eval", "resolve"]);
type ToolEffect =
	| "read_only"
	| "canonical_plan_mutation"
	| "local_scratch_mutation"
	| "repository_mutation"
	| "control_plane_mutation"
	| "unknown";

type WriteToolInput = { content: string; path: string };

interface RunMarker {
	version: 2;
	runId: string;
	planSlug: string;
	planArtifact: string;
	planDigest: string;
	status: LeanFlowState["runMarkerStatus"];
	updatedAt: number;
	phaseStartedAt: number;
	scoutCalls: number;
	startedAt: number;
	handoffStatus?: LeanFlowState["handoffStatus"];
	handoffWarnings?: string[];
	stats: NonNullable<LeanFlowState["stats"]>;
	lspProbeStatus: LeanFlowState["lspProbeStatus"];
}

interface ActiveRunPointer {
	version: 1;
	runId: string;
	markerArtifact: string;
	planArtifact: string;
	status: NonNullable<LeanFlowState["runMarkerStatus"]>;
	updatedAt: number;
}

type FreshRecoveryLookup =
	| { kind: "none" }
	| { kind: "valid"; marker: RunMarker }
	| { kind: "invalid"; pointer?: Partial<ActiveRunPointer>; reason: string };

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACTIVE_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			!("action" in input) ||
			input.action !== "diagnostics" ||
			!("file" in input) ||
			typeof input.file !== "string"
		) {
			return undefined;
		}
		const target = input.file.trim();
		if (!target) return undefined;
		if (target === "*") return target;
		if (target.includes("\0") || path.isAbsolute(target)) return undefined;
		const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
		return normalized;
	} catch {
		// Malformed device input is neither a diagnostics probe nor a mutation.
		return undefined;
	}
}

async function isUsableLspTarget(ctx: ExtensionContext, target: string): Promise<boolean> {
	if (target === "*") return true;
	const candidate = path.resolve(ctx.cwd, target);
	if (candidate !== ctx.cwd && !candidate.startsWith(`${path.resolve(ctx.cwd)}${path.sep}`)) return false;
	try {
		return (await fs.stat(candidate)).isFile();
	} catch {
		return false;
	}
}

function isProposalWrite(event: ToolCallEvent): event is ToolCallEvent & { input: WriteToolInput; toolName: "write" } {
	return isWriteToolCall(event) && event.input.path === "xd://propose";
}

function expectedPlanArtifact(state: LeanFlowState): string | undefined {
	return state.planSlug ? `local://${state.planSlug}-plan.md` : undefined;
}



function unwrapHashlineTarget(rawTarget: string): string {
	const trimmed = rawTarget.trimEnd();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return rawTarget;
	const inner = trimmed.slice(1, -1);
	const tag = /#[0-9A-Fa-f]{4}$/.exec(inner);
	const target = tag ? inner.slice(0, tag.index) : inner;
	return target && !target.includes("#") ? target : rawTarget;
}

function resolveLocalTarget(ctx: ExtensionContext, target: string): string | undefined {
	if (!ctx.localProtocolOptions) return undefined;
	const root = resolveRunMarkerPath(ctx.localProtocolOptions, "local://");
	if (!root) return undefined;
	let relative: string;
	try {
		relative = decodeURIComponent(target.slice("local://".length).replaceAll("\\", "/").replace(/^\/+/, ""));
	} catch {
		return undefined;
	}
	if (relative.includes("\0") || path.isAbsolute(relative)) return undefined;
	const normalized = path.posix.normalize(relative);
	if (normalized === ".." || normalized.startsWith("../")) return undefined;
	const resolved = path.resolve(root, normalized === "." ? "" : normalized);
	return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function normalizeFilesystemIdentity(target: string): string {
	const absolute = path.resolve(target);
	let existing = absolute;
	const suffix: string[] = [];
	for (;;) {
		try {
			return path.join(fsSync.realpathSync.native(existing), ...suffix.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return absolute;
			suffix.push(path.basename(existing));
			existing = parent;
		}
	}
}

function resolveLeanFlowTarget(ctx: ExtensionContext, rawTarget: string): string | undefined {
	const unwrapped = unwrapHashlineTarget(rawTarget);
	const target = unwrapped.replace(/^(local:)\/(?!\/)/, "$1//");
	if (target.startsWith("local://")) {
		const resolved = resolveLocalTarget(ctx, target);
		return resolved ? normalizeFilesystemIdentity(resolved) : undefined;
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return undefined;
	const expanded = target === "~" ? os.homedir() : target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	const resolved = /^\/+$/.test(expanded) ? ctx.cwd : path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
	return normalizeFilesystemIdentity(resolved);
}

function toolTargets(event: ToolCallEvent): string[] {
	if (event.toolName !== "write" && event.toolName !== "edit") return [];
	const targets: string[] = [];
	if ("path" in event.input && typeof event.input.path === "string") targets.push(event.input.path);
	if ("paths" in event.input && Array.isArray(event.input.paths)) {
		for (const candidate of event.input.paths) if (typeof candidate === "string") targets.push(candidate);
	}
	return targets;
}

function toolTargetsPath(ctx: ExtensionContext, event: ToolCallEvent, target: string): boolean {
	const expected = resolveLeanFlowTarget(ctx, target);
	return expected !== undefined && toolTargets(event).some((candidate) => resolveLeanFlowTarget(ctx, candidate) === expected);
}

function toolTargetsOnlyPath(ctx: ExtensionContext, event: ToolCallEvent, target: string): boolean {
	const expected = resolveLeanFlowTarget(ctx, target);
	const targets = toolTargets(event);
	return expected !== undefined && targets.length > 0 && targets.every((candidate) => resolveLeanFlowTarget(ctx, candidate) === expected);
}

function lspAction(event: ToolCallEvent): string | undefined {
	if (!isWriteToolCall(event) || event.input.path !== "xd://lsp") return undefined;
	try {
		const input: unknown = JSON.parse(event.input.content);
		return input && typeof input === "object" && !Array.isArray(input) && "action" in input && typeof input.action === "string"
			? input.action
			: undefined;
	} catch {
		return undefined;
	}
}

function targetsLocalSandbox(ctx: ExtensionContext, event: ToolCallEvent): boolean {
	if (!ctx.localProtocolOptions) return false;
	const localRoot = resolveRunMarkerPath(ctx.localProtocolOptions, "local://");
	if (!localRoot) return false;
	const root = normalizeFilesystemIdentity(localRoot);
	const targets = toolTargets(event);
	return (
		targets.length > 0 &&
		targets.every((candidate) => {
			const resolved = resolveLeanFlowTarget(ctx, candidate);
			return resolved !== undefined && (resolved === root || resolved.startsWith(`${root}${path.sep}`));
		})
	);
}

function classifyToolEffect(
	ctx: ExtensionContext,
	event: ToolCallEvent,
	canonicalPlanArtifact: string | undefined,
): ToolEffect {
	if (READ_ONLY_TOOLS.has(event.toolName)) return "read_only";
	if (isWriteToolCall(event) && event.input.path === "xd://lsp") {
		const action = lspAction(event);
		if (action === "diagnostics" && lspDiagnosticsTarget(event) === undefined) return "control_plane_mutation";
		return action !== undefined && LSP_READ_ONLY_ACTIONS.has(action) ? "read_only" : "control_plane_mutation";
	}
	if (
		canonicalPlanArtifact !== undefined &&
		toolTargetsOnlyPath(ctx, event, canonicalPlanArtifact)
	) {
		return "canonical_plan_mutation";
	}
	if (isProposalWrite(event) || isTaskToolCall(event)) return "control_plane_mutation";
	if (targetsLocalSandbox(ctx, event)) return "local_scratch_mutation";
	if (REPOSITORY_MUTATION_TOOLS.has(event.toolName) || event.toolName === "write" || event.toolName === "edit") {
		return "repository_mutation";
	}
	return "unknown";
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

function hasPlanModeEntryAfter(branch: Iterable<unknown>, boundary: number): boolean {
	let index = 0;
	for (const entry of branch) {
		if (
			index >= boundary &&
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "mode_change" &&
			"mode" in entry &&
			entry.mode === "plan"
		) {
			return true;
		}
		index++;
	}
	return false;
}

/** Native approval prompts are persisted developer messages on the branch. */
function approvedArtifactAfter(branch: Iterable<unknown>, boundary = 0): string | undefined {
	let index = 0;
	let artifact: string | undefined;
	for (const entry of branch) {
		if (
			index >= boundary &&
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "message" &&
			"message" in entry
		) {
			artifact = approvedPlanArtifact(entry.message) ?? artifact;
		}
		index++;
	}
	return artifact;
}

function planSlugFromArtifact(artifact: string): string {
	return artifact.slice("local://".length, -"-plan.md".length);
}

function runMarkerArtifact(_planSlug: string, runId: string): string {
	return `local://.leanflow/runs/${runId}.json`;
}

function activePointerArtifact(planSlug: string): string {
	return `local://.leanflow/active/${encodeURIComponent(planSlug)}.json`;
}

function targetsReservedLeanFlowState(ctx: ExtensionContext, event: ToolCallEvent): boolean {
	if (!ctx.localProtocolOptions) return false;
	const reservedRoot = resolveRunMarkerPath(ctx.localProtocolOptions, "local://.leanflow");
	if (!reservedRoot) return false;
	const root = normalizeFilesystemIdentity(reservedRoot);
	return toolTargets(event).some((candidate) => {
		const resolved = resolveLeanFlowTarget(ctx, candidate);
		return resolved !== undefined && (resolved === root || resolved.startsWith(`${root}${path.sep}`));
	});
}

function linesOutsideMarkdownFences(content: string): string[] {
	const outside: string[] = [];
	let fence: { char: "`" | "~"; length: number } | undefined;
	for (const line of content.split(/\r?\n/)) {
		const match = /^\s*(`{3,}|~{3,})/.exec(line);
		if (!fence) {
			if (match) {
				const token = match[1];
				fence = { char: token[0] as "`" | "~", length: token.length };
			} else {
				outside.push(line);
			}
			continue;
		}
		if (match && match[1][0] === fence.char && match[1].length >= fence.length) fence = undefined;
	}
	return outside;
}

function lspStatusFromPlan(content: string): { status: LeanFlowState["lspProbeStatus"]; warning?: string } {
	const declarations = linesOutsideMarkdownFences(content).flatMap((line) => {
		const match = /^LSP applicability:\s*(required|not_required)\s*$/i.exec(line);
		return match ? [match[1].toLowerCase()] : [];
	});
	if (declarations.length !== 1) {
		return {
			status: "pending",
			warning: `Expected exactly one LSP applicability declaration outside fenced code; found ${declarations.length}.`,
		};
	}
	return { status: declarations[0] === "not_required" ? "not_required" : "pending" };
}

function runIdFromPlan(content: string): string | undefined {
	const declarations = linesOutsideMarkdownFences(content).flatMap((line) => {
		const match = /^LeanFlow run ID:\s*([0-9a-f-]+)\s*$/i.exec(line);
		return match ? [match[1]] : [];
	});
	return declarations.length === 1 && RUN_ID_PATTERN.test(declarations[0]) ? declarations[0] : undefined;
}

function planDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function resolveRunMarkerPath(
	options: NonNullable<ExtensionContext["localProtocolOptions"]>,
	artifact: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!artifact.startsWith("local://")) return undefined;
	const artifactsDir = options.getArtifactsDir?.();
	const sessionId = (options.getSessionId?.() ?? "session").replace(/[^a-zA-Z0-9_.-]/g, "_") || "session";
	const candidateRoot = artifactsDir ? path.resolve(artifactsDir, "local") : path.join(os.tmpdir(), "omp-local", sessionId);
	const root =
		platform === "win32" && candidateRoot.length >= 180
			? path.join(os.tmpdir(), "omp-local", sessionId)
			: candidateRoot;
	const target = path.resolve(root, artifact.slice("local://".length));
	if (target !== root && !target.startsWith(`${root}${path.sep}`)) return undefined;
	return target;
}

function isRunMarker(value: unknown, approvedArtifact: string): value is RunMarker {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const marker = value as Partial<RunMarker>;
	return (
		marker.version === 2 &&
		typeof marker.runId === "string" &&
		RUN_ID_PATTERN.test(marker.runId) &&
		typeof marker.planSlug === "string" &&
		marker.planSlug.length > 0 &&
		marker.planArtifact === approvedArtifact &&
		typeof marker.planDigest === "string" &&
		SHA256_PATTERN.test(marker.planDigest) &&
		marker.status === "awaiting_approval" &&
		typeof marker.updatedAt === "number" &&
		Number.isFinite(marker.updatedAt) &&
		Date.now() - marker.updatedAt >= 0 &&
		Date.now() - marker.updatedAt <= ACTIVE_MARKER_MAX_AGE_MS &&
		typeof marker.phaseStartedAt === "number" &&
		Number.isFinite(marker.phaseStartedAt) &&
		typeof marker.scoutCalls === "number" &&

		Number.isInteger(marker.scoutCalls) &&
		marker.scoutCalls >= 0 &&
		marker.scoutCalls <= 3 &&
		typeof marker.startedAt === "number" &&
		Number.isFinite(marker.startedAt) &&
		!!marker.stats &&
		(marker.lspProbeStatus === "not_required" || marker.lspProbeStatus === "pending")
	);
}
async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	const handle = await fs.open(temporary, "wx");
	try {
		await handle.writeFile(JSON.stringify(value), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();
	let hasPersistedLeanFlowState = false;
	// Correlate tool_call → tool_result for plan writes, LSP probes, and gate calls.
	const pendingPlanRefreshes = new Set<string>(); // successful canonical write/edit → reread and reassess
	const pendingLspProbes = new Map<string, string>(); // toolCallId → diagnostics target
	const pendingApprovalWrites = new Map<string, string>(); // toolCallId → exact plan artifact
	const pendingGateCalls = new Set<string>(); // toolCallIds
	const pendingArtifactUpdates = new Map<string, string[]>(); // toolCallId → artifact kinds

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, state);
		hasPersistedLeanFlowState = true;
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

	async function writeRunMarker(ctx: ExtensionContext, status: NonNullable<LeanFlowState["runMarkerStatus"]>): Promise<boolean> {
		if (!state.runId || !state.planSlug || !state.planArtifact || !state.planDigest || !state.startedAt || !state.stats) {
			state.persistenceDegraded = true;
			return false;
		}
		const options = ctx.localProtocolOptions;
		if (!options) {
			state.persistenceDegraded = true;
			return false;
		}
		const artifact = runMarkerArtifact(state.planSlug, state.runId);
		const markerPath = resolveRunMarkerPath(options, artifact);
		const pointerPath = resolveRunMarkerPath(options, activePointerArtifact(state.planSlug));
		if (!markerPath || !pointerPath) return false;
		const now = Date.now();
		const marker: RunMarker = {
			version: 2,
			runId: state.runId,
			planSlug: state.planSlug,
			planArtifact: state.planArtifact,
			planDigest: state.planDigest,
			status,
			updatedAt: now,
			phaseStartedAt: state.phaseStartedAt ?? now,
			scoutCalls: state.scoutCalls,
			startedAt: state.startedAt,
			handoffStatus: state.handoffStatus,
			handoffWarnings: state.handoffWarnings,
			stats: state.stats,
			lspProbeStatus: state.lspProbeStatus,
		};
		const pointer: ActiveRunPointer = {
			version: 1,
			runId: state.runId,
			markerArtifact: artifact,
			planArtifact: state.planArtifact,
			status,
			updatedAt: now,
		};
		state.runMarkerArtifact = artifact;
		state.runMarkerStatus = status;
		try {
			if (status === "awaiting_approval") {
				await writeJsonAtomically(markerPath, marker);
				await writeJsonAtomically(pointerPath, pointer);
			} else {
				await writeJsonAtomically(pointerPath, pointer);
				await writeJsonAtomically(markerPath, marker);
			}
			return true;
		} catch {
			state.persistenceDegraded = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"LeanFlow: workflow state persistence degraded; this approved session may continue, but future fresh-session recovery is unavailable.",
					"warning",
				);
			}
			return false;
		}
	}


	async function lookupFreshRecovery(ctx: ExtensionContext, approvedArtifact: string): Promise<FreshRecoveryLookup> {
		const options = ctx.localProtocolOptions;
		if (!options) return { kind: "none" };
		const slug = planSlugFromArtifact(approvedArtifact);
		const pointerPath = resolveRunMarkerPath(options, activePointerArtifact(slug));
		if (!pointerPath) return { kind: "none" };
		let rawPointer: unknown;
		try {
			rawPointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
		} catch (error) {
			const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!missing) return { kind: "invalid", reason: "corrupt active pointer" };
			const runsPath = resolveRunMarkerPath(options, "local://.leanflow/runs");
			if (!runsPath) return { kind: "invalid", reason: "invalid active marker directory" };
			try {
				const names = await fs.readdir(runsPath);
				let activeMatches = 0;
				for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
					try {
						const candidate: unknown = JSON.parse(await fs.readFile(path.join(runsPath, name), "utf8"));
						if (
							isRunMarker(candidate, approvedArtifact) &&
							candidate.planSlug === slug &&
							name === `${candidate.runId}.json`
						) {
							activeMatches++;
						}
					} catch {
						// Corrupt and expired orphan markers cannot claim an ordinary approval.
					}
				}
				if (activeMatches === 0) return { kind: "none" };
				return {
					kind: "invalid",
					reason: activeMatches > 1 ? "multiple active marker candidates" : "orphan active marker",
				};
			} catch (scanError) {
				const noRuns =
					typeof scanError === "object" &&
					scanError !== null &&
					"code" in scanError &&
					scanError.code === "ENOENT";
				return noRuns
					? { kind: "none" }
					: { kind: "invalid", reason: "unreadable active marker directory" };
			}
		}
		if (!rawPointer || typeof rawPointer !== "object" || Array.isArray(rawPointer)) {
			return { kind: "invalid", reason: "invalid active pointer shape" };
		}
		const pointer = rawPointer as Partial<ActiveRunPointer>;
		if (
			pointer.status === "completed" ||
			pointer.status === "failed" ||
			pointer.status === "abandoned" ||
			pointer.status === "invalidated"
		) {
			return { kind: "none" };
		}
		if (pointer.status !== "awaiting_approval") {
			return { kind: "invalid", pointer, reason: "invalid active pointer status" };
		}
		if (pointer.planArtifact !== approvedArtifact) {
			return { kind: "invalid", pointer, reason: "active pointer plan artifact mismatch" };
		}
		if (
			pointer.version !== 1 ||
			typeof pointer.runId !== "string" ||
			!RUN_ID_PATTERN.test(pointer.runId) ||
			pointer.markerArtifact !== runMarkerArtifact(slug, pointer.runId)
		) {
			return { kind: "invalid", pointer, reason: "invalid active pointer identity" };
		}
		const markerPath = resolveRunMarkerPath(options, pointer.markerArtifact);
		if (!markerPath) return { kind: "invalid", pointer, reason: "invalid marker path" };
		try {
			const marker: unknown = JSON.parse(await fs.readFile(markerPath, "utf8"));
			return isRunMarker(marker, approvedArtifact) &&
				marker.runId === pointer.runId &&
				marker.planArtifact === pointer.planArtifact &&
				marker.status === pointer.status
				? { kind: "valid", marker }
				: { kind: "invalid", pointer, reason: "invalid, expired, or mismatched marker" };
		} catch {
			return { kind: "invalid", pointer, reason: "corrupt marker" };
		}
	}

	async function refreshCanonicalPlanState(
		ctx: ExtensionContext,
		reason: "mutation" | "proposal" | "approval" | "recovery",
	): Promise<boolean> {
		const artifact = expectedPlanArtifact(state);
		const options = ctx.localProtocolOptions;
		if (!artifact || !options || !state.runId) return false;
		const filePath = resolveRunMarkerPath(options, artifact);
		if (!filePath) return false;
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf8");
		} catch {
			return false;
		}

		const assessed = assessHandoff(content);
		const identityValid = runIdFromPlan(content) === state.runId;
		const lsp = lspStatusFromPlan(content);
		const warnings = [...assessed.warnings];
		if (!identityValid) {
			warnings.push("Plan must contain exactly one matching `LeanFlow run ID` metadata line outside fenced code.");
		}
		if (lsp.warning) warnings.push(lsp.warning);

		state.planArtifact = artifact;
		state.planDigest = planDigest(content);
		state.handoffStatus = identityValid ? assessed.status : "NEEDS_UPDATE";
		state.handoffWarnings = warnings;
		state.lspProbeStatus = lsp.status;
		state.lspProbeTarget = undefined;

		if (reason === "mutation") {
			state.proposalBoundary = undefined;
			state.proposedPlanArtifact = undefined;
			state.proposedPlanDigest = undefined;
			state.approvedPlanArtifact = undefined;
		}

		if (state.handoffStatus === "NEEDS_UPDATE") {
			state.approvalInvalidated ||= reason === "approval" || reason === "recovery";
			if ((reason === "approval" || reason === "recovery") && state.planSlug) {
				state.approvalRepairBoundary = ctx.sessionManager.getBranch().length;
				if (ctx.hasUI) {
					ctx.ui.setEditorText(
						`/plan Repair the existing LeanFlow plan at local://${state.planSlug}-plan.md in place. Preserve its run ID, fix only the invalid final-plan content, write the same artifact, then re-propose ${state.planSlug}. Do not repeat repository investigation.`,
					);
				}
			}
			transitionPhase(state, "planning");
			await writeRunMarker(ctx, "invalidated");
			persist();
			updateStatus(ctx);
			ctx.ui.notify(formatHandoffNotification({ status: "NEEDS_UPDATE", warnings }), "warning");
			return false;
		}

		state.approvalInvalidated = false;
		if (reason === "mutation") transitionPhase(state, "awaiting_approval");
		const markerWritten = await writeRunMarker(ctx, "awaiting_approval");
		if (!markerWritten && (reason === "mutation" || reason === "proposal")) {
			transitionPhase(state, "planning");
			persist();
			updateStatus(ctx);
			return false;
		}
		persist();
		updateStatus(ctx);
		if (reason === "mutation") {
			ctx.ui.notify(
				`${formatHandoffNotification({ status: state.handoffStatus, warnings })}\nRequest approval by writing \`${state.planSlug}\` to xd://propose.`,
				"info",
			);
		}
		return true;
	}

	/**
	 * Native mode exit alone is ambiguous: the operator can leave plan mode
	 * without approving. Require its post-proposal synthetic developer prompt to
	 * name the exact artifact proposed by this workflow.
	 */
	async function nativeApprovalConfirmed(ctx: ExtensionContext, messages?: readonly unknown[]): Promise<boolean> {
		if (state.phase === "building") return true;
		const artifact = state.proposedPlanArtifact;
		if (state.phase !== "awaiting_approval" || !artifact || state.proposalBoundary === undefined) return false;
		const branch = ctx.sessionManager.getBranch();
		if (!hasPlanModeExitAfter(branch, state.proposalBoundary)) return false;
		const promptArtifact =
			messages?.reduceRight<string | undefined>((match, message) => match ?? approvedPlanArtifact(message), undefined) ??
			approvedArtifactAfter(branch, state.proposalBoundary);
		if (promptArtifact !== artifact) return false;
		if (!(await refreshCanonicalPlanState(ctx, "approval"))) return false;

		state.approvedPlanArtifact = artifact;
		state.proposedPlanDigest = state.planDigest;
		transitionPhase(state, "building");
		state.writtenArtifacts = [];
		await writeRunMarker(ctx, "building");
		persist();
		return true;
	}

	async function lockFreshRecovery(
		ctx: ExtensionContext,
		artifact: string,
		lookup: Extract<FreshRecoveryLookup, { kind: "invalid" }>,
	): Promise<void> {
		const now = Date.now();
		const slug = planSlugFromArtifact(artifact);
		const pointerRunId = lookup.pointer?.runId;
		const runId = typeof pointerRunId === "string" && RUN_ID_PATTERN.test(pointerRunId) ? pointerRunId : randomUUID();
		let content = "";
		const planPath = ctx.localProtocolOptions ? resolveRunMarkerPath(ctx.localProtocolOptions, artifact) : undefined;
		if (planPath) {
			try {
				content = await fs.readFile(planPath, "utf8");
			} catch {
				// The locked repair prompt will require restoring the canonical plan.
			}
		}
		state = {
			phase: "planning",
			phaseStartedAt: now,
			runId,
			scoutCalls: 0,
			gateCalls: 0,
			gateAttempt: 0,
			planSlug: slug,
			planArtifact: artifact,
			planDigest: planDigest(content),
			startedAt: now,
			handoffStatus: "NEEDS_UPDATE",
			handoffWarnings: [`Fresh approval recovery locked: ${lookup.reason}.`],
			lspProbeStatus: "pending",
			approvalInvalidated: true,
			approvalRepairBoundary: ctx.sessionManager.getBranch().length,
			stats: defaultStats(),
		};
		await writeRunMarker(ctx, "invalidated");
		persist();
		updateStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.setEditorText(
				`/plan Repair the existing LeanFlow plan at ${artifact} in place. Restore exactly one LeanFlow run ID (${runId}), repair its metadata/content, write the same artifact, then re-propose ${slug}. Do not repeat repository investigation.`,
			);
		}
	}

	/** Recover only a marked LeanFlow run after Approve-and-execute creates a fresh session. */
	async function recoverFreshApprovedPlan(ctx: ExtensionContext, messages: readonly unknown[]): Promise<boolean> {
		if (hasPersistedLeanFlowState || state.phase !== "idle") return false;
		const artifact = messages.reduceRight<string | undefined>(
			(match, message) => match ?? approvedPlanArtifact(message),
			undefined,
		);
		if (!artifact) return false;
		const lookup = await lookupFreshRecovery(ctx, artifact);
		if (lookup.kind === "none") return false;
		if (lookup.kind === "invalid") {
			await lockFreshRecovery(ctx, artifact, lookup);
			return true;
		}
		const marker = lookup.marker;

		const now = Date.now();
		state = restoreState([
			{
				type: "custom",
				customType: CUSTOM_TYPE,
				data: {
					phase: "awaiting_approval",
					phaseStartedAt: marker.phaseStartedAt,
					runId: marker.runId,
					scoutCalls: marker.scoutCalls,
					gateCalls: 0,
					gateAttempt: 0,
					planSlug: marker.planSlug,
					planArtifact: marker.planArtifact,
					planDigest: marker.planDigest,
					proposedPlanDigest: marker.planDigest,
					proposedPlanArtifact: marker.planArtifact,
					approvedPlanArtifact: undefined,
					runMarkerArtifact: runMarkerArtifact(marker.planSlug, marker.runId),
					runMarkerStatus: marker.status,
					lspProbeStatus: marker.lspProbeStatus,
					startedAt: marker.startedAt,
					handoffStatus: marker.handoffStatus,
					handoffWarnings: marker.handoffWarnings,
					stats: marker.stats,
					writtenArtifacts: [],
				},
			},
		]);
		if (!(await refreshCanonicalPlanState(ctx, "recovery"))) return true;
		state.approvedPlanArtifact = marker.planArtifact;
		state.proposedPlanDigest = state.planDigest;
		transitionPhase(state, "building", now);
		await writeRunMarker(ctx, "building");
		persist();
		return true;
	}

	async function finishGateResult(
		verdict: "PASS" | "FAIL" | undefined,
		isError: boolean,
		ctx: ExtensionContext,
	): Promise<void> {
		const retryAvailable = state.gateCalls < 2;
		if (verdict === "PASS") {
			const followedImplementationRepair = state.gateRetryMode === "repair";
			state.gateRetryMode = undefined;
			state.terminalOutcome = "pass";
			recordStats(() => recordGatePass(state, followedImplementationRepair), false);
			transitionPhase(state, "finalizing");
			await writeRunMarker(ctx, "completed");
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: Gate PASS. Finalizing the run.", "info");
			return;
		}

		if (isError || verdict === undefined) {
			recordStats(() => {
				recordGateError(state, false);
				if (!retryAvailable) recordTerminalFailure(state);
			}, false);
			if (retryAvailable) {
				state.gateRetryMode = "operational";
				transitionPhase(state, "building");
				persist();
				updateStatus(ctx);
				ctx.ui.notify("LeanFlow: Gate did not complete. Retry review with unchanged evidence (1 retry left).", "warning");
				return;
			}
			state.gateRetryMode = undefined;
			state.terminalOutcome = "gate_operational_failure";
			transitionPhase(state, "finalizing");
			await writeRunMarker(ctx, "failed");
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: Gate did not complete (2/2). Report the operational failure.", "warning");
			return;
		}

		recordStats(() => {
			recordGateFailure(state, retryAvailable);
			if (!retryAvailable) recordTerminalFailure(state);
		}, false);
		if (retryAvailable) {
			state.gateRetryMode = "repair";
			transitionPhase(state, "building");
			state.writtenArtifacts = [];
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: Gate returned FAIL. Repair, refresh evidence, and re-gate (1 retry left).", "warning");
			return;
		}

		state.gateRetryMode = undefined;
		state.terminalOutcome = "fail_after_retry";
		transitionPhase(state, "finalizing");
		await writeRunMarker(ctx, "failed");
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
		const branch = ctx.sessionManager.getBranch();
		hasPersistedLeanFlowState = hasPersistedState(branch);
		state = restoreState(branch);
		pendingPlanRefreshes.clear();
		pendingLspProbes.clear();
		pendingApprovalWrites.clear();
		pendingGateCalls.clear();
		pendingArtifactUpdates.clear();
		resumePhaseTiming(state);
		updateStatus(ctx);
	};
	pi.on("agent_end", async (event, ctx) => {
		if (
			(state.phase === "planning" || state.phase === "awaiting_approval") &&
			pendingPlanRefreshes.size > 0
		) {
			pendingPlanRefreshes.clear();
			await refreshCanonicalPlanState(ctx, "mutation");
		}
		if (
			state.phase === "finalizing" &&
			(typeof event !== "object" || event === null || !("willContinue" in event) || event.willContinue !== true)
		) {
			transitionPhase(state, "idle");
			persist();
			updateStatus(ctx);
		}
	});
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

			if (
				state.runMarkerArtifact &&
				(state.runMarkerStatus === "awaiting_approval" || state.runMarkerStatus === "building")
			) {
				await writeRunMarker(ctx, "abandoned");
			}

			// Initialize state machine and the first observable phase.
			const now = Date.now();
			state = {
				phase: "planning",
				phaseStartedAt: now,
				scoutCalls: 0,
				runId: randomUUID(),
				gateCalls: 0,
				gateAttempt: 0,
				lspProbeStatus: "pending",
				planSlug: slug,
				startedAt: now,
				stats: defaultStats(),
			};
			persist();
			updateStatus(ctx);

			// Enter native plan mode with a Planner-only prompt.
			const prompt = buildPlanningPrompt(task, slug, state.runId!);
			ctx.ui.setEditorText(`/plan ${prompt}`);
		},
	});

	// -----------------------------------------------------------------------
	// Tool guard + phase transitions (pre-execution)
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "idle") return;
		if (state.phase === "finalizing") {
			return {
				block: true,
				reason: "LeanFlow: no tools are allowed while producing the terminal response.",
			};
		}

		const canonicalPlanArtifact = expectedPlanArtifact(state);
		const canonicalPlanMutation =
			canonicalPlanArtifact !== undefined && toolTargetsPath(ctx, event, canonicalPlanArtifact);

		if (targetsReservedLeanFlowState(ctx, event)) {
			return {
				block: true,
				reason: "LeanFlow: internal workflow state artifacts are extension-owned.",
			};
		}

		const approvalConfirmed =
			state.phase === "building" || (state.phase === "awaiting_approval" && (await nativeApprovalConfirmed(ctx)));

		if (
			canonicalPlanMutation &&
			(state.phase === "building" || state.phase === "gating")
		) {
			return {
				block: true,
				reason: "LeanFlow: the approved canonical plan is immutable after BUILD begins.",
			};
		}
		let roles: LeanFlowAgentRole[] = [];
		if (isTaskToolCall(event)) {
			const guard = checkTaskGuard(state.phase, event.input);
			if (guard.block) return { block: true, reason: guard.reason };
			roles = extractAgentRoles(event.input);
			const budget = checkAgentBudget(state, roles);
			if (budget.block) return { block: true, reason: budget.reason };
		}

		const effect = classifyToolEffect(ctx, event, canonicalPlanArtifact);
		const locked =
			state.phase === "planning" ||
			(state.phase === "awaiting_approval" && !approvalConfirmed) ||
			(state.phase === "building" && state.lspProbeStatus === "pending");
		const planningScout =
			state.phase === "planning" && isTaskToolCall(event) && roles.length > 0 && roles.every((role) => role === "scout");
		const allowedWhileLocked =
			effect === "read_only" ||
			((state.phase === "planning" || state.phase === "awaiting_approval") &&
				effect === "canonical_plan_mutation") ||
			(state.phase === "awaiting_approval" && isProposalWrite(event)) ||
			planningScout;
		if (locked && !allowedWhileLocked) {
			return {
				block: true,
				reason:
					state.phase === "building"
						? "LeanFlow: only read-only tools and a valid LSP diagnostics probe are allowed before the first BUILD mutation."
						: "LeanFlow: this tool or operation is not explicitly read-only before native plan approval.",
			};
		}


		if (isTaskToolCall(event)) {
			const scoutCount = roles.filter((role) => role === "scout").length;
			const gateCount = roles.filter((role) => role === "gate").length;
			if (gateCount > 0) {
				const missing = missingArtifacts(state);
				if (missing.length > 0) {
					recordStats(() => recordGateReadinessBlock(state));
					return {
						block: true,
						reason: `LeanFlow: Gate unavailable — complete build evidence first (missing: ${missing.join(", ")}).`,
					};
				}
			}
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

		if (
			canonicalPlanMutation &&
			(state.phase === "planning" || (state.phase === "awaiting_approval" && !approvalConfirmed))
		) {
			pendingPlanRefreshes.add(event.toolCallId);
		}

		const diagnosticsTarget = lspDiagnosticsTarget(event);
		if (
			state.phase === "building" &&
			state.lspProbeStatus === "pending" &&
			diagnosticsTarget !== undefined &&
			(await isUsableLspTarget(ctx, diagnosticsTarget))
		) {
			pendingLspProbes.set(event.toolCallId, diagnosticsTarget);
		}

		if (isProposalWrite(event)) {
			if (state.phase !== "awaiting_approval" || approvalConfirmed) {
				return {
					block: true,
					reason: "LeanFlow: approval is only allowed after the current canonical plan passes handoff assessment.",
				};
			}
			if (
				state.approvalRepairBoundary !== undefined &&
				!hasPlanModeEntryAfter(ctx.sessionManager.getBranch(), state.approvalRepairBoundary)
			) {
				return {
					block: true,
					reason: "LeanFlow: re-enter native plan mode for the queued local repair before requesting approval again.",
				};
			}
			if (pendingPlanRefreshes.size > 0) {
				return {
					block: true,
					reason: "LeanFlow: wait for the canonical plan mutation to finish before proposing.",
				};
			}
			const expected = state.planArtifact ?? canonicalPlanArtifact;
			const lookup = expected ? await lookupFreshRecovery(ctx, expected) : { kind: "none" as const };
			if (
				!expected ||
				event.input.content.trim() !== state.planSlug ||
				!state.runId ||
				lookup.kind !== "valid"
			) {
				return {
					block: true,
					reason: "LeanFlow: write the canonical plan and durable run marker before proposing its exact slug.",
				};
			}
			if (!(await refreshCanonicalPlanState(ctx, "proposal"))) {
				return {
					block: true,
					reason: "LeanFlow: the current canonical plan is invalid; repair it before requesting approval.",
				};
			}
			pendingApprovalWrites.set(event.toolCallId, expected);
		}

		if (state.phase === "building") {
			const kinds = artifactKindsForEvent(ctx, event, state);
			if (kinds.length > 0) pendingArtifactUpdates.set(event.toolCallId, kinds);
		}
	});

	// -----------------------------------------------------------------------
	// Post-execution: handoff assessment + gate verdict
	// -----------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "write" && pendingApprovalWrites.has(event.toolCallId)) {
			const artifact = pendingApprovalWrites.get(event.toolCallId)!;
			pendingApprovalWrites.delete(event.toolCallId);
			if (event.isError) return;
			state.proposalBoundary = ctx.sessionManager.getBranch().length;
			state.proposedPlanArtifact = artifact;
			state.approvalRepairBoundary = undefined;
			state.approvedPlanArtifact = undefined;
			state.proposedPlanDigest = state.planDigest;
			state.lspProbeTarget = undefined;
			await writeRunMarker(ctx, "awaiting_approval");
			persist();
			updateStatus(ctx);
			return;
		}

		if (event.toolName === "write" && pendingLspProbes.has(event.toolCallId)) {
			const target = pendingLspProbes.get(event.toolCallId)!;
			pendingLspProbes.delete(event.toolCallId);
			state.lspProbeStatus = "completed";
			state.lspProbeTarget = target;
			persist();
			updateStatus(ctx);
			return;
		}

		if (pendingPlanRefreshes.has(event.toolCallId)) {
			pendingPlanRefreshes.delete(event.toolCallId);
			if (event.isError) return;
			await refreshCanonicalPlanState(ctx, "mutation");
			return;
		}

		if (pendingArtifactUpdates.has(event.toolCallId)) {
			const kinds = pendingArtifactUpdates.get(event.toolCallId)!;
			pendingArtifactUpdates.delete(event.toolCallId);
			if (event.isError) return;
			const written = new Set(state.writtenArtifacts ?? []);
			for (const kind of kinds) written.add(kind);
			state.writtenArtifacts = [...written];
			persist();
			return;
		}

		if (event.toolName === "task" && pendingGateCalls.has(event.toolCallId)) {
			pendingGateCalls.delete(event.toolCallId);
			await finishGateResult(event.isError ? undefined : extractVerdict(event.content), event.isError, ctx);
			return;
		}
	});

	// -----------------------------------------------------------------------
	// Context filter: remove planning history from builder context
	// -----------------------------------------------------------------------

	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		const recovered = await recoverFreshApprovedPlan(ctx, messages);
		if (recovered) updateStatus(ctx);
		if (state.phase === "awaiting_approval" && !recovered && !(await nativeApprovalConfirmed(ctx, messages))) return;
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

	pi.registerCommand("flowcancel", {
		description: "Cancel the active LeanFlow run and invalidate its recovery marker.",
		handler: async (_args, ctx) => {
			if (state.phase === "idle") {
				ctx.ui.notify("LeanFlow: no active run to cancel.", "warning");
				return;
			}
			if (state.runMarkerStatus === "awaiting_approval" || state.runMarkerStatus === "building") {
				await writeRunMarker(ctx, "abandoned");
			}
			transitionPhase(state, "idle");
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: run cancelled and recovery marker abandoned.", "info");
		},
	});

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
// Build-evidence artifact tracking (gate readiness)
// ---------------------------------------------------------------------------

/** The three evidence artifacts Gate requires, keyed by path suffix. */
const REQUIRED_ARTIFACTS = ["build", "diff", "evidence"] as const;


/** Canonical evidence artifacts targeted by a successful write or edit. */
function artifactKindsForEvent(ctx: ExtensionContext, event: ToolCallEvent, state: LeanFlowState): string[] {
	if (event.toolName !== "write" && event.toolName !== "edit") return [];
	const kinds = new Set<string>();
	for (const candidate of toolTargets(event)) {
		const kind = artifactKind(ctx, candidate, state);
		if (kind) kinds.add(kind);
	}
	return [...kinds];
}

/** Classify only this run's canonical evidence artifacts. */
function artifactKind(ctx: ExtensionContext, rawTarget: string, state: LeanFlowState): string | undefined {
	if (!state.planSlug) return undefined;
	const candidate = resolveLeanFlowTarget(ctx, rawTarget);
	if (!candidate) return undefined;
	for (const kind of REQUIRED_ARTIFACTS) {
		const expected = resolveLeanFlowTarget(ctx, `local://${state.planSlug}-${kind}.md`);
		if (expected !== undefined && candidate === expected) return kind;
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

function buildPlanningPrompt(task: string, slug: string, runId: string): string {
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
		`Include exactly one identity line outside fenced code: \`LeanFlow run ID: ${runId}\`. Approval is blocked if it is missing, duplicated, or changed.`,
		"Include exactly one metadata line outside fenced code: `LSP applicability: required` for source/code changes, or `LSP applicability: not_required` only for documentation, static resources, or other changes with no serviceable source path. Missing, duplicated, or invalid metadata fails safe as required.",
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
