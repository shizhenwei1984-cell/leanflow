/**
 * LeanFlow handoff advisor.
 *
 * Assesses the canonical plan after it is written. This is an advisor, not a
 * validator — it provides risk signals but does NOT block the workflow unless
 * the plan is critically incomplete (no target, no files, no behavior).
 *
 * Statuses:
 *   READY               — plan looks executable, proceed to BUILD
 *   READY_WITH_WARNINGS — minor gaps logged, proceed to BUILD
 *   NEEDS_UPDATE        — critically incomplete, advise Planner to revise
 */

import type { HandoffStatus } from "./state";

export interface HandoffResult {
	status: HandoffStatus;
	warnings: string[];
}

const REQUIRED_SECTIONS = ["context", "approach", "verification"];
const RECOMMENDED_SECTIONS = ["critical files", "assumptions"];

export function assessHandoff(planContent: string): HandoffResult {
	const lower = planContent.toLowerCase();
	const warnings: string[] = [];

	// Critical checks → NEEDS_UPDATE (extremely rare)
	const hasTarget =
		/修改|change|modify|implement|add|remove|update|fix|create|delete|refactor/i.test(planContent);
	const hasFileEntry = /[\w./-]+\.\w{1,6}/.test(planContent);

	if (!hasTarget && !hasFileEntry) {
		return {
			status: "NEEDS_UPDATE",
			warnings: ["Plan has no modification target and no file entry points — cannot execute."],
		};
	}

	// Required sections
	for (const section of REQUIRED_SECTIONS) {
		if (!lower.includes(section)) {
			warnings.push(`Missing section: ${section}`);
		}
	}

	// Recommended sections
	for (const section of RECOMMENDED_SECTIONS) {
		if (!lower.includes(section)) {
			warnings.push(`Missing recommended section: ${section}`);
		}
	}

	// Verification detail
	if (!/test|验证|check|assert|expect|run|command|命令/i.test(planContent)) {
		warnings.push("Verification lacks concrete test commands or expected outcomes.");
	}

	// Size sanity
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
		lines.push("Continue BUILD: yes");
	}
	return lines.join("\n");
}
