import type { HandoffStatus } from "./state";
import { parseApprovedValidation, type ApprovedValidation } from "./validation";

export type HandoffBlockerCode =
	| "TARGET_MISSING"
	| "BEHAVIOR_MISSING"
	| "ACCEPTANCE_MISSING"
	| "VERIFICATION_MISSING";

export interface HandoffBlocker {
	code: HandoffBlockerCode;
	detail: string;
}

export interface HandoffResult {
	status: HandoffStatus;
	blockers: HandoffBlocker[];
	warnings: string[];
}

const TARGET_PATH_OCCURRENCES =
	/\b[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|py|md|json|yml|yaml|pm|pl|go|rs|toml|lock|mk|mod|sum|gradle)\b|\bDockerfile\b|\bMakefile\b|\bgo\.mod\b|\bgo\.sum\b/gi;
const BEHAVIOR_VERB =
	/\b(?:change|update|add|remove|implement|fix|refactor|extend|replace|rename|delete|create|migrate|split|merge|rewrite|ensure|prevent|persist|validate|check|verify|support|enable|disable|handle|process)\b|修改|新增|添加|删除|创建|调整|替换|迁移|拆分|合并|重写|修复|实现|扩展|重命名|支持|确保|避免|保证|处理|校验|验证|检查|兼容/i;
const PLACEHOLDER_LINE = /^(?:TBD|N\/A|\?|unknown|待定|待补充)\s*$/i;
const EDGE_CASE_CUE = /\bedge[ -]?cases?\b|边界(?:情况|条件)?|异常(?:情况)?/i;
const METADATA_LINE = /^\s*(?:LeanFlow run ID|LSP applicability):/i;
const MARKDOWN_HEADING = /^(#{1,6})\s+/;

const PLACEHOLDER_TOKENS =
	/^(?:TBD|N\/A|\?|unknown|待定|待补充|none|nope|todo|fixme)$/i;
const DECORATED_PLACEHOLDER = /^(?:TBD|N\/A|TODO|unknown)\b/i;
const DECORATED_PLACEHOLDER_CJK = /^(?:待定|待补充)/;
const ROOT_SPECIAL_FILES = new Set([
	"package.json",
	"README.md",
	".gitignore",
	"Dockerfile",
	"Makefile",
	"Gemfile",
	"Cargo.toml",
	"tsconfig.json",
]);

function normalizeEntry(line: string): string {
	return line
		.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
		.replace(/^\[[ xX]\]\s*/, "")
		.replace(/^[`'"]+|[`'"]+$/g, "")
		.trim();
}

function isPlaceholder(value: string): boolean {
	const n = normalizeEntry(value).toLowerCase();
	return PLACEHOLDER_TOKENS.test(n) || PLACEHOLDER_LINE.test(n);
}

function isDecoratedPlaceholder(value: string): boolean {
	const n = normalizeEntry(value);
	if (!n) return false;
	if (PLACEHOLDER_TOKENS.test(n) || PLACEHOLDER_LINE.test(n)) return true;
	if (DECORATED_PLACEHOLDER.test(n) || DECORATED_PLACEHOLDER_CJK.test(n)) return true;
	if (/^(?:echo|printf)\s+(?:TBD|N\/A|unknown|TODO)\b/i.test(n)) return true;
	return false;
}
function isValidRepoPath(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.startsWith("/") || trimmed.includes("\0") || trimmed.includes("..")) {
		return false;
	}
	if (isDecoratedPlaceholder(trimmed)) return false;
	if (!/^[\w.-]+(\/[\w./-]+)*$/.test(trimmed)) return false;
	if (!trimmed.includes("/")) return ROOT_SPECIAL_FILES.has(trimmed) || trimmed.includes(".");
	const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	return basename.includes(".");
}

function parseTarget(entry: string): { path: string; symbol?: string } | undefined {
	const n = normalizeEntry(entry);
	if (!n || isDecoratedPlaceholder(n)) return undefined;
	const parts = n.split("::");
	if (parts.length === 2) {
		const left = parts[0]!.trim();
		const right = parts[1]!.trim();
		if (!left || !right || isDecoratedPlaceholder(left) || isDecoratedPlaceholder(right)) return undefined;
		if (!isValidRepoPath(left)) return undefined;
		return { path: left, symbol: right };
	}
	if (parts.length > 2) return undefined;
	if (!isValidRepoPath(n)) return undefined;
	return { path: n };
}

function hasBehaviorEvidence(lines: string[]): boolean {
	for (const line of lines) {
		if (MARKDOWN_HEADING.test(line) || METADATA_LINE.test(line)) continue;
		if (BEHAVIOR_VERB.test(line.replace(TARGET_PATH_OCCURRENCES, " "))) return true;
	}
	return false;
}

function hasCriticalFilesEntries(lines: string[]): boolean {
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{2,6})\s+critical files\s*#*\s*$/i.exec(lines[index]!);
		if (!heading) continue;
		const depth = heading[1]!.length;
		for (let next = index + 1; next < lines.length; next++) {
			const line = lines[next]!;
			const nextHeading = /^(#{1,6})\s+/.exec(line);
			if (nextHeading && nextHeading[1]!.length <= depth) break;
			const trimmed = normalizeEntry(line);
			if (!trimmed || isPlaceholder(trimmed) || isDecoratedPlaceholder(trimmed)) continue;
			if (parseTarget(trimmed)) return true;
		}
	}
	return false;
}

function sliceSection(lines: string[], headingPattern: RegExp): string[] {
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index]!);
		if (!heading || !headingPattern.test(heading[2]!)) continue;
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


function hasVerificationEvidence(lines: string[]): boolean {
	const section = sliceSection(lines, /verification|验证/i);
	if (section.length === 0) return false;
	const text = section.join("\n");
	const fenceBlocks: string[] = [];
	const fenceRe = /(```|~~~)[^\n]*\n([\s\S]*?)\n\1/g;
	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(text)) !== null) fenceBlocks.push(match[2] ?? "");
	let validFencedCommand = false;
	for (const block of fenceBlocks) {
		for (const rawLine of block.split(/\r?\n/)) {
			const normalized = normalizeEntry(rawLine);
			if (!normalized || normalized.startsWith("#")) continue;
			if (isPlaceholder(normalized) || isDecoratedPlaceholder(normalized) || !parseApprovedValidation(normalized)) {
				return false;
			}
			validFencedCommand = true;
		}
	}
	if (validFencedCommand) return true;
	for (const line of section) {
		const inline = /`([^`]+)`/g;
		let matchInline: RegExpExecArray | null;
		while ((matchInline = inline.exec(line)) !== null) {
			const normalized = normalizeEntry(matchInline[1] ?? "");
			if (normalized && !isPlaceholder(normalized) && !isDecoratedPlaceholder(normalized) && parseApprovedValidation(normalized)) return true;
		}
	}
	return false;
}

function hasAcceptanceEvidence(lines: string[]): boolean {
	const section = sliceSection(lines, /acceptance|验收/i);

	if (section.length === 0) return false;
	for (const line of section) {
		const trimmed = line.trim();
		if (/^- \[ \]/.test(trimmed)) {
			const rest = normalizeEntry(trimmed);
			if (rest && !isPlaceholder(rest) && !isDecoratedPlaceholder(rest)) return true;
			continue;
		}
		if (/^(?:[-*]|\d+\.)\s+\S+/.test(trimmed) && /(must|expected|should|shall|必须|期望|应当)/i.test(trimmed)) {
			const rest = normalizeEntry(trimmed);
			if (rest && !isPlaceholder(rest) && !isDecoratedPlaceholder(rest)) return true;
		}
	}
	return false;
}
/** Extracts the exact non-shell validation commands approved in a plan. */
export function approvedValidationsFromPlan(content: string): ApprovedValidation[] {
	const section = sliceSection(content.split(/\r?\n/), /verification|验证/i);
	const candidates: string[] = [];
	const text = section.join("\n");
	const fenceRe = /(```|~~~)[^\n]*\n([\s\S]*?)\n\1/g;
	let fence: RegExpExecArray | null;
	while ((fence = fenceRe.exec(text)) !== null) candidates.push(...(fence[2] ?? "").split(/\r?\n/));
	for (const line of section) {
		const inline = /`([^`]+)`/g;
		let match: RegExpExecArray | null;
		while ((match = inline.exec(line)) !== null) candidates.push(match[1] ?? "");
	}
	const seen = new Set<string>();
	return candidates.flatMap((candidate) => {
		const parsed = parseApprovedValidation(normalizeEntry(candidate));
		if (!parsed || seen.has(parsed.digest)) return [];
		seen.add(parsed.digest);
		return [parsed];
	});
}

export function assessHandoff(planContent: string): HandoffResult {
	const lines = planContent.split(/\r?\n/).filter((line) => !METADATA_LINE.test(line));
	const content = lines.join("\n");
	const blockers: HandoffBlocker[] = [];
	const warnings: string[] = [];

	if (!hasCriticalFilesEntries(lines)) {
		blockers.push({
			code: "TARGET_MISSING",
			detail: "Plan has no repository-relative target path or populated Critical files section.",
		});
	}
	if (!hasBehaviorEvidence(lines)) {
		blockers.push({
			code: "BEHAVIOR_MISSING",
			detail: "Plan has no recognized change or behavior verb.",
		});
	}
	if (!hasAcceptanceEvidence(lines)) {
		blockers.push({
			code: "ACCEPTANCE_MISSING",
			detail: "Plan has no acceptance section with a concrete criterion.",
		});
	}
	if (!hasVerificationEvidence(lines)) {
		blockers.push({
			code: "VERIFICATION_MISSING",
			detail: "Plan has no Verification/验证 section containing an executable command.",
		});
	}

	if (planContent.split(/\r?\n/).filter((line) => line.trim().length > 0).length < 40) {
		warnings.push("Plan is short (fewer than 40 non-empty lines).");
	}
	if (!EDGE_CASE_CUE.test(content)) {
		warnings.push("Plan does not mention edge-case handling.");
	}

	return {
		status: blockers.length > 0 ? "NEEDS_UPDATE" : warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY",
		blockers,
		warnings,
	};
}

export function formatHandoffNotification(result: HandoffResult): string {
	const lines = [`LeanFlow handoff: ${result.status}`];
	if (result.blockers.length > 0) {
		lines.push("Blockers:");
		for (const blocker of result.blockers) {
			lines.push(`- ${blocker.code}: ${blocker.detail}`);
		}
	}
	if (result.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of result.warnings) {
			lines.push(`- ${warning}`);
		}
	}
	if (result.status !== "NEEDS_UPDATE" && result.blockers.length === 0) {
		lines.push("Proceeding to approval.");
	}
	return lines.join("\n");
}
