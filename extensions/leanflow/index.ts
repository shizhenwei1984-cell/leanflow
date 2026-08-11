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
 *   Gate PASS                      → finalizing → idle
 *   Gate 2nd valid FAIL            → awaiting_human → building (via /flowcontinue)
 *   Gate 1st valid FAIL            → repair_preparing → building (repair record ready)
 *                          ↘ awaiting_human (repair record failed)
 *   Gate BLOCKED                   → building (evidence recovery)
 *   Gate operational error ×4 (per-cycle) → awaiting_human
 *
 * The critical correctness property: a successful proposal is not approval.
 * BUILD begins only when OMP's synthetic approval prompt names the exact plan
 * artifact that LeanFlow proposed. The Builder must then complete diagnostics
 * before its first repository mutation.
 *
 * State persists via appendEntry and restores from the session branch,
 * surviving compaction and session switches. Gate leases retain planDigest +
 * snapshotDigest + buildRecordRound as durable correlation for settlement.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { approvedPlanArtifact, filterForBuilder } from "./context";
import {
	composeCompleteDiff,
	createBuildEvidenceRecord,
	migrateBuildEvidenceRecord,
	parseBuildEvidenceRecord,
	parseBuildEvidenceRecordWithoutRound,
	renderBuildArtifacts,
	selectValidationObservations,
	validationSemanticStates,
} from "./evidence";
import type {
	BuildEvidenceObservationV3,
	BuildEvidenceRecordV3,
	BuildRecordIdentity,
	GitCommandEvidence,
	ParsedLspRequest,
	UntrackedPatch,
} from "./evidence";
import {
	createFinalizedGateSnapshot,
	createOperationalRetrySnapshot,
	finalizedGateSnapshotDigest,
	parseFinalizedGateSnapshot,
} from "./provenance";
import type { FinalizedGateSnapshot, OperationalInterruption } from "./provenance";
import { CUSTOM_TYPE, STATE_VERSION, createRepairLease, defaultState, defaultStats, hasPersistedState, restoreState } from "./state";
import type { BlockedReasonCode, GateOutcome, LeanFlowState, RepositoryFingerprint } from "./state";
import { checkInvariants, reduceGate, resetBlockedRecovery } from "./machine";
import type { Effect, SnapshotFailureKind } from "./machine";
import {
	canCommitOperation,
	createControlOperationIdentity,
	isControlOperationContinuationCurrent,
	isControlOperationCurrent,
	PendingOperationRegistry,
} from "./control-operation";
import type { ActiveControlAuthority, ControlOperationIdentity } from "./control-operation";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles, validateGateTaskCall } from "./guard";
import type { GateArtifacts, LeanFlowAgentRole } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
import { createApprovedValidationContract, parseValidationContract, validationStatesDigest } from "./validation";
import {
	addUsage,
	formatStats,
	recordContextFilter,
	recordGateReadinessBlock,
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
	handoffBlockers?: string[];
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}
function isLeanFlowInternalRepositoryPath(relative: string): boolean {
	return relative === ".leanflow" || relative.startsWith(".leanflow/");
}


function isTaskToolCall(event: ToolCallEvent): event is ToolCallEvent & { input: Record<string, unknown>; toolName: "task" } {
	return event.toolName === "task" && isPlainRecord(event.input);
}

function isFinalizingTodoCompletion(event: ToolCallEvent): boolean {
	if (event.toolName !== "todo" || !isPlainRecord(event.input)) return false;
	const keys = Object.keys(event.input);
	return (
		keys.length === 2 &&
		keys.includes("op") &&
		keys.includes("task") &&
		"op" in event.input &&
		event.input.op === "done" &&
		"task" in event.input &&
		typeof event.input.task === "string" &&
		event.input.task.trim().length > 0
	);
}

function buildHumanRepairPrompt(runId: string | undefined, findings: string | undefined, note: string): string {
	const findingsSummary =
		findings === undefined
			? "(No persisted Gate findings were available.)"
			: findings.length <= 1_500
				? findings
				: `${findings.slice(0, 1_499)}…`;
	return [
		`Continue LeanFlow run ${runId ?? "unknown"} after Gate FAIL.`,
		`Read the previous findings: ${findingsSummary}`,
		`User note: ${note.trim() || "(none)"}`,
		"Repair, re-validate, re-finalize artifacts, then re-gate.",
		"Scope beyond the approved plan requires a new /flow run.",
	].join("\n");
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
const CAPTURE_BASELINE_DEVICE_PATH = "xd://leanflow_capture_baseline";
const RUN_VALIDATION_DEVICE_PATH = "xd://leanflow_run_validation";
const FINALIZE_ARTIFACTS_DEVICE_PATH = "xd://leanflow_finalize_artifacts";
type RoutedLeanFlowDeviceCall = "capture_baseline" | "run_validation" | "finalize_artifacts" | "invalid";

function routedLeanFlowDeviceCall(event: ToolCallEvent): RoutedLeanFlowDeviceCall | undefined {
	if (
		!isWriteToolCall(event) ||
		(event.input.path !== CAPTURE_BASELINE_DEVICE_PATH &&
			event.input.path !== RUN_VALIDATION_DEVICE_PATH &&
			event.input.path !== FINALIZE_ARTIFACTS_DEVICE_PATH)
	) {
		return undefined;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(event.input.content);
	} catch {
		return "invalid";
	}
	if (!isPlainRecord(payload)) return "invalid";
	if (event.input.path === CAPTURE_BASELINE_DEVICE_PATH) {
		return Object.keys(payload).length === 0 ? "capture_baseline" : "invalid";
	}
	if (event.input.path === FINALIZE_ARTIFACTS_DEVICE_PATH) {
		return Object.keys(payload).length === 0 ? "finalize_artifacts" : "invalid";
	}
	return Object.keys(payload).length === 1 &&
		typeof payload.validationId === "string" &&
		payload.validationId.trim().length > 0
		? "run_validation"
		: "invalid";
}


function lspInput(event: ToolCallEvent): Record<string, unknown> | undefined {
	if (event.toolName === "lsp") return isPlainRecord(event.input) ? event.input : undefined;
	if (!isWriteToolCall(event) || event.input.path !== "xd://lsp") return undefined;
	try {
		const input: unknown = JSON.parse(event.input.content);
		return isPlainRecord(input) ? input : undefined;
	} catch {
		return undefined;
	}
}

function parseLspObservationRequest(event: ToolCallEvent): ParsedLspRequest | undefined {
	const input = lspInput(event);
	if (input === undefined || typeof input.action !== "string" || input.action.length === 0) return undefined;
	const request: ParsedLspRequest = { action: input.action };
	if ("file" in input) {
		if (typeof input.file !== "string") return undefined;
		request.file = input.file;
	}
	if ("line" in input) {
		if (typeof input.line !== "number" || !Number.isFinite(input.line) || !Number.isInteger(input.line)) return undefined;
		request.line = input.line;
	}
	if ("symbol" in input) {
		if (typeof input.symbol !== "string") return undefined;
		request.symbol = input.symbol;
	}
	if ("query" in input) {
		if (typeof input.query !== "string") return undefined;
		request.query = input.query;
	}
	if ("new_name" in input) {
		if (typeof input.new_name !== "string") return undefined;
		request.new_name = input.new_name;
	}
	if ("apply" in input) {
		if (typeof input.apply !== "boolean") return undefined;
		request.apply = input.apply;
	}
	if ("timeout" in input) {
		if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout)) return undefined;
		request.timeout = input.timeout;
	}
	if ("payload" in input) {
		if (typeof input.payload !== "string") return undefined;
		request.payload = input.payload;
	}
	return request;
}

function lspDiagnosticsTarget(event: ToolCallEvent): string | undefined {
	const request = parseLspObservationRequest(event);
	if (request?.action !== "diagnostics" || typeof request.file !== "string") return undefined;
	const target = request.file.trim();
	if (!target) return undefined;
	if (target === "*") return target;
	if (target.includes("\0") || path.isAbsolute(target)) return undefined;
	const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
	return normalized;
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

function issueReportContent(event: ToolCallEvent): string | undefined {
	let content: string;
	if (event.toolName === "report_issue" && isPlainRecord(event.input) && typeof event.input.report === "string") {
		content = event.input.report;
	} else if (isWriteToolCall(event) && event.input.path === "xd://report_issue") {
		content = event.input.content;
	} else {
		return undefined;
	}
	return content.trim().length > 0 ? content : undefined;
}

function expectedPlanArtifact(state: LeanFlowState): string | undefined {
	return state.planSlug ? `local://${state.planSlug}-plan.md` : undefined;
}

function expectedGateArtifacts(state: LeanFlowState): GateArtifacts | undefined {
	if (!state.planSlug) return undefined;
	const prefix = `local://${state.planSlug}`;
	return {
		plan: `${prefix}-plan.md`,
		build: `${prefix}-build.md`,
		diff: `${prefix}-diff.md`,
		evidence: `${prefix}-evidence.md`,
	};
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
	routedDeviceCall: RoutedLeanFlowDeviceCall | undefined,
	issueReport: boolean,
): ToolEffect {
	if (READ_ONLY_TOOLS.has(event.toolName)) return "read_only";
	const lspInvocation = event.toolName === "lsp" || (isWriteToolCall(event) && event.input.path === "xd://lsp");
	if (lspInvocation) {
		const request = parseLspObservationRequest(event);
		if (request?.action === "diagnostics" && lspDiagnosticsTarget(event) === undefined) {
			return "control_plane_mutation";
		}
		return request !== undefined && LSP_READ_ONLY_ACTIONS.has(request.action)
			? "read_only"
			: "control_plane_mutation";
	}
	if (issueReport) return "control_plane_mutation";
	if (
		event.toolName === "leanflow_capture_baseline" ||
		event.toolName === "leanflow_run_validation" ||
		event.toolName === "leanflow_finalize_artifacts" ||
		routedDeviceCall === "capture_baseline" ||
		routedDeviceCall === "run_validation" ||
		routedDeviceCall === "finalize_artifacts"
	) {
		return "control_plane_mutation";
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

function buildRecordArtifact(runId: string): string {
	return `local://.leanflow/runs/${runId}-build-record.json`;
}
function finalizedSnapshotArtifact(runId: string): string {
	return `local://.leanflow/runs/${runId}-finalized-gate.json`;
}


function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function activePointerArtifact(planSlug: string): string {
	return `local://.leanflow/active/${sha256Hex(planSlug)}.json`;
}

function legacyActivePointerArtifact(planSlug: string): string {
	return `local://.leanflow/active/${encodeURIComponent(planSlug)}.json`;
}

function taskSlug(task: string): string {
	const stem =
		task
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 30)
			.replace(/-+$/g, "") || "task";
	return `${stem}-${sha256Hex(task).slice(0, 8)}`;
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
	return sha256Hex(content);
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
const DIRECTORY_SYNC_UNSUPPORTED_CODES: Record<string, true> = {
	EINVAL: true,
	ENOTSUP: true,
	EOPNOTSUPP: true,
	ENOSYS: true,
	EPERM: true,
};


function syncParentDirectoryBestEffortSync(filePath: string): void {
	if (process.platform === "win32") return;
	let descriptor: number | undefined;
	try {
		descriptor = fsSync.openSync(path.dirname(filePath), "r");
		fsSync.fsyncSync(descriptor);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (typeof code === "string" && DIRECTORY_SYNC_UNSUPPORTED_CODES[code] === true) return;
		throw error;
	} finally {
		if (descriptor !== undefined) fsSync.closeSync(descriptor);
	}
}

let atomicPublicationAfterCloseHook: ((filePath: string) => Promise<void>) | undefined;

/** Test-only seam: pauses after close and before the final authority check. */
export function setAtomicPublicationAfterCloseHookForTest(hook: ((filePath: string) => Promise<void>) | undefined): void {
	atomicPublicationAfterCloseHook = hook;
}

async function writeTextAtomically(
	filePath: string,
	content: string,
	isCurrent?: () => boolean,
): Promise<boolean> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	if (isCurrent && !isCurrent()) return false;
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		const handle = await fs.open(temporary, "wx");
		let staged = true;
		try {
			await handle.writeFile(content, "utf8");
			staged = !isCurrent || isCurrent();
			if (staged) {
				await handle.sync();
				staged = !isCurrent || isCurrent();
			}
		} finally {
			await handle.close();
		}
		if (atomicPublicationAfterCloseHook) await atomicPublicationAfterCloseHook(filePath);
		if (!staged || (isCurrent && !isCurrent())) {
			await fs.rm(temporary, { force: true });
			return false;
		}
		// The final authority check and publication are synchronous: a stale
		// asynchronous control operation cannot publish after replacement.
		fsSync.renameSync(temporary, filePath);
		syncParentDirectoryBestEffortSync(filePath);
		return true;
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function writeJsonAtomically(
	filePath: string,
	value: unknown,
	isCurrent?: () => boolean,
): Promise<boolean> {
	return writeTextAtomically(filePath, JSON.stringify(value), isCurrent);
}

let buildPublicationStageHook: ((filePath: string) => Promise<void>) | undefined;

/** Test-only seam: pauses after staging and before the final synchronous publication check. */
export function setBuildPublicationStageHookForTest(hook: ((filePath: string) => Promise<void>) | undefined): void {
	buildPublicationStageHook = hook;
}

let restoreSessionHook: (() => Promise<void>) | undefined;

/** Test-only seam: pauses one serialized restoration inside its critical section. */
export function setRestoreSessionHookForTest(hook: (() => Promise<void>) | undefined): void {
	restoreSessionHook = hook;
}

let freshRecoveryLookupHook: (() => Promise<void>) | undefined;

/** Test-only seam: pauses an idle fresh-recovery lookup before it can claim state. */
export function setFreshRecoveryLookupHookForTest(hook: (() => Promise<void>) | undefined): void {
	freshRecoveryLookupHook = hook;
}

let gatePreflightHook: (() => Promise<void>) | undefined;

/** Test-only seam: pauses Gate preflight after authority capture. */
export function setGatePreflightHookForTest(hook: (() => Promise<void>) | undefined): void {
	gatePreflightHook = hook;
}

let repairSetupReadHook: (() => Promise<void>) | undefined;

/** Test-only seam: pauses repair setup after its immutable record read. */
export function setRepairSetupReadHookForTest(hook: (() => Promise<void>) | undefined): void {
	repairSetupReadHook = hook;
}

let proposalLookupHook: (() => Promise<void>) | undefined;

/** Test-only seam: pauses proposal preflight after authority capture. */
export function setProposalLookupHookForTest(hook: (() => Promise<void>) | undefined): void {
	proposalLookupHook = hook;
}

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();
	let hasPersistedLeanFlowState = false;
	let restoreTail = Promise.resolve();
	// toolCallId is transport correlation only. Every asynchronous control
	// callback obtains immutable authority from this registry before it can
	const pendingControlOperations = new PendingOperationRegistry<PendingControlPayload>();
	type PendingControlPayload = {
		artifact?: string;
		lspTarget?: string;
		snapshotDigest?: string;
	};
	type BuildOperationIdentity = Readonly<
		BuildRecordIdentity & {
			operationId: string;
			activationEpoch: number;
			sessionId: string;
			branchId?: string;
			recordPath: string;
		}
	>;
	type FinalizationOperation = Readonly<
		BuildOperationIdentity & {
			planArtifact: string;
			planPath: string;
			finalizedSnapshotPath: string;
			buildPath: string;
			diffPath: string;
			evidencePath: string;
			validationContract: NonNullable<LeanFlowState["approvedValidationContract"]>;
		}
	>;
	type PendingEvidenceObservation =
		| { identity: BuildOperationIdentity; toolName: "bash"; command: string }
		| { identity: BuildOperationIdentity; toolName: "lsp"; lspRequest: ParsedLspRequest };
	const pendingEvidenceObservations = new Map<string, PendingEvidenceObservation>();
	const buildRecordLockTails = new Map<string, Promise<void>>();
	const validationAbortControllers = new Map<string, AbortController>();
	let activationEpoch = 1;

	function queueKey(identity: BuildOperationIdentity): string {
		return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.round}\u0000${identity.activationEpoch}`;
	}

	async function acquireBuildRecordLock(identity: BuildOperationIdentity): Promise<() => void> {
		const key = queueKey(identity);
		const previous = buildRecordLockTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		buildRecordLockTails.set(key, tail);
		await previous;
		return () => {
			release();
			if (buildRecordLockTails.get(key) === tail) buildRecordLockTails.delete(key);
		};
	}

	function invalidateControlOperations(_reason: string): void {
		const previousEpoch = activationEpoch;
		const previousRunId = state.runId;
		activationEpoch += 1;
		pendingControlOperations.invalidateEpoch(previousEpoch);
		if (previousRunId) pendingControlOperations.invalidateRun(previousRunId);
		pendingEvidenceObservations.clear();
		for (const controller of validationAbortControllers.values()) controller.abort();
		validationAbortControllers.clear();
		state.controlOperationEpoch = activationEpoch;
	}

	function advanceBuildActivation(): void {
		invalidateControlOperations("activation replacement");
	}

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, state);
		hasPersistedLeanFlowState = true;
	}

	/** Atomically publishes a complete state candidate without exposing it as live authority first. */
	function persistCandidateState(candidate: LeanFlowState): void {
		pi.appendEntry(CUSTOM_TYPE, candidate);
		hasPersistedLeanFlowState = true;
	}
	function branchContainsFinalizationCandidate(ctx: ExtensionContext, candidate: LeanFlowState): boolean {
		if (!candidate.finalizedGateSnapshot || !candidate.finalizationCommitNonce) return false;
		const restored = restoreState(ctx.sessionManager.getBranch());
		return (
			restored.runId === candidate.runId &&
			restored.currentBuildRound === candidate.currentBuildRound &&
			restored.finalizationCommitNonce === candidate.finalizationCommitNonce &&
			restored.finalizedGateSnapshot !== undefined &&
			finalizedGateSnapshotDigest(restored.finalizedGateSnapshot) ===
				finalizedGateSnapshotDigest(candidate.finalizedGateSnapshot)
		);
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

	function setPersistenceFailure(
		ctx: ExtensionContext,
		stage: NonNullable<LeanFlowState["persistenceFailureStage"]>,
		targetPath: string,
		error: unknown,
		codeOverride?: string,
	): void {
		const errorCode =
			typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
				? error.code
				: undefined;
		const code = codeOverride ?? errorCode ?? "UNKNOWN";
		const message = error instanceof Error ? error.message : String(error);
		state.persistenceDegraded = true;
		state.persistenceFailureStage = stage;
		state.persistenceFailurePath = targetPath;
		state.persistenceFailureCode = code;
		state.persistenceFailureMessage = message;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`LeanFlow: workflow state persistence failed during ${stage} write (code: ${code}, path: ${targetPath}): ${message}`,
				"warning",
			);
		}
	}

	function clearPersistenceFailure(): void {
		state.persistenceDegraded = false;
		delete state.persistenceFailureStage;
		delete state.persistenceFailurePath;
		delete state.persistenceFailureCode;
		delete state.persistenceFailureMessage;
	}

	type BuildRecordSetupResult =
		| {
				ok: true;
				round: number;
				baselinePresent: boolean;
				freshRecord: boolean;
				lspEvidencePresent: boolean;
		  }
		| { ok: false; reason: string };

	type RepairOperationIdentity = Readonly<{
		operationId: string;
		controlSessionId: string;
		controlOperationEpoch: number;
		activationEpoch: number;
		transactionId: string;
		runId: string;
		planSlug: string;
		planDigest: string;
		approvedValidationDigest: string;
		fromRound: number;
		toRound: number;
		recordPath: string;
		reason: NonNullable<LeanFlowState["repairLease"]>["reason"];
	}>;

	function captureRepairOperation(ctx: ExtensionContext): RepairOperationIdentity {
		const lease = state.repairLease;
		if (!lease || !state.controlSessionId || state.controlOperationEpoch === undefined) {
			throw new Error("LeanFlow repair operation lacks a durable lease or control authority");
		}
		if (!ctx.localProtocolOptions) throw new Error("LeanFlow repair record path cannot be resolved without local protocol options");
		const recordPath = resolveRunMarkerPath(ctx.localProtocolOptions, lease.recordArtifact);
		if (!recordPath) throw new Error("LeanFlow repair record path cannot be resolved");
		return Object.freeze({
			operationId: randomUUID(),
			controlSessionId: state.controlSessionId,
			controlOperationEpoch: state.controlOperationEpoch,
			activationEpoch,
			transactionId: lease.transactionId,
			runId: lease.runId,
			planSlug: lease.planSlug,
			planDigest: lease.planDigest,
			approvedValidationDigest: lease.approvedValidationDigest,
			fromRound: lease.fromRound,
			toRound: lease.toRound,
			recordPath,
			reason: lease.reason,
		});
	}

	function isRepairOperationCurrent(operation: RepairOperationIdentity): boolean {
		const lease = state.repairLease;
		return (
			operation.controlSessionId === state.controlSessionId &&
			operation.controlOperationEpoch === state.controlOperationEpoch &&
			operation.activationEpoch === activationEpoch &&
			operation.runId === state.runId &&
			operation.planDigest === state.planDigest &&
			operation.approvedValidationDigest === state.approvedValidationDigest &&
			state.phase === "repair_preparing" &&
			lease?.transactionId === operation.transactionId &&
			lease.fromRound === operation.fromRound &&
			lease.toRound === operation.toRound
		);
	}

	function evidenceFailureMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function activeBuildIdentity(round: number): BuildRecordIdentity {
		if (!state.runId || !state.planSlug || !state.planDigest || !state.approvedValidationDigest) {
			throw new Error("active LeanFlow run identity or approved validation contract is incomplete");
		}
		return {
			runId: state.runId,
			planSlug: state.planSlug,
			planDigest: state.planDigest,
			approvedValidationDigest: state.approvedValidationDigest,
			round,
		};
	}

	function buildRecordPathFor(ctx: ExtensionContext, runId: string): string {
		if (!ctx.localProtocolOptions) throw new Error("local protocol options are unavailable");
		const artifact = buildRecordArtifact(runId);
		const recordPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifact);
		if (!recordPath) throw new Error(`internal build record path cannot be resolved: ${artifact}`);
		return recordPath;
	}

	function finalizedSnapshotPathFor(ctx: ExtensionContext, runId: string): string {
		if (!ctx.localProtocolOptions) throw new Error("local protocol options are unavailable");
		const artifact = finalizedSnapshotArtifact(runId);
		const snapshotPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifact);
		if (!snapshotPath) throw new Error(`finalized Gate snapshot path cannot be resolved: ${artifact}`);
		return snapshotPath;
	}

	function buildSessionId(ctx: ExtensionContext): string {
		try {
			const sessionId = (ctx.localProtocolOptions as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
			return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : `activation-${activationEpoch}`;
		} catch {
			return `activation-${activationEpoch}`;
		}
	}

	function controlAuthority(ctx: ExtensionContext): ActiveControlAuthority {
		return {
			sessionId: buildSessionId(ctx),
			runId: state.runId,
			activationEpoch: state.controlOperationEpoch ?? activationEpoch,
			phase: state.phase,
			planDigest: state.planDigest,
		};
	}

	function captureControlOperation(
		ctx: ExtensionContext,
		artifactIdentity?: string,
		operationId?: string,
	): ControlOperationIdentity {
		return createControlOperationIdentity(controlAuthority(ctx), artifactIdentity, operationId);
	}

	function controlOperationIsCurrent(
		ctx: ExtensionContext,
		identity: ControlOperationIdentity,
		artifactIdentity?: string,
	): boolean {
		return (
			canCommitOperation(identity, state) &&
			isControlOperationCurrent(identity, controlAuthority(ctx)) &&
			(artifactIdentity === undefined || identity.artifactIdentity === artifactIdentity)
		);
	}

	function controlOperationContinuationIsCurrent(ctx: ExtensionContext, identity: ControlOperationIdentity): boolean {
		return isControlOperationContinuationCurrent(identity, controlAuthority(ctx));
	}

	function prospectiveRecoveryRunId(ctx: ExtensionContext, artifact: string): string {
		return `prospective:${sha256Hex(`${buildSessionId(ctx)}\u0000${activationEpoch}\u0000${artifact}`)}`;
	}

	function captureFreshRecoveryOperation(ctx: ExtensionContext, artifact: string): ControlOperationIdentity {
		return createControlOperationIdentity(
			{
				...controlAuthority(ctx),
				runId: state.runId ?? prospectiveRecoveryRunId(ctx, artifact),
			},
			artifact,
		);
	}

	function freshRecoveryOperationIsCurrent(
		ctx: ExtensionContext,
		operation: ControlOperationIdentity,
		artifact: string,
	): boolean {
		const prospectiveRunId = prospectiveRecoveryRunId(ctx, artifact);
		return (
			state.runId === undefined &&
			operation.runId === prospectiveRunId &&
			operation.artifactIdentity === artifact &&
			isControlOperationCurrent(operation, { ...controlAuthority(ctx), runId: prospectiveRunId })
		);
	}
	function captureBuildOperationIdentity(ctx: ExtensionContext, round: number): BuildOperationIdentity {
		const identity = activeBuildIdentity(round);
		return Object.freeze({
			...identity,
			operationId: randomUUID(),
			activationEpoch,
			sessionId: buildSessionId(ctx),
			recordPath: buildRecordPathFor(ctx, identity.runId),
		});
	}

	function gateControlOperationIsCurrent(
		ctx: ExtensionContext,
		operation: ControlOperationIdentity,
		toolCallId: string,
	): boolean {
		return (
			controlOperationIsCurrent(ctx, operation, operation.artifactIdentity) &&
			state.phase === "gating" &&
			state.gateLease?.toolCallId === toolCallId &&
			state.gateLease.snapshotDigest === operation.artifactIdentity &&
			state.gateLease.planDigest === operation.planDigest
		);
	}

	function captureFinalizationOperation(ctx: ExtensionContext, round: number): FinalizationOperation {
		const planArtifact = state.planArtifact;
		const validationContract = state.approvedValidationContract;
		if (!planArtifact || !validationContract) {
			throw new Error("active plan artifact or approved validation contract is unavailable");
		}
		const identity = captureBuildOperationIdentity(ctx, round);
		const artifacts = expectedGateArtifacts(state);
		if (!artifacts || !ctx.localProtocolOptions) throw new Error("canonical Gate artifact identity is unavailable");
		const buildPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifacts.build);
		const diffPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifacts.diff);
		const evidencePath = resolveRunMarkerPath(ctx.localProtocolOptions, artifacts.evidence);
		const planPath = resolveRunMarkerPath(ctx.localProtocolOptions, planArtifact);
		if (!buildPath || !diffPath || !evidencePath || !planPath) {
			throw new Error("canonical plan or Gate artifact path cannot be resolved");
		}
		return Object.freeze({
			...identity,
			planArtifact,
			planPath,
			finalizedSnapshotPath: finalizedSnapshotPathFor(ctx, identity.runId),
			buildPath,
			diffPath,
			evidencePath,
			validationContract,
		});
	}

	function isBuildOperationCurrent(ctx: ExtensionContext, identity: BuildOperationIdentity): boolean {
		return (
			identity.activationEpoch === activationEpoch &&
			identity.sessionId === buildSessionId(ctx) &&
			state.phase === "building" &&
			state.runId === identity.runId &&
			state.planSlug === identity.planSlug &&
			state.planDigest === identity.planDigest &&
			state.approvedValidationDigest === identity.approvedValidationDigest &&
			state.currentBuildRound === identity.round
		);
	}

	function discardedBuildOperation(kind: string) {
		return {
			content: [{ type: "text" as const, text: `LeanFlow ${kind} was discarded because BUILD authority changed.` }],
		};
	}

	function activeBuildRecordPath(ctx: ExtensionContext): string {
		if (!state.runId) throw new Error("run ID is unavailable");
		return buildRecordPathFor(ctx, state.runId);
	}

	function activeFinalizedSnapshotPath(ctx: ExtensionContext): string {
		if (!state.runId) throw new Error("run ID is unavailable");
		return finalizedSnapshotPathFor(ctx, state.runId);
	}


	async function writeBuildTextAtomically(
		ctx: ExtensionContext,
		identity: BuildOperationIdentity,
		filePath: string,
		content: string,
	): Promise<boolean> {
		const temporary = `${filePath}.${identity.operationId}.tmp`;
		try {
			const handle = await fs.open(temporary, "w");
			let staged = isBuildOperationCurrent(ctx, identity);
			try {
				if (staged) {
					await handle.writeFile(content, "utf8");
					staged = isBuildOperationCurrent(ctx, identity);
				}
				if (staged) {
					await handle.sync();
					staged = isBuildOperationCurrent(ctx, identity);
				}
			} finally {
				await handle.close();
			}
			if (buildPublicationStageHook) await buildPublicationStageHook(filePath);
			if (!staged || !isBuildOperationCurrent(ctx, identity)) {
				await fs.rm(temporary, { force: true });
				return false;
			}
			// The final authority check and rename are synchronous: no lifecycle
			// activation can interleave and publish an operation after replacement.
			fsSync.renameSync(temporary, filePath);
			syncParentDirectoryBestEffortSync(filePath);
			return true;
		} catch (error) {
			await fs.rm(temporary, { force: true });
			throw error;
		}
	}

	async function writeBuildJsonAtomically(
		ctx: ExtensionContext,
		identity: BuildOperationIdentity,
		filePath: string,
		value: unknown,
	): Promise<boolean> {
		return writeBuildTextAtomically(ctx, identity, filePath, JSON.stringify(value));
	}

	async function readBuildRecordValueAt(recordPath: string): Promise<unknown> {
		try {
			return JSON.parse(await fs.readFile(recordPath, "utf8"));
		} catch (error) {
			throw new Error(`internal build record is missing or unreadable: ${evidenceFailureMessage(error)}`);
		}
	}

	async function loadBuildRecordForIdentity(identity: BuildOperationIdentity): Promise<BuildEvidenceRecordV3> {
		return parseBuildEvidenceRecord(await readBuildRecordValueAt(identity.recordPath), identity);
	}

	async function readBuildRecordValue(ctx: ExtensionContext): Promise<unknown> {
		return readBuildRecordValueAt(activeBuildRecordPath(ctx));
	}

	async function readBuildRecordForReconciliation(ctx: ExtensionContext): Promise<BuildEvidenceRecordV3> {
		const value = await readBuildRecordValue(ctx);
		const identity = activeBuildIdentity(state.currentBuildRound ?? Math.max(1, state.gateAttempt));
		try {
			return parseBuildEvidenceRecordWithoutRound(value, {
				runId: identity.runId,
				planSlug: identity.planSlug,
				planDigest: identity.planDigest,
				approvedValidationDigest: identity.approvedValidationDigest,
			});
		} catch (error) {
			const legacyRound = isPlainRecord(value) && Number.isInteger(value.round) ? (value.round as number) : undefined;
			if (
				value &&
				isPlainRecord(value) &&
				(value.version === 1 || value.version === 2) &&
				legacyRound !== undefined &&
				legacyRound >= 1
			) {
				const migrated = migrateBuildEvidenceRecord(value, activeBuildIdentity(legacyRound));
				await writeJsonAtomically(activeBuildRecordPath(ctx), migrated);
				return migrated;
			}
			throw error;
		}
	}

	function expectedGateRoundForSnapshot(): number {
		if (!Number.isInteger(state.currentBuildRound) || (state.currentBuildRound ?? 0) < 1) {
			throw new Error("current BUILD round is unavailable");
		}
		return state.currentBuildRound!;
	}

	type VerifiedGateSnapshot = {
		manifest: FinalizedGateSnapshot;
		snapshotDigest: string;
		build: string;
		diff: string;
		evidence: string;
		record: BuildEvidenceRecordV3;
		legacyRecordVersion?: 1 | 2;
	};

	type GateSnapshotFailure = {
		ok: false;
		kind: SnapshotFailureKind;
		reason: string;
		/** A structurally valid, fully passed BUILD record can be re-finalized without a new mutation. */
		checkpointRecoverable?: boolean;
	};
	type GatePreparationFailure =
		| GateSnapshotFailure
		| { ok: false; kind: "pending_evidence"; reason: string }
		| { ok: false; kind: "no_semantic_progress"; reason: string };
	type GatePreparation =
		| {
				ok: true;
				snapshotDigest: string;
				planDigest: string;
				buildRecordRound: number;
				repositoryFingerprint: RepositoryFingerprint;
				build: string;
				diff: string;
				evidence: string;
		  }
		| GatePreparationFailure;

	function hasSemanticValidationProgress(
		before: ReadonlyArray<NonNullable<LeanFlowState["blockedRecovery"]>["validationStates"][number]>,
		after: ReadonlyArray<FinalizedGateSnapshot["validationStates"][number]>,
		affectedIds: readonly string[],
	): boolean {
		const previous = new Map(before.map((validation) => [validation.id, validation]));
		const affected = new Set(affectedIds);
		return after.some((validation) => {
			const prior = previous.get(validation.id);
			if (!affected.has(validation.id)) return false;
			return (
				validation.status === "passed" &&
				prior?.status !== "passed" &&
				validation.observationId !== undefined &&
				(prior?.normalizedOutputDigest === undefined ||
					validation.normalizedOutputDigest !== prior.normalizedOutputDigest ||
					prior.repositoryFingerprintAfter === undefined ||
					validation.repositoryFingerprintAfter !== prior.repositoryFingerprintAfter)
			);
		});
	}

	async function verifyDurableFinalizedSnapshot(
		ctx: ExtensionContext,
		lease?: NonNullable<LeanFlowState["gateLease"]>,
		allowLegacyRecord = false,
	): Promise<{ ok: true; value: VerifiedGateSnapshot } | GateSnapshotFailure> {
		if (
			!ctx.localProtocolOptions ||
			!state.runId ||
			!state.planSlug ||
			!state.planDigest ||
			!state.currentBuildRound
		) {
			return { ok: false, kind: "lease_invalid", reason: "active Gate provenance identity is incomplete" };
		}
		if (!state.approvedValidationContract || !state.approvedValidationDigest) {
			return { ok: false, kind: "validation_contract_invalid", reason: "approved validation contract identity is incomplete" };
		}
		try {
			const contract = createApprovedValidationContract(
				state.approvedValidationContract.planDigest,
				state.approvedValidationContract.validations,
			);
			if (
				state.approvedValidationContract.planDigest !== state.planDigest ||
				contract.digest !== state.approvedValidationContract.digest ||
				contract.digest !== state.approvedValidationDigest
			) {
				return {
					ok: false,
					kind: "validation_contract_invalid",
					reason: "approved validation contract does not match the canonical plan",
				};
			}
		} catch (error) {
			return {
				ok: false,
				kind: "validation_contract_invalid",
				reason: `approved validation contract is invalid: ${evidenceFailureMessage(error)}`,
			};
		}
		const artifacts = expectedGateArtifacts(state);
		if (!artifacts) {
			return { ok: false, kind: "artifact_rebuildable", reason: "canonical Gate artifact identity is unavailable" };
		}

		let manifest: FinalizedGateSnapshot;
		let manifestText: string;
		try {
			manifestText = await fs.readFile(activeFinalizedSnapshotPath(ctx), "utf8");
			const parsed = parseFinalizedGateSnapshot(JSON.parse(manifestText));
			if (!parsed) throw new Error("manifest schema or semantic digest is invalid");
			manifest = parsed;
		} catch (error) {
			return {
				ok: false,
				kind: "manifest_missing",
				reason: `finalized Gate manifest is missing or invalid: ${evidenceFailureMessage(error)}`,
			};
		}
		const snapshotDigest = finalizedGateSnapshotDigest(manifest);
		if (
			!state.finalizedGateSnapshot ||
			!state.finalizationCommitNonce ||
			state.finalizationCommitNonce !== manifest.finalizationCommitNonce ||
			finalizedGateSnapshotDigest(state.finalizedGateSnapshot) !== snapshotDigest
		) {
			return {
				ok: false,
				kind: "artifact_rebuildable",
				reason: "persisted finalized Gate manifest does not match state commit binding",
			};
		}
		if (manifest.runId !== state.runId || manifest.planSlug !== state.planSlug || manifest.planDigest !== state.planDigest) {
			return { ok: false, kind: "plan_drift", reason: "finalized Gate manifest does not match the approved plan" };
		}
		if (manifest.approvedValidationDigest !== state.approvedValidationDigest) {
			return {
				ok: false,
				kind: "validation_contract_invalid",
				reason: "finalized Gate manifest does not match the approved validation contract",
			};
		}
		if (manifest.buildRecordRound !== state.currentBuildRound) {
			return { ok: false, kind: "record_invalid", reason: "finalized Gate manifest does not match currentBuildRound" };
		}
		if (
			lease &&
			(lease.runId !== manifest.runId ||
				lease.planDigest !== manifest.planDigest ||
				lease.buildRecordRound !== manifest.buildRecordRound ||
				lease.snapshotDigest !== snapshotDigest ||
				lease.repositoryFingerprint?.combinedDigest !== manifest.repositoryFingerprint.combinedDigest)
		) {
			return { ok: false, kind: "lease_invalid", reason: "Gate lease does not match the durable finalized snapshot" };
		}

		const planPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifacts.plan);
		if (!planPath) return { ok: false, kind: "plan_drift", reason: "canonical plan artifact path cannot be resolved" };
		try {
			if (sha256Hex(await fs.readFile(planPath, "utf8")) !== manifest.planDigest) {
				return { ok: false, kind: "plan_drift", reason: "canonical plan digest changed after finalization" };
			}
		} catch {
			return { ok: false, kind: "plan_drift", reason: "canonical plan artifact is missing or unreadable" };
		}

		const readArtifact = async (
			kind: "build" | "diff" | "evidence",
			artifact: string,
			expectedDigest: string,
		): Promise<{ ok: true; content: string } | { ok: false; reason: string }> => {
			const artifactPath = resolveRunMarkerPath(ctx.localProtocolOptions!, artifact);
			if (!artifactPath) return { ok: false, reason: `canonical ${kind} artifact path cannot be resolved` };
			try {
				const content = await fs.readFile(artifactPath, "utf8");
				if (content.length === 0 || sha256Hex(content) !== expectedDigest) {
					return { ok: false, reason: `canonical ${kind} artifact digest does not match the finalized manifest` };
				}
				return { ok: true, content };
			} catch {
				return { ok: false, reason: `canonical ${kind} artifact is missing or unreadable` };
			}
		};
		const [build, diff, evidence] = await Promise.all([
			readArtifact("build", artifacts.build, manifest.buildArtifactDigest),
			readArtifact("diff", artifacts.diff, manifest.diffArtifactDigest),
			readArtifact("evidence", artifacts.evidence, manifest.evidenceArtifactDigest),
		]);
		if (!build.ok) return { ok: false, kind: "artifact_rebuildable", reason: build.reason };
		if (!diff.ok) return { ok: false, kind: "artifact_rebuildable", reason: diff.reason };
		if (!evidence.ok) return { ok: false, kind: "artifact_rebuildable", reason: evidence.reason };

		let repositoryFingerprint: RepositoryFingerprint;
		let record: BuildEvidenceRecordV3;
		let legacyRecordVersion: 1 | 2 | undefined;
		try {
			const recordText = await fs.readFile(activeBuildRecordPath(ctx), "utf8");
			const recordDigestMatches = sha256Hex(recordText) === manifest.buildRecordDigest;
			const recordValue: unknown = JSON.parse(recordText);
			if (
				allowLegacyRecord &&
				isPlainRecord(recordValue) &&
				(recordValue.version === 1 || recordValue.version === 2)
			) {
				legacyRecordVersion = recordValue.version;
				record = migrateBuildEvidenceRecord(recordValue, activeBuildIdentity(manifest.buildRecordRound));
			} else {
				record = parseBuildEvidenceRecord(recordValue, activeBuildIdentity(manifest.buildRecordRound));
			}
			const semanticStates = validationSemanticStates(
				record,
				state.approvedValidationContract!,
				manifest.repositoryFingerprint.combinedDigest,
			);
			if (semanticStates.some((validation) => validation.status !== "passed")) {
				return {
					ok: false,
					kind: "record_invalid",
					reason: "BUILD record does not contain a passed checkpoint for every approved validation",
				};
			}
			if (!recordDigestMatches) {
				// A syntactically valid record is a reusable checkpoint only if
				// its recorded validation state still belongs to this repository.
				// This reuses the normal provenance fingerprint without changing
				// its algorithm or the finalized-snapshot binding.
				try {
					repositoryFingerprint = await captureRepositoryFingerprint(ctx, undefined);
				} catch (error) {
					return {
						ok: false,
						kind: "transport_error",
						reason: `repository fingerprint cannot be verified: ${evidenceFailureMessage(error)}`,
					};
				}
				if (repositoryFingerprint.combinedDigest !== manifest.repositoryFingerprint.combinedDigest) {
					return {
						ok: false,
						kind: "repository_changed",
						reason: "repository state changed after artifact finalization",
					};
				}
				return {
					ok: false,
					kind: "record_invalid",
					reason: "BUILD record digest does not match the finalized manifest",
					checkpointRecoverable: true,
				};
			}
			if (validationStatesDigest(semanticStates) !== validationStatesDigest(manifest.validationStates)) {
				return {
					ok: false,
					kind: "record_invalid",
					reason: "BUILD record validation states do not match the finalized manifest",
				};
			}
		} catch (error) {
			return { ok: false, kind: "record_invalid", reason: `BUILD record validation failed: ${evidenceFailureMessage(error)}` };
		}

		try {
			repositoryFingerprint = await captureRepositoryFingerprint(ctx, undefined);
		} catch (error) {
			return {
				ok: false,
				kind: "transport_error",
				reason: `repository fingerprint cannot be verified: ${evidenceFailureMessage(error)}`,
			};
		}
		if (repositoryFingerprint.combinedDigest !== manifest.repositoryFingerprint.combinedDigest) {
			return { ok: false, kind: "repository_changed", reason: "repository state changed after artifact finalization" };
		}
		return {
			ok: true,
			value: {
				manifest,
				snapshotDigest,
				build: build.content,
				diff: diff.content,
				evidence: evidence.content,
				record,
				legacyRecordVersion,
			},
		};
	}

	async function recoverLegacyEvidenceRecord(
		ctx: ExtensionContext,
		verified: VerifiedGateSnapshot,
		resumeTerminalPass: boolean,
	): Promise<boolean> {
		if (verified.legacyRecordVersion === undefined) return false;
		await applyGateRecoveryEvent(ctx, {
			type: "legacy_evidence_migration",
			fromVersion: verified.legacyRecordVersion,
			baselineCaptured: verified.record.baseline !== undefined,
			resumeTerminalPass,
		});
		try {
			await readBuildRecordForReconciliation(ctx);
		} catch (error) {
			await applyGateRecoveryEvent(ctx, {
				type: "record_invalid",
				reason: `legacy BUILD record migration failed: ${evidenceFailureMessage(error)}`,
				checkpointRecoverable: true,
			});
		}
		return true;
	}

	/**
	 * Re-read the atomic manifest and every bound input immediately before
	 * dispatch. writtenArtifacts is advisory UI state and grants no authority.
	 */
	async function prepareGateSnapshot(ctx: ExtensionContext): Promise<GatePreparation> {
		if (pendingEvidenceObservations.size > 0) {
			return {
				ok: false,
				kind: "pending_evidence",
				reason: `${pendingEvidenceObservations.size} BUILD evidence observation(s) are still pending`,
			};
		}
		const verified = await verifyDurableFinalizedSnapshot(ctx);
		if (!verified.ok) return verified;
		if (
			state.blockedRecovery &&
			!hasSemanticValidationProgress(
				state.blockedRecovery.validationStates,
				verified.value.manifest.validationStates,
				state.blockedRecovery.evidenceIds,
			)
		) {
			return {
				ok: false,
				kind: "no_semantic_progress",
				reason: "no affected validation produced a newly passed observation with a changed output digest or repository fingerprint after the prior BLOCKED verdict",
			};
		}
		return {
			ok: true,
			snapshotDigest: verified.value.snapshotDigest,
			planDigest: verified.value.manifest.planDigest,
			buildRecordRound: verified.value.manifest.buildRecordRound,
			repositoryFingerprint: verified.value.manifest.repositoryFingerprint,
			build: verified.value.build,
			diff: verified.value.diff,
			evidence: verified.value.evidence,
		};
	}

	async function verifyGateSnapshot(
		ctx: ExtensionContext,
		lease: NonNullable<LeanFlowState["gateLease"]>,
	): Promise<{ ok: true } | GateSnapshotFailure> {
		const verified = await verifyDurableFinalizedSnapshot(ctx, lease);
		return verified.ok ? { ok: true } : verified;
	}
	async function planDriftedDuringGate(ctx: ExtensionContext, dispatchedPlanDigest: string | undefined): Promise<boolean> {
		if (!ctx.localProtocolOptions || !dispatchedPlanDigest || state.planDigest !== dispatchedPlanDigest) return true;
		const planArtifact = expectedPlanArtifact(state);
		if (!planArtifact) return true;
		const planPath = resolveRunMarkerPath(ctx.localProtocolOptions, planArtifact);
		if (!planPath) return true;
		try {
			return sha256Hex(await fs.readFile(planPath, "utf8")) !== dispatchedPlanDigest;
		} catch {
			return true;
		}
	}

	async function initializeBuildRecord(
		ctx: ExtensionContext,
		identity: BuildRecordIdentity,
		operation: ControlOperationIdentity,
	): Promise<BuildRecordSetupResult> {
		const isCurrent = () => controlOperationIsCurrent(ctx, operation, operation.artifactIdentity);
		if (!isCurrent()) return { ok: false, reason: "control operation authority changed" };
		try {
			const record = createBuildEvidenceRecord(identity);
			const written = await writeJsonAtomically(buildRecordPathFor(ctx, identity.runId), record, isCurrent);
			if (!written || !isCurrent()) return { ok: false, reason: "control operation authority changed" };
			state.currentBuildRound = identity.round;
			state.baselineCaptured = false;
			state.buildMutationObserved = false;
			state.writtenArtifacts = [];
			state.recoveryAction = undefined;
			state.finalizedGateSnapshot = undefined;
			state.finalizationCommitNonce = undefined;
			state.operationalRetrySnapshot = undefined;
			resetBlockedRecovery(state);
			return { ok: true, round: identity.round, baselinePresent: false, freshRecord: true, lspEvidencePresent: false };
		} catch (error) {
			const reason = evidenceFailureMessage(error);
			if (isCurrent() && ctx.hasUI) {
				ctx.ui.notify(
					`LeanFlow: failed to initialize the extension-owned BUILD record: ${reason}`,
					"warning",
				);
			}
			return { ok: false, reason };
		}
	}

	async function beginRepairBuildRound(
		ctx: ExtensionContext,
		operation: RepairOperationIdentity,
	): Promise<BuildRecordSetupResult> {
		const stale = (): BuildRecordSetupResult => ({ ok: false, reason: "stale repair operation" });
		const isCurrent = () => isRepairOperationCurrent(operation);
		if (!isCurrent()) return stale();
		const expected = {
			runId: operation.runId,
			planSlug: operation.planSlug,
			planDigest: operation.planDigest,
			approvedValidationDigest: operation.approvedValidationDigest,
		};
		let recoveryEligible = false;
		try {
			const value = await readBuildRecordValueAt(operation.recordPath);
			if (repairSetupReadHook) await repairSetupReadHook();
			if (!isCurrent()) return stale();
			let actual: BuildEvidenceRecordV3;
			try {
				actual = parseBuildEvidenceRecordWithoutRound(value, expected);
			} catch (error) {
				const legacyRound = isPlainRecord(value) && Number.isInteger(value.round) ? (value.round as number) : undefined;
				if (!isCurrent()) return stale();
				if (
					isPlainRecord(value) &&
					(value.version === 1 || value.version === 2) &&
					legacyRound !== undefined &&
					legacyRound >= 1
				) {
					const legacyIdentity: BuildRecordIdentity = {
						...expected,
						round: legacyRound,
					};
					actual = migrateBuildEvidenceRecord(value, legacyIdentity);
					if (!isCurrent()) return stale();
					if (!(await writeJsonAtomically(operation.recordPath, actual, isCurrent)) || !isCurrent()) return stale();
				} else {
					recoveryEligible = true;
					throw error;
				}
			}
			if (!isCurrent()) return stale();
			if (actual.round === operation.toRound) {
				return {
					ok: true,
					round: operation.toRound,
					baselinePresent: !!actual.baseline,
					freshRecord: actual.observations.length === 0,
					lspEvidencePresent: actual.observations.some((observation) => observation.toolName === "lsp"),
				};
			}
			if (actual.round !== operation.fromRound) {
				recoveryEligible = true;
				throw new Error(`BUILD record round ${actual.round} does not match expected ${operation.fromRound} → ${operation.toRound}`);
			}
			const nextRecord: BuildEvidenceRecordV3 = { ...actual, round: operation.toRound, observations: [] };
			if (!isCurrent()) return stale();
			if (!(await writeJsonAtomically(operation.recordPath, nextRecord, isCurrent)) || !isCurrent()) return stale();
			return {
				ok: true,
				round: operation.toRound,
				baselinePresent: !!nextRecord.baseline,
				freshRecord: true,
				lspEvidencePresent: false,
			};
		} catch (error) {
			if (!isCurrent()) return stale();
			let failure = error;
			if (recoveryEligible && operation.reason === "human_continue") {
				try {
					const fresh = createBuildEvidenceRecord({
						...expected,
						round: operation.toRound,
					});
					if (!isCurrent()) return stale();
					if (!(await writeJsonAtomically(operation.recordPath, fresh, isCurrent)) || !isCurrent()) return stale();
					return {
						ok: true,
						round: operation.toRound,
						baselinePresent: false,
						freshRecord: true,
						lspEvidencePresent: false,
					};
				} catch (recoveryError) {
					failure = recoveryError;
				}
			}
			if (!isCurrent()) return stale();
			const reason = evidenceFailureMessage(failure);
			if (ctx.hasUI) {
				ctx.ui.notify(`LeanFlow: failed to start the repair evidence round: ${reason}`, "warning");
			}
			return { ok: false, reason };
		}
	}

	async function appendBuildObservationUnlocked(
		ctx: ExtensionContext,
		identity: BuildOperationIdentity,
		observation: BuildEvidenceObservationV3,
	): Promise<boolean> {
		if (!isBuildOperationCurrent(ctx, identity)) return false;
		const record = await loadBuildRecordForIdentity(identity);
		if (!isBuildOperationCurrent(ctx, identity)) return false;
		record.observations.push(observation);
		if (!isBuildOperationCurrent(ctx, identity)) return false;
		return writeBuildJsonAtomically(ctx, identity, identity.recordPath, record);
	}

	async function appendBuildObservation(
		ctx: ExtensionContext,
		identity: BuildOperationIdentity,
		observation: BuildEvidenceObservationV3,
	): Promise<boolean> {
		const release = await acquireBuildRecordLock(identity);
		try {
			if (!isBuildOperationCurrent(ctx, identity)) return false;
			return await appendBuildObservationUnlocked(ctx, identity, observation);
		} finally {
			release();
		}
	}

	function combineValidationSignals(
		callerSignal: AbortSignal | undefined,
		authorityController: AbortController,
	): { signal: AbortSignal; cleanup: () => void } {
		if (!callerSignal) return { signal: authorityController.signal, cleanup: () => undefined };
		const combined = new AbortController();
		const abortCombined = () => combined.abort();
		callerSignal.addEventListener("abort", abortCombined, { once: true });
		authorityController.signal.addEventListener("abort", abortCombined, { once: true });
		if (callerSignal.aborted || authorityController.signal.aborted) combined.abort();
		return {
			signal: combined.signal,
			cleanup: () => {
				callerSignal.removeEventListener("abort", abortCombined);
				authorityController.signal.removeEventListener("abort", abortCombined);
			},
		};
	}

	function flattenTextContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.flatMap((block) =>
				isPlainRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
			)
			.join("\n");
	}


	function shellQuote(value: string): string {
		return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
	}

	function gitCommand(args: readonly string[]): string {
		return `git ${args.map(shellQuote).join(" ")}`;
	}

	function combinedExecOutput(stdout: string, stderr: string): string {
		if (!stderr) return stdout;
		const separator = stdout.length === 0 || stdout.endsWith("\n") ? "" : "\n";
		return `${stdout}${separator}[stderr]\n${stderr}`;
	}

	async function runGit(
		ctx: ExtensionContext,
		args: string[],
		signal: AbortSignal | undefined,
		acceptedCodes: readonly number[] = [0],
		label?: string,
	): Promise<{ stdout: string; stderr: string; code: number; evidence: GitCommandEvidence }> {
		const result = await pi.exec("git", args, { cwd: ctx.cwd, signal });
		if (result.killed || !acceptedCodes.includes(result.code)) {
			throw new Error(
				`${gitCommand(args)} failed with code ${result.code}${result.killed ? " (killed)" : ""}: ${combinedExecOutput(result.stdout, result.stderr)}`,
			);
		}
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
			evidence: {
				command: gitCommand(args),
				exitCode: result.code,
				output: combinedExecOutput(result.stdout, result.stderr),
				...(label ? { label } : {}),
			},
		};
	}

	async function captureRepositoryFingerprint(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<RepositoryFingerprint> {
		const head = (await runGit(ctx, ["rev-parse", "HEAD"], signal, [0], "Gate repository HEAD")).stdout.trim();
		if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("git rev-parse HEAD returned an invalid commit identity");
		const trackedDiff = (
			await runGit(ctx, ["diff", "--binary", "HEAD", "--"], signal, [0], "Gate tracked repository diff")
		).stdout;
		const listed = await runGit(
			ctx,
			["ls-files", "--others", "--exclude-standard", "-z"],
			signal,
			[0],
			"Gate untracked repository paths",
		);
		const untrackedEntries: string[] = [];
		const untrackedPaths = parseNulList(listed.stdout, listed.evidence.command)
			.filter((relative) => relative !== ".leanflow" && !relative.startsWith(".leanflow/"))
			.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
		for (const relative of untrackedPaths) {
			const { absolute, stat } = await validateUntrackedPath(ctx, relative);
			if (stat.isSymbolicLink()) {
				untrackedEntries.push(`${relative}\0symlink\0${await fs.readlink(absolute)}`);
			} else {
				const executable = (stat.mode & 0o111) === 0 ? "-" : "x";
				const digest = createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
				untrackedEntries.push(`${relative}\0file\0${executable}\0${digest}`);
			}
		}
		const trackedDiffDigest = sha256Hex(trackedDiff);
		const untrackedDigest = sha256Hex(untrackedEntries.join("\n"));
		return {
			head,
			trackedDiffDigest,
			untrackedDigest,
			combinedDigest: sha256Hex(`${head}\n${trackedDiffDigest}\n${untrackedDigest}`),
		};
	}

	function parseNulList(output: string, command: string): string[] {
		if (output.length === 0) return [];
		if (!output.endsWith("\0")) throw new Error(`${command} returned a malformed NUL-delimited path list.`);
		const values = output.slice(0, -1).split("\0");
		if (values.some((value) => value.length === 0)) {
			throw new Error(`${command} returned an empty path entry.`);
		}
		return values;
	}

	async function validateUntrackedPath(
		ctx: ExtensionContext,
		relative: string,
	): Promise<{ absolute: string; size: number; stat: fsSync.Stats }> {
		if (
			relative.includes("\0") ||
			path.isAbsolute(relative) ||
			path.posix.normalize(relative) !== relative ||
			relative === "." ||
			relative === ".." ||
			relative.startsWith("../")
		) {
			throw new Error(`untracked path escapes or is not canonical: ${JSON.stringify(relative)}`);
		}
		const root = path.resolve(ctx.cwd);
		const absolute = path.resolve(root, relative);
		if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
			throw new Error(`untracked path escapes the repository: ${JSON.stringify(relative)}`);
		}
		const realRoot = await fs.realpath(root);
		const realParent = await fs.realpath(path.dirname(absolute));
		if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
			throw new Error(`untracked path parent resolves outside the repository: ${JSON.stringify(relative)}`);
		}
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) return { absolute, size: stat.size, stat };
		if (!stat.isFile()) {
			throw new Error(`untracked path has an unsupported special-file type: ${JSON.stringify(relative)}`);
		}
		const real = await fs.realpath(absolute);
		if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
			throw new Error(`untracked path resolves outside the repository: ${JSON.stringify(relative)}`);
		}
		return { absolute, size: stat.size, stat };
	}
	async function writeRunMarker(
		ctx: ExtensionContext,
		status: NonNullable<LeanFlowState["runMarkerStatus"]>,
		operation?: ControlOperationIdentity,
	): Promise<boolean> {
		if (!state.runId || !state.planSlug || !state.planArtifact || !state.planDigest || !state.startedAt || !state.stats) {
			setPersistenceFailure(
				ctx,
				"precondition",
				state.planArtifact ?? "local://.leanflow",
				new Error("run marker state is incomplete"),
				"INVALID_STATE",
			);
			return false;
		}
		const options = ctx.localProtocolOptions;
		if (!options) {
			setPersistenceFailure(
				ctx,
				"precondition",
				"local://.leanflow",
				new Error("local protocol options are unavailable"),
				"NO_LOCAL_PROTOCOL",
			);
			return false;
		}
		const artifact = runMarkerArtifact(state.planSlug, state.runId);
		const pointerArtifact = activePointerArtifact(state.planSlug);
		const markerOperation = operation ?? captureControlOperation(ctx, `${artifact}\u0000${pointerArtifact}`);
		const isCurrent = () => controlOperationIsCurrent(ctx, markerOperation);
		if (!isCurrent()) return false;
		state.runMarkerArtifact = artifact;
		state.runMarkerStatus = status;
		const markerPath = resolveRunMarkerPath(options, artifact);
		if (!markerPath) {
			setPersistenceFailure(ctx, "marker", artifact, new Error("run marker path cannot be resolved"), "INVALID_PATH");
			return false;
		}
		const pointerPath = resolveRunMarkerPath(options, pointerArtifact);
		if (!pointerPath) {
			setPersistenceFailure(
				ctx,
				"pointer",
				pointerArtifact,
				new Error("active pointer path cannot be resolved"),
				"INVALID_PATH",
			);
			return false;
		}
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
			handoffBlockers: state.handoffBlockers,
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
		let failureStage: NonNullable<LeanFlowState["persistenceFailureStage"]> =
			status === "awaiting_approval" ? "marker" : "pointer";
		let failurePath = status === "awaiting_approval" ? markerPath : pointerPath;
		try {
			const markerFirst = status === "awaiting_approval";
			const firstPath = markerFirst ? markerPath : pointerPath;
			const firstValue = markerFirst ? marker : pointer;
			if (!(await writeJsonAtomically(firstPath, firstValue, isCurrent))) return false;
			failureStage = markerFirst ? "pointer" : "marker";
			failurePath = markerFirst ? pointerPath : markerPath;
			const secondPath = markerFirst ? pointerPath : markerPath;
			const secondValue = markerFirst ? pointer : marker;
			if (!(await writeJsonAtomically(secondPath, secondValue, isCurrent))) return false;
			if (!isCurrent()) return false;
			state.runMarkerArtifact = artifact;
			state.runMarkerStatus = status;
			clearPersistenceFailure();
			return true;
		} catch (error) {
			if (isCurrent()) setPersistenceFailure(ctx, failureStage, failurePath, error);
			return false;
		}
	}


	async function lookupFreshRecovery(ctx: ExtensionContext, approvedArtifact: string): Promise<FreshRecoveryLookup> {
		const options = ctx.localProtocolOptions;
		if (!options) return { kind: "none" };
		const slug = planSlugFromArtifact(approvedArtifact);
		let rawPointer: unknown;
		let pointerFound = false;
		let legacyPathTooLong = false;
		const pointerArtifacts = [activePointerArtifact(slug), legacyActivePointerArtifact(slug)];
		for (let index = 0; index < pointerArtifacts.length; index++) {
			const pointerPath = resolveRunMarkerPath(options, pointerArtifacts[index]!);
			if (!pointerPath) return { kind: "invalid", reason: "invalid active pointer path" };
			try {
				rawPointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
				pointerFound = true;
				break;
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
						? error.code
						: undefined;
				if (index === 1 && code === "ENAMETOOLONG") legacyPathTooLong = true;
				const absent = code === "ENOENT" || (index === 1 && code === "ENAMETOOLONG");
				if (!absent) return { kind: "invalid", reason: "corrupt active pointer" };
			}
		}
		if (!pointerFound) {
			const runsPath = resolveRunMarkerPath(options, "local://.leanflow/runs");
			const planPath = resolveRunMarkerPath(options, approvedArtifact);
			if (!runsPath || !planPath) return { kind: "invalid", reason: "invalid orphan recovery path" };
			let names: string[];
			try {
				names = await fs.readdir(runsPath);
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
			const activeMarkers: RunMarker[] = [];
			for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
				try {
					const candidate: unknown = JSON.parse(await fs.readFile(path.join(runsPath, name), "utf8"));
					if (
						isRunMarker(candidate, approvedArtifact) &&
						candidate.planSlug === slug &&
						name === `${candidate.runId}.json`
					) {
						activeMarkers.push(candidate);
					}
				} catch {
					// Corrupt and expired orphan markers cannot claim an ordinary approval.
				}
			}
			if (activeMarkers.length === 0) return { kind: "none" };
			if (!legacyPathTooLong || activeMarkers.length > 1) {
				return {
					kind: "invalid",
					reason:
						activeMarkers.length > 1
							? "multiple active marker candidates"
							: "orphan active marker mismatch",
				};
			}
			try {
				const content = await fs.readFile(planPath, "utf8");
				const marker = activeMarkers[0]!;
				return marker.runId === runIdFromPlan(content) && marker.planDigest === planDigest(content)
					? { kind: "valid", marker }
					: { kind: "invalid", reason: "orphan active marker mismatch" };
			} catch {
				return { kind: "invalid", reason: "unreadable orphan recovery plan" };
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
		operation?: ControlOperationIdentity,
	): Promise<boolean> {
		const artifact = expectedPlanArtifact(state);
		const options = ctx.localProtocolOptions;
		if (!artifact || !options || !state.runId) return false;
		const authority = operation ?? captureControlOperation(ctx, artifact);
		if (!controlOperationIsCurrent(ctx, authority, artifact)) return false;
		const filePath = resolveRunMarkerPath(options, artifact);
		if (!filePath) return false;
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf8");
		} catch {
			return false;
		}
		if (!controlOperationIsCurrent(ctx, authority, artifact)) return false;

		const assessed = assessHandoff(content);
		const currentPlanDigest = planDigest(content);
		const validationContract = assessed.validationContract;
		const identityValid = runIdFromPlan(content) === state.runId;
		const lsp = lspStatusFromPlan(content);
		const warnings = [...assessed.warnings];
		if (!identityValid) {
			warnings.push("Plan must contain exactly one matching `LeanFlow run ID` metadata line outside fenced code.");
		}
		if (lsp.warning) warnings.push(lsp.warning);
		const handoffStatus = identityValid ? assessed.status : "NEEDS_UPDATE";

		state.planArtifact = artifact;
		state.planDigest = currentPlanDigest;
		state.handoffStatus = handoffStatus;
		// Handoff assessment is not approval. Keep the parsed contract out of
		// persisted approved state until native approval (or fresh-run recovery)
		// binds it to the canonical plan.
		state.approvedValidationContract =
			reason === "approval" || reason === "recovery" ? validationContract : undefined;
		state.approvedValidationDigest = state.approvedValidationContract?.digest;
		state.handoffWarnings = warnings;
		state.handoffBlockers = assessed.blockers.map((blocker) => blocker.code);
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
			const markerOperation = captureControlOperation(ctx, artifact);
			await writeRunMarker(ctx, "invalidated", markerOperation);
			if (!controlOperationIsCurrent(ctx, markerOperation, artifact)) return false;
			persist();
			updateStatus(ctx);
			ctx.ui.notify(
				formatHandoffNotification({ status: handoffStatus, blockers: assessed.blockers, warnings }),
				"warning",
			);
			return false;
		}

		state.approvalInvalidated = false;
		if (reason === "mutation") transitionPhase(state, "awaiting_approval");
		const markerOperation = captureControlOperation(ctx, artifact);
		const markerWritten = await writeRunMarker(ctx, "awaiting_approval", markerOperation);
		if (!controlOperationIsCurrent(ctx, markerOperation, artifact)) return false;
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
				`${formatHandoffNotification({ status: handoffStatus, blockers: assessed.blockers, warnings })}\nRequest approval by writing \`${state.planSlug}\` to xd://propose.`,
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
		const approvalOperation = captureControlOperation(ctx, artifact);
		const buildIdentity = activeBuildIdentity(1);
		state.approvedPlanArtifact = artifact;
		state.proposedPlanDigest = state.planDigest;
		const buildRecord = await initializeBuildRecord(ctx, buildIdentity, approvalOperation);
		if (!controlOperationIsCurrent(ctx, approvalOperation, artifact)) return false;
		if (!buildRecord.ok) {
			ctx.ui.notify(`LeanFlow: Cannot enter BUILD: ${buildRecord.reason}`, "warning");
			return false;
		}
		transitionPhase(state, "building");
		const markerOperation = captureControlOperation(ctx, artifact);
		if (!(await writeRunMarker(ctx, "building", markerOperation))) return false;
		if (!controlOperationIsCurrent(ctx, markerOperation, artifact)) return false;
		persist();
		return true;
	}

	async function lockFreshRecovery(
		ctx: ExtensionContext,
		artifact: string,
		lookup: Extract<FreshRecoveryLookup, { kind: "invalid" }>,
		operation: ControlOperationIdentity,
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
		if (!freshRecoveryOperationIsCurrent(ctx, operation, artifact)) return;
		advanceBuildActivation();
		state = {
			...defaultState(),
			phase: "planning",
			stateVersion: STATE_VERSION,
			phaseStartedAt: now,
			runId,
			controlSessionId: buildSessionId(ctx),
			controlOperationEpoch: activationEpoch,
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
		const markerOperation = captureControlOperation(ctx, artifact);
		await writeRunMarker(ctx, "invalidated", markerOperation);
		if (!controlOperationIsCurrent(ctx, markerOperation, artifact)) return;
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
		const operation = captureFreshRecoveryOperation(ctx, artifact);
		if (freshRecoveryLookupHook) await freshRecoveryLookupHook();
		const lookup = await lookupFreshRecovery(ctx, artifact);
		if (!freshRecoveryOperationIsCurrent(ctx, operation, artifact)) return false;
		if (lookup.kind === "none") return false;
		if (lookup.kind === "invalid") {
			await lockFreshRecovery(ctx, artifact, lookup, operation);
			return true;
		}
		const marker = lookup.marker;

		advanceBuildActivation();
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
					handoffBlockers: marker.handoffBlockers,
					stats: marker.stats,
					writtenArtifacts: [],
				},
			},
		]);
		state.controlSessionId = buildSessionId(ctx);
		state.controlOperationEpoch = activationEpoch;
		const recoveryOperation = captureControlOperation(ctx, artifact);
		if (!(await refreshCanonicalPlanState(ctx, "recovery", recoveryOperation))) return true;
		const buildSetupOperation = captureControlOperation(ctx, artifact);
		const buildIdentity = activeBuildIdentity(1);
		state.approvedPlanArtifact = marker.planArtifact;
		state.proposedPlanDigest = state.planDigest;
		const buildRecord = await initializeBuildRecord(ctx, buildIdentity, buildSetupOperation);
		if (!controlOperationIsCurrent(ctx, buildSetupOperation, artifact)) return true;
		if (!buildRecord.ok) {
			ctx.ui.notify(`LeanFlow: Cannot enter BUILD: ${buildRecord.reason}`, "warning");
			return true;
		}
		transitionPhase(state, "building", now);
		const markerOperation = captureControlOperation(ctx, artifact);
		if (!(await writeRunMarker(ctx, "building", markerOperation))) return true;
		if (!controlOperationIsCurrent(ctx, markerOperation, artifact)) return true;
		persist();
		return true;
	}

	async function executeGateEffects(
		ctx: ExtensionContext,
		effects: Effect[],
		operation?: ControlOperationIdentity,
		suppressRepairNotification = false,
	): Promise<{ ok: true } | { ok: false; reason?: string }> {
		for (const effect of effects) {
			if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) {
				return { ok: false, reason: "control operation authority changed" };
			}
			switch (effect.kind) {
				case "clear_artifacts":
					state.writtenArtifacts = [];
					break;
				case "begin_repair_round": {
					const repairOperation = captureRepairOperation(ctx);
					const continuation = captureControlOperation(ctx);
					if (!isRepairOperationCurrent(repairOperation)) {
						return { ok: false, reason: "stale repair operation" };
					}
					persist();
					const buildRecord = await beginRepairBuildRound(ctx, repairOperation);
					if (!isRepairOperationCurrent(repairOperation)) {
						return { ok: false, reason: "stale repair operation" };
					}
					const transition = buildRecord.ok
						? reduceGate(state, {
								type: "repair_round_ready",
								transactionId: repairOperation.transactionId,
								runId: repairOperation.runId,
								fromRound: repairOperation.fromRound,
								round: buildRecord.round,
								baselineCaptured: buildRecord.baselinePresent,
								freshRecord: buildRecord.freshRecord,
								lspEvidencePresent: buildRecord.lspEvidencePresent,
							})
						: reduceGate(state, {
								type: "repair_round_failed",
								transactionId: repairOperation.transactionId,
								runId: repairOperation.runId,
								reason: buildRecord.reason,
							});
					persist();
					const repairEffects = suppressRepairNotification
						? transition.effects.filter((candidate) => candidate.kind !== "notify")
						: transition.effects;
					const completed = await executeGateEffects(ctx, repairEffects, continuation);
					if (!completed.ok) return completed;
					updateStatus(ctx);
					const violations = checkInvariants(state);
					if (violations.length > 0) {
						ctx.ui.notify(`LeanFlow invariant violation: ${violations.join("; ")}`, "warning");
					}
					if (!buildRecord.ok) return { ok: false, reason: buildRecord.reason };
					break;
				}
				case "write_marker": {
					const markerOperation = operation ? captureControlOperation(ctx) : undefined;
					await writeRunMarker(ctx, effect.status, markerOperation);
					if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) {
						return { ok: false, reason: "control operation authority changed" };
					}
					break;
				}
				case "notify":
					ctx.ui.notify(`LeanFlow: ${effect.message}`, effect.level);
					break;
			}
		}
		return { ok: true };
	}

	type GateSnapshotFailureSource = "preflight" | "settlement" | "gate_tool_error" | "session_interruption" | "restore";

	async function applyGateRecoveryEvent(
		ctx: ExtensionContext,
		event: Parameters<typeof reduceGate>[1],
		operation?: ControlOperationIdentity,
	): Promise<boolean> {
		if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return false;
		const { effects } = reduceGate(state, event);
		const executed = await executeGateEffects(ctx, effects, operation);
		if (!executed.ok || (operation && !controlOperationContinuationIsCurrent(ctx, operation))) return false;
		persist();
		updateStatus(ctx);
		const violations = checkInvariants(state);
		if (violations.length > 0) {
			ctx.ui.notify(`LeanFlow invariant violation: ${violations.join("; ")}`, "warning");
		}
		return true;
	}

	/**
	 * The only provenance-failure router. Every preflight, settlement, Gate
	 * tool-error, interruption, and restore path enters here with the original
	 * typed failure kind; only actual dispatches change gateDispatches.
	 */
	async function routeGateSnapshotFailure(
		ctx: ExtensionContext,
		failure: GatePreparationFailure,
		source: GateSnapshotFailureSource,
		interruption: OperationalInterruption = "tool_error",
		operation?: ControlOperationIdentity,
	): Promise<void> {
		if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
		switch (failure.kind) {
			case "pending_evidence":
				// BUILD is still active; no provenance state has become invalid.
				return;
			case "no_semantic_progress":
				await applyGateRecoveryEvent(ctx, { type: "blocked_no_progress", reason: failure.reason }, operation);
				return;
			case "repository_changed":
				await applyGateRecoveryEvent(ctx, { type: "repository_changed", reason: failure.reason }, operation);
				return;
			case "artifact_rebuildable":
			case "manifest_missing":
			case "snapshot_changed":
				await applyGateRecoveryEvent(ctx, { type: "snapshot_invalid", reason: failure.reason }, operation);
				return;
			case "record_invalid":
				await applyGateRecoveryEvent(
					ctx,
					{
						type: "record_invalid",
						reason: failure.reason,
						checkpointRecoverable: failure.checkpointRecoverable === true,
					},
					operation,
				);
				return;
			case "lease_invalid":
				await applyGateRecoveryEvent(ctx, { type: "lease_invalid", reason: failure.reason }, operation);
				return;
			case "plan_drift":
			case "validation_contract_invalid": {
				await applyGateRecoveryEvent(
					ctx,
					{
						type: failure.kind === "plan_drift" ? "plan_drift" : "contract_invalid",
						reason: failure.reason,
					},
					operation,
				);
				const artifact = expectedPlanArtifact(state);
				const planPath = artifact && ctx.localProtocolOptions ? resolveRunMarkerPath(ctx.localProtocolOptions, artifact) : undefined;
				let readable = false;
				if (planPath) {
					try {
						await fs.readFile(planPath, "utf8");
						readable = true;
					} catch {
						// The fallback below gives the operator an editable plan repair path.
					}
				}
				if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
				if (readable) {
					const refreshOperation = operation ? captureControlOperation(ctx, artifact) : undefined;
					await refreshCanonicalPlanState(ctx, "mutation", refreshOperation);
					return;
				}
				if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
				state.handoffStatus = "NEEDS_UPDATE";
				const markerOperation = operation ? captureControlOperation(ctx, artifact) : undefined;
				await writeRunMarker(ctx, "invalidated", markerOperation);
				if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`LeanFlow: ${failure.reason}; canonical plan is unreadable — repair and re-propose the plan.`, "warning");
				if (ctx.hasUI && state.planSlug) {
					ctx.ui.setEditorText(
						`/plan Repair the existing LeanFlow plan at local://${state.planSlug}-plan.md in place. Preserve its run ID, fix only the invalid final-plan content, write the same artifact, then re-propose ${state.planSlug}. Do not repeat repository investigation.`,
					);
				}
				return;
			}
			case "transport_error": {
				// Preflight has no Gate lease to retry. Keep its ordinary or
				// operational BUILD state unchanged and deny the dispatch.
				if (source === "preflight") return;
				if (
					source === "restore" &&
					state.phase === "building" &&
					state.gateRetryMode === "operational" &&
					state.operationalRetrySnapshot &&
					state.finalizedGateSnapshot
				) {
					// Operational BUILD intentionally has no live Gate lease.
					// Its persisted retry snapshot is the authority to retain.
					return;
				}
				const lease = state.gateLease;
				const finalized = state.finalizedGateSnapshot;
				if (state.phase !== "gating" || !lease || !finalized) {
					await applyGateRecoveryEvent(
						ctx,
						{
							type: "lease_invalid",
							reason: `${failure.reason}; Gate transport recovery lacks a durable lease`,
						},
						operation,
					);
					return;
				}
				const operationalRetrySnapshot = createOperationalRetrySnapshot(lease, finalized, interruption);
				await applyGateRecoveryEvent(
					ctx,
					source === "session_interruption" || source === "restore"
						? { type: "gate_interrupted", operationalRetrySnapshot }
						: { type: "gate_error", operationalRetrySnapshot },
					operation,
				);
				return;
			}
		}
	}

	async function finishGateResult(
		result: ParsedGateResult | undefined,
		isError: boolean,
		ctx: ExtensionContext,
		interruptedBy: OperationalInterruption = "tool_error",
		operation?: ControlOperationIdentity,
	): Promise<void> {
		if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
		const lease = state.gateLease;
		if (!lease || !state.finalizedGateSnapshot) {
			await routeGateSnapshotFailure(
				ctx,
				{
					ok: false,
					kind: "lease_invalid",
					reason: "Gate settlement lacks its durable lease or finalized manifest",
				},
				"settlement",
				"tool_error",
				operation,
			);
			return;
		}
		if (isError || result === undefined) {
			await routeGateSnapshotFailure(
				ctx,
				{ ok: false, kind: "transport_error", reason: "Gate tool did not return a valid result" },
				"gate_tool_error",
				interruptedBy,
				operation,
			);
			return;
		}
		let currentFingerprint: RepositoryFingerprint;
		try {
			currentFingerprint = await captureRepositoryFingerprint(ctx, undefined);
		} catch (error) {
			await routeGateSnapshotFailure(
				ctx,
				{
					ok: false,
					kind: "transport_error",
					reason: `repository fingerprint transport failed immediately before settlement: ${evidenceFailureMessage(error)}`,
				},
				"settlement",
				"transport_error",
				operation,
			);
			return;
		}
		if (operation && !controlOperationContinuationIsCurrent(ctx, operation)) return;
		if (currentFingerprint.combinedDigest !== lease.repositoryFingerprint?.combinedDigest) {
			await routeGateSnapshotFailure(
				ctx,
				{
					ok: false,
					kind: "repository_changed",
					reason: "repository state changed immediately before Gate settlement",
				},
				"settlement",
				"tool_error",
				operation,
			);
			return;
		}

		const evidenceIds = result.evidenceIds ? [...new Set(result.evidenceIds)].sort() : undefined;
		let validationStates = state.finalizedGateSnapshot.validationStates.map((validation) => ({ ...validation }));
		if (result.verdict === "BLOCKED") {
			if (
				!result.reasonCode ||
				!evidenceIds ||
				evidenceIds.some((id) => !validationStates.some((validation) => validation.id === id))
			) {
				await finishGateResult(undefined, true, ctx, "invalid_gate_output", operation);
				ctx.ui.notify("LeanFlow: Gate BLOCKED result named an unknown approved validation ID.", "warning");
				return;
			}
			const blockedStatus =
				result.reasonCode === "missing_validation"
					? "missing"
					: result.reasonCode === "failed_validation" || result.reasonCode === "other_validation_failure"
						? "failed"
						: "stale";
			validationStates = validationStates.map((validation) =>
				evidenceIds.includes(validation.id) ? { ...validation, status: blockedStatus } : validation,
			);
		}
		await applyGateRecoveryEvent(
			ctx,
			{
				type: "gate_settled",
				outcome: result.verdict,
				findingsJson: result.canonicalJson,
				...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
				...(evidenceIds ? { evidenceIds } : {}),
				...(result.verdict === "BLOCKED"
					? {
							validationStates,
							semanticEvidenceDigest: state.finalizedGateSnapshot.semanticEvidenceDigest,
					  }
					: {}),
			},
			operation,
		);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (state.phase === "idle") {
			ctx.ui.setStatus("leanflow", "");
			return;
		}
		const parts = [`LeanFlow: ${state.phase}`];
		if (state.scoutCalls > 0) parts.push(`scout:${state.scoutCalls}/3`);

		if (state.gateCalls > 0 || (state.gateDispatches ?? 0) > 0) {
			parts.push(`gate verdicts:${state.gateCalls}/2`);
			parts.push(`dispatches:${state.gateDispatches ?? 0}`);
		}
		ctx.ui.setStatus("leanflow", parts.join(" | "));
	}
	function activePhase(): LeanFlowState["phase"] {
		return state.phase;
	}

	/**
	 * Report only the Gate preflight checks available from in-memory state.
	 * Artifact marks are advisory, so this deliberately never touches the
	 * filesystem or revalidates artifact content, plan digest, or build record.
	 */
	function cheapGateReadiness(ctx: ExtensionContext): { ready: true } | { ready: false; reason: string } {
		if (pendingEvidenceObservations.size > 0) {
			return {
				ready: false,
				reason: `${pendingEvidenceObservations.size} BUILD evidence observation(s) are still pending`,
			};
		}
		if (state.phase === "repair_preparing") {
			return { ready: false, reason: "repair preparation in progress" };
		}
		if (!ctx.localProtocolOptions) return { ready: false, reason: "local artifact storage is unavailable" };
		if (!state.runId || !state.planDigest || !state.approvedValidationDigest) {
			return { ready: false, reason: "active run identity or validation contract is incomplete" };
		}
		if (!expectedGateArtifacts(state)) {
			return { ready: false, reason: "canonical Gate artifact identity is unavailable" };
		}
		return { ready: true };
	}

	async function formatFlowStatus(ctx: ExtensionContext): Promise<string> {
		const written = new Set(state.writtenArtifacts ?? []);
		const markedArtifacts = REQUIRED_ARTIFACTS.filter((kind) => written.has(kind));
		const cheap = cheapGateReadiness(ctx);
		let readinessLine: string;
		if (!cheap.ready) {
			readinessLine = `BLOCKED: ${cheap.reason}`;
		} else {
			const deep = await prepareGateSnapshot(ctx);
			if (deep.ok) {
				readinessLine = `READY (deep: verified, round ${deep.buildRecordRound}, snapshot ${deep.snapshotDigest.slice(0, 12)})`;
			} else {
				readinessLine = `BLOCKED: ${deep.reason}`;
			}
		}
		const digest = state.planDigest ? state.planDigest.slice(0, 12) : "unavailable";

		return [
			"LeanFlow status:",
			`- Phase: ${state.phase}`,
			`- Run ID: ${state.runId ?? "unavailable"}`,
			`- Plan digest: ${digest}`,
			`- Repair round: ${state.gateAttempt}`,
			`- Gate verdicts: ${state.gateCalls}/2`,
			`- Gate dispatches: ${state.gateDispatches ?? 0}`,
			`- Gate blocked: ${state.stats?.gateBlocked ?? 0}`,
			`- Consecutive errors: ${state.consecutiveGateErrors ?? 0}/4`,
			`- Pending evidence observations: ${pendingEvidenceObservations.size}`,
			`- Baseline captured: ${state.baselineCaptured === true ? "yes" : "no"}`,
			`- Written artifacts: ${markedArtifacts.length}/${REQUIRED_ARTIFACTS.length} (${markedArtifacts.join(", ") || "none"} / ${REQUIRED_ARTIFACTS.join(", ")})`,
			`- LSP probe: ${state.lspProbeStatus}`,
			`- Human repair cycles: ${state.humanRepairCycles ?? 0}`,
			`- Recovery action: ${state.recoveryAction ?? "none"}`,
			`- Gate readiness: ${readinessLine}`,
		].join("\n");
	}

	// -----------------------------------------------------------------------
	// State restoration on session lifecycle events
	// -----------------------------------------------------------------------

	/**
	 * Captures every persisted field session reconciliation may repair so any
	 * correction — not only phase/lease swaps — is written back durably.
	 */
	function reconciliationFingerprint(value: LeanFlowState): string {
		return JSON.stringify({
			phase: value.phase,
			stateVersion: value.stateVersion,
			gateAttempt: value.gateAttempt,
			currentBuildRound: value.currentBuildRound,
			controlSessionId: value.controlSessionId,
			controlOperationEpoch: value.controlOperationEpoch,
			gateCalls: value.gateCalls,
			gateRetryMode: value.gateRetryMode,
			gateLease: value.gateLease,
			lspLease: value.lspLease,
			repairLease: value.repairLease,
			baselineCaptured: value.baselineCaptured,
			buildMutationObserved: value.buildMutationObserved,
			writtenArtifacts: value.writtenArtifacts,
			recoveryAction: value.recoveryAction,
			consecutiveGateErrors: value.consecutiveGateErrors,
			approvedValidationContract: value.approvedValidationContract,
			approvedValidationDigest: value.approvedValidationDigest,
			finalizedGateSnapshot: value.finalizedGateSnapshot,
			finalizationCommitNonce: value.finalizationCommitNonce,
			operationalRetrySnapshot: value.operationalRetrySnapshot,
			blockedRecovery: value.blockedRecovery,
		});
	}

	const restoreSessionStateImpl = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		if (restoreSessionHook) await restoreSessionHook();
		const branch = ctx.sessionManager.getBranch();
		hasPersistedLeanFlowState = hasPersistedState(branch);
		const rawBeforeRestore = (() => {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (!isPlainRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
				const raw = entry.data;
				if (!isPlainRecord(raw)) return undefined;
				return {
					phase: raw.phase,
					stateVersion: raw.stateVersion,
					data: raw,
				};
			}
			return undefined;
		})();
		const rawStateVersion = rawBeforeRestore?.stateVersion;
		const supportedRawStateVersion =
			rawStateVersion === undefined ||
			(typeof rawStateVersion === "number" &&
				Number.isInteger(rawStateVersion) &&
				rawStateVersion >= 1 &&
				rawStateVersion <= STATE_VERSION);
		const wasGatingRaw = rawBeforeRestore?.phase === "gating" && supportedRawStateVersion && rawStateVersion !== 7;
		state = restoreState(branch);
		state.controlSessionId = buildSessionId(ctx);
		state.controlOperationEpoch = activationEpoch;
		pendingControlOperations.clear();
		pendingEvidenceObservations.clear();

		if (
			rawBeforeRestore?.phase === "repair_preparing" &&
			typeof rawStateVersion === "number" &&
			rawStateVersion >= 3 &&
			rawStateVersion < STATE_VERSION &&
			state.runId &&
			state.planSlug &&
			state.planDigest &&
			state.approvedValidationDigest
		) {
			const rawLease = isPlainRecord(rawBeforeRestore.data.repairLease) ? rawBeforeRestore.data.repairLease : undefined;
			const rawRound = rawBeforeRestore.data.currentBuildRound ?? rawBeforeRestore.data.gateAttempt;
			const fromRound =
				typeof rawLease?.fromRound === "number" && Number.isInteger(rawLease.fromRound)
					? rawLease.fromRound
					: typeof rawRound === "number" && Number.isInteger(rawRound)
						? rawRound
						: undefined;
			if (fromRound !== undefined && fromRound >= 0) {
				try {
					const recordPath = buildRecordPathFor(ctx, state.runId);
					const record = parseBuildEvidenceRecordWithoutRound(await readBuildRecordValueAt(recordPath), {
						runId: state.runId,
						planSlug: state.planSlug,
						planDigest: state.planDigest,
						approvedValidationDigest: state.approvedValidationDigest,
					});
					if (record.round !== fromRound && record.round !== fromRound + 1) {
						throw new Error(`legacy repair record round ${record.round} does not prove ${fromRound} → ${fromRound + 1}`);
					}
					state.repairLease = createRepairLease(state, fromRound, "record_recovery");
					state.phase = "repair_preparing";
					state.gateRetryMode = "repair";
					state.recoveryAction = undefined;
				} catch {
					state.repairLease = undefined;
					state.phase = "awaiting_human";
					state.gateRetryMode = undefined;
					state.recoveryAction = "flowcontinue_rebuild_checkpoint";
					await writeRunMarker(ctx, "paused");
				}
			}
		}

		const restoredFromLegacy =
			rawBeforeRestore !== undefined && rawBeforeRestore.stateVersion !== state.stateVersion;
		const fingerprintBeforeReconcile = reconciliationFingerprint(state);
		const { effects } = reduceGate(state, { type: "restore_reconcile", now: Date.now() });
		await executeGateEffects(ctx, effects);
		if (state.phase === "finalizing" && state.terminalOutcome === "pass") {
			const finalized = await verifyDurableFinalizedSnapshot(ctx, undefined, true);
			if (finalized.ok) {
				await recoverLegacyEvidenceRecord(ctx, finalized.value, true);
			} else {
				await applyGateRecoveryEvent(ctx, {
					type: "finalization_authority_invalid",
					reason: finalized.reason,
				});
			}
		}


		let restoredGateBecameOperational = false;
		if (wasGatingRaw) {
			if (state.phase !== "gating" || !state.gateLease || !state.finalizedGateSnapshot) {
				await routeGateSnapshotFailure(
					ctx,
					{
						ok: false,
						kind: "lease_invalid",
						reason: "restored Gate provenance lacks its durable lease or finalized manifest",
					},
					"restore",
				);
			} else {
				const verified = await verifyDurableFinalizedSnapshot(ctx, state.gateLease, true);
				const migrated =
					verified.ok && (await recoverLegacyEvidenceRecord(ctx, verified.value, false));
				if (!migrated) {
					await routeGateSnapshotFailure(
						ctx,
						verified.ok
							? { ok: false, kind: "transport_error", reason: "Gate was interrupted by session restoration" }
							: verified,
						verified.ok ? "session_interruption" : "restore",
						verified.ok ? "session_switch" : "transport_error",
					);
				}
				restoredGateBecameOperational =
					(state.phase as LeanFlowState["phase"]) === "building" &&
					state.gateRetryMode === "operational" &&
					state.operationalRetrySnapshot !== undefined;
			}
		}
		if (!restoredGateBecameOperational && state.phase === "building" && state.gateRetryMode === "operational") {
			if (!state.operationalRetrySnapshot || !state.finalizedGateSnapshot) {
				await routeGateSnapshotFailure(
					ctx,
					{
						ok: false,
						kind: "lease_invalid",
						reason: "restored operational retry lacks its durable provenance identity",
					},
					"restore",
				);
			} else {
				const verified = await verifyDurableFinalizedSnapshot(ctx, undefined, true);
				const migrated =
					verified.ok && (await recoverLegacyEvidenceRecord(ctx, verified.value, false));
				if (!migrated && !verified.ok) {
					await routeGateSnapshotFailure(ctx, verified, "restore", "transport_error");
				}
			}
		}


		if (state.phase === "repair_preparing") {
			// Repair transactions reconcile from their durable lease and BUILD
			// record only; the generic round reconciliation below would misread
			// the pending round and corrupt gateAttempt.
			if (!state.repairLease) {
				state.phase = "awaiting_human";
				state.recoveryAction = "flowcontinue_rebuild_checkpoint";
				await writeRunMarker(ctx, "paused");
				ctx.ui.notify(
					"LeanFlow: repair preparation has no durable transaction lease; use /flowcontinue or /flowcancel.",
					"warning",
				);
			} else {
				// A restored lease keeps its durable transaction ID. The runtime
				// identity is freshly bound to this restore activation by the
				// effect executor, so replay is serial and idempotent.
				await executeGateEffects(ctx, [{ kind: "begin_repair_round" }], undefined, true);
			}
		} else if (state.phase === "building") {
			try {
				const record = await readBuildRecordForReconciliation(ctx);
				state.currentBuildRound = record.round;
				state.gateAttempt =
					state.gateRetryMode === "operational" || state.gateRetryMode === "evidence"
						? record.round
						: Math.max(0, record.round - 1);
			} catch (error) {
				await routeGateSnapshotFailure(
					ctx,
					{
						ok: false,
						kind: "record_invalid",
						reason: `BUILD record reconciliation failed: ${evidenceFailureMessage(error)}`,
					},
					"restore",
				);
			}
		}

		const violations = checkInvariants(state);
		if (violations.length > 0) {
			ctx.ui.notify(`LeanFlow invariant violation: ${violations.join("; ")}`, "warning");
		}
		if (restoredFromLegacy || reconciliationFingerprint(state) !== fingerprintBeforeReconcile) {
			persist();
		}

		resumePhaseTiming(state);
		updateStatus(ctx);
	};

	const restoreSessionState = async (event: unknown, ctx: ExtensionContext): Promise<void> => {
		const previous = restoreTail.catch(() => undefined);
		const current = previous.then(async () => {
			advanceBuildActivation();
			await restoreSessionStateImpl(event, ctx);
		});
		restoreTail = current.catch(() => undefined);
		await current;
	};
	async function refreshSettledPlanMutations(toolCallIds: Iterable<string>, ctx: ExtensionContext): Promise<void> {
		for (const toolCallId of toolCallIds) {
			const operation = pendingControlOperations.resolveTransport(toolCallId);
			if (operation?.kind !== "proposal_mutation") continue;
			if (!operation || !controlOperationIsCurrent(ctx, operation.identity, operation.payload.artifact)) continue;
			await refreshCanonicalPlanState(ctx, "mutation", operation.identity);
			return;
		}
	}

	pi.on("turn_end", async (event, ctx) => {
		await refreshSettledPlanMutations(
			event.toolResults.map((result) => result.toolCallId),
			ctx,
		);
	});

	pi.on("agent_end", async (event, ctx) => {
		const willContinue =
			typeof event === "object" && event !== null && "willContinue" in event && event.willContinue === true;
		const settledToolCallIds =
			typeof event === "object" && event !== null && "messages" in event && Array.isArray(event.messages)
				? event.messages.flatMap((message) =>
						typeof message === "object" &&
						message !== null &&
						"toolCallId" in message &&
						typeof message.toolCallId === "string"
							? [message.toolCallId]
							: [],
					)
				: [];
		await refreshSettledPlanMutations(settledToolCallIds, ctx);
		if (!willContinue && pendingControlOperations.count("proposal_mutation") > 0) {
			await refreshSettledPlanMutations(pendingControlOperations.pendingTransport("proposal_mutation"), ctx);
		}
		pendingEvidenceObservations.clear();
		if (state.phase === "finalizing" && !willContinue) {
			transitionPhase(state, "idle");
			persist();
			updateStatus(ctx);
		}
	});
	pi.on("session_start", restoreSessionState);
	pi.on("session_switch", restoreSessionState);
	pi.on("session_branch", restoreSessionState);
	pi.on("session_tree", restoreSessionState);
	pi.on("session_shutdown", async () => {
		advanceBuildActivation();
		pendingEvidenceObservations.clear();
	});

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

			// Keep every artifact component ASCII-bounded while preserving task identity.
			const slug = taskSlug(task);
			if (
				state.runMarkerArtifact &&
				(state.runMarkerStatus === "awaiting_approval" || state.runMarkerStatus === "building")
			) {
				const markerOperation = captureControlOperation(ctx, state.planArtifact);
				await writeRunMarker(ctx, "abandoned", markerOperation);
				if (!controlOperationIsCurrent(ctx, markerOperation, state.planArtifact)) return;
			}

			pendingEvidenceObservations.clear();

			// Initialize state machine and the first observable phase.
			const now = Date.now();
			advanceBuildActivation();
			state = {
				...defaultState(),
				phase: "planning",
				stateVersion: STATE_VERSION,
				phaseStartedAt: now,
				scoutCalls: 0,
				runId: randomUUID(),
				controlSessionId: buildSessionId(ctx),
				controlOperationEpoch: activationEpoch,
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

	const { z } = pi.zod;
	const captureBaselineParameters = z.object({}).strict();
	const runValidationParameters = z
		.object({
			validationId: z.string().min(1),
		})
		.strict();
	const finalizeArtifactsParameters = z.object({}).strict();
	const approvedValidationInstructions = (
		contract: LeanFlowState["approvedValidationContract"] = state.approvedValidationContract,
	): string =>
		[
			"Approved validation IDs (execute each with leanflow_run_validation):",
			...(contract?.validations ?? []).map((validation) => `- ${validation.id}: ${validation.displayCommand}`),
		].join("\n");

	pi.registerTool<typeof captureBaselineParameters>({
		name: "leanflow_capture_baseline",
		label: "Capture LeanFlow Baseline",
		description: "Capture the immutable BUILD HEAD and status after the required initial LSP probe and before repository mutations.",
		parameters: captureBaselineParameters,
		strict: true,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow baseline capture failed: ${message}` }],
				isError: true,
			});
			let identity: BuildOperationIdentity;
			let validationInstructions: string;
			try {
				const round = state.repairLease ? state.repairLease.toRound : expectedGateRoundForSnapshot();
				identity = captureBuildOperationIdentity(ctx, round);
				validationInstructions = approvedValidationInstructions(state.approvedValidationContract);
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
			const release = await acquireBuildRecordLock(identity);
			try {
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				if (state.lspProbeStatus === "pending") return fail("complete the required initial LSP diagnostics probe first.");
				if (pendingEvidenceObservations.size > 0) {
					return fail("a BUILD observation is still unpersisted; run /flowcancel and start a new run.");
				}
				if (state.baselineCaptured === true) return fail("the immutable BUILD baseline is already captured.");
				if (state.buildMutationObserved === true) {
					return fail("a repository mutation was already authorized; run /flowcancel and start a new run.");
				}
				const record = await loadBuildRecordForIdentity(identity);
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				if (record.baseline) {
					state.baselineCaptured = true;
					persist();
					return {
						content: [
							{
								type: "text" as const,
								text: `LeanFlow immutable BUILD baseline already captured at ${record.baseline.head}.\n${validationInstructions}`,
							},
						],
					};
				}
				const headResult = await runGit(ctx, ["rev-parse", "HEAD"], signal);
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				const statusResult = await runGit(ctx, ["status", "--short", "--untracked-files=all"], signal);
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				const head = headResult.stdout.trim();
				if (!head || head.includes("\n")) throw new Error("git rev-parse HEAD returned an invalid commit identity");
				record.baseline = {
					head,
					status: statusResult.stdout.trimEnd(),
					capturedAt: Date.now(),
				};
				if (!(await writeBuildJsonAtomically(ctx, identity, identity.recordPath, record))) {
					return discardedBuildOperation("baseline capture");
				}
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				state.baselineCaptured = true;
				persist();
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow immutable BUILD baseline captured at ${head}.\n${validationInstructions}`,
						},
					],
				};
			} catch (error) {
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("baseline capture");
				return fail(evidenceFailureMessage(error));
			} finally {
				release();
			}
		},
	});
	pi.registerTool<typeof runValidationParameters>({
		name: "leanflow_run_validation",
		label: "Run Approved LeanFlow Validation",
		description:
			"Execute one approved Verification entry by validation ID without shell parsing, and bind its result to repository fingerprints.",
		parameters: runValidationParameters,
		strict: true,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow validation failed: ${message}` }],
				isError: true,
			});
			let identity: BuildOperationIdentity;
			let validation: NonNullable<LeanFlowState["approvedValidationContract"]>["validations"][number] | undefined;
			try {
				identity = captureBuildOperationIdentity(ctx, expectedGateRoundForSnapshot());
				validation = state.approvedValidationContract?.validations.find((candidate) => candidate.id === params.validationId);
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
			if (!validation) return fail(`validation ID ${JSON.stringify(params.validationId)} is not approved.`);
			const authorityController = new AbortController();
			validationAbortControllers.set(identity.operationId, authorityController);
			const combined = combineValidationSignals(signal, authorityController);
			const cwd = ctx.cwd;
			const release = await acquireBuildRecordLock(identity);
			try {
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("validation");
				if (state.gateRetryMode === "operational") {
					return fail("operational recovery may only redispatch the already-finalized snapshot.");
				}
				if (state.baselineCaptured !== true) return fail("capture the immutable BUILD baseline first.");
				if (
					state.finalizedGateSnapshot ||
					state.operationalRetrySnapshot ||
					(state.writtenArtifacts?.length ?? 0) > 0
				) {
					state.finalizedGateSnapshot = undefined;
					state.finalizationCommitNonce = undefined;
					state.operationalRetrySnapshot = undefined;
					state.writtenArtifacts = [];
					try {
						persist();
					} catch (error) {
						return fail(`prior Gate authority could not be invalidated: ${evidenceFailureMessage(error)}`);
					}
				}
				const startedAt = Date.now();
				let before: RepositoryFingerprint;
				try {
					before = await captureRepositoryFingerprint(ctx, combined.signal);
				} catch (error) {
					if (!isBuildOperationCurrent(ctx, identity) || authorityController.signal.aborted) {
						return discardedBuildOperation("validation");
					}
					return fail(`repository fingerprint before validation is unavailable: ${evidenceFailureMessage(error)}`);
				}
				if (!isBuildOperationCurrent(ctx, identity) || authorityController.signal.aborted) {
					return discardedBuildOperation("validation");
				}
				const execution = await pi.exec(validation.executable, validation.argv, { cwd, signal: combined.signal }).then(
					(result) => ({ ok: true as const, result }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				if (!isBuildOperationCurrent(ctx, identity) || authorityController.signal.aborted) {
					return discardedBuildOperation("validation");
				}
				if (!execution.ok) return fail(`execution could not start: ${evidenceFailureMessage(execution.error)}`);
				const result = execution.result;
				const finishedAt = Date.now();
				let after: RepositoryFingerprint | undefined;
				let fingerprintError: string | undefined;
				try {
					after = await captureRepositoryFingerprint(ctx, combined.signal);
				} catch (error) {
					if (!isBuildOperationCurrent(ctx, identity) || authorityController.signal.aborted) {
						return discardedBuildOperation("validation");
					}
					fingerprintError = evidenceFailureMessage(error);
				}
				if (!isBuildOperationCurrent(ctx, identity) || authorityController.signal.aborted) {
					return discardedBuildOperation("validation");
				}
				const observation: BuildEvidenceObservationV3 = {
					toolCallId,
					operationId: identity.operationId,
					runId: identity.runId,
					round: identity.round,
					planDigest: identity.planDigest,
					approvedValidationDigest: identity.approvedValidationDigest,
					toolName: "validation",
					validationId: validation.id,
					command: validation.displayCommand,
					executable: validation.executable,
					argv: [...validation.argv],
					repositoryFingerprintBefore: before.combinedDigest,
					repositoryFingerprintAfter: after?.combinedDigest,
					startedAt,
					finishedAt,
					isError: result.code !== 0 || result.killed || fingerprintError !== undefined,
					exitCode: result.code,
					timedOut: result.killed,
					text: combinedExecOutput(result.stdout, result.stderr),
				};
				try {
					if (!(await appendBuildObservationUnlocked(ctx, identity, observation))) {
						return discardedBuildOperation("validation");
					}
				} catch (error) {
					if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("validation");
					return fail(`result could not be committed to the BUILD record: ${evidenceFailureMessage(error)}`);
				}
				if (!isBuildOperationCurrent(ctx, identity)) return discardedBuildOperation("validation");
				state.finalizedGateSnapshot = undefined;
				state.finalizationCommitNonce = undefined;
				state.writtenArtifacts = [];
				if (!after || before.combinedDigest !== after.combinedDigest) {
					state.buildMutationObserved = true;
					if (state.gateRetryMode === "evidence") {
						state.gateRetryMode = undefined;
						resetBlockedRecovery(state);
					}
				}
				persist();
				if (fingerprintError) {
					return fail(`repository fingerprint after validation is unavailable: ${fingerprintError}`);
				}
				if (before.combinedDigest !== after!.combinedDigest) {
					return fail("the approved validation mutated repository state; its evidence is stale.");
				}
				if (result.code !== 0 || result.killed) {
					return fail(
						`${validation.displayCommand} exited ${result.code}${result.killed ? " after interruption" : ""}:\n${observation.text ?? ""}`,
					);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow validation ${validation.id} passed without repository mutation.\n${observation.text ?? ""}`,
						},
					],
				};
			} finally {
				combined.cleanup();
				validationAbortControllers.delete(identity.operationId);
				release();
			}
		},
	});


	pi.registerTool<typeof finalizeArtifactsParameters>({
		name: "leanflow_finalize_artifacts",
		label: "Finalize LeanFlow Artifacts",
		description:
			"Mechanically generate and atomically bind the plan, validation contract, BUILD record, repository fingerprint, and three Gate artifacts.",
		parameters: finalizeArtifactsParameters,
		strict: true,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow artifact finalization failed: ${message}` }],
				isError: true,
			});
			let operation: FinalizationOperation;
			try {
				operation = captureFinalizationOperation(ctx, expectedGateRoundForSnapshot());
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
			const release = await acquireBuildRecordLock(operation);
			try {
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				if (state.gateRetryMode === "operational") {
					return fail("an operational Gate retry must reuse the existing finalized manifest unchanged.");
				}
				if (state.lspProbeStatus === "pending") return fail("the required LSP diagnostics probe is incomplete.");
				if (state.baselineCaptured !== true) return fail("capture the immutable BUILD baseline first.");
				if (pendingEvidenceObservations.size > 0) {
					return fail("one or more BUILD observations are still unpersisted.");
				}

				const planContent = await fs.readFile(operation.planPath, "utf8");
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				if (
					runIdFromPlan(planContent) !== operation.runId ||
					planDigest(planContent) !== operation.planDigest ||
					parseValidationContract(planContent, operation.planDigest).contract?.digest !== operation.approvedValidationDigest
				) {
					throw new Error("canonical plan or approved validation contract changed after approval");
				}

				const record = await loadBuildRecordForIdentity(operation);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				if (!record.baseline) throw new Error("the internal BUILD record has no immutable baseline");
				const gitEvidence: GitCommandEvidence[] = [
					{
						command: "git rev-parse HEAD",
						label: "Baseline HEAD captured by leanflow_capture_baseline",
						exitCode: 0,
						output: `${record.baseline.head}\n`,
					},
					{
						command: "git status --short --untracked-files=all",
						label: "Baseline status captured by leanflow_capture_baseline",
						exitCode: 0,
						output: record.baseline.status,
					},
				];

				const finalHeadResult = await runGit(ctx, ["rev-parse", "HEAD"], signal, [0], "Final HEAD");
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				gitEvidence.push(finalHeadResult.evidence);
				const finalHead = finalHeadResult.stdout.trim();
				if (finalHead !== record.baseline.head) {
					throw new Error(`final HEAD ${finalHead || "(empty)"} differs from baseline HEAD ${record.baseline.head}`);
				}
				const finalStatusResult = await runGit(
					ctx,
					["status", "--short", "--untracked-files=all"],
					signal,
					[0],
					"Final status",
				);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				gitEvidence.push(finalStatusResult.evidence);
				const finalStatus = finalStatusResult.stdout.trimEnd();
				const trackedDiffResult = await runGit(
					ctx,
					["diff", "--binary", record.baseline.head, "--"],
					signal,
					[0],
					"Tracked complete binary diff",
				);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				gitEvidence.push(trackedDiffResult.evidence);
				const trackedNamesResult = await runGit(
					ctx,
					["diff", "--name-only", "-z", record.baseline.head, "--"],
					signal,
					[0],
					"Tracked changed paths",
				);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				const trackedPaths = parseNulList(trackedNamesResult.stdout, trackedNamesResult.evidence.command);
				gitEvidence.push({
					...trackedNamesResult.evidence,
					output: trackedPaths.map((candidate) => JSON.stringify(candidate)).join("\n"),
				});
				const untrackedResult = await runGit(
					ctx,
					["ls-files", "--others", "--exclude-standard", "-z"],
					signal,
					[0],
					"Sorted untracked paths",
				);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				const untrackedPaths = parseNulList(untrackedResult.stdout, untrackedResult.evidence.command)
					.filter((relative) => !isLeanFlowInternalRepositoryPath(relative))
					.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
				gitEvidence.push({
					...untrackedResult.evidence,
					output: untrackedPaths.map((candidate) => JSON.stringify(candidate)).join("\n"),
				});

				const untrackedPatches: UntrackedPatch[] = [];
				const emptyUntrackedFiles: string[] = [];
				for (const relative of untrackedPaths) {
					const { size } = await validateUntrackedPath(ctx, relative);
					if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
					if (size === 0) {
						emptyUntrackedFiles.push(relative);
						continue;
					}
					const patchResult = await runGit(
						ctx,
						["diff", "--no-index", "--binary", "--", os.devNull, relative],
						signal,
						[1],
						`Untracked binary diff: ${relative}`,
					);
					if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
					untrackedPatches.push({ path: relative, patch: patchResult.stdout });
					gitEvidence.push(patchResult.evidence);
				}

				const completeDiff = composeCompleteDiff(trackedDiffResult.stdout, untrackedPatches, emptyUntrackedFiles);
				const repositoryFingerprint = await captureRepositoryFingerprint(ctx, signal);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				const validationStates = validationSemanticStates(
					record,
					operation.validationContract,
					repositoryFingerprint.combinedDigest,
				);
				const incomplete = validationStates.filter((validation) => validation.status !== "passed");
				if (incomplete.length > 0) {
					throw new Error(
						`required validation evidence is incomplete: ${incomplete.map((validation) => `${validation.id}=${validation.status}`).join(", ")}`,
					);
				}
				const validations = selectValidationObservations(
					record,
					operation.validationContract,
					repositoryFingerprint.combinedDigest,
				);
				const changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])];
				const rendered = renderBuildArtifacts({
					planArtifact: operation.planArtifact,
					record,
					finalHead,
					finalStatus,
					changedPaths,
					validations,
					gitCommands: gitEvidence,
					completeDiff,
				});
				const outputs = [
					{ kind: "build", filePath: operation.buildPath, content: rendered.build },
					{ kind: "diff", filePath: operation.diffPath, content: rendered.diff },
					{ kind: "evidence", filePath: operation.evidencePath, content: rendered.evidence },
				] as const;

				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");

				const verified: string[] = [];
				const artifactDigests = new Map<string, string>();
				for (const output of outputs) {
					if (!(await writeBuildTextAtomically(ctx, operation, output.filePath, output.content))) {
						return discardedBuildOperation("artifact finalization");
					}
					const persisted = await fs.readFile(output.filePath, "utf8");
					if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
					const expectedBytes = Buffer.byteLength(output.content, "utf8");
					const actualBytes = Buffer.byteLength(persisted, "utf8");
					const expectedDigest = sha256Hex(output.content);
					const actualDigest = sha256Hex(persisted);
					if (expectedBytes !== actualBytes || expectedDigest !== actualDigest) {
						throw new Error(`canonical ${output.kind} artifact failed byte/hash verification`);
					}
					artifactDigests.set(output.kind, actualDigest);
					verified.push(`${output.kind}.md ${actualBytes} bytes sha256:${actualDigest}`);
				}

				const recordText = await fs.readFile(operation.recordPath, "utf8");
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				parseBuildEvidenceRecord(JSON.parse(recordText), operation);
				const manifest = createFinalizedGateSnapshot({
					runId: operation.runId,
					planSlug: operation.planSlug,
					planDigest: operation.planDigest,
					approvedValidationDigest: operation.approvedValidationDigest,
					buildRecordRound: operation.round,
					buildRecordDigest: sha256Hex(recordText),
					buildArtifactDigest: artifactDigests.get("build")!,
					diffArtifactDigest: artifactDigests.get("diff")!,
					evidenceArtifactDigest: artifactDigests.get("evidence")!,
					repositoryFingerprint,
					validationStates,
				});
				if (!(await writeBuildJsonAtomically(ctx, operation, operation.finalizedSnapshotPath, manifest))) {
					return discardedBuildOperation("artifact finalization");
				}
				const persistedManifest = parseFinalizedGateSnapshot(
					JSON.parse(await fs.readFile(operation.finalizedSnapshotPath, "utf8")),
				);
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				if (!persistedManifest || finalizedGateSnapshotDigest(persistedManifest) !== finalizedGateSnapshotDigest(manifest)) {
					throw new Error("finalized Gate manifest failed atomic persistence verification");
				}
				const resumeLegacyPass = state.recoveryAction === "refinalize_legacy_pass";
				const candidate: LeanFlowState = {
					...state,
					finalizedGateSnapshot: persistedManifest,
					finalizationCommitNonce: persistedManifest.finalizationCommitNonce,
					operationalRetrySnapshot: undefined,
					writtenArtifacts: [...REQUIRED_ARTIFACTS],
					...(resumeLegacyPass
						? {
								phase: "finalizing" as const,
								terminalOutcome: "pass" as const,
								baselineCaptured: false,
								gateRetryMode: undefined,
								recoveryAction: undefined,
								blockedRecovery: undefined,
							}
						: {}),
				};
				try {
					persistCandidateState(candidate);
				} catch (error) {
					if (!branchContainsFinalizationCandidate(ctx, candidate)) {
						throw new Error(`finalized Gate authority could not be persisted: ${evidenceFailureMessage(error)}`);
					}
					// appendEntry may commit and then throw. The exact nonce-bound
					// branch entry proves durable success despite the ambiguous return.
					hasPersistedLeanFlowState = true;
				}
				state = candidate;
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow Gate artifacts and manifest finalized:\n${verified.join("\n")}\nmanifest sha256:${finalizedGateSnapshotDigest(persistedManifest)}`,
						},
					],
				};
			} catch (error) {
				if (!isBuildOperationCurrent(ctx, operation)) return discardedBuildOperation("artifact finalization");
				return fail(evidenceFailureMessage(error));
			} finally {
				release();
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool guard + phase transitions (pre-execution)
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "idle") return;
		if (state.phase === "finalizing") {
			if (isFinalizingTodoCompletion(event)) return;
			return {
				block: true,
				reason: "LeanFlow: no tools are allowed while producing the terminal response.",
			};
		}

		let scheduledObservationIdentity: BuildOperationIdentity | undefined;
		if (state.phase === "building" && state.gateRetryMode !== "operational") {
			try {
				scheduledObservationIdentity = captureBuildOperationIdentity(ctx, expectedGateRoundForSnapshot());
			} catch {
				// Calls without a complete immutable BUILD identity cannot produce evidence.
			}
		}

		if (event.toolName === "task" && !isTaskToolCall(event)) {
			return {
				block: true,
				reason: "LeanFlow guard: task input must be a plain object.",
			};
		}
		if (state.phase === "awaiting_human" && isTaskToolCall(event)) {
			return {
				block: true,
				reason: "LeanFlow: no subagents are allowed while Gate failure is paused.",
			};
		}
		const routedDeviceCall = routedLeanFlowDeviceCall(event);
		if (routedDeviceCall === "invalid") {
			return {
				block: true,
				reason: "LeanFlow guard: routed extension tool input does not match its strict schema.",
			};
		}
		const issueReport = issueReportContent(event) !== undefined;


		const canonicalPlanArtifact = expectedPlanArtifact(state);
		const canonicalPlanMutation =
			canonicalPlanArtifact !== undefined && toolTargetsPath(ctx, event, canonicalPlanArtifact);

		if (targetsReservedLeanFlowState(ctx, event)) {
			return {
				block: true,
				reason: "LeanFlow: internal workflow state artifacts are extension-owned.",
			};
		}

		if (state.phase === "building" && targetsCanonicalGateArtifact(ctx, event, state)) {
			return {
				block: true,
				reason: "LeanFlow: Gate artifacts are extension-generated; use leanflow_finalize_artifacts.",
			};
		}

		const approvalConfirmed =
			state.phase === "building" || (state.phase === "awaiting_approval" && (await nativeApprovalConfirmed(ctx)));

		if (
			canonicalPlanMutation &&
			(state.phase === "building" || state.phase === "gating" || state.phase === "repair_preparing")
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

		const effect = classifyToolEffect(ctx, event, canonicalPlanArtifact, routedDeviceCall, issueReport);
		if (effect === "unknown") {
			return {
				block: true,
				reason: "LeanFlow: unclassified tools are blocked during an active LeanFlow run.",
			};
		}
		if (state.phase === "gating" && effect !== "read_only") {
			return {
				block: true,
				reason: "LeanFlow: Gate snapshot is immutable while review is in flight.",
			};
		}
		const lspProbePending = state.phase === "building" && state.lspProbeStatus === "pending";
		const baselinePending =
			state.phase === "building" && state.lspProbeStatus !== "pending" && state.baselineCaptured !== true;
		const locked =
			state.phase === "planning" ||
			(state.phase === "awaiting_approval" && !approvalConfirmed) ||
			lspProbePending ||
			baselinePending;
		const planningScout =
			state.phase === "planning" && isTaskToolCall(event) && roles.length > 0 && roles.every((role) => role === "scout");
		const baselineCapture =
			baselinePending &&
			(event.toolName === "leanflow_capture_baseline" || routedDeviceCall === "capture_baseline");
		const allowedWhileLocked =
			effect === "read_only" ||
			((state.phase === "planning" || state.phase === "awaiting_approval") &&
				effect === "canonical_plan_mutation") ||
			(state.phase === "awaiting_approval" && isProposalWrite(event)) ||
			baselineCapture ||
			issueReport ||
			planningScout;
		if (locked && !allowedWhileLocked) {
			return {
				block: true,
				reason:
					state.phase !== "building"
						? "LeanFlow: this tool or operation is not explicitly read-only before native plan approval."
						: lspProbePending
							? "LeanFlow: only read-only tools and a valid LSP diagnostics probe are allowed before the first BUILD mutation."
							: "LeanFlow: capture the immutable BUILD baseline before repository mutations.",
			};
		}
		const gateTask =
			isTaskToolCall(event) && roles.length > 0 && roles.every((role) => role === "gate");
		const approvedValidationTool =
			event.toolName === "leanflow_run_validation" || routedDeviceCall === "run_validation";
		const finalizeTool =
			event.toolName === "leanflow_finalize_artifacts" || routedDeviceCall === "finalize_artifacts";
		if (
			state.phase === "building" &&
			state.gateRetryMode === "operational" &&
			effect !== "read_only" &&
			!gateTask &&
			!issueReport
		) {
			return {
				block: true,
				reason: "LeanFlow: operational recovery permits only read-only inspection and Gate redispatch.",
			};
		}
		if (
			state.phase === "building" &&
			state.gateRetryMode === "evidence" &&
			effect !== "read_only" &&
			!gateTask &&
			!approvedValidationTool &&
			!finalizeTool &&
			!issueReport
		) {
			return {
				block: true,
				reason: "LeanFlow: evidence recovery permits only approved validation IDs and artifact finalization.",
			};
		}
		if (state.phase === "repair_preparing") {
			return {
				block: true,
				reason: "LeanFlow: repair preparation is in progress; no tools are allowed until the next BUILD round is ready.",
			};
		}
		if (state.phase === "awaiting_human" && effect !== "read_only") {
			return {
				block: true,
				reason: "LeanFlow: only read-only tools are allowed while Gate failure is paused.",
			};
		}


		if (isTaskToolCall(event)) {
			const scoutCount = roles.filter((role) => role === "scout").length;
			const gateCount = roles.filter((role) => role === "gate").length;
			if (gateCount > 0) {
				const artifacts = expectedGateArtifacts(state);
				if (!artifacts) {
					return { block: true, reason: "LeanFlow guard: Gate call has no active canonical artifact identity." };
				}
				const shape = validateGateTaskCall(event.input, artifacts);
				if (shape.block) return { block: true, reason: shape.reason };
				// writtenArtifacts is advisory UI state. The atomic manifest and
				// its bound digests are the only Gate-readiness authority.
				const preflightOperation = captureControlOperation(ctx, artifacts.plan);
				if (gatePreflightHook) await gatePreflightHook();
				if (!controlOperationIsCurrent(ctx, preflightOperation, artifacts.plan)) {
					return { block: true, reason: "LeanFlow: Gate preflight authority changed before dispatch." };
				}
				const snapshot = await prepareGateSnapshot(ctx);
				if (!controlOperationIsCurrent(ctx, preflightOperation, artifacts.plan)) {
					return { block: true, reason: "LeanFlow: Gate preflight authority changed before dispatch." };
				}
				if (!snapshot.ok) {
					recordStats(() => recordGateReadinessBlock(state));
					await routeGateSnapshotFailure(ctx, snapshot, "preflight", "tool_error", preflightOperation);
					return {
						block: true,
						reason: `LeanFlow: Gate unavailable — complete build evidence first (${snapshot.reason}).`,
					};
				}
				reduceGate(state, {
					type: "gate_dispatch",
					toolCallId: event.toolCallId,
					runId: state.runId ?? "",
					snapshotDigest: snapshot.snapshotDigest,
					planDigest: snapshot.planDigest,
					buildRecordRound: snapshot.buildRecordRound,
					repositoryFingerprint: snapshot.repositoryFingerprint,
					reuseCycle: state.gateRetryMode === "operational" || state.gateRetryMode === "evidence",
					now: Date.now(),
				});
				const gateIdentity = captureControlOperation(ctx, snapshot.snapshotDigest);
				pendingControlOperations.register(event.toolCallId, gateIdentity, {
					kind: "gate_call",
					payload: { snapshotDigest: snapshot.snapshotDigest },
				});
			}
			state.scoutCalls += scoutCount;
			if (roles.length > 0) {
				persist();
				updateStatus(ctx);
			}
		}

		if (
			canonicalPlanMutation &&
			(state.phase === "planning" || (state.phase === "awaiting_approval" && !approvalConfirmed))
		) {
			const operation = captureControlOperation(ctx, canonicalPlanArtifact);
			pendingControlOperations.register(event.toolCallId, operation, {
				kind: "proposal_mutation",
				payload: { artifact: canonicalPlanArtifact },
			});
		}

		const diagnosticsTarget = lspDiagnosticsTarget(event);
		const lspOperation =
			state.phase === "building" && state.lspProbeStatus === "pending" && diagnosticsTarget !== undefined
				? captureControlOperation(ctx, diagnosticsTarget)
				: undefined;
		if (
			lspOperation &&
			diagnosticsTarget !== undefined &&
			(await isUsableLspTarget(ctx, diagnosticsTarget)) &&
			controlOperationIsCurrent(ctx, lspOperation, diagnosticsTarget)
		) {
			pendingControlOperations.register(event.toolCallId, lspOperation, {
				kind: "lsp_probe",
				payload: { lspTarget: diagnosticsTarget },
			});
			state.lspLease = {
				toolCallId: event.toolCallId,
				kind: "lsp",
				runId: state.runId ?? "",
				cycle: 0,
				startedAt: Date.now(),
				lspTarget: diagnosticsTarget,
			};
			persist();
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
			if (pendingControlOperations.count("proposal_mutation") > 0) {
				return {
					block: true,
					reason: "LeanFlow: wait for the canonical plan mutation to finish before proposing.",
				};
			}
			const expected = state.planArtifact ?? canonicalPlanArtifact;
			if (!expected || event.input.content.trim() !== state.planSlug || !state.runId) {
				return {
					block: true,
					reason: "LeanFlow: write the canonical plan and durable run marker before proposing its exact slug.",
				};
			}
			const proposalOperation = captureControlOperation(ctx, expected);
			if (proposalLookupHook) await proposalLookupHook();
			if (!controlOperationIsCurrent(ctx, proposalOperation, expected)) {
				return { block: true, reason: "LeanFlow: proposal authority changed before dispatch." };
			}
			const lookup = await lookupFreshRecovery(ctx, expected);
			if (!controlOperationIsCurrent(ctx, proposalOperation, expected)) {
				return { block: true, reason: "LeanFlow: proposal authority changed before dispatch." };
			}
			if (lookup.kind !== "valid" || lookup.marker.runId !== proposalOperation.runId) {
				return {
					block: true,
					reason: "LeanFlow: write the canonical plan and durable run marker before proposing its exact slug.",
				};
			}
			if (!(await refreshCanonicalPlanState(ctx, "proposal", proposalOperation))) {
				return {
					block: true,
					reason: "LeanFlow: the current canonical plan is invalid; repair it before requesting approval.",
				};
			}
			const approvalIdentity = captureControlOperation(ctx, expected);
			pendingControlOperations.register(event.toolCallId, approvalIdentity, {
				kind: "approval_write",
				payload: { artifact: expected },
			});
		}

		if (state.phase === "building" && effect === "repository_mutation") {
			state.buildMutationObserved = true;
			if ((state.writtenArtifacts?.length ?? 0) > 0) state.writtenArtifacts = [];
			persist();
		}
		if (state.phase === "building" && state.gateRetryMode !== "operational") {
			if (
				scheduledObservationIdentity &&
				isBuildOperationCurrent(ctx, scheduledObservationIdentity) &&
				event.toolName === "bash" &&
				typeof event.input.command === "string" &&
				event.input.command.trim()
			) {
				pendingEvidenceObservations.set(event.toolCallId, {
					identity: scheduledObservationIdentity,
					toolName: "bash",
					command: event.input.command,
				});
			} else if (
				scheduledObservationIdentity &&
				isBuildOperationCurrent(ctx, scheduledObservationIdentity) &&
				effect === "read_only"
			) {
				const lspRequest = parseLspObservationRequest(event);
				if (lspRequest) {
					pendingEvidenceObservations.set(event.toolCallId, {
						identity: scheduledObservationIdentity,
						toolName: "lsp",
						lspRequest,
					});
				}
			}
		}
	});

	// -----------------------------------------------------------------------
	// Post-execution: handoff assessment + gate verdict
	// -----------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		const pendingObservation = pendingEvidenceObservations.get(event.toolCallId);
		if (pendingObservation) {
			const details = isPlainRecord(event.details) ? event.details : undefined;
			const timedOut = typeof details?.timedOut === "boolean" ? details.timedOut : undefined;
			const asyncDetails = details && isPlainRecord(details.async) ? details.async : undefined;
			const asyncRunning = asyncDetails?.state === "running";
			const explicitExitCode =
				typeof details?.exitCode === "number" && Number.isInteger(details.exitCode)
					? details.exitCode
					: undefined;
			const exitCode =
				pendingObservation.toolName === "bash" &&
				explicitExitCode === undefined &&
				!event.isError &&
				timedOut !== true &&
				!asyncRunning
					? 0
					: explicitExitCode;
			const observation: BuildEvidenceObservationV3 = {
				toolCallId: event.toolCallId,
				operationId: pendingObservation.identity.operationId,
				runId: pendingObservation.identity.runId,
				round: pendingObservation.identity.round,
				planDigest: pendingObservation.identity.planDigest,
				approvedValidationDigest: pendingObservation.identity.approvedValidationDigest,
				toolName: pendingObservation.toolName,
				...(pendingObservation.toolName === "bash"
					? { command: pendingObservation.command }
					: { lspRequest: pendingObservation.lspRequest }),
				isError: event.isError,
				...(exitCode !== undefined ? { exitCode } : {}),
				...(timedOut !== undefined ? { timedOut } : {}),
				text: flattenTextContent(event.content),
			};
			try {
				const appended = await appendBuildObservation(ctx, pendingObservation.identity, observation);
				if (pendingEvidenceObservations.get(event.toolCallId) === pendingObservation) {
					pendingEvidenceObservations.delete(event.toolCallId);
				}
				if (!appended) return;
			} catch (error) {
				if (pendingEvidenceObservations.get(event.toolCallId) === pendingObservation) {
					pendingEvidenceObservations.delete(event.toolCallId);
				}
				if (!isBuildOperationCurrent(ctx, pendingObservation.identity)) return;
				state.baselineCaptured = false;
				state.buildMutationObserved = true;
				state.writtenArtifacts = [];
				try {
					persist();
				} catch {
					// In-memory invalidation still prevents capture/finalization in this session.
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`LeanFlow: failed to persist BUILD observation: ${evidenceFailureMessage(error)}`,
						"warning",
					);
				}
			}
		}
		const controlOperation = pendingControlOperations.resolveTransport(event.toolCallId);
		const approvalOperation =
			event.toolName === "write" && controlOperation?.kind === "approval_write" ? controlOperation : undefined;
		if (approvalOperation) {
			const artifact = approvalOperation.payload.artifact;
			if (
				event.isError ||
				!artifact ||
				!controlOperationIsCurrent(ctx, approvalOperation.identity, artifact) ||
				state.planArtifact !== artifact
			) {
				return;
			}
			state.proposalBoundary = ctx.sessionManager.getBranch().length;
			state.proposedPlanArtifact = artifact;
			state.approvalRepairBoundary = undefined;
			state.approvedPlanArtifact = undefined;
			state.proposedPlanDigest = state.planDigest;
			state.lspProbeTarget = undefined;
			if (!(await writeRunMarker(ctx, "awaiting_approval", approvalOperation.identity))) return;
			persist();
			updateStatus(ctx);
			return;
		}

		const lspOperation = controlOperation?.kind === "lsp_probe" ? controlOperation : undefined;
		if (lspOperation) {
			const lspTarget = lspOperation.payload.lspTarget;
			if (
				!lspTarget ||
				!controlOperationIsCurrent(ctx, lspOperation.identity, lspTarget) ||
				state.phase !== "building" ||
				state.lspProbeStatus !== "pending" ||
				state.lspLease?.toolCallId !== event.toolCallId ||
				state.lspLease.lspTarget !== lspTarget
			) {
				return;
			}
			state.lspLease = undefined;
			state.lspProbeStatus = "completed";
			state.lspProbeTarget = lspTarget;
			persist();
			updateStatus(ctx);
			return;
		}

		const planOperation = controlOperation?.kind === "proposal_mutation" ? controlOperation : undefined;
		if (planOperation) {
			if (event.isError || !controlOperationIsCurrent(ctx, planOperation.identity, planOperation.payload.artifact)) {
				return;
			}
			await refreshCanonicalPlanState(ctx, "mutation", planOperation.identity);
			return;
		}

		const gateOperation = event.toolName === "task" && controlOperation?.kind === "gate_call" ? controlOperation : undefined;
		if (gateOperation) {
			const lease = state.gateLease;
			if (!lease || !gateControlOperationIsCurrent(ctx, gateOperation.identity, event.toolCallId)) return;
			const dispatchedPlanDigest = gateOperation.identity.planDigest;
			const snapshotCheck = await verifyGateSnapshot(ctx, lease);
			if (!gateControlOperationIsCurrent(ctx, gateOperation.identity, event.toolCallId)) return;
			if (!snapshotCheck.ok) {
				ctx.ui.notify(`LeanFlow: ${snapshotCheck.reason}; Gate result was discarded.`, "warning");
				await routeGateSnapshotFailure(ctx, snapshotCheck, "settlement", "tool_error", gateOperation.identity);
				return;
			}
			if (!event.isError && (await planDriftedDuringGate(ctx, dispatchedPlanDigest))) {
				if (!gateControlOperationIsCurrent(ctx, gateOperation.identity, event.toolCallId)) return;
				ctx.ui.notify("LeanFlow: plan drifted during Gate; Gate result was discarded.", "warning");
				await routeGateSnapshotFailure(
					ctx,
					{
						ok: false,
						kind: "plan_drift",
						reason: "canonical plan digest changed during Gate",
					},
					"settlement",
					"tool_error",
					gateOperation.identity,
				);
				return;
			}
			let result: ParsedGateResult | undefined;
			if (!event.isError) {
				const parsed = parseGateResult(event.content);
				if (!parsed.ok) {
					ctx.ui.notify(`LeanFlow: Gate result semantic validation failed: ${parsed.reason}`, "warning");
					await finishGateResult(undefined, true, ctx, "invalid_gate_output", gateOperation.identity);
					return;
				}
				result = parsed.result;
			}
			await finishGateResult(result, event.isError, ctx, "tool_error", gateOperation.identity);
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
			if (
				state.runMarkerStatus === "awaiting_approval" ||
				state.runMarkerStatus === "building" ||
				state.runMarkerStatus === "paused"
			) {
				const markerOperation = captureControlOperation(ctx, state.planArtifact);
				await writeRunMarker(ctx, "abandoned", markerOperation);
				if (!controlOperationIsCurrent(ctx, markerOperation, state.planArtifact)) return;
			}
			advanceBuildActivation();
			state.controlSessionId = buildSessionId(ctx);
			state.controlOperationEpoch = activationEpoch;
			pendingEvidenceObservations.clear();
			state.baselineCaptured = false;
			state.buildMutationObserved = false;
			state.gateLease = undefined;
			state.lspLease = undefined;
			state.gateDispatches = undefined;
			state.humanRepairCycles = undefined;
			state.lastGateFindings = undefined;
			transitionPhase(state, "idle");
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: run cancelled and recovery marker abandoned.", "info");
		},
	});

	pi.registerCommand("flowcontinue", {
		description: "Start a new human repair cycle after a paused Gate failure.",
		handler: async (args, ctx) => {
			if (state.phase !== "awaiting_human") {
				ctx.ui.notify("LeanFlow: No paused Gate failure to continue.", "warning");
				return;
			}

			const { effects } = reduceGate(state, { type: "human_continue", now: Date.now() });
			await executeGateEffects(ctx, effects);
			const phaseAfterSetup = activePhase();
			if (phaseAfterSetup !== "repair_preparing") {
				if (phaseAfterSetup === "awaiting_human") {
					ctx.ui.notify("LeanFlow: Cannot continue: repair setup failed; use /flowcontinue to retry.", "warning");
					return;
				}
				persist();
				updateStatus(ctx);
				ctx.ui.setEditorText(buildHumanRepairPrompt(state.runId, state.lastGateFindings, args));
				return;
			}
			ctx.ui.notify("LeanFlow: Cannot continue: repair setup did not complete.", "warning");
		},
	});

	pi.registerCommand("flowfinishfailed", {
		description: "Mark a paused Gate failure as failed and finalize the run.",
		handler: async (_args, ctx) => {
			if (state.phase !== "awaiting_human") {
				ctx.ui.notify("LeanFlow: No paused Gate failure to mark as failed.", "warning");
				return;
			}

			const { effects } = reduceGate(state, { type: "human_finish_failed", now: Date.now() });
			await executeGateEffects(ctx, effects);
			persist();
			updateStatus(ctx);
			ctx.ui.notify("LeanFlow: Marked run as failed; finalizing.", "info");
		},
	});

	pi.registerCommand("flowstatus", {
		description: "Show the current LeanFlow phase and deep Gate readiness.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await formatFlowStatus(ctx), "info");
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


/** Whether a write/edit targets any extension-generated canonical Gate artifact. */
function targetsCanonicalGateArtifact(ctx: ExtensionContext, event: ToolCallEvent, state: LeanFlowState): boolean {
	if (event.toolName !== "write" && event.toolName !== "edit") return false;
	return toolTargets(event).some((candidate) => artifactKind(ctx, candidate, state) !== undefined);
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


// ---------------------------------------------------------------------------
// Planner-only prompt — no Gate schema, no build artifact detail
// ---------------------------------------------------------------------------

function buildPlanningPrompt(task: string, slug: string, runId: string): string {
	return [
		`You are LeanFlow Planner (@plan). Task: ${task}`,
		"",
		"## User language",
		"All communication addressed to the user MUST be in Simplified Chinese.",
		"Write the decision-complete canonical plan in Simplified Chinese.",
		"Keep source code, commands, file paths, symbol names, API names, structured artifact keys, and verbatim tool or error output unchanged unless translation is necessary for comprehension.",
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

type GateFindingCategory =
	| "correctness"
	| "validation_failure"
	| "plan_deviation"
	| "missing_change"
	| "regression_risk"
	| "style"
	| "naming";
type GateFindingSeverity = "blocking" | "nonblocking";
interface GateFinding {
	category: GateFindingCategory;
	severity: GateFindingSeverity;
	file: string;
	location: string;
	issue: string;
	required_fix: string;
}
interface ParsedGateResult {
	verdict: GateOutcome;
	findings: GateFinding[];
	reasonCode?: BlockedReasonCode;
	evidenceIds?: string[];
	canonicalJson: string;
}

const GATE_FINDING_CATEGORIES = new Set<GateFindingCategory>([
	"correctness",
	"validation_failure",
	"plan_deviation",
	"missing_change",
	"regression_risk",
	"style",
	"naming",
]);
const GATE_BLOCKING_CATEGORIES = new Set<GateFindingCategory>([
	"correctness",
	"validation_failure",
	"plan_deviation",
	"missing_change",
	"regression_risk",
]);
const GATE_BLOCKED_REASON_CODES = new Set<BlockedReasonCode>([
	"missing_validation",
	"failed_validation",
	"stale_validation",
	"run_mismatch",
	"artifact_unreadable",
	"artifact_inconsistent",
	"build_record_invalid",
	"other_validation_failure",
]);

function parseGateResult(content: unknown): { ok: true; result: ParsedGateResult } | { ok: false; reason: string } {
	if (!Array.isArray(content)) return { ok: false, reason: "result has no text content" };
	for (const block of content) {
		if (!isPlainRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		const text = block.text;
		for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
			const candidate = extractBalancedJsonObject(text, start);
			if (!candidate) continue;
			let value: unknown;
			try {
				value = JSON.parse(candidate);
			} catch {
				continue;
			}
			if (!isPlainRecord(value) || !("verdict" in value)) continue;
			if (value.verdict !== "PASS" && value.verdict !== "FAIL" && value.verdict !== "BLOCKED") {
				return { ok: false, reason: "verdict must be PASS, FAIL, or BLOCKED" };
			}
			if (!Array.isArray(value.findings)) return { ok: false, reason: "findings must be an array" };
			const findings: GateFinding[] = [];
			for (const finding of value.findings) {
				if (!isPlainRecord(finding)) return { ok: false, reason: "every finding must be an object" };
				const { category, severity, file, location, issue, required_fix } = finding;
				if (typeof category !== "string" || !GATE_FINDING_CATEGORIES.has(category as GateFindingCategory)) {
					return { ok: false, reason: "finding category is invalid" };
				}
				if (severity !== "blocking" && severity !== "nonblocking") {
					return { ok: false, reason: "finding severity is invalid" };
				}
				if (
					typeof file !== "string" ||
					typeof location !== "string" ||
					typeof issue !== "string" ||
					typeof required_fix !== "string" ||
					file.trim().length === 0 ||
					location.trim().length === 0 ||
					issue.trim().length === 0 ||
					required_fix.trim().length === 0
				) {
					return { ok: false, reason: "finding file, location, issue, and required_fix must be non-empty strings" };
				}
				findings.push({
					category: category as GateFindingCategory,
					severity,
					file: file.trim(),
					location: location.trim(),
					issue: issue.trim(),
					required_fix: required_fix.trim(),
				});
			}
			const blocking = findings.filter((finding) => finding.severity === "blocking");
			if (value.verdict === "PASS" && blocking.length > 0) {
				return { ok: false, reason: "PASS must not contain blocking findings" };
			}
			if (
				value.verdict === "FAIL" &&
				(blocking.length === 0 || blocking.some((finding) => !GATE_BLOCKING_CATEGORIES.has(finding.category)))
			) {
				return {
					ok: false,
					reason:
						"FAIL requires a blocking correctness, validation_failure, plan_deviation, missing_change, or regression_risk finding",
				};
			}
			let reasonCode: BlockedReasonCode | undefined;
			let evidenceIds: string[] | undefined;
			if (value.verdict === "BLOCKED") {
				const finding = findings[0];
				if (
					findings.length !== 1 ||
					!finding ||
					finding.severity !== "blocking" ||
					finding.category !== "validation_failure" ||
					typeof value.reason_code !== "string" ||
					!GATE_BLOCKED_REASON_CODES.has(value.reason_code as BlockedReasonCode) ||
					!Array.isArray(value.evidence_ids) ||
					value.evidence_ids.length === 0 ||
					value.evidence_ids.some((id) => typeof id !== "string" || id.trim().length === 0)
				) {
					return {
						ok: false,
						reason:
							"BLOCKED requires one blocking validation_failure plus a structured reason_code and non-empty evidence_ids",
					};
				}
				reasonCode = value.reason_code as BlockedReasonCode;
				evidenceIds = [...new Set(value.evidence_ids.map((id) => (id as string).trim()))].sort();
			} else if ("reason_code" in value || "evidence_ids" in value) {
				return { ok: false, reason: "PASS and FAIL must not contain BLOCKED recovery fields" };
			}
			return {
				ok: true,
				result: {
					verdict: value.verdict,
					findings,
					...(reasonCode ? { reasonCode } : {}),
					...(evidenceIds ? { evidenceIds } : {}),
					canonicalJson: JSON.stringify({
						verdict: value.verdict,
						findings,
						...(reasonCode ? { reason_code: reasonCode, evidence_ids: evidenceIds } : {}),
					}),
				},
			};
		}
	}
	return { ok: false, reason: "no Gate JSON object was found" };
}

function extractBalancedJsonObject(text: string, start: number): string | undefined {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
	}
	return undefined;
}
