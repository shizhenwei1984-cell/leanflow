/**
 * LeanFlow handoff advisor.
 *
 * Assesses the canonical plan after it is written. This is an advisor, not a
 * validator — it provides risk signals but does NOT block the workflow unless
 * the plan is critically incomplete (no target, no files, no behavior).
 *
 * Checks semantic signals, not section headings. A plan that says
 * "## Implementation Strategy" instead of "## Approach" is fine.
 *
 * Statuses:
 *   READY               — plan looks executable, proceed
 *   READY_WITH_WARNINGS — minor gaps logged, proceed
 *   NEEDS_UPDATE        — critically incomplete, advise Planner to revise
 */

import type { HandoffStatus } from "./state";

export interface HandoffResult {
	status: HandoffStatus;
	warnings: string[];
}

export function assessHandoff(planContent: string): HandoffResult {
	const warnings: string[] = [];

	// Critical: no modification target AND no file references → cannot execute.
	const hasTarget =
		/修改|change|modify|implement|add|remove|update|fix|create|delete|refactor|replace|rewrite/i.test(
			planContent,
		);
	const hasFileEntry = /[\w./-]+\.\w{1,6}/.test(planContent);

	if (!hasTarget && !hasFileEntry) {
		return {
			status: "NEEDS_UPDATE",
			warnings: ["Plan has no modification target and no file entry points — cannot execute."],
		};
	}

	// Semantic: does the plan describe what to verify?
	if (!/test|验证|check|assert|expect|run|command|命令|smoke|spec|unittest|pytest|cargo|npm|bun/i.test(planContent)) {
		warnings.push("No verification signals found — plan may lack test/validation detail.");
	}

	// Semantic: does the plan reference concrete files or symbols?
	if (!hasFileEntry) {
		warnings.push("No file paths found — Builder may lack concrete entry points.");
	}

	// Size sanity (very short plans are suspicious).
	if (planContent.length < 100) {
		warnings.push("Plan is very short — may lack implementation detail.");
	}

	return {
		status: warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY",
		warnings,
	};
}

export function formatHandoffNotification(result: HandoffResult): string {
	const lines = [`LeanFlow handoff: ${result.status}`];
	if (result.warnings.length > 0) {
		lines.push("Warnings:");
		for (const w of result.warnings) {
			lines.push(`  - ${w}`);
		}
	}
	if (result.status !== "NEEDS_UPDATE") {
		lines.push("Proceeding to approval.");
	}
	return lines.join("\n");
}
