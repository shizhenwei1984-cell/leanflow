import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const BUILD_EVIDENCE_RECORD_VERSION = 1 as const;
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

export interface BuildEvidenceObservationV1 {
	toolCallId: string;
	toolName: "bash" | "lsp";
	command?: string;
	lspRequest?: ParsedLspRequest;
	isError: boolean;
	exitCode?: number;
	timedOut?: boolean;
	text: string;
}

export interface BuildEvidenceBaselineV1 {
	head: string;
	status: string;
	capturedAt: number;
}

export interface BuildEvidenceRecordV1 {
	version: 1;
	runId: string;
	planSlug: string;
	planDigest: string;
	round: number;
	baseline?: BuildEvidenceBaselineV1;
	observations: BuildEvidenceObservationV1[];
}

export interface BuildRecordIdentity {
	runId: string;
	planSlug: string;
	planDigest: string;
	round: number;
}

export interface SelectedValidation {
	command: string;
	observation: BuildEvidenceObservationV1;
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
	record: BuildEvidenceRecordV1;
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

const RECORD_KEYS = ["version", "runId", "planSlug", "planDigest", "round", "baseline", "observations"] as const;
const BASELINE_KEYS = ["head", "status", "capturedAt"] as const;
const OBSERVATION_KEYS = [
	"toolCallId",
	"toolName",
	"command",
	"lspRequest",
	"isError",
	"exitCode",
	"timedOut",
	"text",
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

function assertObservation(value: unknown): asserts value is BuildEvidenceObservationV1 {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, OBSERVATION_KEYS)) {
		throw new BuildEvidenceError("Build record contains an invalid observation object.");
	}
	if (
		!nonEmptyString(value.toolCallId) ||
		(value.toolName !== "bash" && value.toolName !== "lsp") ||
		typeof value.isError !== "boolean" ||
		typeof value.text !== "string"
	) {
		throw new BuildEvidenceError("Build record observation is missing required fields.");
	}
	if (value.exitCode !== undefined && !finiteInteger(value.exitCode)) {
		throw new BuildEvidenceError("Build record observation has an invalid exit code.");
	}
	if (value.timedOut !== undefined && typeof value.timedOut !== "boolean") {
		throw new BuildEvidenceError("Build record observation has an invalid timeout result.");
	}
	if (value.toolName === "bash") {
		if (!nonEmptyString(value.command) || value.lspRequest !== undefined) {
			throw new BuildEvidenceError("Build record bash observation has an invalid command shape.");
		}
	} else {
		if (value.command !== undefined) {
			throw new BuildEvidenceError("Build record LSP observation cannot contain a bash command.");
		}
		assertParsedLspRequest(value.lspRequest);
	}
}

export function createBuildEvidenceRecord(identity: BuildRecordIdentity): BuildEvidenceRecordV1 {
	assertIdentity(identity);
	return {
		version: BUILD_EVIDENCE_RECORD_VERSION,
		runId: identity.runId,
		planSlug: identity.planSlug,
		planDigest: identity.planDigest,
		round: identity.round,
		observations: [],
	};
}

export function parseBuildEvidenceRecord(value: unknown, expected: BuildRecordIdentity): BuildEvidenceRecordV1 {
	assertIdentity(expected);
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
		throw new BuildEvidenceError("Internal build record is missing or has an invalid shape.");
	}
	if (
		value.version !== BUILD_EVIDENCE_RECORD_VERSION ||
		value.runId !== expected.runId ||
		value.planSlug !== expected.planSlug ||
		value.planDigest !== expected.planDigest ||
		value.round !== expected.round ||
		!Array.isArray(value.observations)
	) {
		throw new BuildEvidenceError("Internal build record identity does not match the active LeanFlow run.");
	}
	if (value.baseline !== undefined) {
		if (!isPlainRecord(value.baseline) || !hasOnlyKeys(value.baseline, BASELINE_KEYS)) {
			throw new BuildEvidenceError("Internal build record has an invalid baseline.");
		}
		if (
			!nonEmptyString(value.baseline.head) ||
			typeof value.baseline.status !== "string" ||
			typeof value.baseline.capturedAt !== "number" ||
			!Number.isFinite(value.baseline.capturedAt)
		) {
			throw new BuildEvidenceError("Internal build record baseline is incomplete.");
		}
	}
	for (const observation of value.observations) assertObservation(observation);
	return value as unknown as BuildEvidenceRecordV1;
}

export function parseBuildEvidenceRecordWithoutRound(
	value: unknown,
	expected: Omit<BuildRecordIdentity, "round">,
): BuildEvidenceRecordV1 {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
		throw new BuildEvidenceError("Internal build record is missing or has an invalid shape.");
	}
	if (
		value.version !== BUILD_EVIDENCE_RECORD_VERSION ||
		value.runId !== expected.runId ||
		value.planSlug !== expected.planSlug ||
		value.planDigest !== expected.planDigest ||
		!Array.isArray(value.observations)
	) {
		throw new BuildEvidenceError("Internal build record identity does not match the active LeanFlow run.");
	}
	if (!finiteInteger(value.round) || (value.round as number) < 1) {
		throw new BuildEvidenceError("Internal build record has an invalid round.");
	}
	if (value.baseline !== undefined) {
		if (!isPlainRecord(value.baseline) || !hasOnlyKeys(value.baseline, BASELINE_KEYS)) {
			throw new BuildEvidenceError("Internal build record has an invalid baseline.");
		}
		if (
			!nonEmptyString(value.baseline.head) ||
			typeof value.baseline.status !== "string" ||
			typeof value.baseline.capturedAt !== "number" ||
			!Number.isFinite(value.baseline.capturedAt)
		) {
			throw new BuildEvidenceError("Internal build record baseline is incomplete.");
		}
	}
	for (const observation of value.observations) assertObservation(observation);
	return value as unknown as BuildEvidenceRecordV1;
}

function assertIdentity(identity: BuildRecordIdentity): void {
	if (
		!nonEmptyString(identity.runId) ||
		!nonEmptyString(identity.planSlug) ||
		!SHA256_PATTERN.test(identity.planDigest) ||
		!finiteInteger(identity.round) ||
		identity.round < 1
	) {
		throw new BuildEvidenceError("Invalid build record identity.");
	}
}

export function selectValidationObservations(
	record: BuildEvidenceRecordV1,
	validationCommands: readonly string[],
): SelectedValidation[] {
	if (validationCommands.length === 0) {
		throw new BuildEvidenceError("At least one validation command is required.");
	}
	const commands = [...validationCommands];
	if (commands.some((command) => command.trim().length === 0)) {
		throw new BuildEvidenceError("Validation commands must be non-empty after trimming.");
	}
	if (new Set(commands).size !== commands.length) {
		throw new BuildEvidenceError("Validation commands must be globally unique.");
	}

	return commands.map((command) => {
		const matches = record.observations.filter(
			(observation) => observation.toolName === "bash" && observation.command === command,
		);
		const observation = matches.at(-1);
		if (!observation) {
			throw new BuildEvidenceError(`Validation command was not recorded in the current round: ${command}`);
		}
		if (observation.isError || observation.timedOut === true || observation.exitCode !== 0) {
			throw new BuildEvidenceError(`Validation command did not finish synchronously with exit code 0: ${command}`);
		}
		return { command, observation };
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

function renderObservation(observation: BuildEvidenceObservationV1): string[] {
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
