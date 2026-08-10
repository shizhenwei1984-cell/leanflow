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
	migrateLegacyBuildEvidenceRecord,
	parseBuildEvidenceRecord,
	parseBuildEvidenceRecordWithoutRound,
	renderBuildArtifacts,
	selectValidationObservations,
	validationSemanticStates,
} from "./evidence";
import type {
	BuildEvidenceObservationV2,
	BuildEvidenceRecordV2,
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
import { CUSTOM_TYPE, STATE_VERSION, defaultState, defaultStats, hasPersistedState, restoreState } from "./state";
import type { BlockedReasonCode, GateOutcome, LeanFlowState, RepositoryFingerprint } from "./state";
import { checkInvariants, reduceGate, resetBlockedRecovery } from "./machine";
import type { Effect, SnapshotFailureKind } from "./machine";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles, validateGateTaskCall } from "./guard";
import type { GateArtifacts, LeanFlowAgentRole } from "./guard";
import { assessHandoff, formatHandoffNotification } from "./handoff";
import { parseValidationContract, validationStatesDigest } from "./validation";
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
async function writeTextAtomically(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		const handle = await fs.open(temporary, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await writeTextAtomically(filePath, JSON.stringify(value));
}

export default function leanflow(pi: ExtensionAPI): void {
	let state: LeanFlowState = defaultState();
	let hasPersistedLeanFlowState = false;
	// Correlate pre-scheduled calls with their eventual results without trusting result-hook inputs.
	const pendingPlanRefreshes = new Set<string>(); // successful canonical write/edit → reread and reassess
	const pendingLspProbes = new Map<string, string>(); // toolCallId → diagnostics target
	const pendingApprovalWrites = new Map<string, string>(); // toolCallId → exact plan artifact
	const pendingGateCalls = new Set<string>(); // toolCallIds
	const pendingGatePlanDigests = new Map<string, string>(); // toolCallId → dispatch-time canonical plan digest
	type PendingEvidenceObservation =
		| { toolName: "bash"; command: string }
		| { toolName: "lsp"; lspRequest: ParsedLspRequest };
	const pendingEvidenceObservations = new Map<string, PendingEvidenceObservation>();
	let buildRecordLockTail = Promise.resolve();

	async function acquireBuildRecordLock(): Promise<() => void> {
		const previous = buildRecordLockTail;
		let release!: () => void;
		buildRecordLockTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		return release;
	}

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

	function activeBuildRecordPath(ctx: ExtensionContext): string {
		if (!ctx.localProtocolOptions || !state.runId) {
			throw new Error("local protocol options or run ID are unavailable");
		}
		const artifact = buildRecordArtifact(state.runId);
		const recordPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifact);
		if (!recordPath) throw new Error(`internal build record path cannot be resolved: ${artifact}`);
		return recordPath;
	}

	function activeFinalizedSnapshotPath(ctx: ExtensionContext): string {
		if (!ctx.localProtocolOptions || !state.runId) {
			throw new Error("local protocol options or run ID are unavailable");
		}
		const artifact = finalizedSnapshotArtifact(state.runId);
		const snapshotPath = resolveRunMarkerPath(ctx.localProtocolOptions, artifact);
		if (!snapshotPath) throw new Error(`finalized Gate snapshot path cannot be resolved: ${artifact}`);
		return snapshotPath;
	}

	async function readBuildRecordValue(ctx: ExtensionContext): Promise<unknown> {
		try {
			return JSON.parse(await fs.readFile(activeBuildRecordPath(ctx), "utf8"));
		} catch (error) {
			throw new Error(`internal build record is missing or unreadable: ${evidenceFailureMessage(error)}`);
		}
	}

	async function loadBuildRecord(ctx: ExtensionContext, round: number): Promise<BuildEvidenceRecordV2> {
		return parseBuildEvidenceRecord(await readBuildRecordValue(ctx), activeBuildIdentity(round));
	}

	async function readBuildRecordForReconciliation(ctx: ExtensionContext): Promise<BuildEvidenceRecordV2> {
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
			if (value && isPlainRecord(value) && value.version === 1 && legacyRound !== undefined && legacyRound >= 1) {
				const migrated = migrateLegacyBuildEvidenceRecord(value, activeBuildIdentity(legacyRound));
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
		record: BuildEvidenceRecordV2;
	};

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
	): Promise<{ ok: true; value: VerifiedGateSnapshot } | { ok: false; kind: SnapshotFailureKind; reason: string }> {
		if (
			!ctx.localProtocolOptions ||
			!state.runId ||
			!state.planSlug ||
			!state.planDigest ||
			!state.approvedValidationContract ||
			!state.approvedValidationDigest ||
			!state.currentBuildRound
		) {
			return { ok: false, kind: "lease_invalid", reason: "active Gate provenance identity is incomplete" };
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
				kind: "artifact_rebuildable",
				reason: `finalized Gate manifest is missing or invalid: ${evidenceFailureMessage(error)}`,
			};
		}
		const snapshotDigest = finalizedGateSnapshotDigest(manifest);
		if (
			!state.finalizedGateSnapshot ||
			finalizedGateSnapshotDigest(state.finalizedGateSnapshot) !== snapshotDigest
		) {
			return { ok: false, kind: "artifact_rebuildable", reason: "persisted finalized Gate manifest does not match state" };
		}
		if (
			manifest.runId !== state.runId ||
			manifest.planSlug !== state.planSlug ||
			manifest.planDigest !== state.planDigest ||
			manifest.approvedValidationDigest !== state.approvedValidationDigest
		) {
			return { ok: false, kind: "plan_drift", reason: "finalized Gate manifest does not match the approved plan or validation contract" };
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

		let record: BuildEvidenceRecordV2;
		try {
			const recordText = await fs.readFile(activeBuildRecordPath(ctx), "utf8");
			if (sha256Hex(recordText) !== manifest.buildRecordDigest) {
				return { ok: false, kind: "record_invalid", reason: "BUILD record digest does not match the finalized manifest" };
			}
			record = parseBuildEvidenceRecord(JSON.parse(recordText), activeBuildIdentity(manifest.buildRecordRound));
			const semanticStates = validationSemanticStates(
				record,
				state.approvedValidationContract,
				manifest.repositoryFingerprint.combinedDigest,
			);
			if (
				validationStatesDigest(semanticStates) !== validationStatesDigest(manifest.validationStates) ||
				semanticStates.some((validation) => validation.status !== "passed")
			) {
				return { ok: false, kind: "record_invalid", reason: "BUILD record validation states do not match the finalized manifest" };
			}
		} catch (error) {
			return { ok: false, kind: "record_invalid", reason: `BUILD record validation failed: ${evidenceFailureMessage(error)}` };
		}

		let repositoryFingerprint: RepositoryFingerprint;
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
			},
		};
	}

	/**
	 * Re-read the atomic manifest and every bound input immediately before
	 * dispatch. writtenArtifacts is advisory UI state and grants no authority.
	 */
	async function prepareGateSnapshot(
		ctx: ExtensionContext,
	): Promise<
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
		| { ok: false; reason: string; noSemanticProgress?: boolean }
	> {
		if (pendingEvidenceObservations.size > 0) {
			return { ok: false, reason: `${pendingEvidenceObservations.size} BUILD evidence observation(s) are still pending` };
		}
		const verified = await verifyDurableFinalizedSnapshot(ctx);
		if (!verified.ok) return { ok: false, reason: verified.reason };
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
				noSemanticProgress: true,
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
	): Promise<{ ok: true } | { ok: false; kind: SnapshotFailureKind; reason: string }> {
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

	async function initializeBuildRecord(ctx: ExtensionContext): Promise<BuildRecordSetupResult> {
		try {
			const record = createBuildEvidenceRecord(activeBuildIdentity(1));
			await writeJsonAtomically(activeBuildRecordPath(ctx), record);
			state.currentBuildRound = 1;
			state.baselineCaptured = false;
			state.buildMutationObserved = false;
			state.writtenArtifacts = [];
			state.finalizedGateSnapshot = undefined;
			state.operationalRetrySnapshot = undefined;
			resetBlockedRecovery(state);
			return { ok: true, round: 1, baselinePresent: false, freshRecord: true, lspEvidencePresent: false };
		} catch (error) {
			const reason = evidenceFailureMessage(error);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`LeanFlow: failed to initialize the extension-owned BUILD record: ${reason}`,
					"warning",
				);
			}
			return { ok: false, reason };
		}
	}

	async function beginRepairBuildRound(ctx: ExtensionContext): Promise<BuildRecordSetupResult> {
		const lease = state.repairLease;
		const fromRound = lease ? lease.fromRound : (state.currentBuildRound ?? state.gateAttempt);
		const toRound = lease ? lease.toRound : fromRound + 1;
		let recoveryEligible = false;
		try {
			let actual: BuildEvidenceRecordV2;
			try {
				actual = await readBuildRecordForReconciliation(ctx);
			} catch (error) {
				recoveryEligible = true;
				throw new Error(`internal build record is missing or unreadable: ${evidenceFailureMessage(error)}`);
			}
			if (actual.round === toRound) {
				return {
					ok: true,
					round: toRound,
					baselinePresent: !!actual.baseline,
					freshRecord: actual.observations.length === 0,
					lspEvidencePresent: actual.observations.some((observation) => observation.toolName === "lsp"),
				};
			}
			if (actual.round !== fromRound) {
				recoveryEligible = true;
				throw new Error(`BUILD record round ${actual.round} does not match expected ${fromRound} → ${toRound}`);
			}
			const nextRecord: BuildEvidenceRecordV2 = {
				...actual,
				round: toRound,
				observations: [],
			};
			await writeJsonAtomically(activeBuildRecordPath(ctx), nextRecord);
			return {
				ok: true,
				round: toRound,
				baselinePresent: !!nextRecord.baseline,
				freshRecord: true,
				lspEvidencePresent: false,
			};
		} catch (error) {
			let failure = error;
			if (recoveryEligible && lease?.reason === "human_continue") {
				try {
					const fresh = createBuildEvidenceRecord(activeBuildIdentity(toRound));
					await writeJsonAtomically(activeBuildRecordPath(ctx), fresh);
					state.buildMutationObserved = false;
					return {
						ok: true,
						round: toRound,
						baselinePresent: false,
						freshRecord: true,
						lspEvidencePresent: false,
					};
				} catch (recoveryError) {
					failure = recoveryError;
				}
			}
			const reason = evidenceFailureMessage(failure);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`LeanFlow: failed to start the repair evidence round: ${reason}`,
					"warning",
				);
			}
			return { ok: false, reason };
		}
	}

	async function appendBuildObservationUnlocked(
		ctx: ExtensionContext,
		observation: BuildEvidenceObservationV2,
	): Promise<void> {
		const record = await loadBuildRecord(ctx, expectedGateRoundForSnapshot());
		record.observations.push(observation);
		await writeJsonAtomically(activeBuildRecordPath(ctx), record);
	}
	async function appendBuildObservation(
		ctx: ExtensionContext,
		observation: BuildEvidenceObservationV2,
	): Promise<void> {
		const release = await acquireBuildRecordLock();
		try {
			await appendBuildObservationUnlocked(ctx, observation);
		} finally {
			release();
		}
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
			const { absolute } = await validateUntrackedPath(ctx, relative);
			const stat = await fs.lstat(absolute);
			if (stat.isSymbolicLink()) {
				untrackedEntries.push(`${relative}\0symlink\0${await fs.readlink(absolute)}`);
			} else {
				const digest = createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
				untrackedEntries.push(`${relative}\0file\0${digest}`);
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
	): Promise<{ absolute: string; size: number }> {
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
		const real = await fs.realpath(absolute);
		if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
			throw new Error(`untracked path resolves outside the repository: ${JSON.stringify(relative)}`);
		}
		const stat = await fs.lstat(absolute);
		if (!stat.isFile() && !stat.isSymbolicLink()) {
			throw new Error(`untracked path is not a file: ${JSON.stringify(relative)}`);
		}
		return { absolute, size: stat.size };
	}
	async function writeRunMarker(ctx: ExtensionContext, status: NonNullable<LeanFlowState["runMarkerStatus"]>): Promise<boolean> {
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
			if (status === "awaiting_approval") {
				await writeJsonAtomically(markerPath, marker);
				failureStage = "pointer";
				failurePath = pointerPath;
				await writeJsonAtomically(pointerPath, pointer);
			} else {
				await writeJsonAtomically(pointerPath, pointer);
				failureStage = "marker";
				failurePath = markerPath;
				await writeJsonAtomically(markerPath, marker);
			}
			clearPersistenceFailure();
			return true;
		} catch (error) {
			setPersistenceFailure(ctx, failureStage, failurePath, error);
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
		state.approvedValidationContract = validationContract;
		state.approvedValidationDigest = validationContract?.digest;
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
			await writeRunMarker(ctx, "invalidated");
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

		state.approvedPlanArtifact = artifact;
		state.proposedPlanDigest = state.planDigest;
		const buildRecord = await initializeBuildRecord(ctx);
		if (!buildRecord.ok) {
			ctx.ui.notify(`LeanFlow: Cannot enter BUILD: ${buildRecord.reason}`, "warning");
			return false;
		}
		transitionPhase(state, "building");
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
			...defaultState(),
			phase: "planning",
			stateVersion: STATE_VERSION,
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
					handoffBlockers: marker.handoffBlockers,
					stats: marker.stats,
					writtenArtifacts: [],
				},
			},
		]);
		if (!(await refreshCanonicalPlanState(ctx, "recovery"))) return true;
		state.approvedPlanArtifact = marker.planArtifact;
		state.proposedPlanDigest = state.planDigest;
		const buildRecord = await initializeBuildRecord(ctx);
		if (!buildRecord.ok) {
			ctx.ui.notify(`LeanFlow: Cannot enter BUILD: ${buildRecord.reason}`, "warning");
			return true;
		}
		transitionPhase(state, "building", now);
		await writeRunMarker(ctx, "building");
		persist();
		return true;
	}

	async function executeGateEffects(ctx: ExtensionContext, effects: Effect[]): Promise<{ ok: true } | { ok: false; reason?: string }> {
		for (const effect of effects) {
			switch (effect.kind) {
				case "clear_artifacts":
					state.writtenArtifacts = [];
					break;
				case "begin_repair_round": {
					persist();
					const buildRecord = await beginRepairBuildRound(ctx);
					if (!buildRecord.ok) {
						const { effects: repairEffects } = reduceGate(state, {
							type: "repair_round_failed",
							reason: buildRecord.reason,
						});
						await executeGateEffects(ctx, repairEffects);
						persist();
						updateStatus(ctx);
						const violations = checkInvariants(state);
						if (violations.length > 0) {
							ctx.ui.notify(`LeanFlow invariant violation: ${violations.join("; ")}`, "warning");
						}
						return { ok: false, reason: buildRecord.reason };
					}
					if (state.phase === "repair_preparing") {
						const { effects: readyEffects } = reduceGate(state, {
							type: "repair_round_ready",
							round: buildRecord.round,
							baselineCaptured: buildRecord.baselinePresent,
							freshRecord: buildRecord.freshRecord,
							lspEvidencePresent: buildRecord.lspEvidencePresent,
						});
						await executeGateEffects(ctx, readyEffects);
						persist();
					}
					break;
				}
				case "write_marker":
					await writeRunMarker(ctx, effect.status);
					break;
				case "notify":
					ctx.ui.notify(`LeanFlow: ${effect.message}`, effect.level);
					break;
			}
		}
		return { ok: true };
	}

	async function finishGateResult(
		result: ParsedGateResult | undefined,
		isError: boolean,
		ctx: ExtensionContext,
		interruptedBy: OperationalInterruption = "tool_error",
	): Promise<void> {
		const lease = state.gateLease;
		if (!lease || !state.finalizedGateSnapshot) {
			const { effects } = reduceGate(state, {
				type: "snapshot_record_invalid",
				reason: "Gate settlement lacks its durable lease or finalized manifest",
			});
			await executeGateEffects(ctx, effects);
			persist();
			updateStatus(ctx);
			return;
		}
		if (!isError && result !== undefined) {
			let currentFingerprint: RepositoryFingerprint;
			try {
				currentFingerprint = await captureRepositoryFingerprint(ctx, undefined);
			} catch (error) {
				await finishGateResult(undefined, true, ctx, "transport_error");
				ctx.ui.notify(
					`LeanFlow: repository fingerprint transport failed immediately before settlement: ${evidenceFailureMessage(error)}`,
					"warning",
				);
				return;
			}
			if (currentFingerprint.combinedDigest !== lease.repositoryFingerprint?.combinedDigest) {
				const { effects } = reduceGate(state, {
					type: "repository_changed_during_gate",
					reason: "repository state changed immediately before Gate settlement",
				});
				await executeGateEffects(ctx, effects);
				persist();
				updateStatus(ctx);
				return;
			}
		}

		let gateEvent: Extract<Parameters<typeof reduceGate>[1], { type: "gate_error" | "gate_settled" }>;
		if (isError || result === undefined) {
			gateEvent = {
				type: "gate_error",
				operationalRetrySnapshot: createOperationalRetrySnapshot(
					lease,
					state.finalizedGateSnapshot,
					interruptedBy,
				),
			};
		} else {
			const evidenceIds = result.evidenceIds ? [...new Set(result.evidenceIds)].sort() : undefined;
			let validationStates = state.finalizedGateSnapshot.validationStates.map((validation) => ({ ...validation }));
			if (result.verdict === "BLOCKED") {
				if (
					!result.reasonCode ||
					!evidenceIds ||
					evidenceIds.some((id) => !validationStates.some((validation) => validation.id === id))
				) {
					await finishGateResult(undefined, true, ctx, "invalid_gate_output");
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
			gateEvent = {
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
			};
		}
		const { effects } = reduceGate(state, gateEvent);
		await executeGateEffects(ctx, effects);
		persist();
		updateStatus(ctx);
		const violations = checkInvariants(state);
		if (violations.length > 0) {
			ctx.ui.notify(`LeanFlow invariant violation: ${violations.join("; ")}`, "warning");
		}
	}

	async function recoverFromPlanDrift(ctx: ExtensionContext, reason: string): Promise<void> {
		const { effects } = reduceGate(state, { type: "snapshot_plan_drift", reason });
		await executeGateEffects(ctx, effects);
		const refreshed = await refreshCanonicalPlanState(ctx, "mutation");
		if (refreshed || state.phase !== "gating") return;

		// A false return with the run still gating is one of refresh's early,
		// no-mutation failures: the canonical plan cannot be identified or read.
		// Explicitly leave gating so the cleared Gate lease cannot strand the run
		// in a blocked phase.
		state.proposalBoundary = undefined;
		state.proposedPlanArtifact = undefined;
		state.proposedPlanDigest = undefined;
		state.approvedPlanArtifact = undefined;
		state.approvalInvalidated = true;
		state.handoffStatus = "NEEDS_UPDATE";
		transitionPhase(state, "planning");
		await writeRunMarker(ctx, "invalidated");
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`LeanFlow: ${reason}; canonical plan is unreadable — repair and re-propose the plan.`, "warning");
		if (ctx.hasUI && state.planSlug) {
			ctx.ui.setEditorText(
				`/plan Repair the existing LeanFlow plan at local://${state.planSlug}-plan.md in place. Preserve its run ID, fix only the invalid final-plan content, write the same artifact, then re-propose ${state.planSlug}. Do not repeat repository investigation.`,
			);
		}
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
			gateCalls: value.gateCalls,
			gateRetryMode: value.gateRetryMode,
			gateLease: value.gateLease,
			lspLease: value.lspLease,
			repairLease: value.repairLease,
			baselineCaptured: value.baselineCaptured,
			writtenArtifacts: value.writtenArtifacts,
			consecutiveGateErrors: value.consecutiveGateErrors,
			approvedValidationContract: value.approvedValidationContract,
			approvedValidationDigest: value.approvedValidationDigest,
			finalizedGateSnapshot: value.finalizedGateSnapshot,
			operationalRetrySnapshot: value.operationalRetrySnapshot,
			blockedRecovery: value.blockedRecovery,
		});
	}

	const restoreSessionState = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
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
					gateLease: restoreState([entry]).gateLease,
					stateVersion: raw.stateVersion,
				};
			}
			return undefined;
		})();
		const wasGatingRaw = rawBeforeRestore?.phase === "gating" && rawBeforeRestore?.gateLease !== undefined;
		state = restoreState(branch);
		pendingPlanRefreshes.clear();
		pendingLspProbes.clear();
		pendingApprovalWrites.clear();
		pendingGateCalls.clear();
		pendingGatePlanDigests.clear();
		pendingEvidenceObservations.clear();

		const restoredFromLegacy =
			rawBeforeRestore !== undefined && rawBeforeRestore.stateVersion !== state.stateVersion;
		const fingerprintBeforeReconcile = reconciliationFingerprint(state);
		const { effects } = reduceGate(state, { type: "restore_reconcile", now: Date.now() });
		await executeGateEffects(ctx, effects);

		if (wasGatingRaw && state.phase === "gating" && state.gateLease && state.finalizedGateSnapshot) {
			const lease = state.gateLease;
			const verified = await verifyDurableFinalizedSnapshot(ctx, lease);
			if (verified.ok || verified.kind === "transport_error") {
				const interrupted = reduceGate(state, {
					type: "gate_interrupted",
					operationalRetrySnapshot: createOperationalRetrySnapshot(
						lease,
						state.finalizedGateSnapshot,
						verified.ok ? "session_switch" : "transport_error",
					),
				});
				await executeGateEffects(ctx, interrupted.effects);
			} else if (verified.kind === "repository_changed") {
				const changed = reduceGate(state, {
					type: "repository_changed_during_gate",
					reason: verified.reason,
				});
				await executeGateEffects(ctx, changed.effects);
			} else if (verified.kind === "plan_drift") {
				await recoverFromPlanDrift(ctx, verified.reason);
			} else if (verified.kind === "artifact_rebuildable" || verified.kind === "snapshot_changed") {
				const invalid = reduceGate(state, { type: "snapshot_evidence_invalid", reason: verified.reason });
				await executeGateEffects(ctx, invalid.effects);
			} else {
				const invalid = reduceGate(state, { type: "snapshot_record_invalid", reason: verified.reason });
				await executeGateEffects(ctx, invalid.effects);
			}
		}
		if (
			state.phase === "building" &&
			state.gateRetryMode === "operational" &&
			state.operationalRetrySnapshot &&
			state.finalizedGateSnapshot
		) {
			const verified = await verifyDurableFinalizedSnapshot(ctx);
			if (!verified.ok && verified.kind !== "transport_error") {
				if (verified.kind === "repository_changed") {
					state.gateRetryMode = undefined;
					state.operationalRetrySnapshot = undefined;
					state.finalizedGateSnapshot = undefined;
					state.writtenArtifacts = [];
					state.buildMutationObserved = true;
				} else if (verified.kind === "plan_drift") {
					state.gateLease = {
						...state.operationalRetrySnapshot.originalGateLease,
					};
					state.phase = "gating";
					await recoverFromPlanDrift(ctx, verified.reason);
				} else if (verified.kind === "artifact_rebuildable" || verified.kind === "snapshot_changed") {
					state.gateRetryMode = "evidence";
					state.operationalRetrySnapshot = undefined;
					state.finalizedGateSnapshot = undefined;
					state.writtenArtifacts = [];
				} else {
					state.gateRetryMode = undefined;
					state.operationalRetrySnapshot = undefined;
					state.finalizedGateSnapshot = undefined;
					state.baselineCaptured = false;
					state.phase = "awaiting_human";
				}
			}
		}


		if (state.phase === "repair_preparing") {
			// Repair transactions reconcile from their durable lease and BUILD
			// record only; the generic round reconciliation below would misread
			// the pending round and corrupt gateAttempt.
			if (!state.repairLease) {
				let degraded = false;
				try {
					const record = await readBuildRecordForReconciliation(ctx);
					const fromRound = state.currentBuildRound ?? state.gateAttempt;
					const toRound = fromRound + 1;
					if (record.round === fromRound || record.round === toRound) {
						state.repairLease = { fromRound, toRound, reason: "gate_fail", startedAt: Date.now() };
					} else {
						degraded = true;
					}
				} catch {
					degraded = true;
				}
				if (degraded) {
					state.repairLease = undefined;
					state.phase = "awaiting_human";
					await writeRunMarker(ctx, "paused");
					ctx.ui.notify(
						"LeanFlow: repair preparation could not be recovered; use /flowcontinue or /flowcancel.",
						"warning",
					);
				}
			}
			if (state.phase === "repair_preparing" && state.repairLease) {
				try {
					const buildRecord = await beginRepairBuildRound(ctx);
					if (buildRecord.ok) {
						const { effects: readyEffects } = reduceGate(state, {
							type: "repair_round_ready",
							round: buildRecord.round,
							baselineCaptured: buildRecord.baselinePresent,
							freshRecord: buildRecord.freshRecord,
							lspEvidencePresent: buildRecord.lspEvidencePresent,
						});
						await executeGateEffects(
							ctx,
							readyEffects.filter((effect) => effect.kind !== "notify"),
						);
					} else {
						const { effects: repairEffects } = reduceGate(state, {
							type: "repair_round_failed",
							reason: buildRecord.reason,
						});
						await executeGateEffects(ctx, repairEffects);
					}
				} catch {
					// Reconciliation failure is handled at next preflight.
				}
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
				state.gateRetryMode = undefined;
				state.operationalRetrySnapshot = undefined;
				state.finalizedGateSnapshot = undefined;
				state.writtenArtifacts = [];
				state.baselineCaptured = false;
				state.phase = "awaiting_human";
				ctx.ui.notify(
					`LeanFlow: BUILD record reconciliation failed safely: ${evidenceFailureMessage(error)}`,
					"warning",
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
	async function refreshSettledPlanMutations(toolCallIds: Iterable<string>, ctx: ExtensionContext): Promise<void> {
		let settled = false;
		for (const toolCallId of toolCallIds) {
			if (pendingPlanRefreshes.delete(toolCallId)) settled = true;
		}
		if (
			settled &&
			(state.phase === "planning" || state.phase === "awaiting_approval")
		) {
			await refreshCanonicalPlanState(ctx, "mutation");
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
		if (!willContinue && pendingPlanRefreshes.size > 0) {
			await refreshSettledPlanMutations([...pendingPlanRefreshes], ctx);
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
				await writeRunMarker(ctx, "abandoned");
			}

			pendingEvidenceObservations.clear();

			// Initialize state machine and the first observable phase.
			const now = Date.now();
			state = {
				...defaultState(),
				phase: "planning",
				stateVersion: STATE_VERSION,
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

	const { z } = pi.zod;
	const captureBaselineParameters = z.object({}).strict();
	const runValidationParameters = z
		.object({
			validationId: z.string().min(1),
		})
		.strict();
	const finalizeArtifactsParameters = z.object({}).strict();
	const approvedValidationInstructions = (): string =>
		[
			"Approved validation IDs (execute each with leanflow_run_validation):",
			...(state.approvedValidationContract?.validations ?? []).map(
				(validation) => `- ${validation.id}: ${validation.displayCommand}`,
			),
		].join("\n");

	pi.registerTool<typeof captureBaselineParameters>({
		name: "leanflow_capture_baseline",
		label: "Capture LeanFlow Baseline",
		description: "Capture the immutable BUILD HEAD and status after the required initial LSP probe and before repository mutations.",
		parameters: captureBaselineParameters,
		strict: true,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const release = await acquireBuildRecordLock();
			try {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow baseline capture failed: ${message}` }],
				isError: true,
			});
			if (state.phase !== "building") return fail("the workflow is not in BUILD.");
			if (state.lspProbeStatus === "pending") return fail("complete the required initial LSP diagnostics probe first.");
			if (pendingEvidenceObservations.size > 0) {
				return fail("a BUILD observation is still unpersisted; run /flowcancel and start a new run.");
			}
			if (state.baselineCaptured === true) return fail("the immutable BUILD baseline is already captured.");
			if (state.buildMutationObserved === true) {
				return fail("a repository mutation was already authorized; run /flowcancel and start a new run.");
			}
			try {
				const activeRound = state.repairLease ? state.repairLease.toRound : expectedGateRoundForSnapshot();
				let record: BuildEvidenceRecordV2;
				try {
					record = await loadBuildRecord(ctx, activeRound);
				} catch {
					record = await readBuildRecordForReconciliation(ctx);
					if (record.baseline) {
						state.baselineCaptured = true;
						persist();
						return {
							content: [{ type: "text" as const, text: `LeanFlow immutable BUILD baseline already captured at ${record.baseline.head}.\n${approvedValidationInstructions()}` }],
						};
					}
					throw new Error(`BUILD record round ${record.round} does not match expected ${activeRound}`);
				}
				if (record.baseline) {
					state.baselineCaptured = true;
					persist();
					return {
						content: [{ type: "text" as const, text: `LeanFlow immutable BUILD baseline already captured at ${record.baseline.head}.\n${approvedValidationInstructions()}` }],
					};
				}
				const headResult = await runGit(ctx, ["rev-parse", "HEAD"], signal);
				const statusResult = await runGit(ctx, ["status", "--short", "--untracked-files=all"], signal);
				const head = headResult.stdout.trim();
				if (!head || head.includes("\n")) throw new Error("git rev-parse HEAD returned an invalid commit identity");
				record.baseline = {
					head,
					status: statusResult.stdout.trimEnd(),
					capturedAt: Date.now(),
				};
				await writeJsonAtomically(activeBuildRecordPath(ctx), record);
				state.baselineCaptured = true;
				persist();
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow immutable BUILD baseline captured at ${head}.\n${approvedValidationInstructions()}`,
						},
					],
				};
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
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
			const release = await acquireBuildRecordLock();
			try {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow validation failed: ${message}` }],
				isError: true,
			});
			if (state.phase !== "building") return fail("the workflow is not in BUILD.");
			if (state.gateRetryMode === "operational") {
				return fail("operational recovery may only redispatch the already-finalized snapshot.");
			}
			if (state.baselineCaptured !== true) return fail("capture the immutable BUILD baseline first.");
			const validation = state.approvedValidationContract?.validations.find(
				(candidate) => candidate.id === params.validationId,
			);
			if (!validation) return fail(`validation ID ${JSON.stringify(params.validationId)} is not approved.`);
			if (
				state.finalizedGateSnapshot ||
				state.operationalRetrySnapshot ||
				(state.writtenArtifacts?.length ?? 0) > 0
			) {
				state.finalizedGateSnapshot = undefined;
				state.operationalRetrySnapshot = undefined;
				state.writtenArtifacts = [];
				try {
					persist();
				} catch (error) {
					return fail(
						`prior Gate authority could not be invalidated: ${evidenceFailureMessage(error)}`,
					);
				}
			}
			const startedAt = Date.now();
			let before: RepositoryFingerprint;
			try {
				before = await captureRepositoryFingerprint(ctx, signal);
			} catch (error) {
				return fail(`repository fingerprint before validation is unavailable: ${evidenceFailureMessage(error)}`);
			}
			const execution = await pi.exec(validation.executable, validation.argv, { cwd: ctx.cwd, signal }).then(
				(result) => ({ ok: true as const, result }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			if (!execution.ok) return fail(`execution could not start: ${evidenceFailureMessage(execution.error)}`);
			const result = execution.result;
			const finishedAt = Date.now();
			let after: RepositoryFingerprint | undefined;
			let fingerprintError: string | undefined;
			try {
				after = await captureRepositoryFingerprint(ctx, signal);
			} catch (error) {
				fingerprintError = evidenceFailureMessage(error);
			}
			const observation: BuildEvidenceObservationV2 = {
				toolCallId,
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
				await appendBuildObservationUnlocked(ctx, observation);
			} catch (error) {
				return fail(`result could not be committed to the BUILD record: ${evidenceFailureMessage(error)}`);
			}
			state.finalizedGateSnapshot = undefined;
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
			const release = await acquireBuildRecordLock();
			try {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow artifact finalization failed: ${message}` }],
				isError: true,
			});
			if (state.phase !== "building") return fail("the workflow is not in BUILD.");
			if (state.gateRetryMode === "operational") {
				return fail("an operational Gate retry must reuse the existing finalized manifest unchanged.");
			}
			if (state.lspProbeStatus === "pending") return fail("the required LSP diagnostics probe is incomplete.");
			if (state.baselineCaptured !== true) return fail("capture the immutable BUILD baseline first.");
			if (pendingEvidenceObservations.size > 0) {
				return fail("one or more BUILD observations are still unpersisted.");
			}
			try {
				if (
					!state.planArtifact ||
					!state.runId ||
					!state.planDigest ||
					!state.approvedValidationContract ||
					!state.approvedValidationDigest ||
					!ctx.localProtocolOptions
				) {
					throw new Error("active plan identity, validation contract, or local protocol options are incomplete");
				}
				const planPath = resolveRunMarkerPath(ctx.localProtocolOptions, state.planArtifact);
				if (!planPath) throw new Error("canonical plan path cannot be resolved");
				const planContent = await fs.readFile(planPath, "utf8");
				if (
					runIdFromPlan(planContent) !== state.runId ||
					planDigest(planContent) !== state.planDigest ||
					parseValidationContract(planContent, state.planDigest).contract?.digest !== state.approvedValidationDigest
				) {
					throw new Error("canonical plan or approved validation contract changed after approval");
				}

				const recordRound = expectedGateRoundForSnapshot();
				const record = await loadBuildRecord(ctx, recordRound);
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
				gitEvidence.push(finalStatusResult.evidence);
				const finalStatus = finalStatusResult.stdout.trimEnd();
				const trackedDiffResult = await runGit(
					ctx,
					["diff", "--binary", record.baseline.head, "--"],
					signal,
					[0],
					"Tracked complete binary diff",
				);
				gitEvidence.push(trackedDiffResult.evidence);
				const trackedNamesResult = await runGit(
					ctx,
					["diff", "--name-only", "-z", record.baseline.head, "--"],
					signal,
					[0],
					"Tracked changed paths",
				);
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
					untrackedPatches.push({ path: relative, patch: patchResult.stdout });
					gitEvidence.push(patchResult.evidence);
				}

				const completeDiff = composeCompleteDiff(trackedDiffResult.stdout, untrackedPatches, emptyUntrackedFiles);
				const repositoryFingerprint = await captureRepositoryFingerprint(ctx, signal);
				const validationStates = validationSemanticStates(
					record,
					state.approvedValidationContract,
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
					state.approvedValidationContract,
					repositoryFingerprint.combinedDigest,
				);
				const changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])];
				const rendered = renderBuildArtifacts({
					planArtifact: state.planArtifact,
					record,
					finalHead,
					finalStatus,
					changedPaths,
					validations,
					gitCommands: gitEvidence,
					completeDiff,
				});
				const artifacts = expectedGateArtifacts(state);
				if (!artifacts) throw new Error("canonical Gate artifact identity is unavailable");
				const outputs = [
					{ kind: "build", artifact: artifacts.build, content: rendered.build },
					{ kind: "diff", artifact: artifacts.diff, content: rendered.diff },
					{ kind: "evidence", artifact: artifacts.evidence, content: rendered.evidence },
				] as const;

				state.writtenArtifacts = [];
				state.finalizedGateSnapshot = undefined;
				persist();
				try {
					await fs.unlink(activeFinalizedSnapshotPath(ctx));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}

				const verified: string[] = [];
				const artifactDigests = new Map<string, string>();
				for (const output of outputs) {
					const filePath = resolveRunMarkerPath(ctx.localProtocolOptions, output.artifact);
					if (!filePath) throw new Error(`canonical ${output.kind} artifact path cannot be resolved`);
					await writeTextAtomically(filePath, output.content);
					const persisted = await fs.readFile(filePath, "utf8");
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

				const recordText = await fs.readFile(activeBuildRecordPath(ctx), "utf8");
				parseBuildEvidenceRecord(JSON.parse(recordText), activeBuildIdentity(recordRound));
				const manifest = createFinalizedGateSnapshot({
					runId: state.runId,
					planSlug: state.planSlug!,
					planDigest: state.planDigest,
					approvedValidationDigest: state.approvedValidationDigest,
					buildRecordRound: recordRound,
					buildRecordDigest: sha256Hex(recordText),
					buildArtifactDigest: artifactDigests.get("build")!,
					diffArtifactDigest: artifactDigests.get("diff")!,
					evidenceArtifactDigest: artifactDigests.get("evidence")!,
					repositoryFingerprint,
					validationStates,
				});
				await writeJsonAtomically(activeFinalizedSnapshotPath(ctx), manifest);
				const persistedManifest = parseFinalizedGateSnapshot(
					JSON.parse(await fs.readFile(activeFinalizedSnapshotPath(ctx), "utf8")),
				);
				if (!persistedManifest || finalizedGateSnapshotDigest(persistedManifest) !== finalizedGateSnapshotDigest(manifest)) {
					throw new Error("finalized Gate manifest failed atomic persistence verification");
				}
				state.finalizedGateSnapshot = persistedManifest;
				state.operationalRetrySnapshot = undefined;
				state.writtenArtifacts = [...REQUIRED_ARTIFACTS];
				persist();
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow Gate artifacts and manifest finalized:\n${verified.join("\n")}\nmanifest sha256:${finalizedGateSnapshotDigest(persistedManifest)}`,
						},
					],
				};
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
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
				const snapshot = await prepareGateSnapshot(ctx);
				if (!snapshot.ok) {
					recordStats(() => recordGateReadinessBlock(state));
					if (snapshot.noSemanticProgress) {
						const stalled = reduceGate(state, {
							type: "blocked_no_progress",
							reason: snapshot.reason,
						});
						await executeGateEffects(ctx, stalled.effects);
						persist();
						updateStatus(ctx);
					}
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
				pendingGateCalls.add(event.toolCallId);
				pendingGatePlanDigests.set(event.toolCallId, snapshot.planDigest);
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

		if (state.phase === "building" && effect === "repository_mutation") {
			state.buildMutationObserved = true;
			if ((state.writtenArtifacts?.length ?? 0) > 0) state.writtenArtifacts = [];
			persist();
		}
		if (state.phase === "building" && state.gateRetryMode !== "operational") {
			if (event.toolName === "bash" && typeof event.input.command === "string" && event.input.command.trim()) {
				pendingEvidenceObservations.set(event.toolCallId, {
					toolName: "bash",
					command: event.input.command,
				});
			} else if (effect === "read_only") {
				const lspRequest = parseLspObservationRequest(event);
				if (lspRequest) {
					pendingEvidenceObservations.set(event.toolCallId, { toolName: "lsp", lspRequest });
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
			const observation: BuildEvidenceObservationV2 = {
				toolCallId: event.toolCallId,
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
				await appendBuildObservation(ctx, observation);
				pendingEvidenceObservations.delete(event.toolCallId);
			} catch (error) {
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

		const persistedLspTarget =
			state.phase === "building" &&
			state.lspProbeStatus === "pending" &&
			state.lspLease?.toolCallId === event.toolCallId
				? state.lspLease.lspTarget
				: undefined;
		const lspTarget = pendingLspProbes.get(event.toolCallId) ?? persistedLspTarget;
		if (lspTarget !== undefined) {
			pendingLspProbes.delete(event.toolCallId);
			state.lspLease = undefined;
			state.lspProbeStatus = "completed";
			state.lspProbeTarget = lspTarget;
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


		if (
			event.toolName === "task" &&
			(pendingGateCalls.has(event.toolCallId) ||
				(state.phase === "gating" && state.gateLease?.toolCallId === event.toolCallId))
		) {
			const dispatchedPlanDigest = pendingGatePlanDigests.get(event.toolCallId) ?? state.gateLease?.planDigest;
			pendingGateCalls.delete(event.toolCallId);
			pendingGatePlanDigests.delete(event.toolCallId);
			if (state.phase === "gating" && state.gateLease) {
				const snapshotCheck = await verifyGateSnapshot(ctx, state.gateLease);
				if (!snapshotCheck.ok) {
					ctx.ui.notify(`LeanFlow: ${snapshotCheck.reason}; Gate result was discarded.`, "warning");
					if (snapshotCheck.kind === "repository_changed") {
						const { effects } = reduceGate(state, {
							type: "repository_changed_during_gate",
							reason: snapshotCheck.reason,
						});
						await executeGateEffects(ctx, effects);
						persist();
						updateStatus(ctx);
						return;
					}
					if (snapshotCheck.kind === "artifact_rebuildable" || snapshotCheck.kind === "snapshot_changed") {
						const { effects } = reduceGate(state, { type: "snapshot_evidence_invalid", reason: snapshotCheck.reason });
						await executeGateEffects(ctx, effects);
						persist();
						updateStatus(ctx);
						return;
					}
					if (snapshotCheck.kind === "record_invalid" || snapshotCheck.kind === "lease_invalid") {
						const { effects } = reduceGate(state, { type: "snapshot_record_invalid", reason: snapshotCheck.reason });
						await executeGateEffects(ctx, effects);
						persist();
						updateStatus(ctx);
						return;
					}
					if (snapshotCheck.kind === "plan_drift") {
						await recoverFromPlanDrift(ctx, snapshotCheck.reason);
						return;
					}
					await finishGateResult(undefined, true, ctx);
					return;
				}
			}
			if (!event.isError && (await planDriftedDuringGate(ctx, dispatchedPlanDigest))) {
				ctx.ui.notify("LeanFlow: plan drifted during Gate; Gate result was discarded.", "warning");
				await recoverFromPlanDrift(ctx, "canonical plan digest changed during Gate");
				return;
			}
			let result: ParsedGateResult | undefined;
			if (!event.isError) {
				const parsed = parseGateResult(event.content);
				if (!parsed.ok) {
					ctx.ui.notify(`LeanFlow: Gate result semantic validation failed: ${parsed.reason}`, "warning");
					await finishGateResult(undefined, true, ctx);
					return;
				}
				result = parsed.result;
			}
			await finishGateResult(result, event.isError, ctx);
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
				await writeRunMarker(ctx, "abandoned");
			}
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
