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
import {
	composeCompleteDiff,
	createBuildEvidenceRecord,
	parseBuildEvidenceRecord,
	renderBuildArtifacts,
	selectValidationObservations,
} from "./evidence";
import type {
	BuildEvidenceObservationV1,
	BuildEvidenceRecordV1,
	BuildRecordIdentity,
	GitCommandEvidence,
	ParsedLspRequest,
	UntrackedPatch,
} from "./evidence";
import { CUSTOM_TYPE, defaultState, defaultStats, hasPersistedState, restoreState } from "./state";
import type { LeanFlowState } from "./state";
import { checkAgentBudget, checkTaskGuard, extractAgentRoles, validateGateTaskCall } from "./guard";
import type { GateArtifacts, LeanFlowAgentRole } from "./guard";
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
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
const FINALIZE_ARTIFACTS_DEVICE_PATH = "xd://leanflow_finalize_artifacts";
type RoutedLeanFlowDeviceCall = "capture_baseline" | "finalize_artifacts" | "invalid";

function routedLeanFlowDeviceCall(event: ToolCallEvent): RoutedLeanFlowDeviceCall | undefined {
	if (
		!isWriteToolCall(event) ||
		(event.input.path !== CAPTURE_BASELINE_DEVICE_PATH && event.input.path !== FINALIZE_ARTIFACTS_DEVICE_PATH)
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
	if (Object.keys(payload).length !== 1 || !("validationCommands" in payload)) return "invalid";
	const commands = payload.validationCommands;
	return Array.isArray(commands) &&
		commands.length > 0 &&
		commands.every((command) => typeof command === "string" && command.length > 0)
		? "finalize_artifacts"
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
	if (routedDeviceCall === "capture_baseline" || routedDeviceCall === "finalize_artifacts") {
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
	type PendingEvidenceObservation =
		| { toolName: "bash"; command: string }
		| { toolName: "lsp"; lspRequest: ParsedLspRequest };
	const pendingEvidenceObservations = new Map<string, PendingEvidenceObservation>();

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

	function evidenceFailureMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function activeBuildIdentity(round: number): BuildRecordIdentity {
		if (!state.runId || !state.planSlug || !state.planDigest) {
			throw new Error("active LeanFlow run identity is incomplete");
		}
		return {
			runId: state.runId,
			planSlug: state.planSlug,
			planDigest: state.planDigest,
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

	async function loadBuildRecord(ctx: ExtensionContext, round: number): Promise<BuildEvidenceRecordV1> {
		const recordPath = activeBuildRecordPath(ctx);
		let value: unknown;
		try {
			value = JSON.parse(await fs.readFile(recordPath, "utf8"));
		} catch (error) {
			throw new Error(`internal build record is missing or unreadable: ${evidenceFailureMessage(error)}`);
		}
		return parseBuildEvidenceRecord(value, activeBuildIdentity(round));
	}

	async function initializeBuildRecord(ctx: ExtensionContext): Promise<boolean> {
		state.baselineCaptured = false;
		state.buildMutationObserved = false;
		state.writtenArtifacts = [];
		try {
			const record = createBuildEvidenceRecord(activeBuildIdentity(1));
			await writeJsonAtomically(activeBuildRecordPath(ctx), record);
			return true;
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`LeanFlow: failed to initialize the extension-owned BUILD record: ${evidenceFailureMessage(error)}`,
					"warning",
				);
			}
			return false;
		}
	}

	async function beginRepairBuildRound(ctx: ExtensionContext): Promise<void> {
		try {
			const currentRound = state.gateAttempt;
			const record = await loadBuildRecord(ctx, currentRound);
			const nextRecord: BuildEvidenceRecordV1 = {
				...record,
				round: currentRound + 1,
				observations: [],
			};
			await writeJsonAtomically(activeBuildRecordPath(ctx), nextRecord);
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`LeanFlow: failed to start the repair evidence round: ${evidenceFailureMessage(error)}`,
					"warning",
				);
			}
		}
	}

	async function appendBuildObservation(
		ctx: ExtensionContext,
		observation: BuildEvidenceObservationV1,
	): Promise<void> {
		const record = await loadBuildRecord(ctx, state.gateAttempt + 1);
		record.observations.push(observation);
		await writeJsonAtomically(activeBuildRecordPath(ctx), record);
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
		await initializeBuildRecord(ctx);
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
		await initializeBuildRecord(ctx);
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
			await beginRepairBuildRound(ctx);
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
		pendingEvidenceObservations.clear();
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

	const { z } = pi.zod;
	const captureBaselineParameters = z.object({}).strict();
	const finalizeArtifactsParameters = z
		.object({
			validationCommands: z.array(z.string().min(1)).min(1),
		})
		.strict();
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
				const record = await loadBuildRecord(ctx, 1);
				if (record.baseline) return fail("the internal record already contains a baseline.");
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
							text: `LeanFlow immutable BUILD baseline captured at ${head}.`,
						},
					],
				};
			} catch (error) {
				return fail(evidenceFailureMessage(error));
			}
		},
	});

	pi.registerTool<typeof finalizeArtifactsParameters>({
		name: "leanflow_finalize_artifacts",
		label: "Finalize LeanFlow Artifacts",
		description: "Mechanically generate this run's build, complete diff, and runtime evidence artifacts from recorded observations.",
		parameters: finalizeArtifactsParameters,
		strict: true,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const fail = (message: string) => ({
				content: [{ type: "text" as const, text: `LeanFlow artifact finalization failed: ${message}` }],
				isError: true,
			});
			if (state.phase !== "building") return fail("the workflow is not in BUILD.");
			if (state.gateRetryMode === "operational") {
				return fail("an operational Gate retry must reuse the existing artifacts unchanged.");
			}
			if (state.lspProbeStatus === "pending") return fail("the required initial LSP diagnostics probe is incomplete.");
			if (state.baselineCaptured !== true) return fail("capture the immutable BUILD baseline first.");
			if (pendingEvidenceObservations.size > 0) {
				return fail("one or more BUILD observations are still unpersisted.");
			}
			try {
				if (!state.planArtifact || !state.runId || !state.planDigest || !ctx.localProtocolOptions) {
					throw new Error("active plan identity or local protocol options are incomplete");
				}
				const planPath = resolveRunMarkerPath(ctx.localProtocolOptions, state.planArtifact);
				if (!planPath) throw new Error("canonical plan path cannot be resolved");
				const planContent = await fs.readFile(planPath, "utf8");
				if (runIdFromPlan(planContent) !== state.runId || planDigest(planContent) !== state.planDigest) {
					throw new Error("canonical plan run ID or digest changed after approval");
				}

				const record = await loadBuildRecord(ctx, state.gateAttempt + 1);
				if (!record.baseline) throw new Error("the internal build record has no immutable baseline");
				const validations = selectValidationObservations(record, params.validationCommands);
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
					throw new Error(
						`final HEAD ${finalHead || "(empty)"} differs from baseline HEAD ${record.baseline.head}`,
					);
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
				const untrackedPaths = parseNulList(untrackedResult.stdout, untrackedResult.evidence.command).sort((left, right) =>
					Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
				);
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

				const completeDiff = composeCompleteDiff(
					trackedDiffResult.stdout,
					untrackedPatches,
					emptyUntrackedFiles,
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
				persist();
				const verified: string[] = [];
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
					verified.push(`${output.kind}.md ${actualBytes} bytes sha256:${actualDigest}`);
				}
				state.writtenArtifacts = [...REQUIRED_ARTIFACTS];
				persist();
				return {
					content: [
						{
							type: "text" as const,
							text: `LeanFlow Gate artifacts finalized and verified:\n${verified.join("\n")}`,
						},
					],
				};
			} catch (error) {
				return fail(evidenceFailureMessage(error));
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

		const effect = classifyToolEffect(ctx, event, canonicalPlanArtifact, routedDeviceCall, issueReport);
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
		if (state.phase === "building" && state.gateRetryMode === "operational" && effect === "repository_mutation") {
			return {
				block: true,
				reason: "LeanFlow: an operational Gate retry must reuse the implementation and evidence unchanged.",
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
			const observation: BuildEvidenceObservationV1 = {
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

		if (pendingLspProbes.has(event.toolCallId)) {
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
			pendingEvidenceObservations.clear();
			state.baselineCaptured = false;
			state.buildMutationObserved = false;
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
