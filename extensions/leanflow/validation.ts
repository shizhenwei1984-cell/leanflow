import { createHash } from "node:crypto";

export const APPROVED_VALIDATION_CONTRACT_VERSION = 1 as const;

export type ApprovedValidationKind = "test" | "lint" | "typecheck" | "build" | "smoke";

export interface ApprovedValidation {
	id: string;
	executable: string;
	argv: string[];
	digest: string;
	kind: ApprovedValidationKind;
	required: true;
	displayCommand: string;
}

export interface ApprovedValidationContract {
	version: 1;
	planDigest: string;
	validations: ApprovedValidation[];
	digest: string;
}

export interface RejectedValidation {
	raw: string;
	reason: string;
}

export interface ValidationParseResult {
	approved: ApprovedValidation[];
	rejected: RejectedValidation[];
	contract?: ApprovedValidationContract;
}

export type ValidationSemanticStatus = "missing" | "failed" | "stale" | "passed";

export interface ValidationSemanticState {
	id: string;
	status: ValidationSemanticStatus;
	observationId?: string;
	normalizedOutputDigest?: string;
	repositoryFingerprintAfter?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHELL_SYNTAX = /[\r\n;&|<>`$(){}\[\]#!\\]/;
const SAFE_TOKEN = /^[\w./*:=+@,-]+$/;
const FIXED_COMMANDS: Readonly<Record<string, ApprovedValidationKind>> = {
	"npm test": "test",
	"pnpm test": "test",
	"yarn test": "test",
	"npx vitest run": "test",
	"npx jest": "test",
	pytest: "test",
	"pytest -q": "test",
	"python -m pytest": "test",
	"python3 -m pytest": "test",
	"python -m unittest": "test",
	"python3 -m unittest": "test",
	"uv run pytest": "test",
	"go test ./...": "test",
	"cargo test": "test",
	"cargo check": "typecheck",
	"cargo clippy": "typecheck",
	"make test": "test",
	"make check": "typecheck",
	"git diff --check": "lint",
	"tsc --noEmit": "typecheck",
	"bunx tsc --noEmit": "typecheck",
	"mvn test": "test",
	"mvn verify": "test",
	"./mvnw test": "test",
	"gradle test": "test",
	"./gradlew test": "test",
	"dotnet test": "test",
	"bundle exec rspec": "test",
};
const COMMAND_STARTS = new Set([
	"bun",
	"bunx",
	"npm",
	"pnpm",
	"yarn",
	"npx",
	"pytest",
	"python",
	"python3",
	"uv",
	"go",
	"cargo",
	"make",
	"git",
	"tsc",
	"mvn",
	"./mvnw",
	"gradle",
	"./gradlew",
	"dotnet",
	"bundle",
	"bin/rails",
]);
const DANGEROUS_EXECUTABLES = new Set(["rm", "curl", "wget", "sh", "bash", "zsh", "sudo"]);
const BUN_BUILD_OUTPUT_OPTIONS = new Set(["--outfile", "--outdir"]);

function hasUnsafeBunBuildOutput(tokens: readonly string[]): boolean {
	for (let index = 2; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--compile") return true;
		if (BUN_BUILD_OUTPUT_OPTIONS.has(token)) {
			const target = tokens[index + 1];
			if (!target?.startsWith("/tmp/")) return true;
			index++;
			continue;
		}
		for (const option of BUN_BUILD_OUTPUT_OPTIONS) {
			if (token.startsWith(`${option}=`) && !token.slice(option.length + 1).startsWith("/tmp/")) return true;
		}
	}
	return false;
}
const SAFE_PACKAGE_SCRIPTS = /^(?:test(?::[\w-]+)?|lint|typecheck|check|build|smoke)$/;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function validationDigest(value: string): string {
	return `validation-${sha256(value)}`;
}

function normalizeCandidate(line: string): string {
	return line
		.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
		.replace(/^\[[ xX]\]\s*/, "")
		.replace(/^[`'"]+|[`'"]+$/g, "")
		.trim();
}

function safeTokens(tokens: readonly string[]): boolean {
	return tokens.every((token) => SAFE_TOKEN.test(token) && token !== ".." && !token.split("/").includes(".."));
}

function tokenizeValidationCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	for (const character of command.trim()) {
		if (quote) {
			if (character === quote) quote = undefined;
			else token += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (token.length > 0) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += character;
	}
	if (quote) return undefined;
	if (token.length > 0) tokens.push(token);
	return tokens.length > 0 ? tokens : undefined;
}

export function validationCommandRejection(command: string): string | undefined {
	const normalized = command.trim();
	if (!normalized) return "validation command is empty";
	if (SHELL_SYNTAX.test(normalized)) {
		return "shell composition, expansion, and redirection are not allowed";
	}
	const tokens = tokenizeValidationCommand(normalized);
	if (!tokens) return "validation command has unbalanced or empty quoting";
	const executable = tokens[0]!;
	if (DANGEROUS_EXECUTABLES.has(executable)) return `dangerous executable is not allowed: ${executable}`;
	if (
		(executable === "npm" || executable === "pnpm" || executable === "yarn") &&
		tokens[1] === "publish"
	) {
		return "package publication is not a validation";
	}
	if (executable === "git" && tokens[1] === "push") return "git push is not a validation";
	if (executable === "make" && tokens[1] === "install") return "make install is not a validation";
	if (executable === "bun" && tokens[1] === "build" && hasUnsafeBunBuildOutput(tokens)) {
		return "bun build output must remain under /tmp";
	}
	if (tokens.some((token) => /^(?:deploy|release|upload)$/i.test(token))) {
		return "deployment, release, and upload commands are not validations";
	}
	return undefined;
}

export function parseApprovedValidation(command: string): ApprovedValidation | undefined {
	const displayCommand = command.trim();
	if (validationCommandRejection(displayCommand)) return undefined;
	const tokens = tokenizeValidationCommand(displayCommand);
	if (!tokens || !safeTokens(tokens)) return undefined;

	const isFocusedBunTest =
		tokens[0] === "bun" &&
		tokens[1] === "test" &&
		tokens.slice(2).every((token) => !token.startsWith("-") && !token.startsWith("/"));
	const isPackageScript =
		(tokens[0] === "npm" || tokens[0] === "pnpm" || tokens[0] === "yarn" || tokens[0] === "bun") &&
		tokens[1] === "run" &&
		tokens.length === 3 &&
		SAFE_PACKAGE_SCRIPTS.test(tokens[2]!);
	const isProjectTestScript = /^(?:\.\/)?scripts\/(?:test|check)\.sh$/.test(tokens[0]!) && tokens.length === 1;
	const isRailsTest = tokens[0] === "bin/rails" && tokens.length === 2 && tokens[1] === "test";
	const isPythonDiscovery =
		(tokens[0] === "python" || tokens[0] === "python3") &&
		tokens[1] === "-m" &&
		(tokens[2] === "unittest" || tokens[2] === "pytest") &&
		tokens.slice(3).every((token) => SAFE_TOKEN.test(token));
	const isStrictTsc =
		(tokens[0] === "bunx" && tokens[1] === "tsc" && tokens[2] === "--noEmit") ||
		(tokens[0] === "tsc" && tokens[1] === "--noEmit");
	const isBunBuild =
		tokens[0] === "bun" &&
		tokens[1] === "build" &&
		tokens.length >= 3 &&
		tokens.slice(2).every((token) => SAFE_TOKEN.test(token));

	let kind: ApprovedValidationKind | undefined;
	if (isFocusedBunTest || isProjectTestScript || isRailsTest || isPythonDiscovery) kind = "test";
	else if (isPackageScript) {
		const script = tokens[2]!;
		kind = script.startsWith("test")
			? "test"
			: script === "lint" || script === "check"
				? "lint"
				: script === "typecheck"
					? "typecheck"
					: script === "build"
						? "build"
						: "smoke";
	} else if (isStrictTsc) kind = "typecheck";
	else if (isBunBuild) kind = "build";
	else kind = FIXED_COMMANDS[displayCommand];
	if (!kind) return undefined;

	const digest = validationDigest(displayCommand);
	return {
		id: digest,
		executable: tokens[0]!,
		argv: tokens.slice(1),
		digest,
		kind,
		required: true,
		displayCommand,
	};
}

function validationSection(content: string): string[] {
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index]!);
		if (!heading || !/verification|验证/i.test(heading[2]!)) continue;
		const depth = heading[1]!.length;
		const body: string[] = [];
		for (let next = index + 1; next < lines.length; next++) {
			const line = lines[next]!;
			const nextHeading = /^(#{1,6})\s+/.exec(line);
			if (nextHeading && nextHeading[1]!.length <= depth) break;
			body.push(line);
		}
		return body;
	}
	return [];
}

function extractValidationCandidates(content: string): string[] {
	const section = validationSection(content);
	const candidates: string[] = [];
	let inFence = false;
	let fence = "";
	for (const line of section) {
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			if (!inFence) {
				inFence = true;
				fence = fenceMatch[1]!;
			} else if (fenceMatch[1] === fence) {
				inFence = false;
				fence = "";
			}
			continue;
		}
		if (inFence) {
			const candidate = normalizeCandidate(line);
			if (candidate && !candidate.startsWith("#")) candidates.push(candidate);
			continue;
		}

		let hasInline = false;
		const inline = /`([^`]+)`/g;
		let match: RegExpExecArray | null;
		while ((match = inline.exec(line)) !== null) {
			hasInline = true;
			const candidate = normalizeCandidate(match[1] ?? "");
			if (candidate) candidates.push(candidate);
		}
		if (hasInline) continue;
		const candidate = normalizeCandidate(line);
		const first = candidate.split(/\s+/, 1)[0];
		if (first && COMMAND_STARTS.has(first)) candidates.push(candidate);
	}
	return candidates;
}

export function createApprovedValidationContract(
	planDigest: string,
	validations: readonly ApprovedValidation[],
): ApprovedValidationContract {
	if (!SHA256_PATTERN.test(planDigest)) throw new Error("approved validation contract requires a canonical plan digest");
	if (validations.length === 0) throw new Error("approved validation contract requires at least one validation");
	const canonical = validations.map((validation) => {
		const parsed = parseApprovedValidation(validation.displayCommand);
		if (!parsed || parsed.digest !== validation.digest) {
			throw new Error("approved validation contract contains a noncanonical validation");
		}
		return parsed;
	});
	const identities = new Set(canonical.map((validation) => validation.id));
	if (identities.size !== canonical.length) throw new Error("approved validation contract contains duplicate validations");
	const payload = {
		version: APPROVED_VALIDATION_CONTRACT_VERSION,
		planDigest,
		validations: canonical,
	};
	return { ...payload, digest: sha256(JSON.stringify(payload)) };
}

export function parseValidationContract(content: string, planDigest: string): ValidationParseResult {
	const approved: ApprovedValidation[] = [];
	const rejected: RejectedValidation[] = [];
	const seen = new Set<string>();
	for (const raw of extractValidationCandidates(content)) {
		const parsed = parseApprovedValidation(raw);
		if (!parsed) {
			rejected.push({
				raw,
				reason: validationCommandRejection(raw) ?? "unsupported or malformed validation command",
			});
			continue;
		}
		if (seen.has(parsed.id)) continue;
		seen.add(parsed.id);
		approved.push(parsed);
	}
	const contract =
		rejected.length === 0 && approved.length > 0
			? createApprovedValidationContract(planDigest, approved)
			: undefined;
	return { approved, rejected, ...(contract ? { contract } : {}) };
}
export function validationStatesDigest(states: readonly ValidationSemanticState[]): string {
	return sha256(
		JSON.stringify(
			states.map((state) => ({
				id: state.id,
				status: state.status,
				...(state.observationId !== undefined ? { observationId: state.observationId } : {}),
				...(state.normalizedOutputDigest !== undefined
					? { normalizedOutputDigest: state.normalizedOutputDigest }
					: {}),
				...(state.repositoryFingerprintAfter !== undefined
					? { repositoryFingerprintAfter: state.repositoryFingerprintAfter }
					: {}),
			})),
		),
	);
}

export function normalizedValidationOutputDigest(output: string): string {
	return sha256(output.replace(/\r\n/g, "\n").trimEnd());
}
