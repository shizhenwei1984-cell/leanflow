/**
 * Deterministic canonical-plan handoff assessment.
 *
 * The checks deliberately recognize explicit plan signals rather than trying
 * to infer implementation intent from prose. Workflow metadata is excluded so
 * opaque run IDs cannot accidentally satisfy an English behavior-verb check.
 */

import type { HandoffStatus } from "./state";

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

const TARGET_PATH = /\b[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|py|md|json|yml|yaml|pm|pl)\b/i;
const TARGET_PATH_OCCURRENCES = /\b[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|py|md|json|yml|yaml|pm|pl)\b/gi;
const BEHAVIOR_VERB =
	/\b(?:change|update|add|remove|implement|fix|refactor|extend|replace|rename|delete|create|migrate|split|merge|rewrite)\b|修改|新增|添加|删除|创建|调整|替换|迁移|拆分|合并|重写|修复|实现|扩展|重命名/i;
const ACCEPTANCE_CUE = /- \[ \]|\bmust\b|\bexpected\b|必须|期望/i;
const EDGE_CASE_CUE = /\bedge[ -]?cases?\b|边界(?:情况|条件)?|异常(?:情况)?/i;
const METADATA_LINE = /^\s*(?:LeanFlow run ID|LSP applicability):/i;
const MARKDOWN_HEADING = /^(#{1,6})\s+/;

function hasBehaviorEvidence(lines: string[]): boolean {
	let criticalFilesDepth: number | undefined;

	for (const line of lines) {
		const heading = MARKDOWN_HEADING.exec(line);
		if (heading) {
			if (/^#{2,6}\s+critical files\s*#*\s*$/i.test(line)) {
				criticalFilesDepth = heading[1]!.length;
				continue;
			}
			if (criticalFilesDepth !== undefined && heading[1]!.length <= criticalFilesDepth) {
				criticalFilesDepth = undefined;
			}
		}
		if (criticalFilesDepth !== undefined || METADATA_LINE.test(line)) continue;

		// Strip paths before scanning: a target such as `src/add.ts` is not
		// evidence that the plan describes an add operation.
		if (BEHAVIOR_VERB.test(line.replace(TARGET_PATH_OCCURRENCES, ""))) return true;
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
			if (!nextHeading && line.trim().length > 0) return true;
		}
	}
	return false;
}

function hasVerificationEvidence(lines: string[]): boolean {
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+.*(?:verification|验证).*$/i.exec(lines[index]!);
		if (!heading) continue;

		const depth = heading[1]!.length;
		const section: string[] = [];
		for (let next = index + 1; next < lines.length; next++) {
			const line = lines[next]!;
			const nextHeading = /^(#{1,6})\s+/.exec(line);
			if (nextHeading && nextHeading[1]!.length <= depth) break;
			section.push(line);
		}
		const content = section.join("\n");
		if (/^\s*(```|~~~)/m.test(content) || /`(?:bun test|tsc|python|pytest|npm|make|cargo)\b[^`]*`/i.test(content)) {
			return true;
		}
	}
	return false;
}

export function assessHandoff(planContent: string): HandoffResult {
	const lines = planContent.split(/\r?\n/).filter((line) => !METADATA_LINE.test(line));
	const content = lines.join("\n");
	const blockers: HandoffBlocker[] = [];
	const warnings: string[] = [];

	// TARGET is a supported source/config/document path or an explicitly
	// populated `## Critical files` section. Symbols need no special syntax
	// when documented in that section.
	if (!TARGET_PATH.test(content) && !hasCriticalFilesEntries(lines)) {
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
	if (!/^#{1,6}\s+.*(?:acceptance|验收).*$/im.test(content) && !ACCEPTANCE_CUE.test(content)) {
		blockers.push({
			code: "ACCEPTANCE_MISSING",
			detail: "Plan has no acceptance section or acceptance criterion.",
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
