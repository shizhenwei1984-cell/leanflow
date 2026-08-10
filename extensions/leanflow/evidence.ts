import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	normalizedValidationOutputDigest,
	type ApprovedValidationContract,
	type ValidationSemanticState,
} from "./validation";

export const BUILD_EVIDENCE_RECORD_VERSION = 2 as const;
export const MAX_GATE_ARTIFACT_BYTES = 1024 * 1024;

export interface ParsedLspRequest {
	action: string;
	file?: string;
	line?: number;
	symbol?: string;
	query?: string;
	new_name?: string;
	apply?: boolean;
	timeout?: number;
	payload?: string;
}

export interface BuildEvidenceObservationV2 {
	toolCallId: string;
	/** Immutable operation provenance; absent only on historical observations. */
	operationId?: string;
	runId?: string;
	round?: number;
	planDigest?: string;
	approvedValidationDigest?: string;
	toolName: "bash" | "lsp" | "validation";
	command?: string;
	validationId?: string;
	executable?: string;
	argv?: string[];
	lspRequest?: ParsedLspRequest;
	isError: boolean;
	exitCode?: number;
	timedOut?: boolean;
	repositoryFingerprintBefore?: string;
	repositoryFingerprintAfter?: string;
	startedAt?: number;
	finishedAt?: number;
	text: string;
}

export interface BuildEvidenceBaselineV2 {
	head: string;
	status: string;
	capturedAt: number;
}

export interface BuildEvidenceRecordV2 {
	version: 2;
	runId: string;
	planSlug: string;
	planDigest: string;
	approvedValidationDigest: string;
	round: number;
	baseline?: BuildEvidenceBaselineV2;
	observations: BuildEvidenceObservationV2[];
}

export interface BuildRecordIdentity {
	runId: string;
	planSlug: string;
	planDigest: string;
	approvedValidationDigest: string;
	round: number;
}

export interface SelectedValidation {
	command: string;
	observation: BuildEvidenceObservationV2;
}

export interface GitCommandEvidence {
	command: string;
	exitCode: number;
	output: string;
	label?: string;
}

export interface UntrackedPatch {
	path: string;
	patch: string;
}

export interface CompleteDiff {
	patch: string;
	emptyUntrackedFiles: string[];
}

export interface RenderBuildArtifactsInput {
	planArtifact: string;
	record: BuildEvidenceRecordV2;
	finalHead: string;
	finalStatus: string;
	changedPaths: string[];
	validations: SelectedValidation[];
	gitCommands: GitCommandEvidence[];
	completeDiff: CompleteDiff;
}

export interface RenderedBuildArtifacts {
	build: string;
	diff: string;
	evidence: string;
}

export class BuildEvidenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BuildEvidenceError";
	}
}

const RECORD_KEYS = [
	"version",
	"runId",
	"planSlug",
	"planDigest",
	"approvedValidationDigest",
	"round",
	"baseline",
	"observations",
] as const;
const LEGACY_RECORD_KEYS = ["version", "runId", "planSlug", "planDigest", "round", "baseline", "observations"] as const;
const BASELINE_KEYS = ["head", "status", "capturedAt"] as const;
const OBSERVATION_KEYS = [
	"toolCallId",
	"operationId",
	"runId",
	"round",
	"planDigest",
	"approvedValidationDigest",
	"toolName",
	"command",
	"validationId",
	"executable",
	"argv",
	"lspRequest",
	"isError",
	"exitCode",
	"timedOut",
	"repositoryFingerprintBefore",
	"repositoryFingerprintAfter",
	"startedAt",
	"finishedAt",
	"text",
] as const;
const LEGACY_OBSERVATION_KEYS = [
	"toolCallId",
	"toolName",
	"command",
	"lspRequest",
	"isError",
	"exitCode",
	"timedOut",
	"text",
] as const;
const OBSERVATION_PROVENANCE_KEYS = [
	"operationId",
	"runId",
	"round",
	"planDigest",
	"approvedValidationDigest",
] as const;
const LSP_REQUEST_KEYS = ["action", "file", "line", "symbol", "query", "new_name", "apply", "timeout", "payload"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function finiteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function assertBaseline(value: unknown): asserts value is BuildEvidenceBaselineV2 {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, BASELINE_KEYS)) {
		throw new BuildEvidenceError("Internal build record has an invalid baseline.");
	}
	if (
		!nonEmptyString(value.head) ||
		typeof value.status !== "string" ||
		typeof value.capturedAt !== "number" ||
		!Number.isFinite(value.capturedAt)
	) {
		throw new BuildEvidenceError("Internal build record baseline is incomplete.");
	}
}

function assertParsedLspRequest(value: unknown): asserts value is ParsedLspRequest {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, LSP_REQUEST_KEYS) || !nonEmptyString(value.action)) {
		throw new BuildEvidenceError("Build record contains an invalid LSP request.");
	}
	for (const key of ["file", "symbol", "query", "new_name", "payload"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw new BuildEvidenceError(`Build record LSP request has an invalid ${key} field.`);
		}
	}
	if (value.line !== undefined && !finiteInteger(value.line)) {
		throw new BuildEvidenceError("Build record LSP request has an invalid line field.");
	}
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout))) {
		throw new BuildEvidenceError("Build record LSP request has an invalid timeout field.");
	}
	if (value.apply !== undefined && typeof value.apply !== "boolean") {
		throw new BuildEvidenceError("Build record LSP request has an invalid apply field.");
	}
}

function assertObservation(value: unknown, expected?: BuildRecordIdentity): asserts value is BuildEvidenceObservationV2 {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, OBSERVATION_KEYS)) {
		throw new BuildEvidenceError("Build record contains an invalid observation object.");
	}
	if (
		!nonEmptyString(value.toolCallId) ||
		(value.toolName !== "bash" && value.toolName !== "lsp" && value.toolName !== "validation") ||
		typeof value.isError !== "boolean" ||
		typeof value.text !== "string"
	) {
		throw new BuildEvidenceError("Build record observation is missing required fields.");
	}
	assertObservationProvenance(value, expected);
	if (value.exitCode !== undefined && !finiteInteger(value.exitCode)) {
		throw new BuildEvidenceError("Build record observation has an invalid exit code.");
	}
	if (value.timedOut !== undefined && typeof value.timedOut !== "boolean") {
		throw new BuildEvidenceError("Build record observation has an invalid timeout result.");
	}
	for (const key of ["repositoryFingerprintBefore", "repositoryFingerprintAfter"] as const) {
		if (value[key] !== undefined && (typeof value[key] !== "string" || !SHA256_PATTERN.test(value[key]))) {
			throw new BuildEvidenceError(`Build record observation has an invalid ${key} field.`);
		}
	}
	if (value.toolName === "bash") {
		if (
			!nonEmptyString(value.command) ||
			value.validationId !== undefined ||
			value.executable !== undefined ||
			value.argv !== undefined ||
			value.lspRequest !== undefined ||
			value.repositoryFingerprintBefore !== undefined ||
			value.repositoryFingerprintAfter !== undefined ||
			value.startedAt !== undefined ||
			value.finishedAt !== undefined
		) {
			throw new BuildEvidenceError("Build record bash observation has an invalid shape.");
		}
	} else if (value.toolName === "validation") {
		if (
			!nonEmptyString(value.command) ||
			!nonEmptyString(value.validationId) ||
			!nonEmptyString(value.executable) ||
			!Array.isArray(value.argv) ||
			value.argv.some((argument) => typeof argument !== "string") ||
			value.lspRequest !== undefined ||
			!nonEmptyString(value.repositoryFingerprintBefore) ||
			(!value.isError && !nonEmptyString(value.repositoryFingerprintAfter)) ||
			typeof value.startedAt !== "number" ||
			!Number.isFinite(value.startedAt) ||
			typeof value.finishedAt !== "number" ||
			!Number.isFinite(value.finishedAt) ||
			value.finishedAt < value.startedAt
		) {
			throw new BuildEvidenceError("Build record validation observation has an invalid shape.");
		}
	} else {
		if (
			value.command !== undefined ||
			value.validationId !== undefined ||
			value.executable !== undefined ||
			value.argv !== undefined ||
			value.repositoryFingerprintBefore !== undefined ||
			value.repositoryFingerprintAfter !== undefined ||
			value.startedAt !== undefined ||
			value.finishedAt !== undefined
		) {
			throw new BuildEvidenceError("Build record LSP observation contains incompatible fields.");
		}
		assertParsedLspRequest(value.lspRequest);
	}
}

function assertObservationProvenance(value: Record<string, unknown>, expected?: BuildRecordIdentity): void {
	const supplied = OBSERVATION_PROVENANCE_KEYS.filter((key) => value[key] !== undefined);
	if (supplied.length === 0) return; // Parsed as historical evidence only.
	if (supplied.length !== OBSERVATION_PROVENANCE_KEYS.length) {
		throw new BuildEvidenceError("Build record observation has incomplete operation provenance.");
	}
	if (
		!nonEmptyString(value.operationId) ||
		!nonEmptyString(value.runId) ||
		!finiteInteger(value.round) ||
		(value.round as number) < 1 ||
		typeof value.planDigest !== "string" ||
		!SHA256_PATTERN.test(value.planDigest) ||
		typeof value.approvedValidationDigest !== "string" ||
		!SHA256_PATTERN.test(value.approvedValidationDigest)
	) {
		throw new BuildEvidenceError("Build record observation has invalid operation provenance.");
	}
	if (
		expected &&
		(value.runId !== expected.runId ||
			value.round !== expected.round ||
			value.planDigest !== expected.planDigest ||
			value.approvedValidationDigest !== expected.approvedValidationDigest)
	) {
		throw new BuildEvidenceError("Build record observation provenance does not match the record identity.");
	}
}

export function createBuildEvidenceRecord(identity: BuildRecordIdentity): BuildEvidenceRecordV2 {
	assertIdentity(identity);
	return {
		version: BUILD_EVIDENCE_RECORD_VERSION,
		runId: identity.runId,
		planSlug: identity.planSlug,
		planDigest: identity.planDigest,
		approvedValidationDigest: identity.approvedValidationDigest,
		round: identity.round,
		observations: [],
	};
}

export function parseBuildEvidenceRecord(value: unknown, expected: BuildRecordIdentity): BuildEvidenceRecordV2 {
	assertIdentity(expected);
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
		throw new BuildEvidenceError("Internal build record is missing or has an invalid shape.");
	}
	if (
		value.version !== BUILD_EVIDENCE_RECORD_VERSION ||
		value.runId !== expected.runId ||
		value.planSlug !== expected.planSlug ||
		value.planDigest !== expected.planDigest ||
		value.approvedValidationDigest !== expected.approvedValidationDigest ||
		value.round !== expected.round ||
		!Array.isArray(value.observations)
	) {
		throw new BuildEvidenceError("Internal build record identity does not match the active LeanFlow run.");
	}
	if (value.baseline !== undefined) assertBaseline(value.baseline);
	for (const observation of value.observations) assertObservation(observation, expected);
	return value as unknown as BuildEvidenceRecordV2;
}

export function parseBuildEvidenceRecordWithoutRound(
	value: unknown,
	expected: Omit<BuildRecordIdentity, "round">,
): BuildEvidenceRecordV2 {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
		throw new BuildEvidenceError("Internal build record is missing or has an invalid shape.");
	}
	if (
		value.version !== BUILD_EVIDENCE_RECORD_VERSION ||
		value.runId !== expected.runId ||
		value.planSlug !== expected.planSlug ||
		value.planDigest !== expected.planDigest ||
		value.approvedValidationDigest !== expected.approvedValidationDigest ||
		!Array.isArray(value.observations)
	) {
		throw new BuildEvidenceError("Internal build record identity does not match the active LeanFlow run.");
	}
	if (!finiteInteger(value.round) || (value.round as number) < 1) {
		throw new BuildEvidenceError("Internal build record has an invalid round.");
	}
	if (value.baseline !== undefined) assertBaseline(value.baseline);
	const recordIdentity: BuildRecordIdentity = {
		runId: expected.runId,
		planSlug: expected.planSlug,
		planDigest: expected.planDigest,
		approvedValidationDigest: expected.approvedValidationDigest,
		round: value.round as number,
	};
	for (const observation of value.observations) assertObservation(observation, recordIdentity);
	return value as unknown as BuildEvidenceRecordV2;
}

export function migrateLegacyBuildEvidenceRecord(
	value: unknown,
	expected: BuildRecordIdentity,
): BuildEvidenceRecordV2 {
	assertIdentity(expected);
	if (!isPlainRecord(value) || !hasOnlyKeys(value, LEGACY_RECORD_KEYS)) {
		throw new BuildEvidenceError("Legacy build record is missing or has an invalid shape.");
	}
	if (
		value.version !== 1 ||
		value.runId !== expected.runId ||
		value.planSlug !== expected.planSlug ||
		value.planDigest !== expected.planDigest ||
		value.round !== expected.round ||
		!Array.isArray(value.observations)
	) {
		throw new BuildEvidenceError("Legacy build record identity does not match the active LeanFlow run.");
	}
	if (value.baseline !== undefined) assertBaseline(value.baseline);
	const observations: BuildEvidenceObservationV2[] = [];
	for (const candidate of value.observations) {
		if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, LEGACY_OBSERVATION_KEYS)) {
			throw new BuildEvidenceError("Legacy build record contains an invalid observation.");
		}
		const migrated = { ...candidate } as unknown;
		assertObservation(migrated);
		observations.push(migrated);
	}
	return {
		version: BUILD_EVIDENCE_RECORD_VERSION,
		runId: expected.runId,
		planSlug: expected.planSlug,
		planDigest: expected.planDigest,
		approvedValidationDigest: expected.approvedValidationDigest,
		round: expected.round,
		...(value.baseline ? { baseline: value.baseline as unknown as BuildEvidenceBaselineV2 } : {}),
		observations,
	};
}

function assertIdentity(identity: BuildRecordIdentity): void {
	if (
		!nonEmptyString(identity.runId) ||
		!nonEmptyString(identity.planSlug) ||
		!SHA256_PATTERN.test(identity.planDigest) ||
		!SHA256_PATTERN.test(identity.approvedValidationDigest) ||
		!finiteInteger(identity.round) ||
		identity.round < 1
	) {
		throw new BuildEvidenceError("Invalid build record identity.");
	}
}

/** Historical observations may remain readable, but cannot authorize a current BUILD validation. */
export function hasAuthoritativeObservationProvenance(
	observation: BuildEvidenceObservationV2,
	record: BuildEvidenceRecordV2,
): boolean {
	return (
		typeof observation.operationId === "string" &&
		observation.operationId.length > 0 &&
		observation.runId === record.runId &&
		observation.round === record.round &&
		observation.planDigest === record.planDigest &&
		observation.approvedValidationDigest === record.approvedValidationDigest
	);
}

export function validationSemanticStates(
	record: BuildEvidenceRecordV2,
	contract: ApprovedValidationContract,
	repositoryFingerprint: string,
): ValidationSemanticState[] {
	if (record.approvedValidationDigest !== contract.digest) {
		throw new BuildEvidenceError("BUILD record validation contract does not match the approved plan.");
	}
	const approvedById = new Map(contract.validations.map((validation) => [validation.id, validation]));
	for (const observation of record.observations) {
		if (observation.toolName !== "validation" || !hasAuthoritativeObservationProvenance(observation, record)) continue;
		const approved = approvedById.get(observation.validationId!);
		if (
			!approved ||
			observation.command !== approved.displayCommand ||
			observation.executable !== approved.executable ||
			JSON.stringify(observation.argv) !== JSON.stringify(approved.argv)
		) {
			throw new BuildEvidenceError(`Validation observation is not approved by the plan: ${observation.validationId}`);
		}
	}
	return contract.validations.map((validation) => {
		const observation = record.observations
			.filter(
				(candidate) =>
					candidate.toolName === "validation" &&
					hasAuthoritativeObservationProvenance(candidate, record) &&
					candidate.validationId === validation.id &&
					candidate.command === validation.displayCommand &&
					candidate.executable === validation.executable &&
					JSON.stringify(candidate.argv) === JSON.stringify(validation.argv),
			)
			.at(-1);
		if (!observation) return { id: validation.id, status: "missing" };
		const output = normalizedValidationOutputDigest(observation.text);
		const repositoryFingerprintAfter = observation.repositoryFingerprintAfter;
		if (
			observation.isError ||
			observation.timedOut === true ||
			observation.exitCode !== 0 ||
			observation.repositoryFingerprintBefore !== repositoryFingerprintAfter
		) {
			return {
				id: validation.id,
				status: "failed",
				normalizedOutputDigest: output,
				...(repositoryFingerprintAfter ? { repositoryFingerprintAfter } : {}),
				observationId: observation.toolCallId,
			};
		}
		if (repositoryFingerprintAfter !== repositoryFingerprint) {
			return {
				id: validation.id,
				status: "stale",
				normalizedOutputDigest: output,
				...(repositoryFingerprintAfter ? { repositoryFingerprintAfter } : {}),
				observationId: observation.toolCallId,
			};
		}
		return {
			id: validation.id,
			status: "passed",
			normalizedOutputDigest: output,
			observationId: observation.toolCallId,
			repositoryFingerprintAfter,
		};
	});
}

export function selectValidationObservations(
	record: BuildEvidenceRecordV2,
	contract: ApprovedValidationContract,
	repositoryFingerprint: string,
): SelectedValidation[] {
	const states = validationSemanticStates(record, contract, repositoryFingerprint);
	const incomplete = states.filter((state) => state.status !== "passed");
	if (incomplete.length > 0) {
		throw new BuildEvidenceError(
			`Required validations are incomplete: ${incomplete.map((state) => `${state.id}=${state.status}`).join(", ")}`,
		);
	}
	return contract.validations.map((validation) => {
		const observation = record.observations
			.filter(
				(candidate) =>
					candidate.toolName === "validation" &&
					hasAuthoritativeObservationProvenance(candidate, record) &&
					candidate.validationId === validation.id &&
					candidate.command === validation.displayCommand &&
					candidate.executable === validation.executable &&
					JSON.stringify(candidate.argv) === JSON.stringify(validation.argv),
			)
			.at(-1);
		if (!observation) throw new BuildEvidenceError(`Required validation observation is missing: ${validation.id}`);
		return { command: validation.displayCommand, observation };
	});
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function withTrailingNewline(value: string): string {
	return value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
}

export function composeCompleteDiff(
	trackedPatch: string,
	untrackedPatches: readonly UntrackedPatch[],
	emptyUntrackedFiles: readonly string[],
): CompleteDiff {
	const paths = [...untrackedPatches.map(({ path }) => path), ...emptyUntrackedFiles];
	if (paths.some((path) => !nonEmptyString(path)) || new Set(paths).size !== paths.length) {
		throw new BuildEvidenceError("Untracked diff paths must be non-empty and unique.");
	}
	const patchParts = [trackedPatch, ...[...untrackedPatches].sort((a, b) => compareUtf8(a.path, b.path)).map(({ patch }) => patch)]
		.filter((part) => part.length > 0)
		.map(withTrailingNewline);
	return {
		patch: patchParts.join(""),
		emptyUntrackedFiles: [...emptyUntrackedFiles].sort(compareUtf8),
	};
}

function markdownFence(text: string, language = "text"): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	const body = text.length > 0 ? withTrailingNewline(text) : "(no output)\n";
	return `${fence}${language}\n${body}${fence}`;
}

function headingText(value: string): string {
	return value.replace(/[\r\n]+/g, " ↵ ").trim() || "(empty command)";
}

function renderObservation(observation: BuildEvidenceObservationV2): string[] {
	const lines = [
		`- tool call: \`${observation.toolCallId}\``,
		`- error: ${observation.isError}`,
		`- timed out: ${observation.timedOut === true}`,
	];
	if (observation.exitCode !== undefined) lines.push(`- exit code: ${observation.exitCode}`);
	if (observation.toolName === "lsp") {
		lines.push("- parsed request:", markdownFence(JSON.stringify(observation.lspRequest, null, 2), "json"));
	} else {
		lines.push("- command:", markdownFence(observation.command ?? "", "sh"));
		if (observation.toolName === "validation") {
			lines.push(
				`- validation ID: \`${observation.validationId}\``,
				`- repository before: \`${observation.repositoryFingerprintBefore}\``,
				`- repository after: \`${observation.repositoryFingerprintAfter}\``,
			);
		}
	}
	lines.push("- result:", markdownFence(observation.text));
	return lines;
}

function extractTestSummaries(validations: readonly SelectedValidation[]): string[] {
	const summaries: string[] = [];
	for (const { command, observation } of validations) {
		for (const line of observation.text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (
				/^\d+\s+(?:pass|fail)\b/i.test(trimmed) ||
				/^\d+\s+expect\(\)\s+calls?\b/i.test(trimmed) ||
				/^Ran\b/.test(trimmed) ||
				/^(?:OK|FAILED)\b/.test(trimmed)
			) {
				summaries.push(`- \`${headingText(command)}\`: ${trimmed}`);
			}
		}
	}
	return summaries.length > 0 ? summaries : ["- summary parser: unrecognized; see full output"];
}

function assertRenderedSize(name: keyof RenderedBuildArtifacts, content: string): void {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_GATE_ARTIFACT_BYTES) {
		throw new BuildEvidenceError(`${name}.md exceeds the 1 MiB Gate artifact limit (${bytes} bytes).`);
	}
}

export function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildGateSnapshotDigest(input: { planDigest: string; build: string; diff: string; evidence: string }): string {
	return sha256Text(`${input.planDigest}\n${input.build}\n${input.diff}\n${input.evidence}`);
}

export function renderBuildArtifacts(input: RenderBuildArtifactsInput): RenderedBuildArtifacts {
	const record = parseBuildEvidenceRecord(input.record, {
		runId: input.record.runId,
		planSlug: input.record.planSlug,
		planDigest: input.record.planDigest,
		approvedValidationDigest: input.record.approvedValidationDigest,
		round: input.record.round,
	});
	if (!record.baseline) throw new BuildEvidenceError("Cannot render Gate artifacts without an immutable baseline.");
	if (input.finalHead !== record.baseline.head) {
		throw new BuildEvidenceError("Final HEAD differs from the immutable BUILD baseline HEAD.");
	}
	const changedPaths = [...new Set(input.changedPaths)].sort(compareUtf8);
	const summaries = extractTestSummaries(input.validations);
	const lspObservations = record.observations.filter((observation) => observation.toolName === "lsp");

	const buildLines = [
		"# LeanFlow Build Record",
		"",
		`- Plan: \`${input.planArtifact}\``,
		`- Run ID: \`${record.runId}\``,
		`- Plan slug: \`${record.planSlug}\``,
		`- Plan SHA-256: \`${record.planDigest}\``,
		`- Approved validation contract SHA-256: \`${record.approvedValidationDigest}\``,
		`- Build round: ${record.round}`,
		"",
		"## LSP observations",
		"",
	];
	if (lspObservations.length === 0) {
		buildLines.push("No LSP request was recorded for this round.", "");
	} else {
		for (const [index, observation] of lspObservations.entries()) {
			buildLines.push(`### LSP ${index + 1}: ${headingText(observation.lspRequest?.action ?? "unknown")}`, "", ...renderObservation(observation), "");
		}
	}
	buildLines.push(
		"## Immutable baseline",
		"",
		`- captured at: ${new Date(record.baseline.capturedAt).toISOString()}`,
		`- HEAD: \`${record.baseline.head}\``,
		"- status:",
		markdownFence(record.baseline.status),
		"",
		"## Final repository state",
		"",
		`- HEAD: \`${input.finalHead}\``,
		"- status:",
		markdownFence(input.finalStatus),
		"",
		"## Changed paths",
		"",
		...(changedPaths.length > 0 ? changedPaths.map((path) => `- \`${path}\``) : ["- none"]),
		"",
		"## Selected validations",
		"",
	);
	for (const [index, validation] of input.validations.entries()) {
		buildLines.push(
			`### Validation ${index + 1}: ${headingText(validation.command)}`,
			"",
			...renderObservation(validation.observation),
			"",
		);
	}
	buildLines.push("## Test suite summary", "", ...summaries, "");

	const diffLines = [
		"# LeanFlow Complete Diff",
		"",
		`- Plan: \`${input.planArtifact}\``,
		`- Run ID: \`${record.runId}\``,
		`- Baseline HEAD: \`${record.baseline.head}\``,
		`- Final HEAD: \`${input.finalHead}\``,
		"",
		"## Complete binary patch",
		"",
		markdownFence(input.completeDiff.patch, "diff"),
		"",
		"## Empty untracked files",
		"",
		...(input.completeDiff.emptyUntrackedFiles.length > 0
			? input.completeDiff.emptyUntrackedFiles.map((file) => `- \`${file}\``)
			: ["- none"]),
		"",
	];

	const evidenceLines = [
		"# LeanFlow Runtime Evidence",
		"",
		`- Plan: \`${input.planArtifact}\``,
		`- Run ID: \`${record.runId}\``,
		`- Build round: ${record.round}`,
		`- Approved validation contract SHA-256: \`${record.approvedValidationDigest}\``,
		"",
	];
	for (const [index, observation] of lspObservations.entries()) {
		evidenceLines.push(
			`## LSP ${index + 1}: ${headingText(observation.lspRequest?.action ?? "unknown")}`,
			"",
			...renderObservation(observation),
			"",
		);
	}
	for (const [index, command] of input.gitCommands.entries()) {
		evidenceLines.push(
			`## Git ${index + 1}: ${headingText(command.label ?? command.command)}`,
			"",
			`- command: \`${headingText(command.command)}\``,
			`- exit code: ${command.exitCode}`,
			"- output:",
			markdownFence(command.output),
			"",
		);
	}
	for (const [index, validation] of input.validations.entries()) {
		evidenceLines.push(
			`## Validation ${index + 1}: ${headingText(validation.command)}`,
			"",
			...renderObservation(validation.observation),
			"",
		);
	}
	evidenceLines.push("## Test suite summary", "", ...summaries, "");

	const rendered = {
		build: buildLines.join("\n"),
		diff: diffLines.join("\n"),
		evidence: evidenceLines.join("\n"),
	};
	for (const [name, content] of Object.entries(rendered) as [keyof RenderedBuildArtifacts, string][]) {
		assertRenderedSize(name, content);
	}
	return rendered;
}
